import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  Condition,
  HarnessEvent,
  GradeMetrics,
  RunConfig,
  RunRecord,
  RunStatus,
  Task,
} from "@vouch/protocol";
import {
  createWorktree,
  getDiff,
  listDirTool,
  resetWorktree,
  runTestCommand,
} from "@vouch/sandbox";
import { gradeRun } from "@vouch/grader";
import {
  buildBluePrompt,
  buildContextPrompt,
  systemPromptB,
  systemPromptBlue,
} from "@vouch/skills";
import {
  BudgetExceededError,
  RunBudget,
  RunCancelledError,
  ScriptedRunner,
  type AgentRunner,
  type ModelSpec,
  type ProviderKind,
} from "@vouch/model";
import { EventLogger } from "./logger.js";
import { configHash } from "./config.js";
import { buildTools } from "./agent-tools.js";
import { buildReproScript, buildSolutionScript } from "./scripted-solution.js";
import {
  REPRO_PATH,
  buildRunReproTool,
  buildSubmitReproTool,
  runReproOutcome,
  type ReproState,
} from "./repro-tools.js";

export interface ExecuteRunOptions {
  task: Task;
  config: RunConfig;
  runsDir: string;
  repoRoot: string;
  benchDir: string;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
}

const STEP_TIMEOUT_MS = 60_000;

function makeRunId(taskId: string, condition: Condition, seed: number): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) throw new Error("invalid benchmark task ID");
  return `${taskId}__${condition}__seed${seed}__${Date.now()}__${randomUUID()}`;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Runner selection
// ---------------------------------------------------------------------------

export type Role = "solo" | "red" | "blue";

export interface RunnerSelection {
  runner: AgentRunner;
  /** Model id actually sent to the provider for this role. */
  model: string;
  label: string;
}

/** Optional model for reviewing the supplied report and regression evidence. */
export function redSpecFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSpec | null {
  const model = env["VOUCH_RED_MODEL"];
  if (!model) return null;
  const provider = env["VOUCH_RED_PROVIDER"] ?? "compatible";
  if (!["compatible", "anthropic", "openai"].includes(provider)) {
    throw new Error("VOUCH_RED_PROVIDER must be compatible, anthropic, or openai");
  }
  return {
    provider: provider as ProviderKind,
    model,
    baseURL: env["VOUCH_RED_BASE_URL"],
    apiKeyEnv: env["VOUCH_RED_API_KEY_ENV"],
  };
}

function scriptedRunner(role: Role, task: Task, benchDir: string): RunnerSelection | null {
  const taskDir = resolve(benchDir, "tasks", task.id);
  if (role === "red") {
    const repro = join(taskDir, "repro", REPRO_PATH);
    if (!existsSync(repro)) return null;
    return {
      runner: new ScriptedRunner(buildReproScript(repro)),
      model: "scripted",
      label: "scripted-repro",
    };
  }
  const solutionDir = join(taskDir, "solution");
  if (!existsSync(solutionDir)) return null;
  return {
    runner: new ScriptedRunner(buildSolutionScript(solutionDir)),
    model: "scripted",
    label: "scripted-solution",
  };
}

export function selectRunner(
  role: Role,
  task: Task,
  benchDir: string,
  config: RunConfig,
): RunnerSelection {
  if ((config.mode ?? "live") !== "scripted") {
    throw new Error("legacy benchmark fixtures require explicit scripted mode; use --repo with a supplied --report and --regression for live repair");
  }
  const scripted = scriptedRunner(role, task, benchDir);
  if (scripted) return scripted;
  throw new Error(
    `no supplied scripted ${role} artifact for task ${task.id}`,
  );
}

// ---------------------------------------------------------------------------
// Shared run scaffolding
// ---------------------------------------------------------------------------

interface RunContext {
  task: Task;
  config: RunConfig;
  benchDir: string;
  logger: EventLogger;
  worktreeDir: string;
  extraPath: string;
  testCmd: string;
  fileTree: string[];
  publicTestFiles: Array<[string, string]>;
  budget: RunBudget;
}

interface Outcome {
  status: RunStatus;
  metrics: GradeMetrics;
  inputTokens: number;
  outputTokens: number;
}

async function diffAndGrade(ctx: RunContext): Promise<Pick<Outcome, "status" | "metrics">> {
  ctx.budget.assertActive();
  const diff = await getDiff(ctx.worktreeDir, { signal: ctx.budget.signal, timeoutMs: remainingTimeout(ctx) });
  ctx.logger.emit({ type: "diff_snapshot", patch: diff.patch });
  const grade = await gradeRun({
    benchDir: ctx.benchDir,
    taskId: ctx.task.id,
    taskKind: ctx.task.kind,
    worktreeDir: ctx.worktreeDir,
    changedFiles: diff.changedFiles,
    diffLineCount: diff.lineCount,
    timeoutMs: remainingTimeout(ctx),
    extraPath: ctx.extraPath,
    signal: ctx.budget.signal,
    remainingTimeoutMs: () => remainingTimeout(ctx),
  });
  ctx.logger.emit({ type: "grade", metrics: grade.metrics });
  ctx.budget.assertActive();
  return { status: grade.status, metrics: grade.metrics };
}

