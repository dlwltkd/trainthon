import type {
  AgentPlanStep,
  AgentRole,
  Budgets,
  EngineState,
  GateEvent,
  GradeMetrics,
  HarnessEvent,
  RunStatus,
  TestRunEvent,
} from "@vouch/protocol";
import { parseUnifiedDiff, type DiffFile } from "./diff";
import { basename } from "./format";

export const STAGES: EngineState[] = ["INIT", "CONTEXT", "REPRODUCE", "PATCH", "VERIFY", "REVIEW", "DONE"];

export const STAGE_LABEL: Record<EngineState, string> = {
  INIT: "Init",
  CONTEXT: "Context",
  REPRODUCE: "Reproduce",
  PATCH: "Patch",
  VERIFY: "Verify",
  REVIEW: "Review",
  DONE: "Done",
};

export const STAGE_HINT: Record<EngineState, string> = {
  INIT: "Preparing the run",
  CONTEXT: "Snapshot repository, baseline tests",
  REPRODUCE: "Confirm the report with a failing test",
  PATCH: "Agent edits application source",
  VERIFY: "Re-run regression + functional in a fresh workspace",
  REVIEW: "Independent grading",
  DONE: "Final verdict",
};

export type StageStatus = "pending" | "active" | "done" | "skipped";

export interface StageView {
  id: EngineState;
  status: StageStatus;
  enteredAt?: number;
  leftAt?: number;
  durationMs?: number;
}

export type ToolOutcome = "running" | "succeeded" | "failed" | "unresolved";

export interface ToolCallItem {
  kind: "tool";
  id: string;
  seq: number;
  ts: number;
  name: string;
  summary: string;
  target?: string;
  args: unknown;
  result?: unknown;
  error?: string;
  truncated?: boolean;
  outcome: ToolOutcome;
  durationMs?: number;
  agentRole?: AgentRole;
  stage?: EngineState;
  readOnly: boolean;
}

export interface CheckItem {
  kind: "check";
  id: string;
  seq: number;
  ts: number;
  stage?: EngineState;
  label: string;
  detail?: string;
  status: "passed" | "failed" | "info" | "warn";
  durationMs?: number;
  test?: TestRunEvent;
  gate?: GateEvent;
}

export interface HandoffItem {
  kind: "handoff";
  id: string;
  seq: number;
  ts: number;
  role: AgentRole;
  from?: AgentRole;
  runner: string;
  model?: string;
  provider?: string;
  stage?: EngineState;
}

export interface StageItem {
  kind: "stage";
  id: string;
  seq: number;
  ts: number;
  from: EngineState;
  to: EngineState;
}

export interface NoteItem {
  kind: "note";
  id: string;
  seq: number;
  ts: number;
  text: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  final: boolean;
}

export interface GuidanceItem {
  kind: "guidance";
  id: string;
  seq: number;
  ts: number;
  guidanceId: string;
  version: string;
  agentRole: AgentRole;
  stage?: EngineState;
}

