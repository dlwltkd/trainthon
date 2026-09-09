import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyVitestEvidence, DockerProjectRunner, type VitestEvidence } from "./docker-project.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import type { LocalWorkspace } from "./local-workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const success: ExecResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const failing: ExecResult = { ...success, exitCode: 1 };
function evidence(state: string, errorName = "AssertionError"): VitestEvidence {
  return { version: 1, files: [{ path: "/repo/regression.test.ts", task: { type: "suite", result: { state }, tasks: [{ type: "test", mode: "run", result: { state, errors: state === "fail" ? [{ name: errorName, message: "expected 1 to be 2", stack: "AssertionError: expected 1 to be 2\n at /repo/node_modules/@vitest/expect/index.js:1:1" }] : [] } }] } }], errors: [] };
}
const npmLock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/vitest": { version: "5.0.0", resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.0.tgz", integrity: "sha512-AAAA" },
    "node_modules/vite": { version: "8.0.0", resolved: "https://registry.npmjs.org/vite/-/vite-8.0.0.tgz", integrity: "sha512-BBBB" },
  },
});
const pnpmLock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: 5.0.0\n        version: 5.0.0\n\npackages:\n\n  vite@8.0.0:\n    resolution: {integrity: sha512-BBBB}\n\n  vitest@5.0.0:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  vite@8.0.0: {}\n\n  vitest@5.0.0:\n    dependencies:\n      vite: 8.0.0\n";

describe("structured Vitest evidence", () => {
  test("requires assertion evidence and an agreeing process exit", () => {
    expect(classifyVitestEvidence(evidence("fail"), failing, "regression", "regression.test.ts").status).toBe("assertion_failed");
    expect(classifyVitestEvidence(evidence("fail"), success, "regression", "regression.test.ts").status).toBe("invalid");
    expect(classifyVitestEvidence(evidence("pass"), success, "regression", "regression.test.ts").status).toBe("passed");
    expect(classifyVitestEvidence(evidence("fail", "TypeError"), failing, "regression", "regression.test.ts").status).toBe("invalid");
    const spoofed = evidence("fail"); spoofed.files[0]!.task.tasks![0]!.result!.errors![0]!.stack = "AssertionError: fake\n at /repo/regression.test.ts:1:1";
    expect(classifyVitestEvidence(spoofed, failing, "regression", "regression.test.ts").status).toBe("invalid");
    expect(classifyVitestEvidence(evidence("fail"), failing, "regression", "regression.test.ts").output).toContain("expected 1 to be 2");
    expect(classifyVitestEvidence(evidence("pass"), success, "regression", "regression.test.ts").output).toContain("1 passed");
  });
  test("rejects skipped, empty, wrong-selection, import and hook failures", () => {
    expect(classifyVitestEvidence(evidence("skip"), success, "regression", "regression.test.ts").status).toBe("invalid");
    const empty: VitestEvidence = { version: 1, files: [], errors: [] };
    expect(classifyVitestEvidence(empty, success, "functional", "regression.test.ts").status).toBe("invalid");
    expect(classifyVitestEvidence(evidence("pass"), success, "functional", "regression.test.ts").status).toBe("invalid");
    const imported = evidence("fail"); imported.files[0]!.task.result!.errors = [{ name: "SyntaxError" }];
    expect(classifyVitestEvidence(imported, failing, "regression", "regression.test.ts").status).toBe("invalid");
    const hook = evidence("fail"); hook.files[0]!.task.tasks![0]!.result!.hooks = { beforeEach: "run" };
    expect(classifyVitestEvidence(hook, failing, "regression", "regression.test.ts").reason).toContain("hook");
  });
  test("treats runner crashes, unhandled errors, cancellation and timeout distinctly", () => {
    expect(classifyVitestEvidence(undefined, failing, "regression", "regression.test.ts").status).toBe("error");
    const unhandled = evidence("pass"); unhandled.errors.push({ name: "Error" });
    expect(classifyVitestEvidence(unhandled, failing, "regression", "regression.test.ts").status).toBe("error");
    expect(classifyVitestEvidence(evidence("pass"), { ...success, cancelled: true }, "regression", "regression.test.ts").status).toBe("cancelled");
    expect(classifyVitestEvidence(evidence("pass"), { ...success, timedOut: true }, "regression", "regression.test.ts").status).toBe("timeout");
  });
});

