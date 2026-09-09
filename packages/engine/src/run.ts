import { join } from "node:path";
import type {
  Condition,
  EngineState,
  RunConfig,
  RunRecord,
  RunStatus,
  Task,
} from "@vouch/protocol";
import { EventLogger } from "./logger.js";
import { configHash } from "./config.js";

export interface ExecuteRunOptions {
  task: Task;
  config: RunConfig;
  /** Directory where the <runId>.jsonl log is written. */
  runsDir: string;
}

function makeRunId(taskId: string, condition: Condition, seed: number): string {
  return `${taskId}__${condition}__seed${seed}__${Date.now()}`;
}

const STATE_PATH: EngineState[] = [
  "INIT",
  "CONTEXT",
  "REPRODUCE",
  "PATCH",
  "VERIFY",
  "REVIEW",
  "DONE",
];

/**
 * M0 placeholder executor: walks the state machine and produces a well-formed
 * run record without invoking a model or sandbox. Replaced by the real B/C
 * agents in M1/M2. Keeps the event schema and run-record shape stable so that
 * downstream (replay, bench, UI) can be built against it immediately.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunRecord> {
  const { task, config, runsDir } = opts;
  const runId = makeRunId(task.id, config.condition, config.seed);
  const filePath = join(runsDir, `${runId}.jsonl`);
  const logger = new EventLogger(runId, filePath);
  const hash = configHash(config, task.id);
  const startedAt = Date.now();

  logger.emit({
    type: "run_start",
    configHash: hash,
    taskId: task.id,
    condition: config.condition,
    model: config.model,
    seed: config.seed,
    budgets: config.budgets,
  });

  for (let i = 0; i < STATE_PATH.length - 1; i++) {
    logger.emit({
      type: "state_change",
      from: STATE_PATH[i]!,
      to: STATE_PATH[i + 1]!,
    });
  }

  logger.emit({ type: "diff_snapshot", patch: "" });

  const status: RunStatus = "FAILED_NO_FIX";
  const metrics = {
    exploitNeutralized: null,
    functionalPass: null,
    guardedFilesTouched: null,
    diffLineCount: 0,
  };
  logger.emit({ type: "grade", metrics });

  const endedAt = Date.now();
  const elapsedMs = endedAt - startedAt;
  logger.emit({ type: "run_end", status, costUsd: 0, elapsedMs });

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
    costUsd: 0,
    metrics,
    events: [...logger.getEvents()],
  };
}
