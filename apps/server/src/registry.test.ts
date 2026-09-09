import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import { RunRegistry, parseJsonl, readBoundedText, resolveInside, type ActiveRun } from "./registry.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-registry-"));
  roots.push(root);
  const dir = join(root, "run-1");
  mkdirSync(dir);
  const path = join(dir, "events.jsonl");
  writeFileSync(path, JSON.stringify(event(0, "run_start")) + "\n");
  return { root, dir, path };
}

function event(seq: number, type: string): HarnessEvent {
  return { runId: "run-1", seq, type, ts: 100, runKind: "local_repository", model: "scripted", repository: { name: "sample" } } as HarnessEvent;
}

describe("run registry", () => {
  it("distinguishes observed CLI activity from controllable runs and closes stale observations", () => {
    const { root, path } = fixture();
    const now = Date.now();
    utimesSync(path, new Date(now), new Date(now));
    let clock = now;
    const registry = new RunRegistry(root, { staleAfterMs: 500, now: () => clock });
    expect(registry.load("run-1")).toMatchObject({ active: false, streamable: true, controllable: false, observation: "tailing" });
    expect(registry.list()[0]).toMatchObject({ observation: "tailing", status: "RUNNING" });
    clock += 501;
    expect(registry.load("run-1")).toMatchObject({ active: false, streamable: false, observation: "stale" });
    appendFileSync(path, JSON.stringify(event(1, "run_end")) + "\n");
    expect(registry.load("run-1")).toMatchObject({ streamable: false, observation: "completed" });
  });

  it("holds incomplete JSONL tails, ignores invalid metadata, and deduplicates replay IDs", () => {
    const first = JSON.stringify(event(0, "run_start"));
    const second = JSON.stringify(event(1, "state_change"));
    const text = `${first}\n${first}\n{bad}\n${JSON.stringify({ ...event(2, "note"), runId: "other" })}\n${second}`;
    expect(parseJsonl(text, "run-1").map(e => e.seq)).toEqual([0]);
    expect(parseJsonl(text + "\n", "run-1").map(e => e.seq)).toEqual([0, 1]);
  });

  it("loads only explicit recorded source metadata and tolerates incomplete records", () => {
    const { root, dir } = fixture();
    writeFileSync(join(dir, "repository.json"), JSON.stringify({ sourcePath: "/tmp/recorded-repository" }));
    writeFileSync(join(dir, "record.json"), "{");
    const registry = new RunRegistry(root);
    expect(registry.load("run-1")).toMatchObject({ sidecar: { repoPath: "/tmp/recorded-repository" }, record: null });
    writeFileSync(join(dir, "repository.json"), JSON.stringify({ sourcePath: "relative-repository" }));
    expect(registry.load("run-1")?.sidecar.repoPath).toBeUndefined();
    writeFileSync(join(dir, "record.json"), JSON.stringify({ provisional: true, status: "TESTS_PASSED" }));
    expect(registry.load("run-1")?.streamable).toBe(true);
    writeFileSync(join(dir, "record.json"), JSON.stringify({ status: "TESTS_PASSED" }));
    expect(registry.load("run-1")?.streamable).toBe(true);
  });

  it("bounds previews and rejects hidden paths and symlinks", () => {
    const { root, dir } = fixture();
    writeFileSync(join(dir, "report.txt"), "sample report");
    symlinkSync(join(dir, "report.txt"), join(dir, "alias.txt"));
    expect(readBoundedText(dir, "report.txt", 5)).toBeNull();
    expect(readBoundedText(dir, "alias.txt", 100)).toBeNull();
    expect(resolveInside(dir, ".env")).toBeNull();
    expect(resolveInside(dir, "../outside.txt")).toBeNull();
    symlinkSync(dir, join(root, "alias-run"));
    expect(new RunRegistry(root).load("alias-run")).toBeNull();
    expect(new RunRegistry(root).runDir("../run-1")).toBeNull();
  });

  it("counts only unfinished managed runs and notifies completion once", () => {
    const { root } = fixture();
    const registry = new RunRegistry(root);
    const run: ActiveRun = { runId: "run-1", events: [event(0, "run_start")], listeners: new Set(), controller: new AbortController(), done: false, sidecar: {} };
    registry.register(run);
    expect(registry.activeCount).toBe(1);
    expect(registry.load("run-1")?.controllable).toBe(true);
    registry.finish("run-1");
    expect(registry.activeCount).toBe(0);
    expect(registry.load("run-1")?.observation).toBe("completed");
  });
});
