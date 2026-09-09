import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { DockerSession, exceedsDirectoryLimit, type DockerInvoker } from "./docker-session.js";
import { DockerProjectRunner, type ProjectTestRunner, type PytestRuntime, type StructuredTestResult, type TestSelection } from "./docker-project.js";
import { safePath } from "./fs-tools.js";
import { readBoundedRegularFile, type LocalWorkspace } from "./local-workspace.js";
import { classifyPytestEvidence, PYTEST_EVIDENCE_MARKER, PYTEST_LAUNCHER } from "./pytest-evidence.js";
import type { ExecResult } from "./exec.js";

export const DEFAULT_PYTHON_IMAGE = "python:3.11-slim@sha256:3c1dfceb3f1267d4d378e7883cddf35c58757bab98d70bba30b6e02e808fa21d";
const MAX_METADATA_BYTES = 2_000_000;
const TEST_ENVIRONMENT = {
  TESTING: "1",
  DATABASE_URL: "sqlite:////tmp/vouch-test.sqlite3",
  PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
  PYTHON_DOTENV_DISABLED: "1",
};
const canonicalName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

interface PythonRequirements {
  file: string;
  hash: string;
  content: string;
  versions: Map<string, string>;
}

export function readPythonRequirements(root: string): PythonRequirements {
  const file = existsSync(join(root, "requirements-test.txt")) ? "requirements-test.txt" : "requirements.txt";
  const sources = new Map<string, Buffer>();
  const visiting = new Set<string>();
  const versions = new Map<string, string>();
  const pins = new Set<string>();
  const read = (path: string) => {
    if (visiting.has(path)) throw new Error("cyclic Python requirements include");
    if (sources.has(path)) return;
    if (sources.size >= 20) throw new Error("too many Python requirements files");
    if (!/^[A-Za-z0-9_./-]+\.txt$/.test(path)) throw new Error("requirements includes must be repository-relative .txt files");
    const bytes = readBoundedRegularFile(safePath(root, path), 100_000, "Python requirements");
    sources.set(path, bytes);
    visiting.add(path);
    for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const include = /^-r\s+([A-Za-z0-9_./-]+\.txt)$/.exec(line);
      if (include) {
        if (posix.isAbsolute(include[1]!)) throw new Error("requirements include must be relative");
        read(posix.join(dirname(path), include[1]!));
        continue;
      }
      const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9_.,-]+\])?==([0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc|\.post|\.dev)[0-9]+)?)$/.exec(line);
      if (!pin) throw new Error(`Python dependencies require exact name==version pins; unsupported entry in ${path}`);
      const name = canonicalName(pin[1]!);
      const version = pin[3]!;
      if (versions.has(name) && versions.get(name) !== version) throw new Error(`conflicting Python dependency pins: ${name}`);
      versions.set(name, version);
      pins.add(`${name}${pin[2] ?? ""}==${version}`);
      if (pins.size > 1000) throw new Error("too many Python dependencies");
    }
    visiting.delete(path);
  };
  read(file);
  if (!/^[89]\./.test(versions.get("pytest") ?? "")) throw new Error("Python projects must pin pytest 8 or 9 in requirements-test.txt or requirements.txt");
  const hash = createHash("sha256");
  for (const [path, bytes] of [...sources].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update("\0").update(bytes).update("\0");
  return { file, hash: hash.digest("hex"), content: [...pins].sort().join("\n") + "\n", versions };
}

function runtimeFromReport(report: unknown, requirements: PythonRequirements, image: string): PytestRuntime {
  const data = report as {
    version?: string; pip_version?: string; environment?: { python_full_version?: string };
    install?: Array<{ metadata?: { name?: string; version?: string }; download_info?: { url?: string; archive_info?: { hashes?: { sha256?: string } } } }>;
  } | null;
  if (data?.version !== "1" || !/^\d+(?:\.\d+)+$/.test(data.pip_version ?? "") ||
      !/^3\.11\.\d+$/.test(data.environment?.python_full_version ?? "") || !Array.isArray(data.install) || !data.install.length || data.install.length > 1000) {
    throw new Error("invalid pip installation report or unsupported Python runtime (requires 3.11)");
  }
  const dependencies: PytestRuntime["dependencies"] = [];
  const installed = new Map<string, string>();
  for (const entry of data.install) {
    const name = canonicalName(entry?.metadata?.name ?? "");
    const version = entry?.metadata?.version;
    const sha256 = entry?.download_info?.archive_info?.hashes?.sha256;
    const url = new URL(entry?.download_info?.url ?? "invalid:");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !version || version.length > 100 || installed.has(name) ||
        !/^[a-f0-9]{64}$/.test(sha256 ?? "") || url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" ||
        url.username || url.password || url.port || !url.pathname.endsWith(".whl")) {
      throw new Error("Python setup must resolve unique, hash-recorded PyPI wheels");
    }
    installed.set(name, version);
    dependencies.push({ name, version, sha256: sha256! });
  }
  for (const [name, version] of requirements.versions) {
    if (installed.get(name) !== version) throw new Error(`installed dependency does not match pinned requirement: ${name}`);
  }
  return {
    adapter: "pytest", repositoryConfig: "disabled", conftest: "immutable", image,
    requirementsFile: requirements.file, requirementsHash: requirements.hash,
    packageManager: `pip@${data.pip_version}`, pythonVersion: data.environment!.python_full_version!,
    pytestVersion: installed.get("pytest")!, dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
    testEnvironment: { ...TEST_ENVIRONMENT },
  };
}

