import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Condition,
  GradeMetrics,
  RunConfig,
  RunRecord,
  RunStatus,
  Task,
} from "@vouch/protocol";
import { createWorktree, getDiff, listDirTool } from "@vouch/sandbox";
import { gradeRun } from "@vouch/grader";
import { buildContextPrompt, systemPromptB } from "@vouch/skills";
import {
  computeCost,
  providerForModel,
  resolveRunnerFromEnv,
  ScriptedRunner,
  type AgentRunner,
  type ProviderName,
} from "@vouch/model";
import { EventLogger } from "./logger.js";
import { configHash } from "./config.js";
import { buildTools } from "./agent-tools.js";
import { buildSolutionScript } from "./scripted-solution.js";

export interface ExecuteRunOptions {
  task: Task;
  config: RunConfig;
  runsDir: string;
  repoRoot: string;
  benchDir: string;
}

const STEP_TIMEOUT_MS = 60_000;

function makeRunId(taskId: string, condition: Condition, seed: number): string {
  return `${taskId}__${condition}__seed${seed}__${Date.now()}`;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface RunnerSelection {
  runner: AgentRunner;
  label: string;
}

function selectRunner(
  task: Task,
  benchDir: string,
  config: RunConfig,
): RunnerSelection {
  const preferred = (config.provider ?? providerForModel(config.model)) as
    | ProviderName
    | undefined;
  const resolved = resolveRunnerFromEnv({ preferred, model: config.model });
  if (resolved) {
    return { runner: resolved.runner, label: `${resolved.provider}:${resolved.model}` };
  }
  const solutionDir = resolve(benchDir, "tasks", task.id, "solution");
  if (existsSync(solutionDir)) {
    return {
      runner: new ScriptedRunner(buildSolutionScript(solutionDir)),
      label: "scripted-solution",
    };
  }
  throw new Error(
    "no model API key (set ANTHROPIC_API_KEY or OPENAI_API_KEY) and no scripted solution present",
  );
}

/**
 * Condition-B (baseline) run: worktree -> agent loop -> diff -> external grade.
 * Condition C (harness gate) is layered on in M2; for now it shares this path.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunRecord> {
  const { task, config, runsDir, repoRoot, benchDir } = opts;
  const runId = makeRunId(task.id, config.condition, config.seed);
  const logger = new EventLogger(runId, join(runsDir, `${runId}.jsonl`));
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
    worktree = await createWorktree({
      repoRoot,
      sourcePath: task.repoRef.url,
      runId,
    });

    const fileTree = listDirTool(worktree.dir);
    const publicTestFiles: Array<[string, string]> = task.publicTests.map((p) => [
      p,
      safeRead(join(worktree!.dir, p)),
    ]);
    const system = systemPromptB();
    const prompt = buildContextPrompt({ task, fileTree, publicTestFiles });
    const tools = buildTools({
      worktreeDir: worktree.dir,
      testCmd,
      timeoutMs: STEP_TIMEOUT_MS,
      extraPath,
    });

    const { runner } = selectRunner(task, benchDir, config);

    logger.emit({ type: "state_change", from: "CONTEXT", to: "PATCH" });
    const result = await runner.run({
      system,
      prompt,
      tools,
      budgets: config.budgets,
      model: config.model,
      onEvent: (e) => logger.emit(e),
    });
    costUsd = computeCost(result.inputTokens, result.outputTokens);

    logger.emit({ type: "state_change", from: "PATCH", to: "VERIFY" });
    const diff = await getDiff(worktree.dir);
    logger.emit({ type: "diff_snapshot", patch: diff.patch });

    const grade = await gradeRun({
      benchDir,
      taskId: task.id,
      taskKind: task.kind,
      worktreeDir: worktree.dir,
      changedFiles: diff.changedFiles,
      diffLineCount: diff.lineCount,
      timeoutMs: STEP_TIMEOUT_MS,
      extraPath,
    });
    metrics = grade.metrics;
    status = grade.status;
    logger.emit({ type: "grade", metrics });
    logger.emit({ type: "state_change", from: "VERIFY", to: "REVIEW" });
    logger.emit({ type: "state_change", from: "REVIEW", to: "DONE" });
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
