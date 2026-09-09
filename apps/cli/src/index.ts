import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Condition, RunConfig } from "@vouch/protocol";
import { DEFAULT_BUDGETS } from "@vouch/protocol";
import { executeRun, loadTask } from "@vouch/engine";
import { getString, parseArgs } from "./args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const BENCH_DIR = resolve(REPO_ROOT, "bench");
const RUNS_DIR = resolve(REPO_ROOT, "runs");

const DEFAULT_MODEL = "claude-sonnet-5";
const GRADER_VERSION = "0.0.0";

function isCondition(v: string | undefined): v is Condition {
  return v === "A" || v === "B" || v === "C";
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const taskId = getString(flags, "task");
  const conditionRaw = getString(flags, "condition");
  if (!taskId) throw new Error("--task <id> is required");
  if (!isCondition(conditionRaw)) {
    throw new Error("--condition must be one of A | B | C");
  }
  const seed = Number(getString(flags, "seed") ?? "1");
  const model = getString(flags, "model") ?? DEFAULT_MODEL;

  const task = loadTask(BENCH_DIR, taskId);
  const config: RunConfig = {
    model,
    seed,
    budgets: DEFAULT_BUDGETS,
    condition: conditionRaw,
    graderVersion: GRADER_VERSION,
  };

  const record = await executeRun({ task, config, runsDir: RUNS_DIR });
  process.stdout.write(
    `run ${record.runId}\n` +
      `  task=${record.taskId} condition=${record.condition} status=${record.status}\n` +
      `  configHash=${record.configHash} elapsedMs=${record.elapsedMs}\n` +
      `  log=runs/${record.runId}.jsonl (${record.events.length} events)\n`,
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "run":
      await cmdRun(flags);
      break;
    default:
      process.stderr.write(
        "usage: vouch run --task <id> --condition <A|B|C> [--seed N] [--model M]\n",
      );
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
