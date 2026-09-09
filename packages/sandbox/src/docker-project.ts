import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, type ExecOptions, type ExecResult } from "./exec.js";
import { localProcessEnv, readBoundedRegularFile, type LocalWorkspace } from "./local-workspace.js";

export type TestSelection = "regression" | "functional";
export interface StructuredTestResult {
  status: "passed" | "assertion_failed" | "invalid" | "error" | "timeout" | "cancelled";
  passed: boolean;
  output: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  collectedFiles: string[];
  testManifest: string[];
  reason?: string;
}
export interface ProjectRuntime {
  adapter: "vitest";
  image: string;
  lockfile: "package-lock.json" | "pnpm-lock.yaml";
  lockfileHash: string;
  packageManager: string;
  vitestVersion: string;
  viteVersion: string;
}
export interface ProjectTestRunner {
  readonly runtime?: ProjectRuntime;
  prepare(workspace: LocalWorkspace, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  runTests(dir: string, selection: TestSelection, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<StructuredTestResult>;
  cleanup(): Promise<void>;
}
export type DockerInvoker = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;
export interface DockerProjectRunnerOptions { image?: string; invoke?: DockerInvoker }
interface ReportTask { name?: string; type?: string; mode?: string; result?: { state?: string; errors?: Array<{ name?: string; message?: string }>; hooks?: Record<string, string> }; tasks?: ReportTask[] }
export interface VitestEvidence { version: 1; files: Array<{ path: string; task: ReportTask }>; errors: unknown[] }

export const DEFAULT_NODE_IMAGE = "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const MAX_METADATA_BYTES = 2_000_000;

const REPORTER = `const clean = task => ({ name: task.name, type: task.type, mode: task.mode, result: task.result && { state: task.result.state, errors: task.result.errors?.map(e => ({name:e.name,message:e.message})), hooks:task.result.hooks }, tasks: task.tasks?.map(clean) });
export default class VouchReporter {
  onInit(ctx) { this.ctx = ctx; }
  save(files, errors) { globalThis.__vouchEvidence = {version:1,files:(files || []).map(file => ({path:file.filepath,task:clean(file)})),errors:(errors || []).map(e=>({name:e.name,message:e.message}))}; }
  onFinished(files, errors) { this.save(files, errors); }
  onTestRunEnd(modules, errors) { this.save(this.ctx.state.getFiles(), errors); }
}
`;

const LAUNCHER = `import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/repo/package.json');
const { startVitest } = await import(require.resolve('vitest/node'));
const { configDefaults } = await import(require.resolve('vitest/config'));
const [selection, regression] = process.argv.slice(2);
const options = { root:'/repo',run:true,watch:false,cache:false,fsModuleCache:false,configLoader:'runner',pool:'forks',isolate:true,fileParallelism:false,maxWorkers:1,reporters:['/vouch/reporter.mjs'] };
if(selection === 'functional') options.exclude = [...configDefaults.exclude, regression];
const ctx = await startVitest('test', selection === 'regression' ? [regression] : [], options, {cacheDir:'/tmp/vite-cache'});
await ctx?.close();
if (globalThis.__vouchEvidence) writeFileSync('/evidence/result.json', JSON.stringify(globalThis.__vouchEvidence));
`;

export function classifyVitestEvidence(evidence: unknown, execution: ExecResult, selection: TestSelection, regressionPath: string): StructuredTestResult {
  const base: StructuredTestResult = { status: "invalid", passed: false, output: `${execution.stdout}\n${execution.stderr}`.trim().slice(-16_000), exitCode: execution.exitCode, timedOut: execution.timedOut, cancelled: Boolean(execution.cancelled), testsPassed: 0, testsFailed: 0, testsSkipped: 0, collectedFiles: [], testManifest: [] };
  if (execution.cancelled) return { ...base, status: "cancelled", reason: "test execution cancelled" };
  if (execution.timedOut) return { ...base, status: "timeout", reason: "test execution timed out" };
  if (!evidence || typeof evidence !== "object") return { ...base, status: "error", reason: "Vitest did not produce structured test evidence" };
  const report = evidence as VitestEvidence;
  if (report.version !== 1 || !Array.isArray(report.files) || !Array.isArray(report.errors)) return { ...base, reason: "invalid test evidence" };
  if (report.errors.length) return { ...base, status: "error", reason: "Vitest reported an unhandled error" };
  const expected = `/repo/${regressionPath}`;
  if (selection === "regression" && (report.files.length !== 1 || report.files[0]?.path !== expected)) return { ...base, reason: "designated regression was not the sole collected test file" };
  if (selection === "functional" && report.files.some(file => file.path === expected)) return { ...base, reason: "functional suite included designated regression" };
  let invalidReason: string | undefined;
  const failureDetails: string[] = [];
  const inspect = (task: ReportTask, file: string, parents: string[]) => {
    if (!task || typeof task !== "object") { invalidReason = "malformed task evidence"; return; }
    if (Object.values(task.result?.hooks ?? {}).some(state => state !== "pass")) invalidReason = "test setup or teardown hook failed";
    const errors = task.result?.errors ?? [];
    if (!Array.isArray(errors)) { invalidReason = "malformed error evidence"; return; }
    if (task.type !== "test") {
      if (errors.length || (task.result?.state === "fail" && !task.tasks?.length)) invalidReason = "test collection, setup, or suite failed";
      if (task.tasks !== undefined && !Array.isArray(task.tasks)) { invalidReason = "malformed suite evidence"; return; }
      const nextParents = task.name ? [...parents, task.name] : parents;
      for (const child of task.tasks ?? []) inspect(child, file, nextParents);
      return;
    }
    const mode = task.mode === "skip" || task.mode === "todo" || ["skip", "todo", "pending"].includes(task.result?.state ?? "") ? "skipped" : "run";
    base.testManifest.push(`${file}::${[...parents, task.name ?? "test"].join(" > ")}#${mode}`);
    if (task.mode === "skip" || task.mode === "todo" || ["skip", "todo", "pending"].includes(task.result?.state ?? "")) { base.testsSkipped++; return; }
    if (task.result?.state === "pass") base.testsPassed++;
    else if (task.result?.state === "fail") {
      base.testsFailed++;
      failureDetails.push(`${task.name ?? "test"}: ${errors.map(error => error.message ?? error.name ?? "assertion failed").join("; ")}`);
      if (!errors.length || errors.some(error => !["AssertionError", "AssertionError [ERR_ASSERTION]"].includes(error.name ?? ""))) invalidReason = "failure was not a test assertion";
    } else invalidReason = "test did not finish";
  };
  for (const file of report.files) {
    if (!file.path.startsWith("/repo/") || file.path.slice(6).split("/").some(part => !part || part === "." || part === "..")) {
      invalidReason = "collected test path is outside the repository";
      continue;
    }
    const relativePath = file.path.slice(6);
    base.collectedFiles.push(relativePath);
    inspect(file.task, relativePath, []);
  }
  base.collectedFiles.sort();
  base.testManifest.sort();
  if (new Set(base.collectedFiles).size !== base.collectedFiles.length) invalidReason = "duplicate collected test file evidence";
  if (!base.testsPassed && !base.testsFailed) return { ...base, reason: "no tests executed" };
  if (selection === "regression" && base.testsSkipped) return { ...base, reason: "designated regression contains skipped tests" };
  if (invalidReason) return { ...base, reason: invalidReason };
  if (base.testsFailed) {
    if (execution.exitCode !== 1) return { ...base, reason: "assertion evidence disagrees with process exit" };
    return {
      ...base,
      status: "assertion_failed",
      output: base.output || `${base.testsPassed} passed, ${base.testsFailed} failed, ${base.testsSkipped} skipped\n${failureDetails.join("\n")}`.trim(),
      reason: "executed test assertion failed",
    };
  }
  if (execution.exitCode !== 0) return { ...base, status: "error", reason: "test process exited unsuccessfully" };
  return {
    ...base,
    status: "passed",
    passed: true,
    output: base.output || `${base.testsPassed} passed, ${base.testsFailed} failed, ${base.testsSkipped} skipped`,
  };
}

export class DockerProjectRunner implements ProjectTestRunner {
  private readonly invoke: DockerInvoker;
  private readonly image: string;
  private runtimeData?: ProjectRuntime;
  private root?: string;
  private workspace?: LocalWorkspace;
  private active = new Set<string>();
  constructor(opts: DockerProjectRunnerOptions = {}) { this.invoke = opts.invoke ?? runCommand; this.image = opts.image ?? DEFAULT_NODE_IMAGE; }
  get runtime(): ProjectRuntime | undefined { return this.runtimeData ? { ...this.runtimeData } : undefined; }

  private async execute(args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ExecResult> {
    const name = `vouch-${randomUUID()}`;
    this.active.add(name);
    try {
      return await this.invoke("docker", ["run", "--rm", "--name", name, "--init", "--log-driver=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--cpus=2", "--ulimit=nofile=1024:1024", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--env", "HOME=/tmp/vouch-home", "--env", "CI=1", ...args], { cwd: this.root ?? tmpdir(), env: localProcessEnv(), timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 100_000 });
    } finally {
      await this.invoke("docker", ["rm", "--force", name], { cwd: this.root ?? tmpdir(), env: localProcessEnv(), timeoutMs: 5000, maxOutputBytes: 1000 });
      this.active.delete(name);
    }
  }

  async prepare(workspace: LocalWorkspace, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this.root) throw new Error("runner already prepared");
    opts.signal?.throwIfAborted();
    const manifestPath = join(workspace.baselineDir, "package.json");
    if (!existsSync(manifestPath)) throw new Error("Node project package.json is required at repository root");
    const manifest = JSON.parse(readBoundedRegularFile(manifestPath, MAX_METADATA_BYTES, "package.json").toString("utf8")) as { packageManager?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (!(manifest.dependencies?.vitest || manifest.devDependencies?.vitest)) throw new Error("the repository must declare Vitest as a dependency");
    const npm = existsSync(join(workspace.baselineDir, "package-lock.json"));
    const pnpm = existsSync(join(workspace.baselineDir, "pnpm-lock.yaml"));
    if (npm === pnpm) throw new Error("exactly one npm or pnpm lockfile is required");
    if (manifest.packageManager && !new RegExp(`^${pnpm ? "pnpm" : "npm"}@\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$`).test(manifest.packageManager)) throw new Error("packageManager must match the lockfile and specify an exact version");
    this.root = mkdtempSync(join(tmpdir(), "vouch-docker-"));
    this.workspace = workspace;
    const setup = join(this.root, "setup");
    cpSync(workspace.baselineDir, setup, { recursive: true });
    mkdirSync(join(this.root, "tools"));
    writeFileSync(join(this.root, "tools", "reporter.mjs"), REPORTER);
    writeFileSync(join(this.root, "tools", "run.mjs"), LAUNCHER);
    const prepareStartedAt = Date.now();
    const prepareTimeout = opts.timeoutMs ?? 180_000;
    const timeoutRemaining = () => Math.max(1, prepareTimeout - (Date.now() - prepareStartedAt));
    let npmVersion: string | undefined;
    if (npm) {
      const version = await this.execute(["--network=none", this.image, "npm", "--version"], { signal: opts.signal, timeoutMs: timeoutRemaining() });
      npmVersion = version.stdout.trim();
      if (version.exitCode !== 0 || version.timedOut || version.cancelled || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(npmVersion)) {
        throw new Error("could not resolve the npm version from the pinned runtime image");
      }
      if (manifest.packageManager && manifest.packageManager !== `npm@${npmVersion}`) {
        throw new Error(`packageManager requests ${manifest.packageManager}, but the runtime image provides npm@${npmVersion}`);
      }
    }
    const packageCommand = pnpm ? ["corepack", `pnpm@${manifest.packageManager?.split("@")[1] ?? "10.33.3"}`, "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--store-dir=/tmp/pnpm-store"] : ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache=/tmp/npm-cache"];
    const result = await this.execute(["--network=bridge", "--mount", `type=bind,src=${setup},dst=/repo`, "--workdir=/repo", "--env", "COREPACK_HOME=/tmp/corepack", this.image, ...packageCommand], { signal: opts.signal, timeoutMs: timeoutRemaining() });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error(`dependency setup ${result.cancelled ? "cancelled" : result.timedOut ? "timed out" : "failed"}: ${result.stderr.slice(-4000)}`);
    if (!existsSync(join(setup, "node_modules", "vitest", "vitest.mjs"))) throw new Error("dependency setup did not install the declared Vitest runner");
    const installed = JSON.parse(readBoundedRegularFile(join(setup, "node_modules", "vitest", "package.json"), MAX_METADATA_BYTES, "installed Vitest package.json").toString("utf8")) as { version?: string };
    if (!/^[345]\./.test(installed.version ?? "")) throw new Error("MVP structured verification requires Vitest 3, 4, or 5 with Vite 6.1 or newer");
    const vite = JSON.parse(readBoundedRegularFile(join(setup, "node_modules", "vite", "package.json"), MAX_METADATA_BYTES, "installed Vite package.json").toString("utf8")) as { version?: string };
    const [viteMajor = 0, viteMinor = 0] = (vite.version ?? "").split(".").map(Number);
    if (viteMajor < 6 || (viteMajor === 6 && viteMinor < 1)) throw new Error("MVP structured verification requires Vite 6.1 or newer");
    const lockfile = pnpm ? "pnpm-lock.yaml" : "package-lock.json";
    this.runtimeData = {
      adapter: "vitest",
      image: this.image,
      lockfile,
      lockfileHash: createHash("sha256").update(readBoundedRegularFile(join(workspace.baselineDir, lockfile), MAX_METADATA_BYTES, lockfile)).digest("hex"),
      packageManager: manifest.packageManager ?? (pnpm ? "pnpm@10.33.3" : `npm@${npmVersion}`),
      vitestVersion: installed.version!,
      viteVersion: vite.version!,
    };
  }

  async runTests(dir: string, selection: TestSelection, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<StructuredTestResult> {
    if (!this.root || !this.workspace) throw new Error("prepare the project runner before running tests");
    if (![this.workspace.dir, this.workspace.baselineDir, this.workspace.verificationDir].includes(resolve(dir))) throw new Error("test directory is outside the prepared workspace");
    const evidenceDir = mkdtempSync(join(this.root, "evidence-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    const result = await this.execute(["--network=none", "--mount", `type=bind,src=${dir},dst=/repo,readonly`, "--mount", `type=bind,src=${join(this.root, "setup", "node_modules")},dst=/repo/node_modules,readonly`, "--mount", `type=bind,src=${join(this.root, "tools")},dst=/vouch,readonly`, "--mount", `type=bind,src=${evidenceDir},dst=/evidence`, "--workdir=/repo", this.image, "node", "/vouch/run.mjs", selection, this.workspace.regressionPath], opts);
    let evidence: unknown;
    try {
      const evidencePath = join(evidenceDir, "result.json");
      evidence = JSON.parse(readBoundedRegularFile(evidencePath, MAX_METADATA_BYTES, "test evidence").toString());
    } catch { /* Missing, special, oversized, or malformed evidence fails verification. */ }
    return classifyVitestEvidence(evidence, result, selection, this.workspace.regressionPath);
  }

  async cleanup(): Promise<void> {
    for (const name of this.active) await this.invoke("docker", ["rm", "--force", name], { cwd: tmpdir(), env: localProcessEnv(), timeoutMs: 5000, maxOutputBytes: 1000 });
    this.active.clear();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
    this.workspace = undefined;
  }
}
