import { afterEach, describe, expect, test } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PythonProjectRunner, createProjectTestRunner, readPythonRequirements } from "./python-project.js";
import { DockerProjectRunner, type DockerInvoker } from "./docker-project.js";
import { classifyPytestEvidence, PYTEST_EVIDENCE_MARKER, type PytestEvidence } from "./pytest-evidence.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import type { LocalWorkspace } from "./local-workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const success: ExecResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
function fixture(): LocalWorkspace {
  const root = mkdtempSync(join(tmpdir(), "vouch-pytest-test-")); roots.push(root);
  const baselineDir = join(root, "baseline");
  mkdirSync(join(baselineDir, "tests"), { recursive: true });
  writeFileSync(join(baselineDir, "requirements-test.txt"), "pytest==9.1.1\n");
  writeFileSync(join(baselineDir, "tests", "test_regression.py"), "def test_sum(): assert 1 + 1 == 2\n");
  return { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"),
    commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "tests/test_regression.py", regressionHash: "x", cleanup() {} };
}
function evidence(outcome: "passed" | "failed" | "skipped" = "passed"): PytestEvidence {
  const nodeid = "tests/test_regression.py::test_sum";
  return { version: 1, collected: [{ nodeid, file: "tests/test_regression.py" }], errors: [], reports: [
    { nodeid, when: "setup", outcome: "passed", assertion: false, expectedFailure: false },
    { nodeid, when: "call", outcome, assertion: outcome === "failed", expectedFailure: false },
    { nodeid, when: "teardown", outcome: "passed", assertion: false, expectedFailure: false },
  ] };
}
const classify = (report: unknown, result: ExecResult = success) => classifyPytestEvidence(report, result, "regression", "tests/test_regression.py");

describe("pytest evidence", () => {
  test("accepts completed assertions with matching process exits", () => {
    expect(classify(evidence()).status).toBe("passed");
    expect(classify(evidence("failed"), { ...success, exitCode: 1 }).status).toBe("assertion_failed");
    expect(classify(evidence("failed")).status).toBe("invalid");
    expect(classify(evidence(), { ...success, exitCode: 3 }).status).toBe("error");
  });
  test("distinguishes collection, setup, teardown and application exceptions from assertions", () => {
    const collection = evidence(); collection.errors.push("import failed");
    expect(classify(collection).status).toBe("error");
    for (const phase of [0, 2]) {
      const report = evidence("failed"); report.reports[phase]!.outcome = "failed";
      expect(classify(report, { ...success, exitCode: 1 }).reason).toContain("setup or teardown");
    }
    const exception = evidence("failed"); exception.reports[1]!.assertion = false;
    expect(classify(exception, { ...success, exitCode: 1 }).reason).toContain("not an assertion");
  });
  test("rejects missing, duplicate, skipped, wrong-selection and unfinished evidence", () => {
    expect(classify(undefined).status).toBe("error");
    expect(classify(evidence("skipped")).passed).toBe(false);
    const xfail = evidence(); xfail.reports[1]!.expectedFailure = true;
    expect(classify(xfail).passed).toBe(false);
    const missing = evidence(); missing.reports.pop();
    expect(classify(missing).reason).toContain("did not finish");
    const duplicate = evidence(); duplicate.reports.push(duplicate.reports[0]!);
    expect(classify(duplicate).reason).toContain("duplicated");
    const duplicateItem = evidence(); duplicateItem.collected.push(duplicateItem.collected[0]!);
    expect(classify(duplicateItem).reason).toContain("duplicate");
    const outside = evidence(); outside.collected[0]!.file = "../test.py";
    expect(classify(outside).status).toBe("invalid");
    expect(classifyPytestEvidence(evidence(), success, "functional", "tests/test_regression.py").status).toBe("invalid");
    const unknown = evidence(); unknown.reports[0]!.nodeid = "missing::test";
    expect(classify(unknown).status).toBe("invalid");
    expect(classify({ version: 1, collected: [], reports: [], errors: [] }).passed).toBe(false);
    expect(classify(undefined, { ...success, timedOut: true }).status).toBe("timeout");
    expect(classify(undefined, { ...success, cancelled: true }).status).toBe("cancelled");
  });
  test("retains functional skips in the test manifest", () => {
    const report = evidence();
    const skip = evidence("skipped");
    skip.collected[0]!.nodeid += "_optional";
    for (const phase of skip.reports) phase.nodeid += "_optional";
    report.collected.push(...skip.collected); report.reports.push(...skip.reports);
    const result = classifyPytestEvidence(report, success, "functional", "tests/other.py");
    expect(result).toMatchObject({ status: "passed", testsPassed: 1, testsSkipped: 1 });
    expect(result.testManifest).toContain("tests/test_regression.py::test_sum_optional#skipped");
    expect(classify(report).reason).toContain("skipped");
  });
});

