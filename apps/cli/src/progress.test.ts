import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGETS, type EventInput, type HarnessEvent } from "@vouch/protocol";
import { createRunProgress } from "./progress.js";

function event(input: EventInput): HarnessEvent {
  return { ...input, runId: "local-run", seq: 0, ts: Date.now() } as HarnessEvent;
}

function start(): HarnessEvent {
  return event({
    type: "run_start", runKind: "local_repository", configHash: "hash", mode: "scripted",
    model: "supplied-patch", seed: 1, budgets: DEFAULT_BUDGETS,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("run progress", () => {
  it("shows persisted progress immediately, then describes a quiet operation without inventing progress", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    expect(vi.getTimerCount()).toBe(0);

    progress.onEvent(start());
    progress.onEvent(event({ type: "action_summary", summary: "Installing pinned test dependencies" }));
    expect(write.mock.calls.flat().join("")).toContain("[00:00] events: /tmp/runs/local-run/events.jsonl\n");
    expect(write.mock.calls.flat().join("")).toContain("[00:00] Installing pinned test dependencies\n");

    vi.advanceTimersByTime(9_999);
    expect(write).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenLastCalledWith("[00:10] still waiting: Installing pinned test dependencies\n");
    expect(write.mock.calls.flat().join("")).not.toContain("%");

    progress.onEvent(event({ type: "run_end", status: "NOT_REPRODUCIBLE", elapsedMs: 10_000, costUsd: null }));
    expect(write).toHaveBeenLastCalledWith("[00:10] run ended: NOT_REPRODUCIBLE (10.0s)\n");
    expect(vi.getTimerCount()).toBe(0);
    const lines = write.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    progress.onEvent(event({ type: "action_summary", summary: "late event" }));
    expect(write).toHaveBeenCalledTimes(lines);
  });

  it("renders useful metadata while omitting tool payloads, error text, model summaries and terminal controls", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    progress.onEvent(start());
    progress.onEvent(event({ type: "repository_snapshot", name: "example\nrepository", commit: "abcdef0123456789", files: ["private-source.ts"], artifact: "repository.json" }));
    progress.onEvent(event({ type: "guidance_configured", id: "local-repair", version: "1", agentRole: "blue" }));
    progress.onEvent(event({ type: "role_assigned", role: "blue", runner: "sdk", provider: "openai", model: "configured-model" }));
    progress.onEvent(event({ type: "action_summary", summary: "searching for secret-query", callId: "read-1", agentRole: "blue" }));
    progress.onEvent(event({ type: "tool_call", name: "\u001b[31mread_file\u001b[0m\r\n", args: { key: "secret-argument" }, callId: "read-1", agentRole: "blue" }));
    vi.advanceTimersByTime(1200);
    progress.onEvent(event({ type: "tool_result", name: "read_file", result: "secret-source", truncated: false, callId: "read-1", agentRole: "blue" }));
    progress.onEvent(event({ type: "tool_error", name: "run_tests", error: "secret-error", outcome: "failed", durationMs: 200, callId: "test-1", agentRole: "blue" }));
    progress.onEvent(event({ type: "test_run", phase: "baseline-functional", outcome: "passed", passed: true, testsPassed: 163, testsFailed: 0, testsSkipped: 41, artifact: "test.json", durationMs: 1200 }));
    progress.onEvent(event({ type: "model_msg", role: "assistant", tokensIn: 100, tokensOut: 20, agentRole: "blue" }));
    progress.onEvent(event({ type: "agent_summary", summary: "secret-model-summary", agentRole: "blue", stage: "PATCH" }));
    progress.onEvent(event({ type: "file_change", path: "private-source.ts", patch: "secret-patch", artifact: "patch.diff", agentRole: "blue" }));

    const output = write.mock.calls.flat().join("");
    expect(output).toContain("repository snapshot: example repository @ abcdef012345, 1 files");
    expect(output).toContain("blue guidance: local-repair@1");
    expect(output).toContain("blue assigned: openai / configured-model");
    expect(output).toContain("blue tool read_file started\n");
    expect(output).toContain("blue tool read_file completed (1.2s)\n");
    expect(output).toContain("blue tool run_tests failed (0.2s)\n");
    expect(output).toContain("tests baseline-functional: passed, 163 passed / 0 failed / 41 skipped (1.2s)");
    expect(output).toContain("blue model step finished");
    expect(output).not.toMatch(/secret-|private-source|\u001b|\r/);
    expect(output.split("\n").filter(Boolean).every(line => /^\[\d+:\d{2}\] /.test(line))).toBe(true);
    progress.stop();
  });

  it("reports a quiet step within one second of ten seconds of silence even when it starts between ticks", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    progress.onEvent(start());
    vi.advanceTimersByTime(5);
    progress.onEvent(event({ type: "action_summary", summary: "Preparing isolated tests" }));
    vi.advanceTimersByTime(9_995);
    expect(write).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenLastCalledWith("[00:11] still waiting: Preparing isolated tests\n");
    expect(write).toHaveBeenCalledTimes(4);
    progress.stop();
  });

  it("stops quietly when a heartbeat cannot be written", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    progress.onEvent(start());
    write.mockImplementationOnce(() => { throw new Error("closed pipe"); });
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30_000);
    progress.onEvent(event({ type: "action_summary", summary: "late event" }));
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("stops its heartbeat when execution is rejected or cancelled", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    progress.onEvent(start());
    expect(vi.getTimerCount()).toBe(1);
    progress.stop();
    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("clears the timer even if output fails while the final event is printed", () => {
    const write = vi.fn();
    const progress = createRunProgress("/tmp/runs", write);
    progress.onEvent(start());
    write.mockImplementation(() => { throw new Error("closed pipe"); });
    expect(() => progress.onEvent(event({ type: "run_end", status: "CANCELLED", elapsedMs: 1, costUsd: null }))).toThrow("closed pipe");
    expect(vi.getTimerCount()).toBe(0);
  });
});
