import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedRunner, type AgentRunner, type Script } from "@vouch/model";
import type { HarnessEvent } from "@vouch/protocol";
import type {
  LocalWorkspace,
  ProjectTestRunner,
  StructuredTestResult,
  TestSelection,
} from "@vouch/sandbox";
import { executeLocalRun as runLocal, type ExecuteLocalRunOptions } from "./local-run.js";

const roots: string[] = [];

function tracedRunner(script: Script): ScriptedRunner {
  return new ScriptedRunner(async tools => {
    await tools["use_skill"]!({ skillId: "minimal-repair", reason: "Apply the change required by the supplied assertion." });
    await tools["report_progress"]!({
      summary: "The supplied assertion identifies behavior to correct.",
      nextAction: "Inspect and update the application source.",
      evidence: ["tests/security.test.ts"],
      plan: [{ id: "repair", title: "Apply and check the source change", status: "in_progress" }],
    });
    return script(tools);
  });
}

async function executeLocalRun(options: ExecuteLocalRunOptions) {
  const record = await runLocal(options);
  expect(record.status).not.toBe("FIXED_VERIFIED");
  expect(record.verification).toMatchObject({ scope: "repository_tests", independentGrader: false });
  expect(JSON.parse(readFileSync(record.artifacts.record, "utf8"))).toEqual(record);
  const events = readFileSync(record.artifacts.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({
    type: "run_end",
    status: record.status,
    reason: record.reason,
    elapsedMs: record.elapsedMs,
    costUsd: record.costUsd,
  });
  expect(events.some(event => event.status === "FIXED_VERIFIED")).toBe(false);
  return record;
}

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
  it("publishes setup and test activity while the work is still pending", async () => {
    const input = fixture(true);
    const events: HarnessEvent[] = [];
    let beginSetup!: () => void;
    let releaseSetup!: () => void;
    const enteredSetup = new Promise<void>(resolve => { beginSetup = resolve; });
    const setupGate = new Promise<void>(resolve => { releaseSetup = resolve; });
    class ObservedRunner extends SourceAwareRunner {
      override async prepare(workspace: LocalWorkspace) {
        beginSetup();
        await setupGate;
        await super.prepare(workspace);
      }
      override async runTests(dir: string, selection: TestSelection) {
        expect(events.at(-1)).toMatchObject({ type: "action_summary", summary: `Running baseline ${selection} tests` });
        return super.runTests(dir, selection);
      }
    }
    const pending = executeLocalRun({ ...options(input, new ObservedRunner()), onEvent: event => events.push(event) });
    try {
      await enteredSetup;
      expect(events.at(-1)).toMatchObject({ type: "action_summary", summary: "Preparing test dependencies in Docker" });
      expect(events.some(event => event.type === "test_run" || event.type === "run_end")).toBe(false);
      const runId = events[0]!.runId;
      const persisted = readFileSync(join(input.runs, runId, "events.jsonl"), "utf8");
      expect(persisted).toContain("Preparing test dependencies in Docker");
    } finally { releaseSetup(); }
    const record = await pending;
    expect(record.status).toBe("NOT_REPRODUCIBLE");
    expect(events.filter(event => event.type === "test_run")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run_end");
  });

  it("reports repository tests passed without claiming independent security verification", async () => {
    const input = fixture();
    const runner = new SourceAwareRunner();
    const repairRunner = tracedRunner(async (tools) => {
      await tools["write_file"]?.({
        path: "src/value.ts",
        content: "export function clean(value: string) { return value.replace(/</g, ''); }\n",
      });
      await tools["run_regression"]?.({});
      return "Escaped the unsafe delimiter and ran the supplied checks.";
    });
    const record = await executeLocalRun({ ...options(input, runner), repairRunner });

    expect(record.status).toBe("TESTS_PASSED");
    expect(record.reason).toContain("do not independently verify a security fix");
    expect(record.verification).toEqual({ scope: "repository_tests", independentGrader: false, reproduced: true, regressionPassed: true, functionalPassed: true, regressionManifestMatched: true, functionalManifestMatched: true });
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
    const selected = events.find(event => event.type === "skill_call");
    expect(selected).toMatchObject({ skillId: "minimal-repair", agentRole: "blue", version: "1.0.0" });
    expect(events.find(event => event.type === "tool_call" && event.callId === selected.callId)?.name).toBe("use_skill");
    expect(events.find(event => event.type === "agent_update")).toMatchObject({ evidence: ["tests/security.test.ts"], nextAction: "Inspect and update the application source." });
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

  it("records and hashes canonical provider settings", async () => {
    const first = fixture(true);
    const second = fixture(true);
    const reviewRunner = new ScriptedRunner(async () => "unused injected review runner");
    const implicit = await executeLocalRun({
      ...options(first, new SourceAwareRunner()),
      reviewModel: { provider: "compatible", model: "glm-5.3-flash-uncensored" },
      reviewRunner,
    });
    const explicit = await executeLocalRun({
      ...options(second, new SourceAwareRunner()),
      model: { provider: "openai", model: "gpt-test", apiKeyEnv: "OPENAI_API_KEY" },
      reviewModel: {
        provider: "compatible",
        model: "glm-5.3-flash-uncensored",
        baseURL: "https://api.routeway.ai/v1/",
        apiKeyEnv: "ROUTEWAY_API_KEY",
      },
      reviewRunner,
    });

    expect(implicit.configHash).toBe(explicit.configHash);
    expect(implicit.models).toEqual({
      repair: { provider: "openai", model: "gpt-test", apiKeyEnv: "OPENAI_API_KEY" },
      review: {
        provider: "compatible",
        model: "glm-5.3-flash-uncensored",
        baseURL: "https://api.routeway.ai/v1",
        apiKeyEnv: "ROUTEWAY_API_KEY",
      },
    });
    expect(explicit.models).toEqual(implicit.models);
  });

  it("reports invalid reproduction evidence without attempting repair", async () => {
    const input = fixture();
    class InvalidRegressionRunner extends SourceAwareRunner {
      override async runTests(dir: string, selection: TestSelection): Promise<StructuredTestResult> {
        return selection === "regression" ? result("invalid") : super.runTests(dir, selection);
      }
    }
    const record = await executeLocalRun(options(input, new InvalidRegressionRunner()));

    expect(record.status).toBe("INVALID_REPRODUCTION");
    expect(record.verification.reproduced).toBe(false);
    expect(record.modelUsage.repair.invoked).toBe(false);
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

  it.each([false, true])("does not retain a success status when cleanup fails (already passing: %s)", async (alreadyPassing) => {
    const input = fixture(alreadyPassing);
    class FailingCleanupRunner extends SourceAwareRunner {
      override async cleanup(): Promise<void> {
        throw new Error("container removal failed");
      }
    }
    const repairRunner = tracedRunner(async (tools) => {
      await tools["write_file"]?.({
        path: "src/value.ts",
        content: "export function clean(value: string) { return value.replace(/</g, ''); }\n",
      });
      return "fixed";
    });
    const record = await executeLocalRun({ ...options(input, new FailingCleanupRunner()), repairRunner });

    expect(record.status).toBe("INFRA_ERROR");
    expect(record.reason).toContain("runner cleanup failed: container removal failed");
    expect(record.verification.regressionPassed).toBe(alreadyPassing ? null : true);
  });

  it("retains source changes when a later protected write fails", async () => {
    const input = fixture();
    const repairRunner = tracedRunner(async (tools) => {
      await tools["write_file"]?.({
        path: "src/value.ts",
        content: "export function clean(value: string) { return value.replace(/</g, ''); }\n",
      });
      await tools["write_file"]?.({ path: "tests/security.test.ts", content: "// changed test\n" });
      return "unexpected";
    });
    const record = await executeLocalRun({ ...options(input, new SourceAwareRunner()), repairRunner });

    expect(record.status).toBe("FAILED_NO_FIX");
    expect(record.reason).toContain("only application source files may be edited");
    expect(record.changes.files).toEqual(["src/value.ts"]);
    expect(readFileSync(record.artifacts.patch, "utf8")).toContain("value.replace");
  });

  it("rejects a passing verification when the functional test inventory changes", async () => {
    const input = fixture();
    const repairRunner = tracedRunner(async (tools) => {
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

  it.each([
    { thrown: new Error(""), expected: "Error: no error message was provided" },
    {
      thrown: Object.assign(new Error(" \n "), {
        name: "AI_APICallError", statusCode: 503, requestBodyValues: { private: "must not be logged" },
      }),
      expected: "AI_APICallError (HTTP 503): no error message was provided",
    },
    { thrown: "", expected: "Unknown error: no error message was provided" },
  ])("persists a usable reason when a review provider throws an empty message ($expected)", async ({ thrown, expected }) => {
    const input = fixture();
    const runner = new SourceAwareRunner();
    let repairInvoked = false;
    const record = await executeLocalRun({
      ...options(input, runner),
      reviewModel: { provider: "compatible", model: "review-test" },
      reviewRunner: {
        async run(runInput) {
          runInput.budget!.consumeStep(10, 5);
          throw thrown;
        },
      },
      repairRunner: { async run() { repairInvoked = true; throw new Error("unexpected repair"); } },
    });

    expect(record.status).toBe("INFRA_ERROR");
    expect(record.reason).toBe(expected);
    expect(record.modelUsage.review).toMatchObject({ invoked: true, inputTokens: 10, outputTokens: 5 });
    expect(record.modelUsage.repair.invoked).toBe(false);
    expect(repairInvoked).toBe(false);
    expect(runner.cleaned).toBe(true);
    expect(readFileSync(record.artifacts.record, "utf8")).not.toContain("must not be logged");
  });

  it("drains an in-flight test before run_end after cancellation", async () => {
    const input = fixture();
    const controller = new AbortController();
    const repairRunner = tracedRunner(async (tools) => {
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
    expect(record.verification).toEqual({ scope: "repository_tests", independentGrader: false, reproduced: true, regressionPassed: null, functionalPassed: null, regressionManifestMatched: null, functionalManifestMatched: null });
    const events = readFileSync(record.artifacts.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)?.type).toBe("run_end");
    expect(events.some(event => event.type === "test_run" && event.phase.startsWith("agent-regression"))).toBe(true);
  });
});
