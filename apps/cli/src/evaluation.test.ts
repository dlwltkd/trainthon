import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceEvaluation } from "@vouch/protocol";
import { summarizeSourceEvaluation } from "@vouch/protocol";
import { executeRepositoryReview } from "@vouch/engine";
import { runCodexSource } from "./evaluation-codex.js";
import { hasUncommittedEvaluationCode, runSourceEvaluation } from "./evaluation.js";

vi.mock("@vouch/engine", () => ({ executeRepositoryReview: vi.fn() }));
vi.mock("./evaluation-codex.js", () => ({ runCodexSource: vi.fn() }));
vi.mock("./progress.js", () => ({ createRunProgress: () => ({ stop: vi.fn(), onEvent: vi.fn() }) }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn((file, args, options) => {
    if (file === "codex") return "codex test";
    if (file === "git") return args.includes("rev-parse") ? "a".repeat(40) : "";
    return actual.execFileSync(file, args, options);
  }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });

describe("paired evaluation orchestration", () => {
  it("allows unrelated untracked presentation images while still rejecting uncommitted implementation", () => {
    expect(hasUncommittedEvaluationCode("?? output/presentations/pitch/cover.png\0")).toBe(false);
    expect(hasUncommittedEvaluationCode(" M packages/skills/src/index.ts\0")).toBe(true);
    expect(hasUncommittedEvaluationCode("?? output/presentations/pitch/helper.ts\0")).toBe(true);
    expect(hasUncommittedEvaluationCode(" M output/presentations/pitch/cover.png\0")).toBe(true);
    expect(hasUncommittedEvaluationCode("?? output/presentations/pitch/cover.png\0?? apps/cli/new.ts\0")).toBe(true);
  });

  it("runs every fixed problem in both arms, excludes reference data, and retains individual failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "vouch-paired-evaluation-"));
    mkdirSync(join(root, "bench/development20"), { recursive: true });
    writeFileSync(join(root, "bench/development20/cases.json"), readFileSync(resolve(import.meta.dirname, "../../../bench/development20/cases.json")));
    vi.stubEnv("OPENAI_API_KEY", "test-only-placeholder");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const answer = (source: string) => JSON.stringify({ verdict: "uncertain", summary: "Uncertain test response", evidence: [{ path: "policy.py", quote: source.split("\n")[0] }], edits: [] });
    let active = 0, peak = 0, codexCalls = 0;
    const tick = async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; };
    vi.mocked(runCodexSource).mockImplementation(async input => {
      const ordinal = codexCalls++;
      expect(input.sourcePath).toBe("policy.py");
      expect(input.prompt).not.toMatch(/reference\.py|case-\d+|fixture:\/\//);
      await tick();
      if (ordinal === 0) throw new Error("test provider failure");
      return { text: answer(input.source), usage: undefined };
    });
    vi.mocked(executeRepositoryReview).mockImplementation(async input => {
      expect(readdirSync(input.repoPath)).toEqual(["policy.py"]);
      expect(input.model).toEqual(input.reviewModel);
      expect(input.prompt).not.toMatch(/reference\.py|case-\d+|fixture:\/\//);
      const source = readFileSync(join(input.repoPath, "policy.py"), "utf8");
      await tick();
      return { runId: "test-only", status: "REVIEW_COMPLETE", usageKnown: false, summary: source.includes("session_active") ? "invalid JSON" : answer(source), changes: { files: [] }, artifacts: { dir: input.repoPath } } as unknown as Awaited<ReturnType<typeof executeRepositoryReview>>;
    });
    try {
      await runSourceEvaluation({ suite: "development20" }, root);
      expect(runCodexSource).toHaveBeenCalledTimes(20);
      expect(executeRepositoryReview).toHaveBeenCalledTimes(20);
      expect(peak).toBe(4);
      const [id] = readdirSync(join(root, "runs/evaluations"));
      const record = JSON.parse(readFileSync(join(root, "runs/evaluations", id!, "evaluation.json"), "utf8")) as SourceEvaluation;
      expect(record.status).toBe("completed");
      expect(record.trials).toHaveLength(40);
      expect(record.trials.filter(trial => trial.status === "error")).toHaveLength(2);
      expect(record.trials.filter(trial => trial.status === "completed")).toHaveLength(38);
      expect(summarizeSourceEvaluation(record)).toMatchObject({ complete: true, differencePp: 0, arms: [{ total: 20, correct: 0, errors: 1 }, { total: 20, correct: 0, errors: 1 }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
