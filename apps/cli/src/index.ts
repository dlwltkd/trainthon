import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Condition, RunConfig } from "@vouch/protocol";
import { DEFAULT_BUDGETS } from "@vouch/protocol";
import {
  executeBench,
  executeRun,
  formatBenchTable,
  formatReplay,
  loadRun,
  loadTask,
} from "@vouch/engine";
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

function printRecord(record: {
  runId: string;
  taskId: string;
  condition: string;
  status: string;
  configHash: string;
  elapsedMs: number | null;
  costUsd: number;
  metrics: {
    exploitNeutralized: boolean | null;
    functionalPass: boolean | null;
    diffLineCount: number;
    guardedFilesTouched: boolean | null;
  } | null;
  events: unknown[];
}): void {
  const m = record.metrics;
  process.stdout.write(
    `run ${record.runId}\n` +
      `  task=${record.taskId} condition=${record.condition} status=${record.status}\n` +
      `  configHash=${record.configHash} elapsedMs=${record.elapsedMs ?? "?"} costUsd=${record.costUsd.toFixed(4)}\n` +
      (m
        ? `  metrics: exploitNeutralized=${m.exploitNeutralized} functionalPass=${m.functionalPass} diffLines=${m.diffLineCount} guarded=${m.guardedFilesTouched}\n`
        : "") +
      `  log=runs/${record.runId}.jsonl (${record.events.length} events)\n`,
  );
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
  const provider = getString(flags, "provider");

  const task = loadTask(BENCH_DIR, taskId);
  const config: RunConfig = {
    model,
    provider,
    seed,
    budgets: DEFAULT_BUDGETS,
    condition: conditionRaw,
    graderVersion: GRADER_VERSION,
  };

  const record = await executeRun({
    task,
    config,
    runsDir: RUNS_DIR,
    repoRoot: REPO_ROOT,
    benchDir: BENCH_DIR,
  });
  printRecord(record);
}

async function cmdReplay(flags: Record<string, string | boolean>): Promise<void> {
  const runId = getString(flags, "run");
  if (!runId) throw new Error("--run <runId> is required");
  const record = loadRun(RUNS_DIR, runId);
  process.stdout.write(formatReplay(record));
}

async function cmdBench(flags: Record<string, string | boolean>): Promise<void> {
  const splitRaw = getString(flags, "set") ?? "dev";
  if (splitRaw !== "dev" && splitRaw !== "eval") {
    throw new Error("--set must be dev | eval");
  }
  const repeats = Number(getString(flags, "repeats") ?? "1");
  const seed = Number(getString(flags, "seed") ?? "1");
  const model = getString(flags, "model") ?? DEFAULT_MODEL;
  const provider = getString(flags, "provider");
  const condRaw = getString(flags, "conditions") ?? "B,C";
  const conditions = condRaw.split(",").map((s) => s.trim());
  if (!conditions.every(isCondition)) {
    throw new Error("--conditions must be a comma list of A|B|C");
  }

  const report = await executeBench({
    split: splitRaw,
    conditions,
    repeats,
    seed,
    model,
    provider,
    runsDir: RUNS_DIR,
    repoRoot: REPO_ROOT,
    benchDir: BENCH_DIR,
    onRun: (row) => {
      process.stderr.write(`  ${row.condition} ${row.taskId} -> ${row.status}\n`);
    },
  });
  process.stdout.write(formatBenchTable(report));
  process.stdout.write(`wrote runs/bench-latest.json\n`);
}

function usage(): string {
  return [
    "usage:",
    "  vouch run   --task <id> --condition <A|B|C> [--seed N] [--model M] [--provider anthropic|openai]",
    "  vouch replay --run <runId>",
    "  vouch bench --set <dev|eval> [--repeats N] [--conditions B,C] [--seed N] [--model M]",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "run":
      await cmdRun(flags);
      break;
    case "replay":
      await cmdReplay(flags);
      break;
    case "bench":
      await cmdBench(flags);
      break;
    default:
      process.stderr.write(usage());
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