test("Docker project runner mounts only isolated data and disables networking for tests", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-docker-test-")); roots.push(root);
  const baselineDir = join(root, "baseline"); mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, "package.json"), '{"devDependencies":{"vitest":"^5.0.0"}}'); writeFileSync(join(baselineDir, "package-lock.json"), npmLock);
  const workspace: LocalWorkspace = { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"), commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "regression.test.ts", regressionHash: "x", cleanup() {} };
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const sentinel = "test-sentinel-do-not-forward"; process.env.VOUCH_SANDBOX_TEST_SECRET = sentinel;
  const runner = new DockerProjectRunner({ invoke: async (cmd, args, opts) => {
    expect(cmd).toBe("docker"); calls.push({ args, opts });
    if (args.at(-2) === "npm" && args.at(-1) === "--version") return { ...success, stdout: "10.9.8\n" };
    if (args.includes("--network=bridge")) {
      const mount = args.find(arg => arg.startsWith("type=bind,src=") && arg.endsWith(",dst=/repo"))!;
      const setup = mount.slice("type=bind,src=".length, -",dst=/repo".length);
      mkdirSync(join(setup, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(setup, "node_modules", "vitest", "vitest.mjs"), "");
      writeFileSync(join(setup, "node_modules", "vitest", "package.json"), '{"name":"vitest","version":"5.0.0"}');
      mkdirSync(join(setup, "node_modules", "vite"), { recursive: true });
      writeFileSync(join(setup, "node_modules", "vite", "package.json"), '{"name":"vite","version":"8.0.0"}');
    }
    if (args.includes("/vouch/run.mjs")) return { ...success, stdout: `__VOUCH_EVIDENCE_V1__${Buffer.from(JSON.stringify(evidence("pass"))).toString("base64")}\n` };
    return success;
  } });
  try {
    await runner.prepare(workspace);
    const result = await runner.runTests(baselineDir, "regression", { timeoutMs: 1000 }); expect(result.status).toBe("passed");
    const run = calls.find(call => call.args.includes("/vouch/run.mjs"))!;
    expect(run.args).toContain("--cap-drop=ALL"); expect(run.args).toContain("--read-only"); expect(run.args).toContain("--pids-limit=128");
    expect(run.args).toContain("--log-driver=local");
    expect(run.args).toContain("compress=false");
    expect(run.args).toContain(`type=bind,src=${baselineDir},dst=/repo,readonly`);
    expect(run.args.some(arg => arg.includes("dst=/evidence"))).toBe(false);
    const toolsMount = run.args.find(arg => arg.startsWith("type=bind,src=") && arg.endsWith(",dst=/vouch,readonly"))!;
    const toolsDir = toolsMount.slice("type=bind,src=".length, -",dst=/vouch,readonly".length);
    const launcher = readFileSync(join(toolsDir, "run.mjs"), "utf8");
    expect(launcher).toContain("config:false");
    expect(launcher).toContain("configFile:false");
    expect(launcher).toContain("postcss:{plugins:[]}");
    expect(run.opts.maxOutputBytes).toBe(3_000_000);
    expect(run.args.join(" ")).not.toContain("docker.sock");
    expect(JSON.stringify(calls)).not.toContain(sentinel);
    expect(calls.some(call => call.args.includes("--ignore-scripts"))).toBe(true);
    expect(runner.runtime?.packageManager).toBe("npm@10.9.8");
    expect(runner.runtime?.repositoryConfig).toBe("disabled");
    expect(calls.filter(call => call.args[0] === "rm")).toHaveLength(3);
  } finally { delete process.env.VOUCH_SANDBOX_TEST_SECRET; await runner.cleanup(); }
});

