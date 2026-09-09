import { afterEach, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { applyLocalPatch, captureLocalChanges, createVerificationWorkspace, prepareLocalWorkspace, writeLocalSource } from "./local-workspace.js";
import { listDirTool, readFileTool, writeFileTool } from "./fs-tools.js";
import { runCommand } from "./exec.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-workspace-test-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
  writeFileSync(join(repo, "src", "tool.js"), "#!/usr/bin/env node\n");
  chmodSync(join(repo, "src", "tool.js"), 0o755);
  writeFileSync(join(repo, "package.json"), '{"devDependencies":{"vitest":"^5.0.0"}}');
  writeFileSync(join(repo, "package-lock.json"), "{}");
  writeFileSync(join(repo, ".env"), "SENTINEL=hidden");
  writeFileSync(join(repo, ".ENV"), "SENTINEL=hidden");
  writeFileSync(join(repo, ".npmrc"), "//registry.example/:_authToken=SENTINEL");
  writeFileSync(join(repo, ".pnpmfile.cjs"), "throw new Error('must not run')");
  mkdirSync(join(repo, ".secrets"));
  writeFileSync(join(repo, ".secrets", "token"), "SENTINEL=hidden");
  writeFileSync(join(repo, "private.key"), "SENTINEL=hidden");
  writeFileSync(join(repo, "vitest.config.ts"), "export default { test: { setupFiles: ['./bootstrap.ts'] } };\n");
  writeFileSync(join(repo, "bootstrap.ts"), "import './config-helper';\nexport {};\n");
  writeFileSync(join(repo, "config-helper.cts"), "export {};\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "baseline");
  writeFileSync(join(repo, "regression.test.ts"), "// supplied test\n");
  return { root, repo, git, prepare: () => prepareLocalWorkspace({ repoPath: repo, regressionPath: "regression.test.ts", workspacesDir: join(root, "runs") }) };
}

describe("committed repository workspace", () => {
  test("snapshots HEAD, overlays only the supplied regression, and hides credentials", async () => {
    const f = fixture();
    writeFileSync(join(f.repo, "src", "sum.ts"), "uncommitted edit\n");
    const workspace = await f.prepare();
    expect(readFileSync(join(workspace.dir, "src", "sum.ts"), "utf8")).toContain("a - b");
    expect(readFileSync(join(workspace.dir, workspace.regressionPath), "utf8")).toBe("// supplied test\n");
    for (const hidden of [".env", ".ENV", ".npmrc", ".pnpmfile.cjs", ".secrets/token", "private.key"]) {
      expect(workspace.files).not.toContain(hidden);
    }
    expect(workspace.protectedPaths).toContain("config-helper.cts");
    expect(workspace.regressionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(workspace.dir, "src", "tool.js")).mode & 0o111).toBe(0o111);
    workspace.cleanup();
    expect(readFileSync(join(f.repo, "src", "sum.ts"), "utf8")).toBe("uncommitted edit\n");
  });

  test("reconstructs fresh verification from protected originals and candidate source", async () => {
    const f = fixture(); const workspace = await f.prepare();
    const fixed = "export const sum = (a: number, b: number) => a + b;\n";
    writeLocalSource(workspace, "src/sum.ts", fixed);
    writeFileSync(join(workspace.baselineDir, "regression.test.ts"), "tampered copy\n");
    const verified = await createVerificationWorkspace(workspace);
    expect(readFileSync(join(verified, "src/sum.ts"), "utf8")).toBe(fixed);
    expect(readFileSync(join(verified, "regression.test.ts"), "utf8")).toBe("// supplied test\n");
    const diff = await captureLocalChanges(workspace);
    expect(diff.changedFiles).toEqual(["src/sum.ts"]);
    expect(diff.patch).toContain("a + b");
    expect(diff.lineCount).toBe(2);
  });

  test("rejects protected edits and source symlinks before verification", async () => {
    const f = fixture(); const workspace = await f.prepare();
    for (const path of ["package.json", "regression.test.ts", "vitest.config.ts", "config-helper.cts", "../outside.ts", ".env"]) expect(() => writeLocalSource(workspace, path, "bad")).toThrow();
    writeFileSync(join(workspace.dir, "regression.test.ts"), "tampered\n");
    await expect(createVerificationWorkspace(workspace)).rejects.toThrow("protected file changed");
    writeFileSync(join(workspace.dir, "regression.test.ts"), "// supplied test\n");
    symlinkSync(join(f.repo, "src", "sum.ts"), join(workspace.dir, "src", "linked.ts"));
    await expect(captureLocalChanges(workspace)).rejects.toThrow("unsupported workspace entry");
  });

  test("applies exported source patches and rejects protected patches without mutation", async () => {
    const f = fixture(); const first = await f.prepare();
    writeLocalSource(first, "src/sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
    const patch = join(f.root, "change.patch"); writeFileSync(patch, (await captureLocalChanges(first)).patch);
    const second = await f.prepare(); await applyLocalPatch(second, patch);
    expect(readFileSync(join(second.dir, "src/sum.ts"), "utf8")).toContain("a + b");
    writeFileSync(patch, "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{}\n");
    await expect(applyLocalPatch(second, patch)).rejects.toThrow("protected path");
    const aborted = new AbortController(); aborted.abort();
    await expect(applyLocalPatch(second, patch, { signal: aborted.signal })).rejects.toThrow();
  });

  test("rejects symlinks in committed code and supplied regression paths", async () => {
    const f = fixture(); symlinkSync("/tmp", join(f.repo, "link")); f.git("add", "link"); f.git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "link");
    await expect(f.prepare()).rejects.toThrow("symlinks and submodules");
    await expect(prepareLocalWorkspace({ repoPath: f.repo, regressionPath: "../test.ts", workspacesDir: join(f.root, "runs") })).rejects.toThrow("repository-relative");
  });

  test("rejects an oversized supplied regression before reading it", async () => {
    const f = fixture();
    truncateSync(join(f.repo, "regression.test.ts"), 2_000_001);
    await expect(f.prepare()).rejects.toThrow("regression exceeds 2000000 byte limit");
  });

});