export interface SkillItem {
  kind: "skill";
  id: string;
  seq: number;
  ts: number;
  skillId: string;
  version: string;
  reason: string;
  callId: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface DecisionItem {
  kind: "decision";
  id: string;
  seq: number;
  ts: number;
  summary: string;
  nextAction: string;
  evidence: string[];
  plan: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
  callId: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface FindingItem {
  kind: "finding";
  id: string;
  seq: number;
  ts: number;
  findingId: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: "confirmed" | "potential";
  evidence: string[];
  summary: string;
  recommendation: string;
  callId: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface ChangeItem {
  kind: "change";
  id: string;
  seq: number;
  ts: number;
  path: string;
  agentRole: AgentRole;
  additions: number;
  deletions: number;
  stage?: EngineState;
}

export interface EndItem {
  kind: "end";
  id: string;
  seq: number;
  ts: number;
  status: RunStatus;
  reason?: string;
  elapsedMs: number;
  costUsd: number | null;
}

export interface GradeItem {
  kind: "grade";
  id: string;
  seq: number;
  ts: number;
  metrics: GradeMetrics;
}

export type ActivityItem =
  | ToolCallItem
  | CheckItem
  | HandoffItem
  | StageItem
  | NoteItem
  | GuidanceItem
  | SkillItem
  | DecisionItem
  | FindingItem
  | ChangeItem
  | EndItem
  | GradeItem;

export interface RoleInfo {
  role: AgentRole;
  runner: string;
  model?: string;
  provider?: string;
}

export interface RunView {
  runId: string;
  kind: "benchmark" | "local_repository";
  mode?: string;
  workflow?: "repository_review" | "repository_repair" | "repository_remediation";
  condition?: string;
  taskId?: string;
  status: RunStatus;
  reason?: string;
  startedAt: number;
  endedAt?: number;
  lastTs: number;
  elapsedMs?: number;
  costUsd: number | null;
  budgets?: Budgets;
  usage: { tokens: number; steps: number; elapsedMs: number; modelTurns: number };
  repository?: { name: string; url?: string; commit?: string; ref?: string; files: string[] };
  stages: StageView[];
  currentStage: EngineState;
  currentRole?: AgentRole;
  roles: RoleInfo[];
  guidance: GuidanceItem[];
  skills: SkillItem[];
  decisions: DecisionItem[];
  findings: FindingItem[];
  currentDecision?: DecisionItem;
  activity: ActivityItem[];
  currentAction?: ToolCallItem;
  tools: Map<string, ToolCallItem>;
  inspectedFiles: Set<string>;
  changedFiles: Map<string, { patch: string; additions: number; deletions: number }>;
  patch: string;
  diff: DiffFile[];
  tests: TestRunEvent[];
  gates: { reproduce?: Extract<GateEvent, { phase: "reproduce" }>; verify?: Extract<GateEvent, { phase: "verify" }> };
  grade?: GradeMetrics;
  eventCount: number;
}

const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "grep", "search", "run_repro", "run_tests", "run_regression", "run_functional_tests", "use_skill", "report_progress"]);
const EXPLORE_TOOLS = new Set(["read_file", "list_dir", "grep", "search"]);

export function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name);
}

function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function toolTarget(name: string, args: unknown): string | undefined {
  return argString(args, "path") ?? argString(args, "file") ?? argString(args, "pattern") ?? argString(args, "query") ?? argString(args, "cmd") ?? argString(args, "command");
}

export function fallbackSummary(name: string, args: unknown): string {
  const target = toolTarget(name, args);
  switch (name) {
    case "read_file":
      return target ? `Reading ${target}` : "Reading a file";
    case "list_dir":
      return target ? `Listing ${target}` : "Listing the repository";
    case "grep":
    case "search":
      return target ? `Searching for “${target}”` : "Searching the code";
    case "write_file":
    case "apply_patch":
      return target ? `Updating ${target}` : "Editing source";
    case "run_tests":
    case "run_functional_tests":
      return "Running functional tests";
    case "run_regression":
    case "run_repro":
      return "Running the security regression";
    case "submit_repro":
      return "Submitting a reproduction test";
    case "apply_supplied_patch":
      return "Applying the supplied patch";
    case "run_cmd":
      return target ? `Running \`${target}\`` : "Running a command";
    case "use_skill": {
      const skill = argString(args, "skillId");
      return skill ? `Loading skill ${skill}` : "Loading a skill";
    }
    case "report_progress":
      return "Publishing plan and decision summary";
    default:
      return `Running ${name}`;
  }
}

const TEST_PHASE_LABEL: Record<string, string> = {
  "baseline-functional": "Baseline functional tests",
  "baseline-regression": "Regression on unmodified code",
  "verification-regression": "Regression after patch",
  "verification-functional": "Functional tests after patch",
};

export function testPhaseLabel(phase: string): string {
  return TEST_PHASE_LABEL[phase] ?? phase.replace(/-/g, " ");
}

function testDetail(event: TestRunEvent): string {
  const parts = [`${event.testsPassed} passed`];
  if (event.testsFailed) parts.push(`${event.testsFailed} failed`);
  if (event.testsSkipped) parts.push(`${event.testsSkipped} skipped`);
  return `${parts.join(" · ")} · ${event.outcome.replace(/_/g, " ")}`;
}

