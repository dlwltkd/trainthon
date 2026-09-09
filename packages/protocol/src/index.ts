export type Condition = "A" | "B" | "C";
export type ExecutionMode = "live" | "scripted";
export type AgentRole = "solo" | "red" | "blue";

export type TaskKind = "vuln" | "control_fixed" | "control_na";
export type TaskSource = "real_cve" | "synthetic";
export type Split = "dev" | "eval";
export type HintLevel = 0 | 1 | 2 | 3;

export interface RepoRef {
  /** Local path (relative to repo root) or git URL of the target project. */
  url: string;
  /** Commit / ref to check out into the sandbox worktree, or "HEAD". */
  commit: string;
}

export interface TaskReport {
  /** The security report shown to the agent (identical text for B and C). */
  text: string;
  /** 0 = class only, 1 = area, 2 = file, 3 = file+function. */
  hintLevel: HintLevel;
}

export interface Task {
  id: string;
  /** Tasks derived from the same source app/pattern share a group. */
  group: string;
  kind: TaskKind;
  source: TaskSource;
  cveId?: string;
  repoRef: RepoRef;
  report: TaskReport;
  /** Public functional tests visible to the agent (subset). */
  publicTests: string[];
  /** Command the agent's run_tests tool executes (public/functional tests). */
  testCmd?: string;
  split: Split;
}

export interface Budgets {
  maxTokens: number;
  maxSteps: number;
  maxWallMs: number;
}

export type RunStatus =
  | "RUNNING"
  | "FIXED_VERIFIED"
  | "TESTS_PASSED"
  | "NOT_REPRODUCIBLE"
  | "FAILED_NO_FIX"
  | "BROKE_FUNCTION"
  | "BUDGET_TIMEOUT"
  | "CANCELLED"
  | "SETUP_ERROR"
  | "INVALID_REPRODUCTION"
  | "INFRA_ERROR";

export type EngineState =
  | "INIT"
  | "CONTEXT"
  | "REPRODUCE"
  | "PATCH"
  | "VERIFY"
  | "REVIEW"
  | "DONE";

export interface GradeMetrics {
  /** null until graded / not applicable. */
  exploitNeutralized: boolean | null;
  functionalPass: boolean | null;
  guardedFilesTouched: boolean | null;
  diffLineCount: number;
}

export interface BaseEvent {
  schemaVersion?: number;
  runId: string;
  seq: number;
  ts: number;
  type: string;
}

export interface RunStartEvent extends BaseEvent {
  type: "run_start";
  runKind: "benchmark" | "local_repository";
  configHash: string;
  taskId?: string;
  mode?: ExecutionMode;
  repository?: { name: string; commit: string; ref: string };
  condition?: Condition;
  model: string;
  seed: number;
  budgets: Budgets;
}

export interface StateChangeEvent extends BaseEvent {
  type: "state_change";
  from: EngineState;
  to: EngineState;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  name: string;
  args: unknown;
  callId?: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  outcome?: "started";
  durationMs?: number;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  name: string;
  result: unknown;
  truncated: boolean;
  callId?: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  outcome?: "succeeded" | "failed";
  durationMs?: number;
}

export interface ToolErrorEvent extends BaseEvent {
  type: "tool_error";
  name: string;
  callId: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  durationMs: number;
  outcome: "failed";
  error: string;
}

export interface ActionSummaryEvent extends BaseEvent {
  type: "action_summary";
  summary: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  callId?: string;
}

export interface AgentSummaryEvent extends BaseEvent {
  type: "agent_summary";
  summary: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface GuidanceEvent extends BaseEvent {
  type: "guidance_configured";
  id: string;
  version: string;
  agentRole: AgentRole;
}

export interface SkillCallEvent extends BaseEvent {
  type: "skill_call";
  skillId: string;
  version: string;
  reason: string;
  callId: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentUpdateEvent extends BaseEvent {
  type: "agent_update";
  summary: string;
  nextAction: string;
  evidence: string[];
  plan: AgentPlanStep[];
  callId: string;
  agentRole: AgentRole;
  stage: EngineState;
}

export interface RepositoryEvent extends BaseEvent {
  type: "repository_snapshot";
  name: string;
  commit: string;
  files: string[];
  artifact: string;
  inputHash?: string;
}

export interface FileChangeEvent extends BaseEvent {
  type: "file_change";
  path: string;
  agentRole: AgentRole;
  patch: string;
  artifact: string;
}

export interface TestRunEvent extends BaseEvent {
  type: "test_run";
  phase: string;
  outcome: string;
  passed: boolean;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  artifact: string;
  agentRole?: AgentRole;
  stage?: EngineState;
  durationMs?: number;
}

export interface ModelMsgEvent extends BaseEvent {
  type: "model_msg";
  role: "system" | "user" | "assistant" | "tool";
  tokensIn: number;
  tokensOut: number;
  agentRole?: AgentRole;
  stage?: EngineState;
}

export interface BudgetUpdateEvent extends BaseEvent {
  type: "budget_update";
  tokens: number;
  steps: number;
  elapsedMs: number;
  agentRole?: AgentRole;
  stage?: EngineState;
}

export interface DiffSnapshotEvent extends BaseEvent {
  type: "diff_snapshot";
  patch: string;
}

export interface GradeEvent extends BaseEvent {
  type: "grade";
  metrics: GradeMetrics;
}

export interface RunEndEvent extends BaseEvent {
  type: "run_end";
  status: RunStatus;
  costUsd: number | null;
  elapsedMs: number;
  reason?: string;
}

/** Which model actually served a harness role (evidence for the run record). */
export interface RoleAssignedEvent extends BaseEvent {
  type: "role_assigned";
  role: "solo" | "red" | "blue";
  runner: string;
  model?: string;
  provider?: string;
}

/**
 * Condition-C completion gate verdicts, decided by the harness (not the model).
 * `reproduce`: did Red's PoC fail on the unmodified code?
 * `verify`: after Blue, does the PoC pass and do public tests pass?
 */
export type GateEvent = BaseEvent & { type: "gate" } & (
  | { phase: "reproduce"; reproduced: boolean; submissions: number }
  | { phase: "verify"; pocNeutralized: boolean; functionalPassed: boolean; passed: boolean }
);

export type HarnessEvent =
  | RunStartEvent
  | StateChangeEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ActionSummaryEvent
  | AgentSummaryEvent
  | GuidanceEvent
  | SkillCallEvent
  | AgentUpdateEvent
  | RepositoryEvent
  | FileChangeEvent
  | TestRunEvent
  | ModelMsgEvent
  | BudgetUpdateEvent
  | DiffSnapshotEvent
  | GradeEvent
  | RoleAssignedEvent
  | GateEvent
  | RunEndEvent;

/** Distributive Omit so union members keep their discriminant-specific fields. */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** An event as emitted by callers, before the logger stamps runId/seq/ts. */
export type EventInput = DistributiveOmit<HarnessEvent, "runId" | "seq" | "ts">;

export interface RunConfig {
  mode?: ExecutionMode;
  model: string;
  /** Model provider; inferred from the model id when omitted. */
  provider?: string;
  seed: number;
  budgets: Budgets;
  condition: Condition;
  /** Version string of the grader used, part of the config hash. */
  graderVersion: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  condition: Condition;
  model: string;
  seed: number;
  configHash: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number | null;
  costUsd: number;
  metrics: GradeMetrics | null;
  events: HarnessEvent[];
}

export const DEFAULT_BUDGETS: Budgets = {
  maxTokens: 200_000,
  maxSteps: 40,
  maxWallMs: 8 * 60_000,
};