test("harness-owned Vitest options ignore computed config dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-config-bypass-")); roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"type":"module","devDependencies":{"vitest":"5.0.0"}}\n');
  writeFileSync(join(root, "src", "safe.js"), "export const isSafe = () => false;\n");
  writeFileSync(join(root, "regression.test.js"), "import { expect, test } from 'vitest'; import { isSafe } from './src/safe.js'; test('safe', () => expect(isSafe()).toBe(true));\n");
  writeFileSync(join(root, "src", "plugin.cjs"), "module.exports={name:'bypass',enforce:'pre',transform(code,id){if(id.endsWith('regression.test.js'))return code.replace('expect(isSafe()).toBe(true)','expect(true).toBe(true)')}};\n");
  writeFileSync(join(root, "vitest.config.js"), "import { createRequire } from 'node:module'; const req=createRequire(import.meta.url); const plugin=req('./src/'+'plugin.cjs'); export default { plugins:[plugin] };\n");
  const vitestNode = pathToFileURL(createRequire(import.meta.url).resolve("vitest/node")).href;
  const launcher = join(root, "launch.mjs");
  writeFileSync(launcher, `import { startVitest } from ${JSON.stringify(vitestNode)};
const root=process.argv[2]; const config=process.argv[3] === 'disabled' ? false : undefined;
const ctx=await startVitest('test',['regression.test.js'],{root,config,run:true,watch:false,pool:'forks',fileParallelism:false,maxWorkers:1});
await ctx?.close(); process.exit(process.exitCode ?? 0);
`);
  const enabled = spawnSync(process.execPath, [launcher, root, "enabled"], { encoding: "utf8", timeout: 15_000 });
  const disabled = spawnSync(process.execPath, [launcher, root, "disabled"], { encoding: "utf8", timeout: 15_000 });
  expect(enabled.status, enabled.stderr).toBe(0);
  expect(disabled.status).toBe(1);
  expect(`${disabled.stdout}\n${disabled.stderr}`).toContain("expected false to be true");
});

test("file tools cannot access symlinks or hidden credentials", () => {
  const f = fixture();
  symlinkSync(join(f.repo, ".env"), join(f.repo, "public.txt"));
  symlinkSync(join(f.root, "missing"), join(f.repo, "dangling.ts"));
  expect(() => readFileTool(f.repo, "public.txt")).toThrow("symlink");
  expect(() => readFileTool(f.repo, ".env")).toThrow();
  expect(() => writeFileTool(f.repo, "dangling.ts", "oops")).toThrow("symlink");
  expect(listDirTool(f.repo)).not.toContain("public.txt");
  expect(existsSync(join(f.root, "missing"))).toBe(false);
});

test("command execution bounds output and handles pre-cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-process-test-")); roots.push(root);
  const output = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));"], { cwd: root, timeoutMs: 2000, maxOutputBytes: 1000 });
  expect(output.exitCode).toBe(0); expect(output.stdout.length).toBe(1000);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runCommand(process.execPath, ["-e", "throw new Error('must not run');"], { cwd: root, timeoutMs: 2000, signal: controller.signal });
  expect(cancelled.cancelled).toBe(true); expect(cancelled.stdout).toBe("");
});

test("command cancellation kills the process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "vouch-cancel-test-")); roots.push(root);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  const result = await runCommand(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);"], { cwd: root, timeoutMs: 2000, signal: controller.signal });
  clearTimeout(timer); expect(result.cancelled).toBe(true); expect(result.timedOut).toBe(false);
});