function remainingTimeout(ctx: RunContext): number {
  ctx.budget.assertActive();
  return Math.max(1, Math.min(STEP_TIMEOUT_MS, ctx.budget.limits.maxWallMs - ctx.budget.elapsedMs));
}

export function gatedStatus(status: RunStatus, regressionPassed: boolean, functionalPassed: boolean): RunStatus {
  if (!functionalPassed) return "BROKE_FUNCTION";
  if (!regressionPassed) return "FAILED_NO_FIX";
  return status;
}

/** Legacy baseline wiring check with an explicit supplied solution. */
async function runBaseline(ctx: RunContext): Promise<Outcome> {
  const { task, config, logger } = ctx;
  const tools = buildTools({
    worktreeDir: ctx.worktreeDir,
    testCmd: ctx.testCmd,
    timeoutMs: STEP_TIMEOUT_MS,
    extraPath: ctx.extraPath,
    signal: ctx.budget.signal,
    remainingTimeoutMs: () => remainingTimeout(ctx),
    protectedPaths: task.publicTests,
  });
  const sel = selectRunner("solo", task, ctx.benchDir, config);

  logger.emit({ type: "state_change", from: "CONTEXT", to: "PATCH" });
  logger.emit({ type: "role_assigned", role: "solo", runner: sel.label, model: sel.model, provider: "scripted" });
  const result = await sel.runner.run({
    system: systemPromptB(),
    prompt: buildContextPrompt({ task, fileTree: ctx.fileTree, publicTestFiles: ctx.publicTestFiles }),
    tools,
    budgets: config.budgets,
    budget: ctx.budget,
    role: "solo",
    stage: "PATCH",
    seed: config.seed,
    model: sel.model,
    onEvent: (e) => logger.emit(e),
  });

  logger.emit({ type: "state_change", from: "PATCH", to: "VERIFY" });
  const graded = await diffAndGrade(ctx);
  logger.emit({ type: "state_change", from: "VERIFY", to: "REVIEW" });
  logger.emit({ type: "state_change", from: "REVIEW", to: "DONE" });
  return { ...graded, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/** Validate the supplied fixture regression, apply its solution, and enforce verification. */
async function runHarness(ctx: RunContext): Promise<Outcome> {
  const { task, config, logger } = ctx;
  const common = {
    worktreeDir: ctx.worktreeDir, timeoutMs: STEP_TIMEOUT_MS, extraPath: ctx.extraPath,
    signal: ctx.budget.signal, remainingTimeoutMs: () => remainingTimeout(ctx),
    protectedPaths: [...task.publicTests, REPRO_PATH],
  };
  const state: ReproState = { path: REPRO_PATH, reproduced: false, submissions: 0 };
  const reproCtx = { ...common, state };
  const baseTools = buildTools({ ...common, testCmd: ctx.testCmd });
  const context = { task, fileTree: ctx.fileTree, publicTestFiles: ctx.publicTestFiles };
  let inputTokens = 0;
  let outputTokens = 0;

  // REPRODUCE
  const red = selectRunner("red", task, ctx.benchDir, config);
  logger.emit({ type: "state_change", from: "CONTEXT", to: "REPRODUCE" });
  logger.emit({ type: "role_assigned", role: "red", runner: red.label, model: red.model, provider: "scripted" });
  const redResult = await red.runner.run({
    system: "Validate the supplied fixture regression.",
    prompt: task.report.text,
    tools: [buildSubmitReproTool(reproCtx)],
    budgets: config.budgets,
    budget: ctx.budget,
    role: "red",
    stage: "REPRODUCE",
    seed: config.seed,
    model: red.model,
    onEvent: (e) => logger.emit(e),
  });
  inputTokens += redResult.inputTokens;
  outputTokens += redResult.outputTokens;

  logger.emit({
    type: "gate",
    phase: "reproduce",
    reproduced: state.reproduced,
    submissions: state.submissions,
  });

  if (state.outcome !== "passed" && state.outcome !== "assertion_failed") {
    throw new Error(`supplied regression could not be validated: ${state.outcome ?? "not executed"}`);
  }

  if (!state.reproduced) {
    // The gate refuses to patch without proof: revert Red's scratch work so
    // the diff is exactly zero, then let the external grader score it.
    await resetWorktree(ctx.worktreeDir, { signal: ctx.budget.signal, timeoutMs: remainingTimeout(ctx) });
    logger.emit({ type: "state_change", from: "REPRODUCE", to: "VERIFY" });
    const graded = await diffAndGrade(ctx);
    logger.emit({ type: "state_change", from: "VERIFY", to: "DONE" });
    return { ...graded, inputTokens, outputTokens };
  }

  // PATCH
  const blue = selectRunner("blue", task, ctx.benchDir, config);
  logger.emit({ type: "state_change", from: "REPRODUCE", to: "PATCH" });
  logger.emit({ type: "role_assigned", role: "blue", runner: blue.label, model: blue.model, provider: "scripted" });
  const blueResult = await blue.runner.run({
    system: systemPromptBlue(),
    prompt: buildBluePrompt(context, state.path),
    tools: [...baseTools, buildRunReproTool(reproCtx)],
    budgets: config.budgets,
    budget: ctx.budget,
    role: "blue",
    stage: "PATCH",
    seed: config.seed,
    model: blue.model,
    onEvent: (e) => logger.emit(e),
  });
  inputTokens += blueResult.inputTokens;
  outputTokens += blueResult.outputTokens;

  // VERIFY (completion gate, harness-run; independent of what the model claimed)
  logger.emit({ type: "state_change", from: "PATCH", to: "VERIFY" });
  const regressionOutcome = await runReproOutcome(reproCtx);
  if (regressionOutcome === "cancelled") ctx.budget.assertActive();
  if (regressionOutcome === "timeout" || regressionOutcome === "invalid" || regressionOutcome === "error") {
    throw new Error(`regression verification failed to complete: ${regressionOutcome}`);
  }
  const pocNeutralized = regressionOutcome === "passed";
  const functional = await runTestCommand(ctx.worktreeDir, ctx.testCmd, {
    timeoutMs: remainingTimeout(ctx),
    extraPath: ctx.extraPath,
    signal: ctx.budget.signal,
  });
  if (functional.cancelled) ctx.budget.assertActive();
  if (functional.timedOut || (!functional.passed && functional.exitCode !== 1)) {
    throw new Error(`functional verification failed to complete: ${functional.timedOut ? "timeout" : `exit ${functional.exitCode}`}`);
  }
  logger.emit({
    type: "gate",
    phase: "verify",
    pocNeutralized,
    functionalPassed: functional.passed,
    passed: pocNeutralized && functional.passed,
  });

  const graded = await diffAndGrade(ctx);
  logger.emit({ type: "state_change", from: "VERIFY", to: "REVIEW" });
  logger.emit({ type: "state_change", from: "REVIEW", to: "DONE" });
  return { ...graded, status: gatedStatus(graded.status, pocNeutralized, functional.passed), inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeRun(opts: ExecuteRunOptions): Promise<RunRecord> {
  const { task, runsDir, repoRoot, benchDir } = opts;
  const config: RunConfig = Object.freeze({ ...opts.config, budgets: Object.freeze({ ...opts.config.budgets }) });
  const runId = makeRunId(task.id, config.condition, config.seed);
  const logger = new EventLogger(runId, join(runsDir, `${runId}.jsonl`), opts.onEvent);
  const hash = configHash(config, task.id);
  const startedAt = Date.now();
  const extraPath = resolve(repoRoot, "node_modules/.bin");
  const testCmd = task.testCmd ?? "vitest run";

  logger.emit({
    type: "run_start",
    runKind: "benchmark",
    configHash: hash,
    taskId: task.id,
    condition: config.condition,
    model: config.model,
    mode: config.mode ?? "live",
    seed: config.seed,
    budgets: config.budgets,
  });

  let status: RunStatus = "INFRA_ERROR";
  let reason: string | undefined;
  let metrics: GradeMetrics | null = null;
  let costUsd = 0;
  let worktree: { dir: string; cleanup: () => void } | undefined;
  let budget: RunBudget | undefined;

  try {
    if ((config.mode ?? "live") !== "scripted") {
      throw new Error("legacy benchmark fixtures require explicit scripted mode; use --repo with a supplied --report and --regression for live repair");
    }
    budget = new RunBudget(config.budgets, opts.signal);
    budget.assertActive();
    logger.emit({ type: "state_change", from: "INIT", to: "CONTEXT" });
    worktree = await createWorktree({
      repoRoot,
      sourcePath: task.repoRef.url,
      runId,
      signal: budget.signal,
      timeoutMs: Math.max(1, Math.min(20_000, budget.limits.maxWallMs - budget.elapsedMs)),
    });

    const ctx: RunContext = {
      task,
      config,
      benchDir,
      logger,
      worktreeDir: worktree.dir,
      extraPath,
      testCmd,
      fileTree: listDirTool(worktree.dir),
      publicTestFiles: task.publicTests.map((p) => [p, safeRead(join(worktree!.dir, p))]),
      budget,
    };

    const outcome = config.condition === "C" ? await runHarness(ctx) : await runBaseline(ctx);
    status = outcome.status;
    metrics = outcome.metrics;
    costUsd = 0;
  } catch (err) {
    status = opts.signal?.aborted || err instanceof RunCancelledError ? "CANCELLED" :
      err instanceof BudgetExceededError ? "BUDGET_TIMEOUT" : "INFRA_ERROR";
    reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`run ${runId} ${status}: ${reason}\n`);
  } finally {
    budget?.dispose();
    worktree?.cleanup();
  }

  const endedAt = Date.now();
  const elapsedMs = endedAt - startedAt;
  logger.emit({ type: "run_end", status, costUsd, elapsedMs, reason });
  logger.seal();

  return {
    runId,
    taskId: task.id,
    condition: config.condition,
    model: config.model,
    seed: config.seed,
    configHash: hash,
    status,
    startedAt,
    endedAt,
    elapsedMs,
    costUsd,
    metrics,
    events: [...logger.getEvents()],
  };
}