test("requirements flatten relative includes and retain a hash of all source pins", () => {
  const workspace = fixture();
  writeFileSync(join(workspace.baselineDir, "requirements.txt"), "httpx==0.28.1\n");
  writeFileSync(join(workspace.baselineDir, "requirements-test.txt"), "-r requirements.txt\npytest==9.1.1 # runner\n");
  const first = readPythonRequirements(workspace.baselineDir);
  expect(first.content).toBe("httpx==0.28.1\npytest==9.1.1\n");
  writeFileSync(join(workspace.baselineDir, "requirements.txt"), "httpx==0.28.1\n# changed input\n");
  expect(readPythonRequirements(workspace.baselineDir).hash).not.toBe(first.hash);
  expect(createProjectTestRunner(workspace)).toBeInstanceOf(PythonProjectRunner);
  expect(createProjectTestRunner({ ...workspace, regressionPath: "test.ts" })).toBeInstanceOf(DockerProjectRunner);
});

test("requirements reject unpinned, remote, editable, conflicting and cyclic inputs before Docker", () => {
  const workspace = fixture();
  for (const entry of ["pytest>=9", "pytest==9.*", "--extra-index-url https://example.com", "-e .", "pkg @ https://example.com/pkg.whl", "-r ../outside.txt", "-r /tmp/outside.txt", "pytest==9.1.0\npytest==9.1.1", "-r requirements-test.txt"]) {
    writeFileSync(join(workspace.baselineDir, "requirements-test.txt"), entry);
    expect(() => readPythonRequirements(workspace.baselineDir)).toThrow();
  }
});

function installReport() {
  return { version: "1", pip_version: "25.1.1", environment: { python_full_version: "3.11.15" }, install: [
    { metadata: { name: "pytest", version: "9.1.1" }, download_info: {
      url: "https://files.pythonhosted.org/packages/pytest-9.1.1-py3-none-any.whl", archive_info: { hashes: { sha256: "a".repeat(64) } },
    } },
  ] };
}

function fakeDocker(calls: Array<{ args: string[]; opts: ExecOptions }>, report = installReport()): DockerInvoker {
  return async (_cmd, args, opts) => {
    calls.push({ args, opts });
    if (args.includes("--network=bridge")) {
      const mount = args.find(arg => arg.endsWith(",dst=/setup"))!;
      const setup = mount.slice("type=bind,src=".length, -",dst=/setup".length);
      mkdirSync(join(setup, "deps", "pytest"), { recursive: true });
      writeFileSync(join(setup, "deps", "pytest", "__init__.py"), "");
      writeFileSync(join(setup, "install.json"), JSON.stringify(report));
    }
    if (args.includes("/vouch/run.py")) {
      return { ...success, stdout: `${PYTEST_EVIDENCE_MARKER}${Buffer.from(JSON.stringify(evidence())).toString("base64")}\n` };
    }
    return success;
  };
}

test("Docker installs only wheels without repository code and runs pytest with isolated read-only mounts", async () => {
  const workspace = fixture();
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const runner = new PythonProjectRunner({ invoke: fakeDocker(calls) });
  const sentinel = "python-test-secret-must-not-forward";
  process.env.VOUCH_PYTHON_TEST_SECRET = sentinel;
  try {
    await runner.prepare(workspace);
    expect((await runner.runTests(workspace.baselineDir, "regression", { timeoutMs: 1000 })).status).toBe("passed");
    const install = calls.find(call => call.args.includes("--network=bridge"))!;
    expect(install.args).toContain("--only-binary=:all:");
    expect(install.args).toContain("--isolated");
    expect(install.args.some(arg => arg.includes("dst=/repo"))).toBe(false);
    const run = calls.find(call => call.args.includes("/vouch/run.py"))!;
    for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "TESTING=1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1", "-I", "-B"]) expect(run.args).toContain(flag);
    expect(run.args).toContain(`type=bind,src=${workspace.baselineDir},dst=/repo,readonly`);
    expect(run.args.join(" ")).not.toContain("docker.sock");
    expect(run.opts.maxOutputBytes).toBe(3_000_000);
    expect(JSON.stringify(calls)).not.toContain(sentinel);
    expect(runner.runtime).toMatchObject({ adapter: "pytest", conftest: "immutable", packageManager: "pip@25.1.1", pytestVersion: "9.1.1" });
    expect(runner.runtime!.dependencies[0]!.sha256).toBe("a".repeat(64));
    await expect(runner.runTests("/tmp/outside", "regression", { timeoutMs: 1000 })).rejects.toThrow("outside");
    expect(calls.filter(call => call.args[0] === "rm")).toHaveLength(2);
  } finally { delete process.env.VOUCH_PYTHON_TEST_SECRET; await runner.cleanup(); }
});

