import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { type ExecResult } from "./exec.js";
import { readBoundedRegularFile, type LocalWorkspace } from "./local-workspace.js";
import { DockerSession, exceedsDirectoryLimit, type DockerInvoker } from "./docker-session.js";
export type { DockerInvoker } from "./docker-session.js";

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
export interface VitestRuntime {
  adapter: "vitest";
  repositoryConfig: "disabled";
  image: string;
  lockfile: "package-lock.json" | "pnpm-lock.yaml";
  lockfileHash: string;
  packageManager: string;
  vitestVersion: string;
  viteVersion: string;
}
export interface PytestRuntime {
  adapter: "pytest";
  repositoryConfig: "disabled";
  conftest: "immutable";
  image: string;
  requirementsFile: string;
  requirementsHash: string;
  packageManager: string;
  pythonVersion: string;
  pytestVersion: string;
  dependencies: Array<{ name: string; version: string; sha256: string }>;
}
export type ProjectRuntime = VitestRuntime | PytestRuntime;
export interface ProjectTestRunner {
  readonly runtime?: ProjectRuntime;
  prepare(workspace: LocalWorkspace, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  runTests(dir: string, selection: TestSelection, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<StructuredTestResult>;
  cleanup(): Promise<void>;
}
export interface DockerProjectRunnerOptions { image?: string; invoke?: DockerInvoker }
interface ReportTask { name?: string; type?: string; mode?: string; result?: { state?: string; errors?: Array<{ name?: string; message?: string; stack?: string }>; hooks?: Record<string, string> }; tasks?: ReportTask[] }
export interface VitestEvidence { version: 1; files: Array<{ path: string; task: ReportTask }>; errors: unknown[] }

export const DEFAULT_NODE_IMAGE = "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const MAX_METADATA_BYTES = 2_000_000;
const EVIDENCE_MARKER = "__VOUCH_EVIDENCE_V1__";
const MAX_SETUP_BYTES = 750_000_000;
const MAX_SETUP_ENTRIES = 100_000;

function validateNpmLock(bytes: Buffer): void {
  const lock = JSON.parse(bytes.toString("utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
  };
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("npm MVP requires a package-lock.json at lockfileVersion 3");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (entry.link) throw new Error("linked npm dependencies are unsupported in the local MVP");
    if (entry.resolved) {
      let url: URL;
      try { url = new URL(entry.resolved); }
      catch { throw new Error(`npm lockfile contains a non-URL dependency source: ${path}`); }
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
        throw new Error(`npm lockfile dependency is outside registry.npmjs.org: ${path}`);
      }
    }
  }
  for (const name of ["vitest", "vite"] as const) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry?.resolved?.startsWith(`https://registry.npmjs.org/${name}/-/`) || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? "")) {
      throw new Error(`npm lockfile must pin ${name} to an integrity-checked registry.npmjs.org package`);
    }
  }
}

function validatePnpmLock(bytes: Buffer): void {
  const lock = bytes.toString("utf8");
  if (/(?:\b(?:tarball|directory):|\b(?:link|file):)/i.test(lock)) {
    throw new Error("linked, file, directory, and custom tarball dependencies are unsupported in the local MVP");
  }
  const document = parseYaml(lock, { maxAliasCount: 0 }) as {
    lockfileVersion?: string | number;
    importers?: Record<string, { dependencies?: Record<string, { specifier?: unknown; version?: unknown }>; devDependencies?: Record<string, { specifier?: unknown; version?: unknown }> }>;
    packages?: Record<string, { resolution?: { integrity?: unknown } }>;
    snapshots?: Record<string, { dependencies?: Record<string, unknown> }>;
  };
  if (String(document.lockfileVersion) !== "9.0") throw new Error("pnpm MVP requires lockfileVersion 9.0");
  const root = document.importers?.["."];
  const vitest = root?.devDependencies?.vitest ?? root?.dependencies?.vitest;
  if (!vitest || typeof vitest.specifier !== "string" || typeof vitest.version !== "string" || /^(?:npm:|workspace:|link:|file:)/i.test(vitest.specifier)) {
    throw new Error("root pnpm importer must resolve the declared Vitest package directly");
  }
  const vitestVersion = vitest.version.split("(", 1)[0]!;
  if (!/^[45]\./.test(vitestVersion)) throw new Error("root pnpm importer must pin Vitest 4 or 5");
  const vitestPackage = document.packages?.[`vitest@${vitestVersion}`] ?? document.packages?.[`/vitest@${vitestVersion}`];
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(String(vitestPackage?.resolution?.integrity ?? ""))) {
    throw new Error("pnpm lockfile must pin the root Vitest package with sha512 integrity");
  }
  const vitestSnapshot = document.snapshots?.[`vitest@${vitest.version}`] ?? document.snapshots?.[`/vitest@${vitest.version}`];
  const viteResolution = vitestSnapshot?.dependencies?.vite;
  if (typeof viteResolution !== "string" || /^(?:npm:|workspace:|link:|file:)/i.test(viteResolution)) {
    throw new Error("root Vitest snapshot must resolve Vite directly");
  }
  const viteVersion = viteResolution.split("(", 1)[0]!;
  const vitePackage = document.packages?.[`vite@${viteVersion}`] ?? document.packages?.[`/vite@${viteVersion}`];
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(String(vitePackage?.resolution?.integrity ?? ""))) {
    throw new Error("pnpm lockfile must pin Vitest's Vite package with sha512 integrity");
  }
}

