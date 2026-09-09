import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGETS, DEFAULT_REPOSITORY_BUDGETS, type HarnessEvent } from "@vouch/protocol";

const engine = vi.hoisted(() => ({
  executeLocalRun: vi.fn(),
  executeRepositoryReview: vi.fn(),
  executeRun: vi.fn(),
  loadTask: vi.fn(),
}));
const sandbox = vi.hoisted(() => ({ readBoundedRegularFile: vi.fn() }));

vi.mock("@vouch/engine", () => engine);
vi.mock("@vouch/sandbox", () => sandbox);

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sandbox.readBoundedRegularFile.mockReturnValue(Buffer.from("supplied report"));
  process.exitCode = undefined;
  process.argv = ["node", "vouch", "run", "--repo", "/tmp/repository", "--report", "/tmp/report.txt",
    "--regression", "tests/security.test.ts", "--mode", "scripted", "--patch", "/tmp/repair.diff"];
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("run CLI result", () => {
  it.each([["REVIEW_COMPLETE", 0], ["INCOMPLETE_REVIEW", 1]])(
    "routes a GitHub URL and prompt without reading a report, exiting %s correctly",
    async (status, exitCode) => {
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const repo = "https://github.com/example/project.git/";
      process.argv = ["node", "vouch", "run", "--repo", repo, "--prompt", "Review authorization checks."];
      engine.executeRepositoryReview.mockResolvedValue({
        runId: "review-run", status, elapsedMs: 10, costUsd: null,
        verification: { scope: "source_review", independentGrader: false },
        artifacts: { dir: "/tmp/run", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl", reviewSummary: "/tmp/run/review-summary.txt" },
      });

      await import("./index.js");
      await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

      expect(engine.executeRepositoryReview).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: repo, prompt: "Review authorization checks.", report: undefined, ref: "HEAD",
        reviewModel: expect.objectContaining({ provider: "compatible", model: expect.any(String) }),
        budgets: DEFAULT_REPOSITORY_BUDGETS,
      }));
      expect(engine.executeLocalRun).not.toHaveBeenCalled();
      expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
      const output = stdout.mock.calls.flat().join("");
      expect(output).toContain("verification=source_review independentGrader=false");
      expect(output).toContain("review=/tmp/run/review-summary.txt");
      expect(output).not.toContain("  patch=");
      expect(process.exitCode).toBe(exitCode);
    },
  );

  it("keeps regression repair available for a GitHub URL without a report", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const repo = "https://github.com/example/project";
    process.argv = ["node", "vouch", "run", "--repo", repo, "--regression", "tests/test_security.py"];
    engine.executeLocalRun.mockResolvedValue({
      runId: "repair-run", status: "NOT_REPRODUCIBLE", elapsedMs: 10, costUsd: null,
      verification: { scope: "repository_tests", independentGrader: false },
      artifacts: { dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl" },
    });

    await import("./index.js");
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

    expect(engine.executeLocalRun).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: repo, report: undefined, regressionPath: "tests/test_security.py",
    }));
    expect(engine.executeRepositoryReview).not.toHaveBeenCalled();
    expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
  });

  it("routes --fix to source remediation and labels the successful proposal as untested", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = ["node", "vouch", "run", "--repo", "https://github.com/example/project",
      "--prompt", "Correct justified authorization defects.", "--fix"];
    engine.executeRepositoryReview.mockResolvedValue({
      runId: "source-patch-run", status: "PATCH_PROPOSED", elapsedMs: 10, costUsd: null,
      verification: { scope: "source_patch", independentGrader: false, testsRun: false },
      artifacts: {
        dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json",
        events: "/tmp/run/events.jsonl", reviewSummary: "/tmp/run/review-summary.txt",
      },
    });

    await import("./index.js");
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

    expect(engine.executeRepositoryReview).toHaveBeenCalledWith(expect.objectContaining({
      remediate: true, prompt: "Correct justified authorization defects.", report: undefined,
    }));
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
    expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
    const output = stdout.mock.calls.flat().join("");
    expect(output).toContain("status=PATCH_PROPOSED");
    expect(output).toContain("verification=source_patch independentGrader=false");
    expect(output).toContain("testsRun=false");
    expect(output).toContain("patch=/tmp/run/patch.diff");
    expect(process.exitCode).toBe(0);
  });

  it("combines an optional prompt with the supplied report for regression repair", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv.push("--prompt", "Preserve the existing session behavior.");
    engine.executeLocalRun.mockResolvedValue({
      runId: "repair-run", status: "NOT_REPRODUCIBLE", elapsedMs: 10, costUsd: null,
      verification: { scope: "repository_tests", independentGrader: false },
      artifacts: { dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl" },
    });

    await import("./index.js");
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

    expect(sandbox.readBoundedRegularFile).toHaveBeenCalledWith("/tmp/report.txt", 200_000, "report");
    expect(engine.executeLocalRun).toHaveBeenCalledWith(expect.objectContaining({
      report: "supplied report\n\nPreserve the existing session behavior.",
    }));
  });

  it("rejects an explicitly supplied empty report before either workflow starts", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    sandbox.readBoundedRegularFile.mockReturnValue(Buffer.from(" \n"));

    await import("./index.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(stderr.mock.calls.flat().join("")).toContain("the supplied report is empty");
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
    expect(engine.executeRepositoryReview).not.toHaveBeenCalled();
  });

  it("streams progress to stderr before the run resolves while keeping the final summary on stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    engine.executeLocalRun.mockImplementation((options: { onEvent: (event: HarnessEvent) => void }) => {
      options.onEvent({
        type: "run_start", runKind: "local_repository", runId: "pending-run", seq: 0, ts: Date.now(),
        configHash: "hash", mode: "scripted", model: "supplied-patch", seed: 1, budgets: DEFAULT_BUDGETS,
      });
      options.onEvent({ type: "action_summary", runId: "pending-run", seq: 1, ts: Date.now(), summary: "Preparing isolated tests" });
      return pending;
    });

    await import("./index.js");
    expect(stderr.mock.calls.flat().join("")).toContain("Preparing isolated tests");
    expect(stderr.mock.calls.flat().join("")).toContain("pending-run/events.jsonl");
    expect(stdout).not.toHaveBeenCalled();

    finish({
      runId: "pending-run", status: "NOT_REPRODUCIBLE", elapsedMs: 10, costUsd: null,
      verification: { scope: "repository_tests", independentGrader: false },
      artifacts: { dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl" },
    });
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());
    expect(stdout.mock.calls.flat().join("")).toContain("status=NOT_REPRODUCIBLE");
    expect(stdout.mock.calls.flat().join("")).not.toContain("Preparing isolated tests");
  });

  it.each(["rejection", "cancellation"])("cleans up live progress after %s", async (ending) => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const clearTimer = vi.spyOn(globalThis, "clearInterval");
    const once = vi.spyOn(process, "once");
    let reject!: (reason: Error) => void;
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const pending = new Promise((resolve, rejectRun) => { finish = resolve; reject = rejectRun; });
    engine.executeLocalRun.mockImplementation((options: { onEvent: (event: HarnessEvent) => void; signal: AbortSignal }) => {
      signal = options.signal;
      options.onEvent({
        type: "run_start", runKind: "local_repository", runId: "pending-run", seq: 0, ts: Date.now(),
        configHash: "hash", mode: "scripted", model: "supplied-patch", seed: 1, budgets: DEFAULT_BUDGETS,
      });
      return pending;
    });

    await import("./index.js");
    if (ending === "rejection") {
      reject(new Error("setup failed"));
    } else {
      const interrupt = once.mock.calls.find(call => call[0] === "SIGINT")?.[1];
      expect(interrupt).toBeDefined();
      interrupt?.();
      expect(signal.aborted).toBe(true);
      expect(clearTimer).toHaveBeenCalledTimes(1);
      finish({
        runId: "pending-run", status: "CANCELLED", elapsedMs: 10, costUsd: null,
        verification: { scope: "repository_tests", independentGrader: false },
        artifacts: { dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl" },
      });
    }
    await vi.waitFor(() => expect(process.exitCode).toBe(ending === "rejection" ? 1 : 130));
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TESTS_PASSED", 0],
    ["NOT_REPRODUCIBLE", 0],
    ["INFRA_ERROR", 1],
    ["CANCELLED", 130],
  ])("prints the local assurance boundary and exits correctly for %s", async (status, exitCode) => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    engine.executeLocalRun.mockResolvedValue({
      runId: "local-run", status, elapsedMs: 10, costUsd: null,
      reason: "Repository tests do not independently verify a security fix.",
      verification: { scope: "repository_tests", independentGrader: false },
      artifacts: { dir: "/tmp/run", patch: "/tmp/run/patch.diff", record: "/tmp/run/record.json", events: "/tmp/run/events.jsonl" },
    });

    await import("./index.js");
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

    expect(stdout.mock.calls.flat().join("")).toContain("verification=repository_tests independentGrader=false");
    expect(stdout.mock.calls.flat().join("")).toContain("reason=Repository tests do not independently verify a security fix.");
    expect(process.exitCode).toBe(exitCode);
    expect(engine.executeRun).not.toHaveBeenCalled();
  });

  it("preserves successful independently graded benchmark exits", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = ["node", "vouch", "run", "--task", "fixture", "--condition", "C", "--mode", "scripted"];
    engine.loadTask.mockReturnValue({ id: "fixture" });
    engine.executeRun.mockResolvedValue({
      runId: "benchmark-run", taskId: "fixture", condition: "C", status: "FIXED_VERIFIED",
      configHash: "config", elapsedMs: 10, costUsd: 0, metrics: null, events: [],
    });

    await import("./index.js");
    await vi.waitFor(() => expect(stdout).toHaveBeenCalled());

    expect(stdout.mock.calls.flat().join("")).toContain("status=FIXED_VERIFIED");
    expect(process.exitCode).toBe(0);
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
  });
});
