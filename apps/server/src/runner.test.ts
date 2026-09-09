import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_BUDGETS, type HarnessEvent } from "@vouch/protocol";
import { RunRegistry } from "./registry.js";
import { startRun, type RepositoryStartRequest, type StartRequest } from "./runner.js";

const engine = vi.hoisted(() => ({
  executeLocalRun: vi.fn(),
  executeRepositoryReview: vi.fn(),
  executeRun: vi.fn(),
  loadTask: vi.fn(),
}));
const sandbox = vi.hoisted(() => ({ readBoundedRegularFile: vi.fn() }));
vi.mock("@vouch/engine", () => engine);
vi.mock("@vouch/sandbox", () => sandbox);

const roots: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VOUCH_BLUE_MODEL", "gpt-review-fixture");
  vi.stubEnv("VOUCH_BLUE_PROVIDER", "openai");
  vi.stubEnv("VOUCH_RED_MODEL", "glm-review-fixture");
  vi.stubEnv("VOUCH_RED_PROVIDER", "compatible");
  sandbox.readBoundedRegularFile.mockReturnValue(Buffer.from("optional supplied report"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "vouch-server-runner-"));
  roots.push(repoRoot);
  const paths = { repoRoot, runsDir: join(repoRoot, "runs"), benchDir: join(repoRoot, "bench") };
  mkdirSync(paths.runsDir);
  return { paths, registry: new RunRegistry(paths.runsDir) };
}

function holdRun(execute: Mock) {
  let complete!: () => void;
  let onEvent!: (event: HarnessEvent) => void;
  execute.mockImplementation((options: { onEvent: (event: HarnessEvent) => void }) => {
    onEvent = options.onEvent;
    onEvent({
      type: "run_start", runId: "run-1", seq: 0, ts: 100, runKind: "local_repository",
      workflow: "repository_review", model: "gpt-review-fixture", configHash: "fixture",
      seed: 1, budgets: DEFAULT_BUDGETS, mode: "live",
    });
    return new Promise<void>(resolve => { complete = resolve; });
  });
  return {
    emit(event: HarnessEvent) { onEvent(event); },
    finish() { complete(); },
  };
}

const review: RepositoryStartRequest = {
  kind: "repository", repoPath: "https://github.com/example/project.git/",
  prompt: "Review session expiry and ownership checks.", mode: "live",
};

describe("repository run launcher", () => {
  it("starts a prompt-only review without a report, regression, or irrelevant Red configuration", async () => {
    const { paths, registry } = fixture();
    vi.stubEnv("VOUCH_RED_PROVIDER", "unused-invalid-provider");
    const execution = holdRun(engine.executeRepositoryReview);
    const run = await startRun(review, paths, registry);

    expect(engine.executeRepositoryReview).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: review.repoPath, prompt: review.prompt, report: "", remediate: false,
      model: expect.objectContaining({ model: "gpt-review-fixture", provider: "openai" }), seed: 1,
      budgets: DEFAULT_BUDGETS, runsDir: paths.runsDir,
    }));
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
    expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
    expect(run.sidecar.repoPath).toBeUndefined();
    expect(run.events[0]?.type).toBe("run_start");
    expect(registry.getActive("run-1")).toBe(run);
    expect(registry.activeCount).toBe(1);

    const listener = vi.fn();
    run.listeners.add(listener);
    const update: HarnessEvent = { type: "action_summary", runId: "run-1", seq: 1, ts: 101, summary: "Reading session code" };
    execution.emit(update);
    expect(listener).toHaveBeenCalledWith(update);
    expect(run.events).toHaveLength(2);
    execution.finish();
    await vi.waitFor(() => expect(run.done).toBe(true));
    expect(registry.activeCount).toBe(0);
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it("enables source remediation only for its explicit workflow", async () => {
    const { paths, registry } = fixture();
    const execution = holdRun(engine.executeRepositoryReview);
    const run = await startRun({ ...review, workflow: "remediate", ref: "release", seed: 4 }, paths, registry);
    expect(engine.executeRepositoryReview).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: review.repoPath, remediate: true, ref: "release", seed: 4,
    }));
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
    execution.finish();
    await vi.waitFor(() => expect(run.done).toBe(true));
  });

  it.each([
    { reportText: "supplied report in request" },
    { reportPath: "/tmp/vouch-runner-report.md" },
  ])("accepts optional report context for review: %j", async (input) => {
    const { paths, registry } = fixture();
    const execution = holdRun(engine.executeRepositoryReview);
    const run = await startRun({ ...review, ...input }, paths, registry);
    expect(engine.executeRepositoryReview).toHaveBeenCalledWith(expect.objectContaining({
      report: "reportText" in input ? input.reportText : "optional supplied report",
    }));
    if ("reportPath" in input) {
      expect(sandbox.readBoundedRegularFile).toHaveBeenCalledWith(input.reportPath, 200_000, "report");
    } else {
      expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
    }
    execution.finish();
    await vi.waitFor(() => expect(run.done).toBe(true));
  });

  it("requires a regression for test-based repair and preserves its URL without a report", async () => {
    const { paths, registry } = fixture();
    await expect(startRun({ ...review, workflow: "repair" }, paths, registry)).rejects.toThrow("regressionPath is required");
    expect(engine.executeLocalRun).not.toHaveBeenCalled();
    const execution = holdRun(engine.executeLocalRun);
    const run = await startRun({ kind: "repository", repoPath: review.repoPath, regressionPath: "tests/test_security.py", mode: "live", review: false }, paths, registry);
    expect(engine.executeLocalRun).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: review.repoPath, regressionPath: "tests/test_security.py", report: "", ref: "HEAD", reviewModel: undefined,
    }));
    expect(engine.executeRepositoryReview).not.toHaveBeenCalled();
    expect(sandbox.readBoundedRegularFile).not.toHaveBeenCalled();
    expect(run.sidecar.repoPath).toBeUndefined();
    execution.finish();
    await vi.waitFor(() => expect(run.done).toBe(true));
  });

  it("never forwards request-provided callbacks or engine injection seams", async () => {
    const { paths, registry } = fixture();
    const execution = holdRun(engine.executeRepositoryReview);
    const injected = vi.fn();
    const request = {
      ...review, onEvent: injected, reviewRunner: injected, repairRunner: injected,
      acquireSource: injected, model: { model: "request-chosen-model" },
      budgets: { maxTokens: 999_999_999 },
    } as unknown as StartRequest;
    const run = await startRun(request, paths, registry);
    const options = engine.executeRepositoryReview.mock.calls[0]![0];
    expect(options.onEvent).not.toBe(injected);
    expect(options).not.toHaveProperty("reviewRunner");
    expect(options).not.toHaveProperty("repairRunner");
    expect(options).not.toHaveProperty("acquireSource");
    expect(options.budgets).toEqual(DEFAULT_BUDGETS);
    expect(options.model.model).toBe("gpt-review-fixture");
    expect(injected).not.toHaveBeenCalled();
    execution.finish();
    await vi.waitFor(() => expect(run.done).toBe(true));
  });

  it("rejects an engine startup failure without registering an invented run", async () => {
    const { paths, registry } = fixture();
    engine.executeRepositoryReview.mockRejectedValue(new Error("repository input rejected"));
    await expect(startRun(review, paths, registry)).rejects.toThrow("repository input rejected");
    expect(registry.activeCount).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});
