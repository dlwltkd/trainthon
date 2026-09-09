import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DEFAULT_BUDGETS, DEFAULT_REPOSITORY_BUDGETS } from "@vouch/protocol";
import { executeLocalRun, executeRepositoryReview, executeRun, loadTask } from "@vouch/engine";
import { readBoundedRegularFile } from "@vouch/sandbox";
import { parseArgs } from "./args.js";
import { runDoctor } from "./doctor.js";
import { parseDoctorOptions } from "./doctor-options.js";
import { parseRunOptions } from "./run-options.js";
import { createRunProgress } from "./progress.js";
import { runSourceEvaluation } from "./evaluation.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCH_DIR = resolve(REPO_ROOT, "bench");
const RUNS_DIR = resolve(REPO_ROOT, "runs");

function loadLocalEnvironment(): void {
  const path = resolve(REPO_ROOT, ".env");
  if (existsSync(path)) loadEnvFile(path);
}

function costLabel(cost: number | null): string {
  return cost === null ? "unavailable" : cost.toFixed(4);
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const options = parseRunOptions(flags);
  const controller = new AbortController();
  const progress = createRunProgress(RUNS_DIR);
  const interrupt = () => {
    progress.stop();
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (options.kind === "repository") {
      let report: string | undefined;
      if (options.reportPath !== undefined) {
        report = readBoundedRegularFile(resolve(options.reportPath), 200_000, "report").toString("utf8");
        if (!report.trim()) throw new Error("the supplied report is empty");
      }
      const common = {
        repoPath: options.repoPath,
        ref: options.ref,
        runsDir: RUNS_DIR,
        model: options.model,
        budgets: options.regressionPath ? DEFAULT_BUDGETS : DEFAULT_REPOSITORY_BUDGETS,
        seed: options.seed,
        signal: controller.signal,
        onEvent: progress.onEvent,
      };
      const record = options.regressionPath
        ? await executeLocalRun({
          ...common,
          report: [report, options.prompt].filter(Boolean).join("\n\n") || undefined,
          regressionPath: options.regressionPath,
          mode: options.mode,
          reviewModel: options.reviewModel,
          patchPath: options.patchPath ? resolve(options.patchPath) : undefined,
        })
        : await executeRepositoryReview({ ...common, prompt: options.prompt!, report, remediate: options.remediate, reviewModel: options.reviewModel });
      process.stdout.write(
        `run ${record.runId}\n` +
        `  repository=${options.repoPath} mode=${options.mode} status=${record.status}\n` +
        (record.reason ? `  reason=${record.reason}\n` : "") +
        `  verification=${record.verification.scope} independentGrader=${record.verification.independentGrader}\n` +
        (record.status === "PATCH_PROPOSED" ? "  testsRun=false (candidate source patch has not been executed)\n" : "") +
        `  elapsedMs=${record.elapsedMs} costUsd=${costLabel(record.costUsd)}\n` +
        `  artifacts=${record.artifacts.dir}\n` +
        ("patch" in record.artifacts ? `  patch=${record.artifacts.patch}\n` : "") +
        (!options.regressionPath ? `  review=${record.artifacts.reviewSummary}\n` : "") +
        `  record=${record.artifacts.record}\n` +
        `  events=${record.artifacts.events}\n`,
      );
      process.exitCode = record.status === "CANCELLED" ? 130 :
        record.status === "TESTS_PASSED" || record.status === "NOT_REPRODUCIBLE" || record.status === "REVIEW_COMPLETE" || record.status === "PATCH_PROPOSED" ? 0 : 1;
      return;
    }
    const task = loadTask(BENCH_DIR, options.taskId);
    const record = await executeRun({
      task,
      config: {
        model: "scripted",
        provider: "scripted",
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
      onEvent: progress.onEvent,
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
    progress.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function cmdDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const options = parseDoctorOptions(flags);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runDoctor(options, { signal: controller.signal });
    process.stdout.write(result.output);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "run") {
    await cmdRun(flags);
    return;
  }
  if (command === "doctor") {
    await cmdDoctor(flags);
    return;
  }
  if (command === "eval") {
    await runSourceEvaluation(flags, REPO_ROOT);
    return;
  }
  process.stderr.write(
    "usage:\n" +
    "  vouch eval --suite <cvefixes|development20> [--prepare]\n" +
    "  vouch doctor [--live] [--model <id>] [--provider anthropic|openai|compatible] [--base-url <url>] [--api-key-env <name>]\n" +
    "    [--red-model <id>] [--red-provider anthropic|openai|compatible] [--red-base-url <url>] [--red-api-key-env <name>]\n" +
    "  vouch run --repo <local path|https://github.com/owner/repo> --prompt <instructions> [--fix] [--report <file>] [--ref HEAD]\n" +
    "  vouch run --repo <local path|https://github.com/owner/repo> --regression <repo-relative path> [--report <file>] [--prompt <instructions>]\n" +
    "    [--ref HEAD] [--mode live|scripted] [--patch <file>]\n" +
    "    [--model <id>] [--provider anthropic|openai|compatible] [--base-url <url>] [--api-key-env <name>] [--red-model <review model>]\n" +
    "    [--red-provider anthropic|openai|compatible] [--red-base-url <url>] [--red-api-key-env <name>] [--seed N]\n" +
    "    Without --regression: read-only live review; add --fix to propose source changes without executing tests.\n" +
    "    With --regression: source repair against existing tests; --fix is not needed or accepted.\n" +
    "  vouch run --task <id> --condition <A|B|C> --mode scripted [--seed N]\n",
  );
  process.exitCode = command ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
