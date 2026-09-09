import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Condition,
  GradeMetrics,
  HarnessEvent,
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
  buildRedPrompt,
  systemPromptB,
  systemPromptBlue,
  systemPromptRed,
} from "@vouch/skills";
import {
  computeCost,
  createRunnerForSpec,
  providerForModel,
  resolveRunnerFromEnv,
  ScriptedRunner,
  type AgentRunner,
  type ModelSpec,
  type ProviderKind,
  type ProviderName,
} from "@vouch/model";
import { EventLogger } from "./logger.js";
import { configHash } from "./config.js";
import { buildTools } from "./agent-tools.js";
import { buildReproScript, buildSolutionScript } from "./scripted-solution.js";
import {
  REPRO_PATH,
  buildRunReproTool,
  buildSubmitReproTool,
  reproPasses,
  type ReproState,
} from "./repro-tools.js";

export interface ExecuteRunOptions {
  task: Task;
  config: RunConfig;
  runsDir: string;
  repoRoot: string;
  benchDir: string;
  /** Override the generated id (server uses this so SSE can subscribe first). */
  runId?: string;
  /** Live subscriber (SSE). The JSONL file remains the source of truth. */
  onEvent?: (event: HarnessEvent) => void;
}

const STEP_TIMEOUT_MS = 60_000;

