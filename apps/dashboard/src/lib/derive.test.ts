import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import { deriveRun, groupActivity, resolveEvidence } from "./derive";

type Payload = HarnessEvent extends infer Event ? Event extends HarnessEvent ? Omit<Event, "runId" | "seq" | "ts"> : never : never;

function trace(...payloads: Payload[]): HarnessEvent[] {
  const start: Payload = { type: "run_start", runKind: "local_repository", configHash: "test", model: "test-model", mode: "live", seed: 1, budgets: { maxSteps: 20, maxTokens: 5000, maxWallMs: 60000 } };
  return [start, ...payloads].map((payload, seq) => ({ ...payload, runId: "run-1", seq, ts: 1000 + seq * 100 }));
}

describe("agent activity derivation", () => {
  it("distinguishes configured guidance from skill invocation and preserves its stated reason", () => {
    const events = trace(
      { type: "guidance_configured", id: "local-repair", version: "1", agentRole: "blue" },
      { type: "skill_call", skillId: "bounded-source-repair", version: "2", reason: "The baseline test points to the input parser.", callId: "skill-1", agentRole: "blue", stage: "PATCH" },
    );
    const view = deriveRun(events)!;
    expect(deriveRun(events.slice(0, 2))!.skills).toHaveLength(0);
    expect(view.guidance).toHaveLength(1);
    expect(view.skills[0]).toMatchObject({ skillId: "bounded-source-repair", version: "2", reason: "The baseline test points to the input parser.", callId: "skill-1" });
  });

  it("updates the plan only from agent updates and replay never leaks future decisions", () => {
    const events = trace(
      { type: "agent_update", summary: "The parser reads a missing field.", nextAction: "Inspect the parser.", evidence: ["src/parser.ts"], plan: [{ id: "inspect", title: "Inspect parser", status: "in_progress" }], callId: "progress-1", agentRole: "blue", stage: "PATCH" },
      { type: "agent_update", summary: "The supplied input needs a default.", nextAction: "Run the existing test.", evidence: ["src/parser.ts"], plan: [{ id: "inspect", title: "Inspect parser", status: "completed" }, { id: "check", title: "Check existing tests", status: "in_progress" }], callId: "progress-2", agentRole: "blue", stage: "PATCH" },
    );
    expect(deriveRun(events.slice(0, 1))!.currentDecision).toBeUndefined();
    expect(deriveRun(events.slice(0, 2))!.currentDecision!.nextAction).toBe("Inspect the parser.");
    expect(deriveRun(events)!.currentDecision!.plan.map((step) => step.status)).toEqual(["completed", "in_progress"]);
    expect(deriveRun(events)!.decisions).toHaveLength(2);
  });

  it("correlates concurrent calls by ID and marks only successful reads as inspected", () => {
    const events = trace(
      { type: "tool_call", name: "read_file", args: { path: "src/a.ts" }, callId: "read-a" },
      { type: "tool_call", name: "read_file", args: { path: "src/b.ts" }, callId: "read-b" },
      { type: "action_summary", summary: "Read parser implementation", callId: "read-a" },
      { type: "tool_result", name: "read_file", result: "B content", truncated: false, callId: "read-b", outcome: "succeeded" },
      { type: "tool_error", name: "read_file", callId: "read-a", durationMs: 12, outcome: "failed", error: "File unavailable" },
    );
    expect(deriveRun(events.slice(0, 3))!.inspectedFiles.size).toBe(0);
    const view = deriveRun(events)!;
    expect(view.tools.get("read-b")).toMatchObject({ result: "B content", outcome: "succeeded" });
    expect(view.tools.get("read-a")).toMatchObject({ error: "File unavailable", outcome: "failed", summary: "Read parser implementation" });
    expect([...view.inspectedFiles]).toEqual(["src/b.ts"]);
    expect(view.currentAction).toBeUndefined();
  });

  it("does not keep completed tools spinning or invent a result for unfinished calls", () => {
    const view = deriveRun(trace(
      { type: "tool_call", name: "read_file", args: { path: "src/a.ts" }, callId: "read-a" },
      { type: "run_end", status: "CANCELLED", costUsd: null, elapsedMs: 1000 },
    ))!;
    expect(view.currentAction).toBeUndefined();
    expect(view.tools.get("read-a")!.outcome).toBe("unresolved");
    expect(view.tools.get("read-a")!.result).toBeUndefined();
  });

  it("keeps a passing baseline run free of invented model or skill activity", () => {
    const view = deriveRun(trace(
      { type: "test_run", phase: "baseline-regression", outcome: "passed", passed: true, testsPassed: 10, testsFailed: 0, testsSkipped: 0, artifact: "tests/baseline-regression.json" },
      { type: "run_end", status: "NOT_REPRODUCIBLE", costUsd: 0, elapsedMs: 3000 },
    ))!;
    expect(view.usage.modelTurns).toBe(0);
    expect(view.skills).toEqual([]);
    expect(view.currentDecision).toBeUndefined();
    expect(view.changedFiles.size).toBe(0);
    expect(view.tests[0]!.testsPassed).toBe(10);
    expect(view.status).toBe("NOT_REPRODUCIBLE");
  });

  it("only links evidence that exists in the recorded repository or activity", () => {
    const view = deriveRun(trace(
      { type: "tool_call", name: "read_file", args: { path: "src/a.ts" }, callId: "read-a" },
      { type: "test_run", phase: "baseline-regression", outcome: "passed", passed: true, testsPassed: 1, testsFailed: 0, testsSkipped: 0, artifact: "/runs/example/tests/baseline-regression.json" },
    ))!;
    expect(resolveEvidence("src/a.ts:42", view, ["src/a.ts"])).toEqual({ kind: "file", value: "src/a.ts" });
    expect(resolveEvidence("tool:read-a", view, [])).toEqual({ kind: "activity", value: "read-a" });
    expect(resolveEvidence("tests/baseline-regression.json", view, [])).toEqual({ kind: "test", value: "baseline-regression" });
    expect(resolveEvidence("missing.ts", view, [])).toBeNull();
    expect(resolveEvidence("https://example.com", view, [])).toBeNull();
  });

  it("does not group failed exploration as a successful repository inspection", () => {
    const view = deriveRun(trace(...[1, 2, 3].flatMap((index): Payload[] => [
      { type: "tool_call", name: "read_file", args: { path: `missing-${index}.ts` }, callId: `read-${index}` },
      { type: "tool_error", name: "read_file", callId: `read-${index}`, durationMs: 1, outcome: "failed", error: "Missing" },
    ])))!;
    expect(groupActivity(view.activity).some((item) => item.kind === "group")).toBe(false);
  });
});
