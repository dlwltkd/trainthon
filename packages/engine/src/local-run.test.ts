import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedRunner, type AgentRunner } from "@vouch/model";
import type {
  LocalWorkspace,
  ProjectTestRunner,
  StructuredTestResult,
  TestSelection,
} from "@vouch/sandbox";
import { executeLocalRun } from "./local-run.js";

const roots: string[] = [];

function result(status: StructuredTestResult["status"], selection: TestSelection = "regression"): StructuredTestResult {
  const passed = status === "passed";
  return {
    status,
    passed,
    output: passed ? "1 test passed" : "AssertionError: unsafe value was returned",
    exitCode: passed ? 0 : 1,
    timedOut: false,
    cancelled: false,
    testsPassed: passed ? 1 : 0,
    testsFailed: passed ? 0 : 1,
    testsSkipped: 0,
    collectedFiles: [selection === "regression" ? "tests/security.test.ts" : "tests/functional.test.ts"],
    testManifest: [selection === "regression" ? "tests/security.test.ts::security regression" : "tests/functional.test.ts::functional behavior"],
    ...(passed ? {} : { reason: "executed test assertion failed" }),
  };
}

class SourceAwareRunner implements ProjectTestRunner {
  prepared = false;
  cleaned = false;

  async prepare(_workspace: LocalWorkspace): Promise<void> {
    this.prepared = true;
  }

  async runTests(dir: string, selection: TestSelection): Promise<StructuredTestResult> {
    if (!this.prepared) throw new Error("runner was not prepared");
    if (selection === "functional") return result("passed", "functional");
    const source = readFileSync(join(dir, "src/value.ts"), "utf8");
    return result(source.includes("return value;") ? "assertion_failed" : "passed");
  }

  async cleanup(): Promise<void> {
    this.cleaned = true;
  }
}

class FailingSetupRunner extends SourceAwareRunner {
  override async prepare(): Promise<void> {
    throw new Error("unsupported project setup");
  }
}

class DelayedCandidateRunner extends SourceAwareRunner {
  override async runTests(dir: string, selection: TestSelection): Promise<StructuredTestResult> {
    if (dir.endsWith("candidate") && selection === "regression") {
      await new Promise(resolve => setTimeout(resolve, 30));
      return result("passed", selection);
    }
    return super.runTests(dir, selection);
  }
}

class ChangedFunctionalManifestRunner extends SourceAwareRunner {
  override async runTests(dir: string, selection: TestSelection): Promise<StructuredTestResult> {
    const testResult = await super.runTests(dir, selection);
    if (selection === "functional" && dir.endsWith("verification")) {
      return { ...testResult, testManifest: [...testResult.testManifest, "tests/functional.test.ts::unexpected added test"] };
    }
    return testResult;
  }
}