test("Docker project runner rejects a declared npm version that differs from the pinned image", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-docker-npm-version-")); roots.push(root);
  const baselineDir = join(root, "baseline"); mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, "package.json"), '{"packageManager":"npm@11.0.0","devDependencies":{"vitest":"5.0.0"}}');
  writeFileSync(join(baselineDir, "package-lock.json"), npmLock);
  const workspace: LocalWorkspace = { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"), commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "regression.test.ts", regressionHash: "x", cleanup() {} };
  const runner = new DockerProjectRunner({ invoke: async (_cmd, args) => args.at(-2) === "npm" && args.at(-1) === "--version" ? { ...success, stdout: "10.9.8\n" } : success });
  await expect(runner.prepare(workspace)).rejects.toThrow("runtime image provides npm@10.9.8");
  await runner.cleanup();
});

test("pnpm setup ignores repository pnpm hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-docker-pnpm-")); roots.push(root);
  const baselineDir = join(root, "baseline"); mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, "package.json"), '{"packageManager":"pnpm@10.33.3","devDependencies":{"vitest":"5.0.0"}}');
  writeFileSync(join(baselineDir, "pnpm-lock.yaml"), pnpmLock);
  const workspace: LocalWorkspace = { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"), commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "regression.test.ts", regressionHash: "x", cleanup() {} };
  let installArgs: string[] = [];
  const runner = new DockerProjectRunner({ invoke: async (_cmd, args) => {
    if (args.includes("--network=bridge")) {
      installArgs = args;
      const mount = args.find(arg => arg.startsWith("type=bind,src=") && arg.endsWith(",dst=/repo"))!;
      const setup = mount.slice("type=bind,src=".length, -",dst=/repo".length);
      mkdirSync(join(setup, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(setup, "node_modules", "vitest", "vitest.mjs"), "");
      writeFileSync(join(setup, "node_modules", "vitest", "package.json"), '{"name":"vitest","version":"5.0.0"}');
      mkdirSync(join(setup, "node_modules", "vite"), { recursive: true });
      writeFileSync(join(setup, "node_modules", "vite", "package.json"), '{"name":"vite","version":"8.0.0"}');
    }
    return success;
  } });
  await runner.prepare(workspace);
  expect(installArgs).toContain("--ignore-pnpmfile");
  expect(installArgs).toContain("--ignore-scripts");
  await runner.cleanup();
});

test("pnpm setup binds runner provenance to the root importer", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-docker-pnpm-alias-")); roots.push(root);
  const baselineDir = join(root, "baseline"); mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, "package.json"), '{"packageManager":"pnpm@10.33.3","devDependencies":{"vitest":"npm:attacker-package@5.0.0"}}');
  writeFileSync(join(baselineDir, "pnpm-lock.yaml"), pnpmLock.replace("specifier: 5.0.0", "specifier: npm:attacker-package@5.0.0"));
  const workspace: LocalWorkspace = { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"), commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "regression.test.ts", regressionHash: "x", cleanup() {} };
  const runner = new DockerProjectRunner({ invoke: async () => success });
  await expect(runner.prepare(workspace)).rejects.toThrow("root pnpm importer");
});

test("project runner rejects Vitest 3", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-docker-vitest3-")); roots.push(root);
  const baselineDir = join(root, "baseline"); mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, "package.json"), '{"packageManager":"pnpm@10.33.3","devDependencies":{"vitest":"3.2.4"}}');
  writeFileSync(join(baselineDir, "pnpm-lock.yaml"), pnpmLock.replaceAll("5.0.0", "3.2.4"));
  const workspace: LocalWorkspace = { dir: join(root, "candidate"), baselineDir, verificationDir: join(root, "verification"), commit: "0".repeat(40), files: [], protectedPaths: [], regressionPath: "regression.test.ts", regressionHash: "x", cleanup() {} };
  const runner = new DockerProjectRunner({ invoke: async () => success });
  await expect(runner.prepare(workspace)).rejects.toThrow("Vitest 4 or 5");
});
