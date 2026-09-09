import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodType } from "zod";
import type { AgentTool } from "@vouch/model";
import { readFileTool, runTestCommand, writeFileTool, type TestOutcome } from "@vouch/sandbox";

export const REPRO_PATH = "vouch.repro.test.ts";

type RegressionOutcome = "passed" | "assertion_failed" | "invalid" | "error" | "timeout" | "cancelled";

export interface ReproState {
  path: string;
  reproduced: boolean;
  submissions: number;
  hash?: string;
  outcome?: RegressionOutcome;
}

export interface ReproToolContext {
  worktreeDir: string;
  timeoutMs: number;
  extraPath?: string;
  state: ReproState;
  signal?: AbortSignal;
  remainingTimeoutMs?: () => number;
}

interface JsonAssertion {
  status?: string;
  failureMessages?: string[];
}

/** Legacy fixtures use Vitest's structured report; infrastructure failures are never proof. */
export function classifyRegression(result: TestOutcome): RegressionOutcome {
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timeout";
  try {
    const report = JSON.parse(result.output) as {
      success?: boolean;
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      numTodoTests?: number;
      numRuntimeErrorTestSuites?: number;
      testResults?: Array<{ assertionResults?: JsonAssertion[]; message?: string }>;
    };
    const assertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? [];
    if (!report.numTotalTests || assertions.length !== report.numTotalTests ||
      report.numPendingTests || report.numTodoTests || assertions.some((test) => !["passed", "failed"].includes(test.status ?? ""))) {
      return "invalid";
    }
    if (report.numRuntimeErrorTestSuites || report.testResults?.some((suite) => suite.message)) return "error";
    if (result.passed && report.success === true && report.numPassedTests === report.numTotalTests && report.numFailedTests === 0 && assertions.every((test) => test.status === "passed")) {
      return "passed";
    }
    const failed = assertions.filter((test) => test.status === "failed");
    if (result.exitCode !== 1 || report.success !== false || failed.length === 0 || failed.length !== report.numFailedTests) return "error";
    return failed.every((test) => test.failureMessages?.length && test.failureMessages.every((message) => /^AssertionError\b/.test(message.trim())))
      ? "assertion_failed" : "error";
  } catch {
    return "error";
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function cast<S extends ZodType>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>) => Promise<unknown>,
): AgentTool {
  return { name, description, schema: schema as unknown as ZodType<unknown>, execute: execute as (args: unknown) => Promise<unknown> };
}

async function runRepro(ctx: ReproToolContext) {
  ctx.signal?.throwIfAborted();
  if (ctx.state.path !== REPRO_PATH) throw new Error("legacy fixtures must use the designated regression path");
  if (ctx.state.hash && hash(readFileTool(ctx.worktreeDir, ctx.state.path)) !== ctx.state.hash) {
    throw new Error("the saved regression test was modified");
  }
  const reportPath = `.git/vouch-regression-${randomUUID()}.json`;
  const result = await runTestCommand(ctx.worktreeDir, `vitest run ${REPRO_PATH} --reporter=json --outputFile=${reportPath} --no-color`, {
    timeoutMs: ctx.remainingTimeoutMs?.() ?? ctx.timeoutMs,
    extraPath: ctx.extraPath,
    signal: ctx.signal,
  });
  let report = "";
  try {
    report = readFileSync(join(ctx.worktreeDir, reportPath), "utf8");
  } catch {
    // A missing report cannot establish a valid test outcome.
  } finally {
    rmSync(join(ctx.worktreeDir, reportPath), { force: true });
  }
  return { ...result, outcome: classifyRegression({ ...result, output: report }), report };
}

/** Used only by the explicit scripted fixture runner to validate its supplied regression. */
export function buildSubmitReproTool(ctx: ReproToolContext): AgentTool {
  return cast(
    "submit_repro",
    `Save the supplied regression to ${REPRO_PATH} and validate its result. Args: { content }.`,
    z.object({ content: z.string() }),
    async ({ content }) => {
      if (ctx.state.path !== REPRO_PATH) throw new Error("legacy fixtures must use the designated regression path");
      writeFileTool(ctx.worktreeDir, ctx.state.path, content);
      ctx.state.hash = hash(content);
      const result = await runRepro(ctx);
      ctx.state.submissions += 1;
      ctx.state.outcome = result.outcome;
      ctx.state.reproduced = result.outcome === "assertion_failed";
      return { failsNow: ctx.state.reproduced, outcome: result.outcome, exitCode: result.exitCode, output: result.output || result.report };
    },
  );
}

export function buildRunReproTool(ctx: ReproToolContext): AgentTool {
  return cast(
    "run_repro",
    `Run the protected regression at ${REPRO_PATH}. No args.`,
    z.object({}),
    async () => {
      const result = await runRepro(ctx);
      return { passed: result.outcome === "passed", outcome: result.outcome, output: result.output || result.report };
    },
  );
}

export async function reproPasses(ctx: ReproToolContext): Promise<boolean> {
  return (await runRepro(ctx)).outcome === "passed";
}
