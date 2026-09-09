import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import { RunRegistry, type ActiveRun } from "./registry.js";
import { observeRun } from "./stream.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const event = (seq: number, type: string) => ({ runId: "run-1", seq, ts: Date.now(), type }) as HarnessEvent;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-stream-"));
  roots.push(root);
  const dir = join(root, "run-1");
  mkdirSync(dir);
  const path = join(dir, "events.jsonl");
  writeFileSync(path, JSON.stringify(event(0, "run_start")) + "\n");
  return { root, path };
}

describe("run observer", () => {
  it("delivers events emitted while replay is writing exactly once, including completion", async () => {
    const { root } = fixture();
    const registry = new RunRegistry(root);
    const run: ActiveRun = { runId: "run-1", events: [event(0, "run_start")], listeners: new Set(), controller: new AbortController(), done: false, sidecar: {} };
    registry.register(run);
    const frames: Array<{ event: string; data: string }> = [];
    await observeRun(registry, run.runId, -1, async frame => {
      frames.push(frame);
      if (frame.event === "harness" && JSON.parse(frame.data).seq === 0) {
        for (const next of [event(1, "tool_call"), event(2, "run_end")]) {
          run.events.push(next);
          for (const listener of run.listeners) listener(next);
        }
        registry.finish(run.runId);
      }
    }, new AbortController().signal, { pollMs: 2 });
    expect(frames.filter(f => f.event === "harness").map(f => JSON.parse(f.data).seq)).toEqual([0, 1, 2]);
    expect(frames.at(-1)).toMatchObject({ event: "end", data: JSON.stringify({ reason: "completed" }) });
    expect(run.listeners.size).toBe(0);
  });

  it("tails CLI JSONL until a complete run_end arrives", async () => {
    const { root, path } = fixture();
    const registry = new RunRegistry(root);
    const frames: Array<{ event: string; data: string }> = [];
    let appended = false;
    await observeRun(registry, "run-1", -1, async frame => {
      frames.push(frame);
      if (!appended) {
        appended = true;
        appendFileSync(path, JSON.stringify(event(1, "agent_summary")) + "\n" + JSON.stringify(event(2, "run_end")) + "\n");
      }
    }, new AbortController().signal, { pollMs: 2 });
    expect(frames.filter(f => f.event === "harness").map(f => JSON.parse(f.data).seq)).toEqual([0, 1, 2]);
    expect(frames.at(-1)?.event).toBe("end");
  });

  it("sends observed heartbeats, stops stale files, and never invents a run_end", async () => {
    const { root } = fixture();
    let clock = Date.now();
    const registry = new RunRegistry(root, { staleAfterMs: 50, now: () => clock });
    const frames: Array<{ event: string; data: string }> = [];
    await observeRun(registry, "run-1", 0, async frame => {
      frames.push(frame);
      if (frame.event === "ping") clock += 100;
    }, new AbortController().signal, { pollMs: 2, heartbeatMs: 2 });
    expect(frames.some(f => f.event === "ping" && JSON.parse(f.data).observation === "tailing")).toBe(true);
    expect(frames.at(-1)?.data).toBe(JSON.stringify({ reason: "stale" }));
    expect(frames.some(f => f.event === "harness")).toBe(false);
  });

  it("removes the live listener when the browser disconnects", async () => {
    const { root } = fixture();
    const registry = new RunRegistry(root);
    const run: ActiveRun = { runId: "run-1", events: [event(0, "run_start")], listeners: new Set(), controller: new AbortController(), done: false, sidecar: {} };
    registry.register(run);
    const controller = new AbortController();
    await observeRun(registry, "run-1", -1, async () => { controller.abort(); }, controller.signal, { pollMs: 2 });
    expect(run.listeners.size).toBe(0);
  });
});
