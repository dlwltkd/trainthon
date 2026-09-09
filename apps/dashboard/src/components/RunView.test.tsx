import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessEvent } from "@vouch/protocol";
import type { RunController } from "../hooks/useRun";
import { deriveRun } from "../lib/derive";
import { RunView } from "./RunView";
import { EvidencePanel } from "./EvidencePanel";
import { RepoHeader } from "./RepoHeader";
import { AgentIntent } from "./AgentActivity";
import { FindingsPanel } from "./FindingsPanel";

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
  it("shows usage without enormous sentinel limits for unbounded prompt reviews", () => {
    const view = deriveRun(trace({ type: "budget_update", tokens: 1234, usageKnown: true, steps: 41, elapsedMs: 1000 }))!;
    view.budgets = { maxSteps: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER, maxWallMs: 1_200_000 };
    const html = renderToStaticMarkup(<RepoHeader view={view} source={null} now={1000} connection="recorded" playback="recorded" />);
    expect(html).toContain("No step ceiling");
    expect(html).toContain("No token ceiling");
    expect(html).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });
  it("labels conservative budget accounting without presenting it as reported token use", () => {
    const view = deriveRun(trace(
      { type: "budget_update", tokens: 1234, usageKnown: false, steps: 3, elapsedMs: 1000 },
      { type: "run_end", status: "BUDGET_TIMEOUT", reason: "Run tokens budget exhausted", costUsd: null, elapsedMs: 1000 },
    ))!;
    const header = renderToStaticMarkup(<RepoHeader view={view} source={null} now={1000} connection="recorded" playback="recorded" />);
    expect(header).toContain("token estimate");
    expect(header).toContain("Conservative accounting");
    const evidence = renderToStaticMarkup(<EvidencePanel view={view} source={null} focusPhase={null} />);
    expect(evidence).toContain("Conservative budget accounting: 1,234 / 5,000 tokens");
    expect(evidence).toContain("provider usage was unavailable");
    expect(evidence).not.toContain("Recorded model usage");
  });

  it("shows Red claims and Blue assessments as separate role-labeled reports", () => {
    const finding: Payload = { type: "finding_reported", findingId: "default-value", title: "Default input needs review", severity: "medium", confidence: "confirmed", summary: "A missing input follows an unexpected branch.", recommendation: "Supply an explicit default value.", evidence: ["calc.py"], callId: "finding-red", agentRole: "red", stage: "REVIEW" };
    const view = deriveRun(trace(finding, { ...finding, callId: "finding-blue", agentRole: "blue", summary: "Blue checked the default branch independently." }))!;
    const html = renderToStaticMarkup(<FindingsPanel view={view} files={["calc.py"]} onEvidence={() => undefined} />);
    expect(html).toContain("1 Red claim");
    expect(html).toContain("1 Blue assessment");
    expect(html).toContain("Source-supported claim");
    expect(html).toContain("Confirmed in source");
    expect(html).toContain("A missing input follows an unexpected branch.");
    expect(html).toContain("Blue checked the default branch independently.");
  });

  it("shows a token budget stop with recorded usage instead of labeling it a timeout", () => {
    const events = trace(
      { type: "budget_update", tokens: 1234, steps: 3, elapsedMs: 1000 },
      { type: "run_end", status: "BUDGET_TIMEOUT", reason: "Run tokens budget exhausted", costUsd: null, elapsedMs: 1000 },
    );
    state.run = controller(events);
    const html = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(html).toContain("Token budget limit");
    expect(html).toContain("run tokens");
    expect(html).toContain("1.2k / 5.0k");
    expect(html).not.toContain("Budget timeout");
    const evidence = renderToStaticMarkup(<EvidencePanel view={state.run.view!} source={state.run.source} focusPhase={null} />);
    expect(evidence).toContain("per-run token allowance check");
    expect(evidence).toContain("1,234 / 5,000 tokens");
  });

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

  it("renders completed source review findings without test or repair gates", () => {
    const events = trace(
      { type: "agent_summary", agentRole: "blue", stage: "REVIEW", summary: "The inspected authorization check verifies ownership before reading the record." },
      { type: "run_end", status: "REVIEW_COMPLETE", costUsd: null, elapsedMs: 2000 },
    );
    const start = events[0]!;
    if (start.type === "run_start") start.workflow = "repository_review";
    const view = deriveRun(events)!;
    state.run = controller(events);
    const runHtml = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(runHtml).toContain("Repository review");
    expect(runHtml).toContain("Review findings");
    expect(runHtml).toContain("verifies ownership");
    const evidence = renderToStaticMarkup(<EvidencePanel view={view} source={{ ...state.run.source!, prompt: "Review authorization." }} focusPhase={null} />);
    expect(evidence).toContain("source review · model-reported findings");
    expect(evidence).toContain("tests were not run");
    expect(evidence).toContain("Task prompt");
    expect(evidence).not.toContain("Before / after test evidence");
    expect(evidence).not.toContain(">Gates<");
    expect(evidence).not.toContain("Independent grade");
  });

  it("keeps Red handoff notes separate from Blue's final review and patch summary", () => {
    const events = trace({ type: "agent_summary", agentRole: "red", stage: "REVIEW", summary: "Red found a branch for Blue to inspect." });
    const start = events[0]!;
    if (start.type === "run_start") start.workflow = "repository_remediation";
    const view = deriveRun(events)!;
    const intent = renderToStaticMarkup(<AgentIntent view={view} files={[]} onEvidence={() => undefined} />);
    const evidence = renderToStaticMarkup(<EvidencePanel view={view} source={null} focusPhase={null} />);
    expect(intent).not.toContain("Review &amp; patch notes");
    expect(evidence).toContain("A final summary has not been recorded.");
    expect(evidence).not.toContain("Red found a branch");
    expect(view.activity.some((item) => item.kind === "note" && item.agentRole === "red" && item.text === "Red found a branch for Blue to inspect.")).toBe(true);
  });

  it("links only canonical GitHub origins and the exact recorded commit", () => {
    const run = controller(trace());
    const source = { ...run.source!, url: "https://github.com/example/repository", commit: "a".repeat(40) };
    const render = (url: string) => renderToStaticMarkup(<RepoHeader view={run.view!} source={{ ...source, url }} now={1000} connection="recorded" playback="recorded" />);
    expect(render(source.url)).toContain(`href="${source.url}/tree/${source.commit}"`);
    expect(render("https://github.com.attacker.test/example/repository")).not.toContain('href="https://github.com.attacker.test');
  });

  it("renders structured source findings and marks a proposed patch as untested", () => {
    const events = trace(
      { type: "finding_reported", findingId: "default-value", title: "Default input needs review", severity: "medium", confidence: "potential", summary: "A missing input follows an unexpected branch.", recommendation: "Supply an explicit default value.", evidence: ["calc.py"], callId: "finding-1", agentRole: "blue", stage: "REVIEW" },
      { type: "agent_summary", agentRole: "blue", stage: "PATCH", summary: "**Finding:** the proposed default is in `calc.py`." },
      { type: "run_end", status: "PATCH_PROPOSED", costUsd: null, elapsedMs: 2000 },
    );
    const start = events[0]!;
    if (start.type === "run_start") start.workflow = "repository_remediation";
    state.run = controller(events);
    const html = renderToStaticMarkup(<RunView runId="run-1" />);
    expect(html).toContain("Review &amp; propose fix");
    expect(html).toContain("Patch proposed · untested");
    expect(html).toContain("Default input needs review");
    expect(html).toContain("Potential");
    expect(html).toContain("Recorded source evidence");
    expect(html).toContain("Supply an explicit default value.");
    expect(html).toContain("Findings &amp; patch");
    expect(html).toContain("Source patch · untested");
    expect(html).toContain(">Finding:</strong>");
    expect(html).toContain(">calc.py</code>");
    expect(html).not.toContain("**Finding:**");
    expect(html).not.toContain("Create draft PR");
    const evidence = renderToStaticMarkup(<EvidencePanel view={state.run.view!} source={state.run.source} focusPhase={null} />);
    expect(evidence).toContain("source patch · tests not run");
    expect(evidence).not.toContain(">Gates<");
  });
});