class DeadlineSetupRunner extends SourceAwareRunner {
  override async prepare(_workspace: LocalWorkspace, opts?: { signal?: AbortSignal }): Promise<void> {
    await new Promise<void>(resolve => {
      if (opts?.signal?.aborted) return resolve();
      opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("dependency setup cancelled");
  }
}

function fixture(fixed = false): { root: string; repo: string; runs: string; regression: string } {
  const root = mkdtempSync(join(tmpdir(), "vouch-local-run-"));
  roots.push(root);
  const repo = join(root, "repo");
  const runs = join(root, "runs");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  const source = fixed
    ? "export function clean(value: string) { return value.replace(/</g, ''); }\n"
    : "export function clean(value: string) { return value; }\n";
  writeFileSync(join(repo, "src/value.ts"), source);
  writeFileSync(join(repo, "tests/security.test.ts"), "// supplied security regression\n");
  writeFileSync(join(repo, "tests/functional.test.ts"), "// protected functional test\n");
  writeFileSync(join(repo, "package.json"), '{"devDependencies":{"vitest":"5.0.0"}}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return { root, repo, runs, regression: "tests/security.test.ts" };
}

function options(input: ReturnType<typeof fixture>, runner: ProjectTestRunner) {
  return {
    repoPath: input.repo,
    report: "Unsanitized values are returned to an HTML sink.",
    regressionPath: input.regression,
    runsDir: input.runs,
    mode: "live" as const,
    model: { provider: "openai" as const, model: "gpt-test" },
    budgets: { maxTokens: 20_000, maxSteps: 10, maxWallMs: 30_000 },
    seed: 1,
    testRunner: runner,
    repairRunner: new ScriptedRunner(async () => "unused injected repair runner"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("executeLocalRun", () => {
  it("repairs source and verifies the exact regression plus functional suite in a fresh copy", async () => {
    const input = fixture();
    const runner = new SourceAwareRunner();
    const repairRunner = new ScriptedRunner(async (tools) => {
      await tools["write_file"]?.({
        path: "src/value.ts",
        content: "export function clean(value: string) { return value.replace(/</g, ''); }\n",
      });
      await tools["run_regression"]?.({});
      return "Escaped the unsafe delimiter and ran the supplied checks.";
    });
    const record = await executeLocalRun({ ...options(input, runner), repairRunner });

    expect(record.status).toBe("FIXED_VERIFIED");
    expect(record.verification).toEqual({ reproduced: true, regressionPassed: true, functionalPassed: true, regressionManifestMatched: true, functionalManifestMatched: true });
    expect(record.changes.files).toEqual(["src/value.ts"]);
    expect(readFileSync(join(input.repo, "src/value.ts"), "utf8")).toContain("return value;");
    expect(readFileSync(record.artifacts.patch, "utf8")).toContain("value.replace");
    expect(existsSync(record.artifacts.record)).toBe(true);
    expect(record.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.modelUsage.repair.invoked).toBe(true);
    expect(statSync(record.artifacts.dir).mode & 0o777).toBe(0o700);
    expect(statSync(record.artifacts.record).mode & 0o777).toBe(0o600);
    expect(statSync(record.artifacts.events).mode & 0o777).toBe(0o600);
    expect(runner.cleaned).toBe(true);

    const events = readFileSync(record.artifacts.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const call = events.find(event => event.type === "tool_call" && event.name === "write_file");
    const completed = events.find(event => event.type === "tool_result" && event.callId === call?.callId);
    expect(call?.agentRole).toBe("blue");
    expect(call?.args.content).toMatch(/^\[omitted \d+ bytes\]$/);
    expect(call?.args.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.outcome).toBe("succeeded");
    const testResult = events.find(event => event.type === "tool_result" && event.name === "run_regression");
    expect(testResult?.result?.artifact).toBe(record.tests["agent-regression-1"]?.artifact);
    expect(existsSync(testResult.result.artifact)).toBe(true);
    expect(events.at(-1)?.type).toBe("run_end");
  });

  it("returns not reproducible with an empty diff and never invokes the repair model", async () => {
    const input = fixture(true);
    let invoked = false;
    const repairRunner = new ScriptedRunner(async () => {
      invoked = true;
      return "unexpected";
    });
    const record = await executeLocalRun({
      ...options(input, new SourceAwareRunner()),
      repairRunner,
    });

    expect(record.status).toBe("NOT_REPRODUCIBLE");
    expect(record.changes).toEqual({ files: [], lineCount: 0 });
    expect(readFileSync(record.artifacts.patch, "utf8")).toBe("");
    expect(invoked).toBe(false);
  });

  it("rejects a scripted patch that targets the protected regression", async () => {
    const input = fixture();
    const patchPath = join(input.root, "protected.diff");
    writeFileSync(patchPath, [
      "diff --git a/tests/security.test.ts b/tests/security.test.ts",
      "--- a/tests/security.test.ts",
      "+++ b/tests/security.test.ts",
      "@@ -1 +1 @@",
      "-// supplied security regression",
      "+// weakened security regression",
      "",
    ].join("\n"));
    const record = await executeLocalRun({
      ...options(input, new SourceAwareRunner()),
      mode: "scripted",
      patchPath,
    });

    expect(record.status).toBe("FAILED_NO_FIX");
    expect(record.reason).toMatch(/protected path/);
    expect(record.changes.files).toEqual([]);
    expect(readFileSync(join(input.repo, input.regression), "utf8")).toContain("supplied");
    const events = readFileSync(record.artifacts.events, "utf8");
    expect(events).toContain('"type":"tool_error"');
    expect(existsSync(record.artifacts.record)).toBe(true);
  });

  it("persists a setup failure record before cleaning the runner", async () => {
    const input = fixture();
    let recordExistedDuringCleanup = false;
    class RecordAwareFailingRunner extends FailingSetupRunner {
      override async cleanup(): Promise<void> {
        const runDir = readdirSync(input.runs).find(name => !name.startsWith("."));
        recordExistedDuringCleanup = Boolean(runDir && existsSync(join(input.runs, runDir, "record.json")));
        await super.cleanup();
      }
    }
    const runner = new RecordAwareFailingRunner();
    const record = await executeLocalRun({ ...options(input, runner) });

    expect(record.status).toBe("SETUP_ERROR");
    expect(record.reason).toContain("unsupported project setup");
    expect(existsSync(record.artifacts.events)).toBe(true);
    expect(existsSync(record.artifacts.record)).toBe(true);
    expect(recordExistedDuringCleanup).toBe(true);
    expect(runner.cleaned).toBe(true);
  });

  it("rejects a passing verification when the functional test inventory changes", async () => {
    const input = fixture();
    const repairRunner = new ScriptedRunner(async (tools) => {
      await tools["write_file"]?.({
        path: "src/value.ts",
        content: "export function clean(value: string) { return value.replace(/</g, ''); }\n",
      });
      return "fixed";
    });
    const record = await executeLocalRun({ ...options(input, new ChangedFunctionalManifestRunner()), repairRunner });

    expect(record.status).toBe("BROKE_FUNCTION");
    expect(record.verification.functionalManifestMatched).toBe(false);
    expect(record.reason).toContain("inventory changed");
  });

  it("classifies a shared deadline during setup as a budget timeout", async () => {
    const input = fixture();
    const record = await executeLocalRun({
      ...options(input, new DeadlineSetupRunner()),
      budgets: { maxTokens: 20_000, maxSteps: 10, maxWallMs: 100 },
    });

    expect(record.status).toBe("BUDGET_TIMEOUT");
    expect(record.reason).toContain("wall budget exhausted");
  });

  it("retains billed usage when a live repair runner fails", async () => {
    const input = fixture();
    const repairRunner: AgentRunner = {
      async run(runInput) {
        runInput.budget!.consumeStep(10, 5);
        throw new Error("provider failed after usage");
      },
    };
    const record = await executeLocalRun({
      ...options(input, new SourceAwareRunner()),
      repairRunner,
      pricing: { repair: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } },
    });

    expect(record.status).toBe("INFRA_ERROR");
    expect(record.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, steps: 1 });
    expect(record.costUsd).toBe(15);
  });

  it("drains an in-flight test before run_end after cancellation", async () => {
    const input = fixture();
    const controller = new AbortController();
    const repairRunner = new ScriptedRunner(async (tools) => {
      setTimeout(() => controller.abort(), 5);
      await tools["run_regression"]?.({});
      return "unexpected";
    });
    const record = await executeLocalRun({
      ...options(input, new DelayedCandidateRunner()),
      repairRunner,
      signal: controller.signal,
    });

    expect(record.status).toBe("CANCELLED");
    expect(record.verification).toEqual({ reproduced: true, regressionPassed: null, functionalPassed: null, regressionManifestMatched: null, functionalManifestMatched: null });
    const events = readFileSync(record.artifacts.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)?.type).toBe("run_end");
    expect(events.some(event => event.type === "test_run" && event.phase.startsWith("agent-regression"))).toBe(true);
  });
});