function testCheck(event: TestRunEvent): CheckItem {
  const base = {
    kind: "check" as const,
    id: `test-${event.seq}`,
    seq: event.seq,
    ts: event.ts,
    stage: event.stage,
    durationMs: event.durationMs,
    test: event,
    detail: testDetail(event),
  };
  if (event.phase === "baseline-regression") {
    if (event.outcome === "assertion_failed") {
      return { ...base, label: "Regression assertion failed on the checked commit", status: "warn" };
    }
    if (event.passed) {
      return { ...base, label: "Regression already passes — nothing to reproduce", status: "info" };
    }
    return { ...base, label: `Regression could not run (${event.outcome.replace(/_/g, " ")})`, status: "failed" };
  }
  return {
    ...base,
    label: testPhaseLabel(event.phase),
    status: event.passed ? "passed" : "failed",
  };
}

function gateCheck(event: GateEvent): CheckItem {
  const base = { kind: "check" as const, id: `gate-${event.seq}`, seq: event.seq, ts: event.ts, gate: event };
  if (event.phase === "reproduce") {
    return event.reproduced
      ? { ...base, label: "Gate · reproduction confirmed", detail: `${event.submissions} submission${event.submissions === 1 ? "" : "s"}`, status: "passed" }
      : { ...base, label: "Gate · not reproduced", detail: `${event.submissions} submission${event.submissions === 1 ? "" : "s"} · no patch will be attempted`, status: "info" };
  }
  const detail = `PoC neutralized: ${event.pocNeutralized ? "yes" : "no"} · functional: ${event.functionalPassed ? "pass" : "fail"}`;
  return {
    ...base,
    label: event.passed ? "Gate · verification passed" : "Gate · verification failed",
    detail,
    status: event.passed ? "passed" : "failed",
  };
}

