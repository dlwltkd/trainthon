import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftPullRequest } from "./pull-request.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = "a".repeat(40);
const baseTree = "b".repeat(40);
const nextTree = "c".repeat(40);
const nextCommit = "d".repeat(40);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const blob = (content: string | Buffer) => { const bytes = Buffer.from(content); return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); };
const original = "export const add = (a, b) => a - b;\n";
const corrected = "export const add = (a, b) => a + b;\n";

function fixture(status = "PATCH_PROPOSED") {
  const runsDir = mkdtempSync(join(tmpdir(), "vouch-pr-test-"));
  roots.push(runsDir);
  const runId = "run-1";
  const runDir = join(runsDir, runId);
  for (const folder of ["source", "candidate"]) mkdirSync(join(runDir, folder, "src"), { recursive: true });
  writeFileSync(join(runDir, "source/src/add.js"), original);
  writeFileSync(join(runDir, "candidate/src/add.js"), corrected);
  const patch = "diff --git a/src/add.js b/src/add.js\n--- a/src/add.js\n+++ b/src/add.js\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n";
  writeFileSync(join(runDir, "patch.diff"), patch);
  const record = {
    runId, status, summary: "Correct the addition function to return the sum of both operands.",
    repository: { url: "https://github.com/example/calculator", commit: base, regressionPath: "tests/test_add.py" },
    artifacts: { patch: "/ignored/arbitrary/browser/path.diff" },
    verification: { scope: "repository_tests", regressionPassed: true, functionalPassed: true, regressionManifestMatched: true, functionalManifestMatched: true },
    changes: { files: ["src/add.js"] },
    delivery: { patchHash: hash(patch), files: [{ path: "src/add.js", sha256: hash(corrected), deleted: false }] },
  };
  const save = () => writeFileSync(join(runDir, "record.json"), JSON.stringify(record));
  save();
  return { runsDir, runDir, record, save };
}

function github(options: { push?: boolean; moved?: boolean; baselineHash?: string; mode?: string; failFirstPull?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown>; authorization: string | null }> = [];
  let branchExists = false;
  let pull: Record<string, unknown> | undefined;
  let pullAttempts = 0;
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("error");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/repos/example/calculator", "") + url.search;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, body, authorization: new Headers(init?.headers).get("Authorization") });
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET") {
      if (path === "") return response({ full_name: "example/calculator", private: false, default_branch: "main", permissions: { push: options.push ?? true } });
      if (path === "/git/ref/heads/main") return response({ object: { sha: options.moved ? "f".repeat(40) : base } });
      if (path === `/git/commits/${base}`) return response({ sha: base, tree: { sha: baseTree } });
      if (path === `/git/trees/${baseTree}?recursive=1`) return response({ tree: [{ path: "src/add.js", type: "blob", mode: options.mode ?? "100644", sha: options.baselineHash ?? blob(original) }], truncated: false });
      if (path.startsWith("/pulls?")) return response(pull ? [pull] : []);
      if (path === "/git/ref/heads/vouch%2Frun-1") return branchExists ? response({ object: { sha: nextCommit } }) : response({}, 404);
    } else {
      if (path === "/git/blobs") return response({ sha: blob(Buffer.from(String(body!.content), "base64")) }, 201);
      if (path === "/git/trees") return response({ sha: nextTree }, 201);
      if (path === "/git/commits") return response({ sha: nextCommit }, 201);
      if (path === "/git/refs") { branchExists = true; return response({ ref: body!.ref, object: { sha: body!.sha } }, 201); }
      if (path === "/pulls") {
        if (options.failFirstPull && ++pullAttempts === 1) return response({ message: "temporary failure" }, 503);
        pull = { html_url: "https://github.com/example/calculator/pull/7", number: 7, draft: true, body: body!.body, head: { sha: nextCommit } };
        return response(pull, 201);
      }
    }
    throw new Error(`unexpected mocked request ${method} ${path}`);
  });
  return { calls, transport: transport as typeof fetch };
}

