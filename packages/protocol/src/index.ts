export type Condition = "A" | "B" | "C";

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
  | "NOT_REPRODUCIBLE"
  | "FAILED_NO_FIX"
  | "BROKE_FUNCTION"
  | "BUDGET_TIMEOUT"
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
  runId: string;
  seq: number;
  ts: number;
  type: string;
}

export interface RunStartEvent extends BaseEvent {
  type: "run_start";
  configHash: string;
  taskId: string;
  condition: Condition;
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
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  name: string;
  result: unknown;
  truncated: boolean;
}

export interface ModelMsgEvent extends BaseEvent {
  type: "model_msg";
  role: "system" | "user" | "assistant" | "tool";
  tokensIn: number;
  tokensOut: number;
}

export interface BudgetUpdateEvent extends BaseEvent {
  type: "budget_update";
  tokens: number;
  steps: number;
  elapsedMs: number;
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
  costUsd: number;
  elapsedMs: number;
}

export type HarnessEvent =
  | RunStartEvent
  | StateChangeEvent
  | ToolCallEvent
  | ToolResultEvent
  | ModelMsgEvent
  | BudgetUpdateEvent
  | DiffSnapshotEvent
  | GradeEvent
  | RunEndEvent;

/** Distributive Omit so union members keep their discriminant-specific fields. */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** An event as emitted by callers, before the logger stamps runId/seq/ts. */
export type EventInput = DistributiveOmit<HarnessEvent, "runId" | "seq" | "ts">;

export interface RunConfig {
  model: string;
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