test("Docker rejects dependency provenance that disagrees with requested pins", async () => {
  const workspace = fixture();
  const report = installReport(); report.install[0]!.metadata.version = "9.0.0";
  const runner = new PythonProjectRunner({ invoke: fakeDocker([], report) });
  try { await expect(runner.prepare(workspace)).rejects.toThrow("does not match pinned"); }
  finally { await runner.cleanup(); }
});

test("Docker cleanup retries a failed removal before deleting setup data", async () => {
  const workspace = fixture();
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const invoke = fakeDocker(calls);
  let removals = 0;
  const runner = new PythonProjectRunner({ invoke: async (cmd, args, opts) => {
    if (args[0] === "rm" && ++removals === 1) return { ...success, exitCode: 1 };
    return invoke(cmd, args, opts);
  } });
  await expect(runner.prepare(workspace)).rejects.toThrow("could not remove sandbox container");
  await runner.cleanup();
  expect(removals).toBe(2);
});

test.runIf(process.env.VOUCH_DOCKER_TESTS === "1")("real pytest distinguishes arithmetic assertions from import errors and excludes the regression from functional tests", async () => {
  const workspace = fixture();
  writeFileSync(join(workspace.baselineDir, "arithmetic.py"), "def add(a, b): return a - b\n");
  writeFileSync(join(workspace.baselineDir, "tests", "test_regression.py"), "from arithmetic import add\ndef test_sum(): assert add(2, 1) == 3\n");
  writeFileSync(join(workspace.baselineDir, "tests", "test_functional.py"), "from arithmetic import add\ndef test_zero(): assert add(0, 0) == 0\n");
  writeFileSync(join(workspace.baselineDir, "conftest.py"), "import os\nimport pytest\n@pytest.fixture(autouse=True)\ndef test_env(): assert os.environ['TESTING'] == '1'\n");
  writeFileSync(join(workspace.baselineDir, "pytest.ini"), "[pytest]\naddopts = --collect-only\n");
  cpSync(workspace.baselineDir, workspace.dir, { recursive: true });
  const runner = new PythonProjectRunner();
  try {
    await runner.prepare(workspace);
    const functional = await runner.runTests(workspace.baselineDir, "functional", { timeoutMs: 20_000 });
    expect(functional.status, functional.output).toBe("passed");
    expect(functional.collectedFiles).toEqual(["tests/test_functional.py"]);
    expect(existsSync(join(workspace.baselineDir, workspace.regressionPath))).toBe(true);
    const baseline = await runner.runTests(workspace.baselineDir, "regression", { timeoutMs: 20_000 });
    expect(baseline.status, baseline.output).toBe("assertion_failed");
    writeFileSync(join(workspace.dir, "arithmetic.py"), "def add(a, b): return a + b\n");
    const fixed = await runner.runTests(workspace.dir, "regression", { timeoutMs: 20_000 });
    expect(fixed.status, fixed.output).toBe("passed");
    expect(fixed.testManifest).toEqual(baseline.testManifest);
    writeFileSync(join(workspace.dir, "arithmetic.py"), "raise ImportError('arithmetic unavailable')\n");
    expect((await runner.runTests(workspace.dir, "regression", { timeoutMs: 20_000 })).status).toBe("error");
    expect(readFileSync(join(workspace.baselineDir, "arithmetic.py"), "utf8")).toContain("a - b");
  } finally { await runner.cleanup(); }
}, 180_000);
