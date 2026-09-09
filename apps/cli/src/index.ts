import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_BUDGETS } from "@vouch/protocol";
import { executeLocalRun, executeRun, loadTask } from "@vouch/engine";
import { parseArgs } from "./args.js";
import { parseRunOptions } from "./run-options.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCH_DIR = resolve(REPO_ROOT, "bench");
const RUNS_DIR = resolve(REPO_ROOT, "runs");

function costLabel(cost: number | null): string {
  return cost === null ? "unavailable" : cost.toFixed(4);
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const options = parseRunOptions(flags);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (options.kind === "repository") {
      const report = readFileSync(resolve(options.reportPath), "utf8");
      if (!report.trim()) throw new Error("the supplied report is empty");
      const record = await executeLocalRun({
        repoPath: resolve(options.repoPath),
        ref: options.ref,
        report,
        regressionPath: options.regressionPath,
        runsDir: RUNS_DIR,
        mode: options.mode,
        model: options.model,
        reviewModel: options.reviewModel,
        budgets: DEFAULT_BUDGETS,
        seed: options.seed,
        patchPath: options.patchPath ? resolve(options.patchPath) : undefined,
        signal: controller.signal,
      });
      process.stdout.write(
        `run ${record.runId}\n` +
        `  repository=${options.repoPath} mode=${options.mode} status=${record.status}\n` +
        `  elapsedMs=${record.elapsedMs} costUsd=${costLabel(record.costUsd)}\n` +
        `  artifacts=${record.artifacts.dir}\n` +
        `  patch=${record.artifacts.patch}\n` +
        `  record=${record.artifacts.record}\n` +
        `  events=${record.artifacts.events}\n`,
      );
      process.exitCode = record.status === "CANCELLED" ? 130 :
        record.status === "FIXED_VERIFIED" || record.status === "NOT_REPRODUCIBLE" ? 0 : 1;
      return;
    }
    const task = loadTask(BENCH_DIR, options.taskId);
    const record = await executeRun({
      task,
      config: {
        model: options.model.model,
        provider: options.model.provider,
        mode: options.mode,
        seed: options.seed,
        budgets: DEFAULT_BUDGETS,
        condition: options.condition,
        graderVersion: "0.0.0",
      },
      runsDir: RUNS_DIR,
      repoRoot: REPO_ROOT,
      benchDir: BENCH_DIR,
      signal: controller.signal,
    });
    const metrics = record.metrics;
    process.stdout.write(
      `run ${record.runId}\n` +
      `  task=${record.taskId} condition=${record.condition} mode=${options.mode} status=${record.status}\n` +
      `  configHash=${record.configHash} elapsedMs=${record.elapsedMs} costUsd=${costLabel(record.costUsd)}\n` +
      (metrics ? `  metrics: exploitNeutralized=${metrics.exploitNeutralized} functionalPass=${metrics.functionalPass} diffLines=${metrics.diffLineCount} guarded=${metrics.guardedFilesTouched}\n` : "") +
      `  log=${resolve(RUNS_DIR, `${record.runId}.jsonl`)} (${record.events.length} events)\n`,
    );
    process.exitCode = record.status === "CANCELLED" ? 130 :
      record.status === "FIXED_VERIFIED" || record.status === "NOT_REPRODUCIBLE" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "run") {
    await cmdRun(flags);
    return;
  }
  process.stderr.write(
    "usage:\n" +
    "  vouch run --repo <path> --report <file> --regression <repo-relative path> [--ref HEAD] [--mode live|scripted] [--patch <file>]\n" +
    "    [--model <id>] [--provider anthropic|openai|compatible] [--base-url <url>] [--api-key-env <name>] [--red-model <review model>] [--seed N]\n" +
    "  vouch run --task <id> --condition <A|B|C> --mode scripted [--seed N]\n",
  );
  process.exitCode = command ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