function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export function deriveRun(events: HarnessEvent[]): RunView | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const start = sorted.find((e) => e.type === "run_start");
  if (!start || start.type !== "run_start") return null;

  const view: RunView = {
    runId: start.runId,
    kind: start.runKind ?? (start.taskId ? "benchmark" : "local_repository"),
    mode: start.mode,
    workflow: start.workflow,
    condition: start.condition,
    taskId: start.taskId,
    status: "RUNNING",
    startedAt: start.ts,
    lastTs: start.ts,
    costUsd: null,
    budgets: start.budgets,
    usage: { tokens: 0, steps: 0, elapsedMs: 0, modelTurns: 0 },
    repository: start.repository ? { ...start.repository, files: [] } : undefined,
    stages: STAGES.map((id) => ({ id, status: "pending" as StageStatus })),
    currentStage: "INIT",
    roles: [],
    guidance: [],
    skills: [],
    decisions: [],
    findings: [],
    activity: [],
    tools: new Map(),
    inspectedFiles: new Set(),
    changedFiles: new Map(),
    patch: "",
    diff: [],
    tests: [],
    gates: {},
    eventCount: sorted.length,
  };

  const stageIndex = (id: EngineState) => view.stages.findIndex((s) => s.id === id);
  const enter = (id: EngineState, ts: number) => {
    const stage = view.stages[stageIndex(id)];
    if (stage) {
      stage.status = "active";
      stage.enteredAt ??= ts;
    }
  };
  const leave = (id: EngineState, ts: number) => {
    const stage = view.stages[stageIndex(id)];
    if (stage) {
      stage.status = "done";
      stage.leftAt = ts;
      if (stage.enteredAt !== undefined) stage.durationMs = ts - stage.enteredAt;
    }
  };
  enter("INIT", start.ts);

  const pendingSummaries = new Map<string, string>();
  const openByName = new Map<string, ToolCallItem[]>();
  let currentRole: AgentRole | undefined;

  for (const event of sorted) {
    view.lastTs = Math.max(view.lastTs, event.ts);
    switch (event.type) {
      case "run_start":
        break;
      case "state_change": {
        leave(event.from, event.ts);
        enter(event.to, event.ts);
        view.currentStage = event.to;
        view.activity.push({ kind: "stage", id: `stage-${event.seq}`, seq: event.seq, ts: event.ts, from: event.from, to: event.to });
        break;
      }
      case "repository_snapshot": {
        view.repository = { name: event.name, url: ("url" in event && typeof event.url === "string" ? event.url : undefined) ?? view.repository?.url, commit: event.commit, ref: view.repository?.ref, files: event.files };
        break;
      }
      case "role_assigned": {
        const info: RoleInfo = { role: event.role, runner: event.runner, model: event.model, provider: event.provider };
        view.roles = [...view.roles.filter((r) => r.role !== event.role), info];
        view.activity.push({
          kind: "handoff",
          id: `role-${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          role: event.role,
          from: currentRole && currentRole !== event.role ? currentRole : undefined,
          runner: event.runner,
          model: event.model,
          provider: event.provider,
          stage: view.currentStage,
        });
        currentRole = event.role;
        view.currentRole = event.role;
        break;
      }
      case "guidance_configured": {
        const item: GuidanceItem = {
          kind: "guidance",
          id: `guidance-${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          guidanceId: event.id,
          version: event.version,
          agentRole: event.agentRole,
          stage: view.currentStage,
        };
        view.guidance.push(item);
        view.activity.push(item);
        break;
      }
      case "skill_call": {
        const item: SkillItem = { ...event, kind: "skill", id: `skill-${event.seq}` };
        view.skills.push(item);
        view.activity.push(item);
        break;
      }
      case "agent_update": {
        const item: DecisionItem = { ...event, kind: "decision", id: `decision-${event.seq}` };
        view.decisions.push(item);
        view.currentDecision = item;
        view.activity.push(item);
        break;
      }
      case "finding_reported": {
        const item: FindingItem = { ...event, kind: "finding", id: `finding-${event.seq}` };
        view.findings = [...view.findings.filter((finding) => finding.findingId !== item.findingId), item];
        view.activity.push(item);
        break;
      }
      case "action_summary": {
        if (event.callId) {
          const existing = view.tools.get(event.callId);
          if (existing) existing.summary = event.summary;
          else pendingSummaries.set(event.callId, event.summary);
        } else {
          view.activity.push({
            kind: "note",
            id: `note-${event.seq}`,
            seq: event.seq,
            ts: event.ts,
            text: event.summary,
            agentRole: event.agentRole ?? currentRole,
            stage: event.stage ?? view.currentStage,
            final: false,
          });
        }
        break;
      }
      case "agent_summary": {
        view.activity.push({
          kind: "note",
          id: `summary-${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          text: event.summary,
          agentRole: event.agentRole,
          stage: event.stage,
          final: true,
        });
        break;
      }
      case "tool_call": {
        const id = event.callId ?? `tool-${event.seq}`;
        const item: ToolCallItem = {
          kind: "tool",
          id,
          seq: event.seq,
          ts: event.ts,
          name: event.name,
          summary: pendingSummaries.get(id) ?? fallbackSummary(event.name, event.args),
          target: toolTarget(event.name, event.args),
          args: event.args,
          outcome: "running",
          agentRole: event.agentRole ?? currentRole,
          stage: event.stage ?? view.currentStage,
          readOnly: READ_ONLY_TOOLS.has(event.name),
        };
        pendingSummaries.delete(id);
        view.tools.set(id, item);
        view.activity.push(item);
        if (!event.callId) {
          const queue = openByName.get(event.name) ?? [];
          queue.push(item);
          openByName.set(event.name, queue);
        }
        break;
      }
      case "tool_result":
      case "tool_error": {
        let item = event.callId ? view.tools.get(event.callId) : undefined;
        if (!item) {
          const queue = openByName.get(event.name);
          item = queue?.shift();
        }
        if (!item) break;
        item.durationMs = event.durationMs ?? event.ts - item.ts;
        if (event.type === "tool_error") {
          item.outcome = "failed";
          item.error = event.error;
        } else {
          item.result = event.result;
          item.truncated = event.truncated;
          item.outcome = event.outcome === "failed" ? "failed" : "succeeded";
          if (item.target && item.outcome === "succeeded" && (item.name === "read_file" || item.name === "list_dir")) {
            view.inspectedFiles.add(item.target);
          }
          if (item.name === "write_file" || item.name === "apply_patch") {
            const target = item.target;
            const ok = typeof event.result === "object" && event.result !== null ? (event.result as { ok?: unknown }).ok !== false : true;
            if (target && ok) view.inspectedFiles.add(target);
          }
        }
        break;
      }
      case "test_run": {
        view.tests.push(event);
        view.activity.push(testCheck(event));
        break;
      }
      case "gate": {
        if (event.phase === "reproduce") view.gates.reproduce = event;
        else view.gates.verify = event;
        view.activity.push(gateCheck(event));
        break;
      }
      case "file_change": {
        const counts = countPatch(event.patch);
        view.changedFiles.set(event.path, { patch: event.patch, ...counts });
        view.activity.push({
          kind: "change",
          id: `change-${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          path: event.path,
          agentRole: event.agentRole,
          stage: view.currentStage,
          ...counts,
        });
        break;
      }
      case "diff_snapshot": {
        view.patch = event.patch;
        break;
      }
      case "model_msg": {
        view.usage.tokens += event.tokensIn + event.tokensOut;
        if (event.role === "assistant") view.usage.modelTurns++;
        break;
      }
      case "budget_update": {
        view.usage.tokens = Math.max(view.usage.tokens, event.tokens);
        view.usage.steps = Math.max(view.usage.steps, event.steps);
        view.usage.elapsedMs = Math.max(view.usage.elapsedMs, event.elapsedMs);
        break;
      }
      case "grade": {
        view.grade = event.metrics;
        view.activity.push({ kind: "grade", id: `grade-${event.seq}`, seq: event.seq, ts: event.ts, metrics: event.metrics });
        break;
      }
      case "run_end": {
        view.status = event.status;
        view.reason = event.reason;
        view.endedAt = event.ts;
        view.elapsedMs = event.elapsedMs;
        view.costUsd = event.costUsd;
        view.activity.push({
          kind: "end",
          id: `end-${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          status: event.status,
          reason: event.reason,
          elapsedMs: event.elapsedMs,
          costUsd: event.costUsd,
        });
        break;
      }
    }
  }

  view.diff = parseUnifiedDiff(view.patch);
  for (const file of view.diff) {
    if (file.generated) continue;
    if (!view.changedFiles.has(file.path)) {
      view.changedFiles.set(file.path, { patch: "", additions: file.additions, deletions: file.deletions });
    }
  }
  if (view.diff.length === 0 && view.changedFiles.size > 0) {
    view.patch = [...view.changedFiles.values()].map((c) => c.patch).filter(Boolean).join("\n");
    view.diff = parseUnifiedDiff(view.patch);
  }

  if (view.endedAt !== undefined) {
    for (const tool of view.tools.values()) {
      if (tool.outcome === "running") tool.outcome = "unresolved";
    }
    for (const stage of view.stages) {
      if (stage.status === "active") {
        stage.status = "done";
        stage.leftAt = view.endedAt;
        if (stage.enteredAt !== undefined) stage.durationMs = view.endedAt - stage.enteredAt;
      } else if (stage.status === "pending") {
        stage.status = "skipped";
      }
    }
  } else {
    for (const tool of view.tools.values()) {
      if (tool.outcome === "running") {
        view.currentAction = tool;
      }
    }
  }

  return view;
}

export interface EvidenceTarget {
  kind: "file" | "test" | "activity";
  value: string;
}

export function resolveEvidence(reference: string, view: RunView, files: string[]): EvidenceTarget | null {
  const file = reference.replace(/:\d+(?::\d+)?$/, "");
  if (files.includes(file)) return { kind: "file", value: file };
  const toolId = reference.replace(/^tool:/, "");
  if (view.tools.has(toolId)) return { kind: "activity", value: toolId };
  const phase = reference.replace(/^test:/, "");
  const test = view.tests.find((entry) => entry.phase === phase || entry.artifact === reference || entry.artifact.endsWith(`/${reference}`));
  if (test) return { kind: "test", value: test.phase };
  const activity = view.activity.find((entry) => entry.id === reference || `event:${entry.seq}` === reference);
  return activity ? { kind: "activity", value: activity.id } : null;
}

export function statusTone(status: RunStatus): "pass" | "fail" | "info" | "warn" | "neutral" | "running" {
  switch (status) {
    case "RUNNING":
      return "running";
    case "FIXED_VERIFIED":
    case "TESTS_PASSED":
      return "pass";
    case "NOT_REPRODUCIBLE":
    case "REVIEW_COMPLETE":
      return "info";
    case "FAILED_NO_FIX":
    case "BROKE_FUNCTION":
    case "INVALID_REPRODUCTION":
      return "fail";
    case "BUDGET_TIMEOUT":
    case "CANCELLED":
    case "INCOMPLETE_REVIEW":
    case "PATCH_PROPOSED":
      return "warn";
    default:
      return "neutral";
  }
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  RUNNING: "Running",
  FIXED_VERIFIED: "Fixed · verified",
  TESTS_PASSED: "Tests passed",
  REVIEW_COMPLETE: "Review complete",
  INCOMPLETE_REVIEW: "Incomplete review",
  PATCH_PROPOSED: "Patch proposed · untested",
  NOT_REPRODUCIBLE: "Not reproducible",
  FAILED_NO_FIX: "No fix",
  BROKE_FUNCTION: "Broke function",
  BUDGET_TIMEOUT: "Budget timeout",
  CANCELLED: "Cancelled",
  SETUP_ERROR: "Setup error",
  INVALID_REPRODUCTION: "Invalid reproduction",
  INFRA_ERROR: "Infra error",
};

export function statusDescription(view: RunView): string {
  switch (view.status) {
    case "PATCH_PROPOSED":
      return "A source patch was proposed from code inspection. Tests were not run. Review the diff and findings before delivery.";
    case "REVIEW_COMPLETE":
      return "Read-only source review completed. Findings describe the inspected code; tests were not run.";
    case "INCOMPLETE_REVIEW":
      return "The source review ended before a complete summary was recorded. Inspect the available notes and evidence.";
    case "TESTS_PASSED":
      return "Supplied regression and protected functional tests pass in a fresh workspace. Scope: repository tests, no independent grader — needs code review.";
    case "FIXED_VERIFIED":
      return "Hidden grader confirmed the exploit is neutralized and functional tests pass.";
    case "NOT_REPRODUCIBLE":
      return "The supplied regression did not fail on the checked commit. No patch was attempted (0 lines changed).";
    case "FAILED_NO_FIX":
      return "The regression still fails after the agent's changes.";
    case "BROKE_FUNCTION":
      return "The regression passes but functional tests now fail.";
    case "RUNNING":
      return isRepositoryReview(view) ? "The agent is reviewing source for the requested task." : "The harness is executing.";
    default:
      return view.reason ?? "";
  }
}

export function isRepositoryReview(view: Pick<RunView, "workflow" | "status">): boolean {
  return view.workflow === "repository_review" || view.status === "REVIEW_COMPLETE" || view.status === "INCOMPLETE_REVIEW";
}

export function isRepositoryRemediation(view: Pick<RunView, "workflow" | "status">): boolean {
  return view.workflow === "repository_remediation" || view.status === "PATCH_PROPOSED";
}

export function repositoryWorkflowLabel(view: Pick<RunView, "workflow" | "status">): string {
  return isRepositoryRemediation(view) ? "Review & propose fix" : isRepositoryReview(view) ? "Repository review" : "Repair with regression";
}

export function roleLabel(role: AgentRole | undefined): string {
  if (role === "red") return "Red";
  if (role === "blue") return "Blue";
  if (role === "solo") return "Agent";
  return "Harness";
}

export function fileLabel(path: string): string {
  return basename(path);
}

/** Group consecutive read-only exploration calls from one role so long scans stay compact. */
export type FeedEntry = ActivityItem | { kind: "group"; id: string; seq: number; ts: number; items: ToolCallItem[]; agentRole?: AgentRole; stage?: EngineState };

export function groupActivity(items: ActivityItem[], minGroup = 3): FeedEntry[] {
  const out: FeedEntry[] = [];
  let run: ToolCallItem[] = [];
  const flush = () => {
    if (run.length >= minGroup) {
      const first = run[0]!;
      out.push({ kind: "group", id: `group-${first.seq}`, seq: first.seq, ts: first.ts, items: run, agentRole: first.agentRole, stage: first.stage });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && isExploreTool(item.name) && item.outcome === "succeeded") {
      const prev = run.at(-1);
      if (prev && (prev.agentRole !== item.agentRole || prev.stage !== item.stage)) flush();
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}