export function makeRunId(taskId: string, condition: Condition, seed: number): string {
  return `${taskId}__${condition}__seed${seed}__${Date.now()}`;
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

function baseRunner(config: RunConfig): RunnerSelection | null {
  const preferred = (config.provider ?? providerForModel(config.model)) as
    | ProviderName
    | undefined;
  const resolved = resolveRunnerFromEnv({ preferred, model: config.model });
  if (!resolved) return null;
  return {
    runner: resolved.runner,
    model: resolved.model,
    label: `${resolved.provider}:${resolved.model}`,
  };
}

/**
 * Optional Red-role override. Safety-tuned frontier models often refuse to
 * write proof-of-concept exploits, so Red can be routed to a less restricted
 * model on an OpenAI-compatible gateway (Routeway by default):
 *   VOUCH_RED_MODEL        model id on the gateway (required to enable)
 *   VOUCH_RED_PROVIDER     compatible | anthropic | openai   (default compatible)
 *   VOUCH_RED_BASE_URL     gateway base URL                   (default Routeway)
 *   VOUCH_RED_API_KEY_ENV  env var holding the key            (default ROUTEWAY_API_KEY)
 */
export function redSpecFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSpec | null {
  const model = env["VOUCH_RED_MODEL"];
  if (!model) return null;
  return {
    provider: (env["VOUCH_RED_PROVIDER"] as ProviderKind | undefined) ?? "compatible",
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
  if (role === "red") {
    const spec = redSpecFromEnv();
    const redRunner = spec ? createRunnerForSpec(spec) : null;
    if (spec && redRunner) {
      return { runner: redRunner, model: spec.model, label: `red:${spec.provider}:${spec.model}` };
    }
  }
  const base = baseRunner(config);
  if (base) return base;
  const scripted = scriptedRunner(role, task, benchDir);
  if (scripted) return scripted;
  if (role !== "red") {
    return {
      runner: new ScriptedRunner(async (tools) => {
        if (tools["run_tests"]) await tools["run_tests"]({});
        return "no scripted artifact; public tests only";
      }),
      model: "scripted",
      label: "scripted-noop",
    };
  }
  throw new Error(
    `no model API key (set ANTHROPIC_API_KEY or OPENAI_API_KEY) and no scripted ${role} artifact for task ${task.id}`,
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
}

interface Outcome {
  status: RunStatus;
  metrics: GradeMetrics;
  inputTokens: number;
  outputTokens: number;
}

async function diffAndGrade(ctx: RunContext): Promise<Pick<Outcome, "status" | "metrics">> {
  const diff = await getDiff(ctx.worktreeDir);
  ctx.logger.emit({ type: "diff_snapshot", patch: diff.patch });
  const grade = await gradeRun({
    benchDir: ctx.benchDir,
    taskId: ctx.task.id,
    taskKind: ctx.task.kind,
    worktreeDir: ctx.worktreeDir,
    changedFiles: diff.changedFiles,
    diffLineCount: diff.lineCount,
    timeoutMs: STEP_TIMEOUT_MS,
    extraPath: ctx.extraPath,
  });
  ctx.logger.emit({ type: "grade", metrics: grade.metrics });
  return { status: grade.status, metrics: grade.metrics };
}

/** Condition B: one agent, no gate. The model decides when it is done. */
async function runBaseline(ctx: RunContext): Promise<Outcome> {
  const { task, config, logger } = ctx;
  const tools = buildTools({
    worktreeDir: ctx.worktreeDir,
    testCmd: ctx.testCmd,
    timeoutMs: STEP_TIMEOUT_MS,
    extraPath: ctx.extraPath,
  });
  const sel = selectRunner("solo", task, ctx.benchDir, config);

  logger.emit({ type: "state_change", from: "CONTEXT", to: "PATCH" });
  logger.emit({ type: "role_assigned", role: "solo", runner: sel.label });
  const result = await sel.runner.run({
    system: systemPromptB(),
    prompt: buildContextPrompt({ task, fileTree: ctx.fileTree, publicTestFiles: ctx.publicTestFiles }),
    tools,
    budgets: config.budgets,
    model: sel.model,
    onEvent: (e) => logger.emit(e),
  });

  logger.emit({ type: "state_change", from: "PATCH", to: "VERIFY" });
  const graded = await diffAndGrade(ctx);
  logger.emit({ type: "state_change", from: "VERIFY", to: "REVIEW" });
  logger.emit({ type: "state_change", from: "REVIEW", to: "DONE" });
  return { ...graded, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/**
 * Condition C: proof-carrying harness.
 *   REPRODUCE  Red must make a PoC test fail on the unmodified code.
 *              No proof -> revert everything, stop. (Controls end here, diff=0.)
 *   PATCH      Blue edits until the PoC passes and public tests pass.
 *   VERIFY     Harness re-runs PoC + public tests itself (completion gate),
 *              then the hidden external grader scores the result exactly as in B.
 */
async function runHarness(ctx: RunContext): Promise<Outcome> {
  const { task, config, logger } = ctx;
  const common = { worktreeDir: ctx.worktreeDir, timeoutMs: STEP_TIMEOUT_MS, extraPath: ctx.extraPath };
  const state: ReproState = { path: REPRO_PATH, reproduced: false, submissions: 0 };
  const reproCtx = { ...common, state };
  const baseTools = buildTools({ ...common, testCmd: ctx.testCmd });
  const readOnly = baseTools.filter((t) => t.name !== "write_file");
  const context = { task, fileTree: ctx.fileTree, publicTestFiles: ctx.publicTestFiles };
  let inputTokens = 0;
  let outputTokens = 0;

  // REPRODUCE
  const red = selectRunner("red", task, ctx.benchDir, config);
  logger.emit({ type: "state_change", from: "CONTEXT", to: "REPRODUCE" });
  logger.emit({ type: "role_assigned", role: "red", runner: red.label });
  const redResult = await red.runner.run({
    system: systemPromptRed(),
    prompt: buildRedPrompt(context),
    tools: [...readOnly, buildSubmitReproTool(reproCtx)],
    budgets: config.budgets,
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

  if (!state.reproduced) {
    // The gate refuses to patch without proof: revert Red's scratch work so
    // the diff is exactly zero, then let the external grader score it.
    await resetWorktree(ctx.worktreeDir);
    logger.emit({ type: "state_change", from: "REPRODUCE", to: "VERIFY" });
    const graded = await diffAndGrade(ctx);
    logger.emit({ type: "state_change", from: "VERIFY", to: "DONE" });
    return { ...graded, inputTokens, outputTokens };
  }

  // PATCH
  const blue = selectRunner("blue", task, ctx.benchDir, config);
  logger.emit({ type: "state_change", from: "REPRODUCE", to: "PATCH" });
  logger.emit({ type: "role_assigned", role: "blue", runner: blue.label });
  const blueResult = await blue.runner.run({
    system: systemPromptBlue(),
    prompt: buildBluePrompt(context, state.path),
    tools: [...baseTools, buildRunReproTool(reproCtx)],
    budgets: config.budgets,
    model: blue.model,
    onEvent: (e) => logger.emit(e),
  });
  inputTokens += blueResult.inputTokens;
  outputTokens += blueResult.outputTokens;

  // VERIFY (completion gate, harness-run; independent of what the model claimed)
  logger.emit({ type: "state_change", from: "PATCH", to: "VERIFY" });
  const pocNeutralized = await reproPasses(reproCtx);
  const functional = await runTestCommand(ctx.worktreeDir, ctx.testCmd, {
    timeoutMs: STEP_TIMEOUT_MS,
    extraPath: ctx.extraPath,
  });
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
  return { ...graded, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeRun(opts: ExecuteRunOptions): Promise<RunRecord> {
  const { task, config, runsDir, repoRoot, benchDir } = opts;
  const runId = opts.runId ?? makeRunId(task.id, config.condition, config.seed);
  const logger = new EventLogger(runId, join(runsDir, `${runId}.jsonl`), opts.onEvent);
  const hash = configHash(config, task.id);
  const startedAt = Date.now();
  const extraPath = resolve(repoRoot, "node_modules/.bin");
  const testCmd = task.testCmd ?? "vitest run";

  logger.emit({
    type: "run_start",
    configHash: hash,
    taskId: task.id,
    condition: config.condition,
    model: config.model,
    seed: config.seed,
    budgets: config.budgets,
  });

  let status: RunStatus = "INFRA_ERROR";
  let metrics: GradeMetrics | null = null;
  let costUsd = 0;
  let worktree: { dir: string; cleanup: () => void } | undefined;

  try {
    logger.emit({ type: "state_change", from: "INIT", to: "CONTEXT" });
    worktree = await createWorktree({ repoRoot, sourcePath: task.repoRef.url, runId });

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
    };

    const outcome = config.condition === "C" ? await runHarness(ctx) : await runBaseline(ctx);
    status = outcome.status;
    metrics = outcome.metrics;
    costUsd = computeCost(outcome.inputTokens, outcome.outputTokens);
  } catch (err) {
    status = "INFRA_ERROR";
    process.stderr.write(
      `run ${runId} infra error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    worktree?.cleanup();
  }

  const endedAt = Date.now();
  const elapsedMs = endedAt - startedAt;
  logger.emit({ type: "run_end", status, costUsd, elapsedMs });

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