describe("draft pull request delivery", () => {
  it("creates only a dedicated branch and explicit untested draft from verified candidate bytes", async () => {
    const f = fixture();
    const api = github();
    const result = await createDraftPullRequest(f.record, { runsDir: f.runsDir, token: "test-token", fetch: api.transport });
    expect(result).toEqual({ url: "https://github.com/example/calculator/pull/7", number: 7, branch: "vouch/run-1" });
    expect(api.calls.every(call => call.authorization === "Bearer test-token")).toBe(true);
    const writes = api.calls.filter(call => call.method === "POST");
    expect(writes.map(call => call.path)).toEqual(["/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/pulls"]);
    expect(writes[0]?.body).toEqual({ content: Buffer.from(corrected).toString("base64"), encoding: "base64" });
    expect(writes[1]?.body).toEqual({ base_tree: baseTree, tree: [{ path: "src/add.js", mode: "100644", type: "blob", sha: blob(corrected) }] });
    expect(writes[2]?.body).toMatchObject({ tree: nextTree, parents: [base] });
    expect(writes[3]?.body).toEqual({ ref: "refs/heads/vouch/run-1", sha: nextCommit });
    expect(writes[4]?.body).toMatchObject({ draft: true, head: "vouch/run-1", base: "main" });
    expect(String(writes[4]?.body?.body)).toContain("UNTESTED DRAFT");
    expect(String(writes[4]?.body?.body)).toContain(f.record.summary);
    expect(readFileSync(join(f.runDir, "pull-request.json"), "utf8")).not.toContain("test-token");
  });

  it("labels TESTS_PASSED with its actual verification scope and preserves executable source modes", async () => {
    const f = fixture("TESTS_PASSED");
    chmodSync(join(f.runDir, "source/src/add.js"), 0o755);
    chmodSync(join(f.runDir, "candidate/src/add.js"), 0o755);
    const api = github({ mode: "100755" });
    await createDraftPullRequest(f.record, { runsDir: f.runsDir, token: "test-token", fetch: api.transport });
    const tree = api.calls.find(call => call.path === "/git/trees" && call.method === "POST")!.body!;
    expect(tree.tree).toEqual([expect.objectContaining({ mode: "100755" })]);
    const body = String(api.calls.find(call => call.path === "/pulls" && call.method === "POST")?.body?.body);
    expect(body).toContain("fresh workspace with matching test inventories");
    expect(body).toContain("not independent security verification");
    expect(body).not.toContain("UNTESTED DRAFT");
  });

  it("coalesces concurrent clicks and reuses a successful artifact without another token or API call", async () => {
    const f = fixture();
    const api = github();
    const options = { runsDir: f.runsDir, token: "test-token", fetch: api.transport };
    const [first, second] = await Promise.all([createDraftPullRequest(f.record, options), createDraftPullRequest(f.record, options)]);
    expect(second).toEqual(first);
    const count = api.calls.length;
    expect(await createDraftPullRequest({ runId: f.record.runId }, { ...options, token: "" })).toEqual(first);
    expect(api.calls).toHaveLength(count);
    expect(api.calls.filter(call => call.path === "/pulls" && call.method === "POST")).toHaveLength(1);
  });

  it("resumes a recorded branch after PR creation fails without duplicating commits or refs", async () => {
    const f = fixture();
    const api = github({ failFirstPull: true });
    const options = { runsDir: f.runsDir, token: "test-token", fetch: api.transport };
    await expect(createDraftPullRequest(f.record, options)).rejects.toThrow("HTTP 503");
    expect(await createDraftPullRequest(f.record, options)).toMatchObject({ number: 7 });
    expect(api.calls.filter(call => call.path === "/git/commits" && call.method === "POST")).toHaveLength(1);
    expect(api.calls.filter(call => call.path === "/git/refs" && call.method === "POST")).toHaveLength(1);
  });

  it("checks permission, branch freshness and source provenance before any remote write", async () => {
    for (const config of [{ push: false }, { moved: true }, { baselineHash: "e".repeat(40) }]) {
      const f = fixture();
      const api = github(config);
      await expect(createDraftPullRequest(f.record, { runsDir: f.runsDir, token: "test-token", fetch: api.transport })).rejects.toThrow(/push access|default branch moved|source baseline/);
      expect(api.calls.some(call => call.method === "POST")).toBe(false);
    }
  });

  it("rejects missing dedicated token, altered artifacts, unsafe files and ineligible run statuses before API calls", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const missing = fixture();
    const api = github();
    await expect(createDraftPullRequest(missing.record, { runsDir: missing.runsDir, fetch: api.transport })).rejects.toThrow("Set GITHUB_TOKEN or GH_TOKEN");
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.record.status = "REVIEW_COMPLETE"; f.save(); },
      (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.runDir, "candidate/src/add.js"), "changed after review"); },
      (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.runDir, "patch.diff"), "changed patch"); },
      (f: ReturnType<typeof fixture>) => { f.record.changes.files = ["tests/check.py"]; f.save(); },
      (f: ReturnType<typeof fixture>) => { f.record.repository.url = "https://example.com/owner/repo"; f.save(); },
      (f: ReturnType<typeof fixture>) => { f.record.status = "TESTS_PASSED"; f.record.verification.functionalPassed = false; f.save(); },
      (f: ReturnType<typeof fixture>) => { rmSync(join(f.runDir, "candidate/src/add.js")); symlinkSync(join(f.runDir, "source/src/add.js"), join(f.runDir, "candidate/src/add.js")); },
    ]) {
      const f = fixture(); mutate(f);
      await expect(createDraftPullRequest({ ...f.record, status: "TESTS_PASSED" }, { runsDir: f.runsDir, token: "test-token", fetch: api.transport })).rejects.toThrow();
    }
    expect(api.calls).toHaveLength(0);
  });

  it("uses baseline hashes for deletion and never uploads a deleted file blob", async () => {
    const f = fixture();
    rmSync(join(f.runDir, "candidate/src/add.js"));
    f.record.delivery.files[0] = { path: "src/add.js", sha256: hash(original), deleted: true };
    f.save();
    const api = github();
    await createDraftPullRequest(f.record, { runsDir: f.runsDir, token: "test-token", fetch: api.transport });
    expect(api.calls.some(call => call.path === "/git/blobs")).toBe(false);
    expect(api.calls.find(call => call.path === "/git/trees" && call.method === "POST")?.body?.tree).toEqual([{ path: "src/add.js", mode: "100644", type: "blob", sha: null }]);
  });

  it("accepts the dedicated GH_TOKEN fallback when GITHUB_TOKEN is blank", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "dedicated-test-token");
    const f = fixture();
    const api = github();
    await createDraftPullRequest(f.record, { runsDir: f.runsDir, fetch: api.transport });
    expect(api.calls.every(call => call.authorization === "Bearer dedicated-test-token")).toBe(true);
    expect(readFileSync(join(f.runDir, "pull-request.json"), "utf8")).not.toContain("dedicated-test-token");
  });
});