const REPORTER = `const clean = task => ({ name: task.name, type: task.type, mode: task.mode, result: task.result && { state: task.result.state, errors: task.result.errors?.map(e => ({name:e.name,message:e.message,stack:e.stack})), hooks:task.result.hooks }, tasks: task.tasks?.map(clean) });
export default class VouchReporter {
  onInit(ctx) { this.ctx = ctx; }
  save(files, errors) { globalThis.__vouchEvidence = {version:1,files:(files || []).map(file => ({path:file.filepath,task:clean(file)})),errors:(errors || []).map(e=>({name:e.name,message:e.message}))}; }
  onFinished(files, errors) { this.save(files, errors); }
  onTestRunEnd(modules, errors) { this.save(this.ctx.state.getFiles(), errors); }
}
`;

const LAUNCHER = `import { closeSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/repo/package.json');
const { startVitest } = await import(require.resolve('vitest/node'));
const { configDefaults } = await import(require.resolve('vitest/config'));
const [selection, regression] = process.argv.slice(2);
const options = { root:'/repo',config:false,run:true,watch:false,cache:false,fsModuleCache:false,pool:'forks',isolate:true,fileParallelism:false,maxWorkers:1,reporters:['/vouch/reporter.mjs'] };
if(selection === 'regression') { options.include = [regression]; options.exclude = [...configDefaults.exclude]; }
const ctx = await startVitest('test', selection === 'regression' ? [regression] : [], options, {configFile:false,envDir:false,cacheDir:'/tmp/vite-cache',css:{postcss:{plugins:[]}}});
await ctx?.close();
const exitCode = process.exitCode ?? 0;
process.removeAllListeners('beforeExit');
process.removeAllListeners('exit');
if (globalThis.__vouchEvidence) writeSync(1, '\\n${EVIDENCE_MARKER}' + Buffer.from(JSON.stringify(globalThis.__vouchEvidence)).toString('base64') + '\\n');
closeSync(1);
process.exit(exitCode);
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
      if (!errors.length || errors.some(error =>
        !["AssertionError", "AssertionError [ERR_ASSERTION]"].includes(error.name ?? "") ||
        !/(?:node:assert|node_modules\/(?:@vitest\/expect|chai|vitest))/i.test(error.stack ?? "")
      )) invalidReason = "failure was not a test-runner assertion";
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
  private readonly session: DockerSession;
  private readonly image: string;
  private runtimeData?: ProjectRuntime;
  private root?: string;
  private workspace?: LocalWorkspace;
  constructor(opts: DockerProjectRunnerOptions = {}) { this.session = new DockerSession(opts.invoke); this.image = opts.image ?? DEFAULT_NODE_IMAGE; }
  get runtime(): ProjectRuntime | undefined { return this.runtimeData ? { ...this.runtimeData } : undefined; }

  private execute(
    args: string[],
    opts: { signal?: AbortSignal; timeoutMs: number },
    maxOutputBytes = 100_000,
  ): Promise<ExecResult> {
    return this.session.run(args, opts, maxOutputBytes);
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
    const lockfile = pnpm ? "pnpm-lock.yaml" : "package-lock.json";
    const lockfileBytes = readBoundedRegularFile(join(workspace.baselineDir, lockfile), MAX_METADATA_BYTES, lockfile);
    if (pnpm) validatePnpmLock(lockfileBytes);
    else validateNpmLock(lockfileBytes);
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
    const storageController = new AbortController();
    let storageExceeded = false;
    const checkStorage = () => {
      if (storageExceeded || !exceedsDirectoryLimit(setup, MAX_SETUP_BYTES, MAX_SETUP_ENTRIES)) return;
      storageExceeded = true;
      storageController.abort();
    };
    const monitor = setInterval(checkStorage, 1_000);
    monitor.unref();
    let result: ExecResult;
    try {
      const setupSignal = opts.signal ? AbortSignal.any([opts.signal, storageController.signal]) : storageController.signal;
      result = await this.execute(["--network=bridge", "--mount", `type=bind,src=${setup},dst=/repo`, "--workdir=/repo", "--env", "COREPACK_HOME=/tmp/corepack", this.image, ...packageCommand], { signal: setupSignal, timeoutMs: timeoutRemaining() });
      checkStorage();
    } finally {
      clearInterval(monitor);
    }
    if (storageExceeded) throw new Error("dependency setup exceeded the 750 MB / 100000 entry limit");
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error(`dependency setup ${result.cancelled ? "cancelled" : result.timedOut ? "timed out" : "failed"}: ${result.stderr.slice(-4000)}`);
    if (!existsSync(join(setup, "node_modules", "vitest", "vitest.mjs"))) throw new Error("dependency setup did not install the declared Vitest runner");
    const installed = JSON.parse(readBoundedRegularFile(join(setup, "node_modules", "vitest", "package.json"), MAX_METADATA_BYTES, "installed Vitest package.json").toString("utf8")) as { name?: string; version?: string };
    if (installed.name !== "vitest" || !/^[45]\./.test(installed.version ?? "")) throw new Error("MVP structured verification requires the official Vitest 4 or 5 package with Vite 6.1 or newer");
    const vite = JSON.parse(readBoundedRegularFile(join(setup, "node_modules", "vite", "package.json"), MAX_METADATA_BYTES, "installed Vite package.json").toString("utf8")) as { name?: string; version?: string };
    const [viteMajor = 0, viteMinor = 0] = (vite.version ?? "").split(".").map(Number);
    if (vite.name !== "vite" || viteMajor < 6 || (viteMajor === 6 && viteMinor < 1)) throw new Error("MVP structured verification requires the official Vite 6.1 or newer package");
    this.runtimeData = {
      adapter: "vitest",
      repositoryConfig: "disabled",
      image: this.image,
      lockfile,
      lockfileHash: createHash("sha256").update(lockfileBytes).digest("hex"),
      packageManager: manifest.packageManager ?? (pnpm ? "pnpm@10.33.3" : `npm@${npmVersion}`),
      vitestVersion: installed.version!,
      viteVersion: vite.version!,
    };
  }

  async runTests(dir: string, selection: TestSelection, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<StructuredTestResult> {
    if (!this.root || !this.workspace) throw new Error("prepare the project runner before running tests");
    if (![this.workspace.dir, this.workspace.baselineDir, this.workspace.verificationDir].includes(resolve(dir))) throw new Error("test directory is outside the prepared workspace");
    let runDir = dir;
    let functionalSnapshot: string | undefined;
    if (selection === "functional") {
      functionalSnapshot = mkdtempSync(join(this.root, "functional-"));
      cpSync(dir, functionalSnapshot, { recursive: true });
      rmSync(join(functionalSnapshot, this.workspace.regressionPath), { force: true });
      runDir = functionalSnapshot;
    }
    mkdirSync(join(runDir, "node_modules"), { recursive: true });
    let result: ExecResult;
    try {
      result = await this.execute(["--network=none", "--mount", `type=bind,src=${runDir},dst=/repo,readonly`, "--mount", `type=bind,src=${join(this.root, "setup", "node_modules")},dst=/repo/node_modules,readonly`, "--mount", `type=bind,src=${join(this.root, "tools")},dst=/vouch,readonly`, "--workdir=/repo", this.image, "node", "/vouch/run.mjs", selection, this.workspace.regressionPath], opts, 3_000_000);
    } finally {
      if (functionalSnapshot) rmSync(functionalSnapshot, { recursive: true, force: true });
    }
    let evidence: unknown;
    let execution = result;
    try {
      const markerIndex = result.stdout.lastIndexOf(EVIDENCE_MARKER);
      if (markerIndex < 0) throw new Error("missing evidence marker");
      const encoded = result.stdout.slice(markerIndex + EVIDENCE_MARKER.length).trim();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_METADATA_BYTES / 3) * 4 + 4) throw new Error("invalid evidence encoding");
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > MAX_METADATA_BYTES) throw new Error("oversized evidence");
      evidence = JSON.parse(decoded.toString("utf8"));
      execution = { ...result, stdout: result.stdout.slice(0, markerIndex).trimEnd() };
    } catch { /* Missing, special, oversized, or malformed evidence fails verification. */ }
    return classifyVitestEvidence(evidence, execution, selection, this.workspace.regressionPath);
  }

  async cleanup(): Promise<void> {
    await this.session.cleanup();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
    this.workspace = undefined;
  }
}
