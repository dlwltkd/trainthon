import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import { createApp } from "./index.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => "export const answer = 42;\n"),
}));

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-server-"));
  roots.push(root);
  const dir = join(root, "runs", "run-1");
  const repo = join(root, "source");
  mkdirSync(dir, { recursive: true });
  mkdirSync(repo);
  const events = [
    { type: "run_start", runKind: "local_repository", model: "scripted", repository: { name: "sample", commit: "a".repeat(40), ref: "HEAD" } },
    { type: "repository_snapshot", name: "sample", commit: "a".repeat(40), files: ["src/index.ts", "tests/check.test.ts", ".env", "secrets.json"] },
    { type: "run_end", status: "TESTS_PASSED", elapsedMs: 100 },
  ].map((e, seq) => ({ ...e, seq, ts: 100 + seq, runId: "run-1" })) as HarnessEvent[];
  writeFileSync(join(dir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "repository.json"), JSON.stringify({ sourcePath: repo }));
  writeFileSync(join(dir, "record.json"), JSON.stringify({ repository: { regressionPath: "tests/check.test.ts" } }));
  writeFileSync(join(dir, "regression.ts"), "expect(42).toBe(42);\n");
  const start = vi.fn();
  const app = createApp({ repoRoot: root, runsDir: join(root, "runs"), port: 8787, start });
  const request = (path: string, init?: RequestInit) => app.request(`http://127.0.0.1:8787${path}`, init);
  return { root, dir, repo, app, request, start };
}

describe("local observer HTTP API", () => {
  it("allows the local dashboard and rejects foreign Host or Origin", async () => {
    const { request, app, start } = fixture();
    const allowed = await request("/api/runs", { headers: { Origin: "http://localhost:5173" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
    expect((await request("/api/runs", { headers: { Origin: "https://example.com" } })).status).toBe(403);
    expect((await request("/api/runs", { headers: { Host: "example.com:8787" } })).status).toBe(403);
    expect((await app.request("http://example.com:8787/api/runs")).status).toBe(403);
    expect((await request("/api/runs", { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ kind: "repository" }) })).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("requires bounded JSON requests before the run launcher is invoked", async () => {
    const { request, start } = fixture();
    expect((await request("/api/runs", { method: "POST", body: "{}" })).status).toBe(415);
    expect((await request("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" })).status).toBe(400);
    expect((await request("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportText: "x".repeat(512_001) }) })).status).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it("replays from the latest reconnect cursor and closes recorded streams", async () => {
    const { request } = fixture();
    const response = await request("/api/runs/run-1/stream?after=0", { headers: { "Last-Event-ID": "1" } });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("id: 2");
    expect(body).not.toContain("id: 1");
    expect(body).toContain("event: end");
    expect((await request("/api/runs/run-1/stream?after=NaN")).status).toBe(400);
  });

  it("uses recorded source metadata and only previews files in the safe snapshot", async () => {
    const { request, repo } = fixture();
    const detail = await (await request("/api/runs/run-1")).json();
    expect(detail).toMatchObject({ observation: "completed", active: false, streamable: false, controllable: false, source: { filesAvailable: true, files: ["src/index.ts", "tests/check.test.ts"] } });
    const preview = await request("/api/runs/run-1/file?path=src%2Findex.ts&repoPath=%2Fbrowser-supplied");
    expect(preview.status).toBe(200);
    const { execFileSync } = await import("node:child_process");
    expect(execFileSync).toHaveBeenCalledWith("git", ["-C", repo, "show", `${"a".repeat(40)}:src/index.ts`], expect.objectContaining({ timeout: 3_000, maxBuffer: 512_000 }));
    for (const path of [".env", "secrets.json", "src/other.ts"]) {
      expect((await request(`/api/runs/run-1/file?path=${encodeURIComponent(path)}`)).status).toBe(404);
    }
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const regression = await (await request("/api/runs/run-1/file?path=tests%2Fcheck.test.ts")).json();
    expect(regression).toMatchObject({ text: "expect(42).toBe(42);\n", revision: "supplied regression" });
  });

  it("does not offer unavailable source paths or non-artifact files", async () => {
    const { request, dir } = fixture();
    writeFileSync(join(dir, "repository.json"), "{}");
    expect((await request("/api/runs/run-1/file?path=src%2Findex.ts")).status).toBe(404);
    writeFileSync(join(dir, "notes.txt"), "private local notes");
    expect((await request("/api/runs/run-1/artifact?name=notes.txt")).status).toBe(404);
    symlinkSync(join(dir, "notes.txt"), join(dir, "report.txt"));
    expect((await request("/api/runs/run-1/artifact?name=report.txt")).status).toBe(404);
    expect((await request("/api/runs/run-1/artifact?name=record.json")).status).toBe(200);
    expect((await request("/api/runs/run-1/cancel", { method: "POST" })).status).toBe(409);
  });
});
