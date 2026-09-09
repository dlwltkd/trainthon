import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
