import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import { deriveRun, groupActivity, resolveEvidence, statusDescription, statusLabel } from "./derive";

type Payload = HarnessEvent extends infer Event ? Event extends HarnessEvent ? Omit<Event, "runId" | "seq" | "ts"> : never : never;

function trace(...payloads: Payload[]): HarnessEvent[] {
  const start: Payload = { type: "run_start", runKind: "local_repository", configHash: "test", model: "test-model", mode: "live", seed: 1, budgets: { maxSteps: 20, maxTokens: 5000, maxWallMs: 60000 } };
  return [start, ...payloads].map((payload, seq) => ({ ...payload, runId: "run-1", seq, ts: 1000 + seq * 100 }));
}

describe("agent activity derivation", () => {
  it("updates one model row per attempt and keeps retry, execution, and replay states separate", () => {
    const request = { type: "model_request" as const, requestId: "request-1", attempt: 1, transport: "stream" as const, agentRole: "red" as const, stage: "REVIEW" as const, outputChars: 0, elapsedMs: 0 };
    const events = trace(
      { ...request, phase: "waiting" },
      { ...request, phase: "tool_input", elapsedMs: 100, firstChunkMs: 50, outputChars: 15, toolName: "read_file" },
      { ...request, phase: "failed", elapsedMs: 200, detail: "Stream interrupted." },
      { type: "model_msg", role: "assistant", agentRole: "red", tokensIn: 100, tokensOut: 50, outcome: "failed" },
      { ...request, phase: "retry_wait", elapsedMs: 200, retryAt: 5000 },
      { ...request, attempt: 2, phase: "waiting" },
      { ...request, attempt: 2, phase: "completed", elapsedMs: 100 },
      { type: "model_msg", role: "assistant", agentRole: "red", tokensIn: 20, tokensOut: 5, outcome: "completed" },
    );
    expect(deriveRun(events.slice(0, 2))!.currentModel?.phase).toBe("waiting");
    expect(deriveRun(events.slice(0, 3))!.currentModel).toMatchObject({ phase: "tool_input", outputChars: 15, ts: events[1]!.ts });
    expect(deriveRun(events.slice(0, 4))!.currentModel).toBeUndefined();
    expect(deriveRun(events.slice(0, 6))!.currentModel?.phase).toBe("retry_wait");
    const view = deriveRun(events)!;
    expect(view.currentModel).toBeUndefined();
    expect(view.activity.filter(item => item.kind === "model")).toHaveLength(2);
    expect(view.usage.modelTurns).toBe(1);
    expect(view.usage.tokens).toBe(175);
  });

  it("clears the previous role's current decision at handoff", () => {
    const view = deriveRun(trace(
      { type: "agent_update", agentRole: "red", stage: "REVIEW", summary: "Red's plan", nextAction: "Read", evidence: [], plan: [], callId: "plan" },
      { type: "role_assigned", role: "blue", runner: "source-review" },
    ))!;
    expect(view.currentDecision).toBeUndefined();
    expect(view.decisions).toHaveLength(1);
  });

  it("shows historical partial reviews as incomplete without changing the stored trace or leaking the ending into replay", () => {
    const events = trace({ type: "run_end", status: "PATCH_PROPOSED", reason: "Old success", costUsd: null, elapsedMs: 1000 });
    expect(deriveRun(events.slice(0, 1), undefined, "partial")!.status).toBe("RUNNING");
    const view = deriveRun(events, undefined, "partial")!;
    expect(view.status).toBe("INCOMPLETE_REVIEW");
    expect(view.reason).toContain("Red did not complete");
    expect(view.activity.at(-1)).toMatchObject({ status: "INCOMPLETE_REVIEW" });
    expect(events.at(-1)).toMatchObject({ status: "PATCH_PROPOSED", reason: "Old success" });
  });

  it("marks conservative token accounting only after its visible event and keeps uncertainty sticky", () => {
    const events = trace(
      { type: "budget_update", tokens: 1234, usageKnown: true, steps: 1, elapsedMs: 1000 },
      { type: "budget_update", tokens: 2400, usageKnown: false, steps: 2, elapsedMs: 2000 },
      { type: "budget_update", tokens: 3600, usageKnown: true, steps: 3, elapsedMs: 3000 },
      { type: "run_end", status: "BUDGET_TIMEOUT", reason: "Run tokens budget exhausted", costUsd: null, elapsedMs: 3000 },
    );
    expect(deriveRun(events.slice(0, 1), false)!.usageKnown).toBeUndefined();
    expect(deriveRun(events.slice(0, 2), false)!.usageKnown).toBe(true);
    expect(deriveRun(events.slice(0, 3))!.usageKnown).toBe(false);
    const view = deriveRun(events, true)!;
    expect(view.usageKnown).toBe(false);
    expect(statusDescription(view)).toContain("Conservative budget accounting: 3,600 / 5,000 tokens");
    expect(statusDescription(view)).not.toContain("Recorded model usage");
  });

  it("uses historical record uncertainty only after the final event is visible", () => {
    const events = trace(
      { type: "budget_update", tokens: 1234, steps: 1, elapsedMs: 1000 },
      { type: "run_end", status: "REVIEW_COMPLETE", costUsd: null, elapsedMs: 1000 },
    );
    expect(deriveRun(events.slice(0, 2), false)!.usageKnown).toBeUndefined();
    expect(deriveRun(events, false)!.usageKnown).toBe(false);
    expect(deriveRun(events)!.usageKnown).toBeUndefined();
  });

  it.each([
    ["Run tokens budget exhausted", "Token budget limit"],
    ["Next model request exceeds the remaining token allowance: estimated request requires at least 8000 tokens; 3766 remain (1234 used of 5000). No provider request was sent.", "Request too large"],
    ["Run steps budget exhausted", "Step limit reached"],
    ["Run wall budget exhausted", "Time limit reached"],
    [undefined, "Budget limit reached"],
  ])("labels budget stops from their recorded reason: %s", (reason, label) => {
    expect(statusLabel("BUDGET_TIMEOUT", reason)).toBe(label);
  });

  it("separates recorded token usage from request admission and keeps historical reasons intact", () => {
    const reason = "Run tokens budget exhausted";
    const view = deriveRun(trace(
      { type: "budget_update", tokens: 1234, steps: 3, elapsedMs: 1000 },
      { type: "run_end", status: "BUDGET_TIMEOUT", reason, costUsd: null, elapsedMs: 1000 },
    ))!;
    expect(view.reason).toBe(reason);
    expect(statusDescription(view)).toBe("The harness stopped at its per-run token allowance check. Recorded model usage: 1,234 / 5,000 tokens.");
    view.reason = "Next model request exceeds the remaining token allowance: estimated request requires at least 8000 tokens; 3766 remain (1234 used of 5000). No provider request was sent.";
    expect(statusDescription(view)).toContain("The request was not sent.");
    expect(statusDescription(view)).toContain("1,234 / 5,000 tokens");
    expect(statusLabel("INFRA_ERROR", "Run tokens budget exhausted")).toBe("Infra error");
  });

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

  it("keeps Red claims and Blue assessments separate without inferring a fix", () => {
    const finding: Payload = { type: "finding_reported", findingId: "input-check", title: "Input check needs review", severity: "medium", confidence: "potential", summary: "A source branch may accept an absent value.", recommendation: "Review the default handling.", evidence: ["src/parser.ts"], callId: "finding-call-1", agentRole: "red", stage: "REVIEW" };
    const events = trace(finding, { ...finding, confidence: "confirmed", callId: "finding-call-2", summary: "The inspected branch does not supply a default.", agentRole: "blue" });
    expect(deriveRun(events.slice(0, 1))!.findings).toEqual([]);
    expect(deriveRun(events.slice(0, 2))!.findings[0]!.confidence).toBe("potential");
    expect(deriveRun(events.slice(0, 2))!.findings[0]!.agentRole).toBe("red");
    const view = deriveRun(events)!;
    expect(view.findings).toHaveLength(2);
    expect(view.findings[0]).toMatchObject({ confidence: "potential", agentRole: "red" });
    expect(view.findings[1]).toMatchObject({ confidence: "confirmed", agentRole: "blue" });
    expect(view.activity.filter((item) => item.kind === "finding")).toHaveLength(2);
    expect(view.tests).toEqual([]);
    expect(view.changedFiles.size).toBe(0);
  });
});