export class PythonProjectRunner implements ProjectTestRunner {
  private readonly session: DockerSession;
  private readonly image: string;
  private root?: string;
  private workspace?: LocalWorkspace;
  private runtimeData?: PytestRuntime;
  constructor(opts: { image?: string; invoke?: DockerInvoker } = {}) {
    this.session = new DockerSession(opts.invoke);
    this.image = opts.image ?? DEFAULT_PYTHON_IMAGE;
  }
  get runtime(): PytestRuntime | undefined { return this.runtimeData ? structuredClone(this.runtimeData) : undefined; }

  async prepare(workspace: LocalWorkspace, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this.root) throw new Error("runner already prepared");
    opts.signal?.throwIfAborted();
    const requirements = readPythonRequirements(workspace.baselineDir);
    this.root = mkdtempSync(join(tmpdir(), "vouch-python-"));
    this.workspace = workspace;
    const setup = join(this.root, "setup");
    const tools = join(this.root, "tools");
    mkdirSync(setup);
    mkdirSync(tools);
    writeFileSync(join(tools, "requirements.txt"), requirements.content);
    writeFileSync(join(tools, "run.py"), PYTEST_LAUNCHER);
    writeFileSync(join(tools, "pytest.ini"), "[pytest]\naddopts =\n");
    const storage = new AbortController();
    let storageExceeded = false;
    const checkStorage = () => {
      if (!exceedsDirectoryLimit(setup, 750_000_000, 100_000)) return;
      storageExceeded = true;
      storage.abort();
    };
    const monitor = setInterval(checkStorage, 1000);
    monitor.unref();
    let result: ExecResult;
    try {
      result = await this.session.run([
        "--network=bridge", "--mount", `type=bind,src=${setup},dst=/setup`,
        "--mount", `type=bind,src=${tools},dst=/vouch,readonly`, "--workdir=/tmp", this.image,
        "python", "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install",
        "--only-binary=:all:", "--ignore-installed", "--no-compile", "--no-cache-dir",
        "--index-url", "https://pypi.org/simple", "--target", "/setup/deps",
        "--report", "/setup/install.json", "-r", "/vouch/requirements.txt",
      ], { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal ? AbortSignal.any([opts.signal, storage.signal]) : storage.signal });
      checkStorage();
    } finally { clearInterval(monitor); }
    if (storageExceeded) throw new Error("dependency setup exceeded the 750 MB / 100000 entry limit");
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
      throw new Error(`Python dependency setup ${result.cancelled ? "cancelled" : result.timedOut ? "timed out" : "failed"}: ${result.stderr.slice(-4000)}`);
    }
    const report = JSON.parse(readBoundedRegularFile(join(setup, "install.json"), MAX_METADATA_BYTES, "pip installation report").toString("utf8"));
    this.runtimeData = runtimeFromReport(report, requirements, this.image);
    if (!existsSync(join(setup, "deps", "pytest", "__init__.py"))) throw new Error("dependency setup did not install pytest");
  }

  async runTests(dir: string, selection: TestSelection, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<StructuredTestResult> {
    if (!this.root || !this.workspace || !this.runtimeData) throw new Error("prepare the project runner before running tests");
    if (![this.workspace.dir, this.workspace.baselineDir, this.workspace.verificationDir].includes(resolve(dir))) throw new Error("test directory is outside the prepared workspace");
    let runDir = dir;
    let functionalSnapshot: string | undefined;
    if (selection === "functional") {
      functionalSnapshot = mkdtempSync(join(this.root, "functional-"));
      cpSync(dir, functionalSnapshot, { recursive: true });
      rmSync(join(functionalSnapshot, this.workspace.regressionPath), { force: true });
      runDir = functionalSnapshot;
    }
    let result: ExecResult;
    try {
      result = await this.session.run([
        "--network=none", "--mount", `type=bind,src=${runDir},dst=/repo,readonly`,
        "--mount", `type=bind,src=${join(this.root, "setup", "deps")},dst=/deps,readonly`,
        "--mount", `type=bind,src=${join(this.root, "tools")},dst=/vouch,readonly`,
        ...Object.entries(TEST_ENVIRONMENT).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        "--workdir=/repo", this.image, "python", "-I", "-B", "/vouch/run.py", selection, this.workspace.regressionPath,
      ], opts, 3_000_000);
    } finally { if (functionalSnapshot) rmSync(functionalSnapshot, { recursive: true, force: true }); }
    let evidence: unknown;
    let execution = result;
    try {
      const index = result.stdout.lastIndexOf(PYTEST_EVIDENCE_MARKER);
      if (index < 0) throw new Error("missing pytest evidence");
      const encoded = result.stdout.slice(index + PYTEST_EVIDENCE_MARKER.length).trim();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_METADATA_BYTES / 3) * 4 + 4) throw new Error("invalid pytest evidence encoding");
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > MAX_METADATA_BYTES) throw new Error("oversized pytest evidence");
      evidence = JSON.parse(decoded.toString("utf8"));
      execution = { ...result, stdout: result.stdout.slice(0, index).trimEnd() };
    } catch { /* Missing or malformed evidence cannot pass verification. */ }
    return classifyPytestEvidence(evidence, execution, selection, this.workspace.regressionPath);
  }

  async cleanup(): Promise<void> {
    await this.session.cleanup();
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
    this.workspace = undefined;
    this.runtimeData = undefined;
  }
}

export function createProjectTestRunner(workspace: LocalWorkspace): ProjectTestRunner {
  return workspace.regressionPath.endsWith(".py") ? new PythonProjectRunner() : new DockerProjectRunner();
}
