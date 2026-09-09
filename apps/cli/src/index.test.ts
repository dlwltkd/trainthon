import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGETS, type HarnessEvent } from "@vouch/protocol";

const engine = vi.hoisted(() => ({
  executeLocalRun: vi.fn(),
  executeRun: vi.fn(),
  loadTask: vi.fn(),
}));

vi.mock("@vouch/engine", () => engine);
vi.mock("@vouch/sandbox", () => ({ readBoundedRegularFile: () => Buffer.from("supplied report") }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
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
