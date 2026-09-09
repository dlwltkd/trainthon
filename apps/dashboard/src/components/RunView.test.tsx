import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessEvent } from "@vouch/protocol";
import type { RunController } from "../hooks/useRun";
import { deriveRun } from "../lib/derive";
import { RunView } from "./RunView";

const state = vi.hoisted(() => ({ run: null as RunController | null }));
vi.mock("@/hooks/useRun", () => ({ useRun: () => state.run }));

type Payload = HarnessEvent extends infer Event ? Event extends HarnessEvent ? Omit<Event, "runId" | "seq" | "ts"> : never : never;

function trace(...payloads: Payload[]): HarnessEvent[] {
  const start: Payload = { type: "run_start", runKind: "local_repository", configHash: "test", model: "test-model", mode: "live", seed: 1, budgets: { maxSteps: 20, maxTokens: 5000, maxWallMs: 60000 } };
  return [start, ...payloads].map((payload, seq) => ({ ...payload, runId: "run-1", seq, ts: 1000 + seq * 100 }));
}

function controller(events: HarnessEvent[], overrides: Partial<RunController> = {}): RunController {
  return {
    view: deriveRun(events), source: { kind: "local_repository", name: "sample-repo", files: ["calc.py"], filesAvailable: false, artifactsAvailable: true }, record: null,
    connection: "recorded", playback: "recorded", totalEvents: events.length, replay: { cursor: events.length, playing: false, speed: 1 }, observation: "completed", controllable: false,
    startReplay: vi.fn(), toggleReplay: vi.fn(), setReplaySpeed: vi.fn(), seekReplay: vi.fn(), exitReplay: vi.fn(), reload: vi.fn(), ...overrides,
  };
}

describe("run view agent trace integration", () => {
  it("renders the current plan, actual skill calls and decision evidence in the connected layout", () => {
    state.run = controller(trace(
      { type: "skill_call", skillId: "bounded-source-repair", version: "1.2", reason: "Existing tests point to a small source correction.", callId: "skill-1", agentRole: "blue", stage: "PATCH" },
      { type: "agent_update", summary: "The arithmetic helper returns the wrong sum.", nextAction: "Run the supplied regression after the correction.", evidence: ["calc.py"], plan: [{ id: "read", title: "Inspect arithmetic helper", status: "completed" }, { id: "test", title: "Check existing tests", status: "in_progress" }], callId: "update-1", agentRole: "blue", stage: "PATCH" },
      { type: "run_end", status: "TESTS_PASSED", costUsd: 0, elapsedMs: 1000 },
    ));
    const html = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(html).toContain("Plan &amp; skills");
    expect(html).toContain("Agent plan");
    expect(html).toContain("Inspect arithmetic helper");
    expect(html).toContain("in progress");
    expect(html).toContain("Skill invoked");
    expect(html).toContain("bounded-source-repair");
    expect(html).toContain("Existing tests point to a small source correction.");
    expect(html).toContain("Decision update");
    expect(html).toContain("Run the supplied regression after the correction.");
    expect(html).toContain('title="calc.py"');
    expect(html).toContain('data-activity-id="skill-1"');
    expect(html).not.toContain("No model invoked");
  });

  it("explicitly shows no model invocation when baseline tests finish before any agent work", () => {
    state.run = controller(trace(
      { type: "test_run", phase: "baseline-regression", outcome: "passed", passed: true, testsPassed: 10, testsFailed: 0, testsSkipped: 0, artifact: "tests/baseline-regression.json" },
      { type: "run_end", status: "NOT_REPRODUCIBLE", costUsd: 0, elapsedMs: 3000 },
    ));
    const html = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(html).toContain("No model invoked");
    expect(html).toContain("The supplied regression already passed");
    expect(html).not.toContain("Skill invoked");
    expect(html).not.toContain("Decision update");
  });

  it("labels CLI streams and never exposes the server cancel action for them", () => {
    state.run = controller(trace(), { playback: "live", connection: "tailing", observation: "tailing", controllable: false });
    const html = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(html).toContain("Following CLI events from disk");
    expect(html).not.toContain("Cancel run");
    expect(html).not.toContain("run ended without a final event");
  });
});
