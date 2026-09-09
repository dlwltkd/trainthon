import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderRequestError, ScriptedRunner, type ScriptToolMap, type RunBudget } from "@vouch/model";
import type { HarnessEvent } from "@vouch/protocol";
import { executeRepositoryReview, type ExecuteRepositoryReviewOptions } from "./repository-review.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const original = "export const add = (a: number, b: number) => a - b;\n";
const corrected = "export const add = (a: number, b: number) => a + b;\n";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-source-review-test-"));
  roots.push(root);
  const repoPath = join(root, "calculator");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  mkdirSync(join(repoPath, "tests"));
  writeFileSync(join(repoPath, "src/add.ts"), original);
  writeFileSync(join(repoPath, "settings.config.ts"), "export const precision = 2;\n");
  writeFileSync(join(repoPath, "tests/existing.test.ts"), "// Existing coverage declaration; this workflow does not execute it.\n");
  writeFileSync(join(repoPath, "package.json"), '{"name":"calculator","private":true}\n');
  writeFileSync(join(repoPath, ".env"), "TEST_PLACEHOLDER=not-a-secret\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "arithmetic source fixture");
  const events: HarnessEvent[] = [];
  const options: Omit<ExecuteRepositoryReviewOptions, "runner"> = {
    repoPath, prompt: "Review the addition function and describe any source-level correction needed.",
    runsDir: join(root, "runs"), workspacesDir: join(root, "workspaces"),
    model: { provider: "openai", model: "gpt-test" }, seed: 1,
    budgets: { maxTokens: 30_000, maxSteps: 10, maxWallMs: 20_000 }, onEvent: event => events.push(event),
  };
  return { root, repoPath, git, events, options };
}

const progress = (evidence: string[] = [], completed = false) => ({
  summary: completed ? "The observed source has been reviewed; runtime checks were not executed." : "Inspect the addition implementation before drawing a conclusion.",
  nextAction: completed ? "Hand off the source observations for review." : "Read src/add.ts.", evidence,
  plan: [{ id: "review-add", title: "Review the addition implementation", status: completed ? "completed" : "in_progress" }],
});
const finding = {
  id: "addition", title: "The addition function subtracts its second operand", severity: "low", confidence: "confirmed",
  evidence: ["src/add.ts"], summary: "The inspected implementation returns a - b although the function is named add.",
  recommendation: "Use addition while preserving the function parameters and numeric return value.",
};
async function startReview(tools: ScriptToolMap) {
  await tools.use_skill!({ skillId: "source-security-review", reason: "Inspect the supplied arithmetic source." });
  await tools.report_progress!(progress());
  await tools.read_file!({ path: "src/add.ts" });
  await tools.report_progress!(progress(["src/add.ts"]));
}
async function edit(tools: ScriptToolMap) {
  await tools.report_finding!(finding);
  await tools.use_skill!({ skillId: "source-remediation", reason: "Correct the source behavior identified in the finding." });
  await tools.write_file!({ path: "src/add.ts", content: corrected });
}
async function inspect(tools: ScriptToolMap) {
  await tools.use_skill!({ skillId: "change-validation", reason: "Review the final source diff without running tests." });
  return tools.inspect_diff!({});
}

function assertFinal(record: Awaited<ReturnType<typeof executeRepositoryReview>>, f: ReturnType<typeof fixture>) {
  expect(JSON.parse(readFileSync(record.artifacts.record, "utf8"))).toEqual(record);
  const logged = readFileSync(record.artifacts.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(logged).toEqual(f.events);
  expect(logged.at(-1)).toMatchObject({ type: "run_end", status: record.status, reason: record.reason });
  expect(logged.map(event => event.seq)).toEqual(logged.map((_, index) => index));
  expect(record.verification.testsRun).toBe(false);
  expect(record.verification.independentGrader).toBe(false);
  expect(f.events.some(event => event.type === "test_run")).toBe(false);
  expect(readdirSync(f.options.workspacesDir!)).toEqual([]);
}

describe("prompt-driven source review", () => {
  const reviewModel = { provider: "compatible" as const, model: "review-test", baseURL: "https://api.routeway.ai/v1" };

  it.each(["provider", "cancel"])("preserves candidate edits when %s interruption precedes final validation", async interruption => {
    const f = fixture();
    const controller = new AbortController();
    const record = await executeRepositoryReview({
      ...f.options, remediate: true, signal: controller.signal,
      runner: new ScriptedRunner(async tools => {
        await startReview(tools);
        await edit(tools);
        if (interruption === "cancel") { controller.abort(); return "Not a completed review."; }
        throw new ProviderRequestError("Model API request failed (HTTP 502).", true);
      }),
    });
    expect(record.status).toBe(interruption === "cancel" ? "CANCELLED" : "INFRA_ERROR");
    expect(readFileSync(record.artifacts.patch, "utf8")).toContain(`+${corrected.trim()}`);
    expect(record.changes.files).toEqual(["src/add.ts"]);
    expect(record.changes.findingIdsByFile).toEqual({ "src/add.ts": ["addition"] });
    expect(record.summary).toBe("");
    expect(record).not.toHaveProperty("delivery");
    expect(record.verification.protectedFilesUnchanged).toBe(true);
    expect(readFileSync(join(f.repoPath, "src/add.ts"), "utf8")).toBe(original);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "action_summary", summary: expect.stringContaining("Saved candidate changes from the interrupted run") }));
    assertFinal(record, f);
  });

  it.each(["confirmed", "dismissed", "unresolved"])("records an independent %s assessment and rejects inherited or invented evidence", async verdict => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); await tools.report_finding!(finding); return "Inspect the arithmetic behavior independently."; }),
      runner: new ScriptedRunner(async tools => {
        const assessment = { findingId: "addition", verdict, blueFindingId: verdict === "confirmed" ? "blue-addition" : null, evidence: ["src/add.ts"], summary: "Source was independently inspected; no runtime tests executed." };
        await tools.use_skill!({ skillId: "source-security-review", reason: "Independently inspect the source." });
        await tools.report_progress!(progress());
        await expect(tools.assess_finding!(assessment)).rejects.toThrow("observed file");
        await startReview(tools);
        await expect(tools.assess_finding!({ ...assessment, findingId: "invented" })).rejects.toThrow("Red's handoff");
        if (verdict === "confirmed") {
          await expect(tools.assess_finding!(assessment)).rejects.toThrow("your own confirmed finding");
          await tools.report_finding!({ ...finding, id: "blue-addition" });
        }
        await tools.assess_finding!(assessment);
        return "Independent source assessment recorded; no runtime testing.";
      }),
    });
    expect(record.status, record.reason).toBe("REVIEW_COMPLETE");
    expect(record.assessments).toEqual([expect.objectContaining({ findingId: "addition", verdict, evidence: ["src/add.ts"] })]);
    expect(record.unassessedFindingIds).toEqual([]);
    expect(f.events.filter(event => event.type === "role_completed").map(event => [event.agentRole, event.status])).toEqual([["red", "complete"], ["blue", "complete"]]);
    assertFinal(record, f);
  });

  it.each([false, true])("requires an explicit current assessment instead of final prose; revised Blue finding: %s", async revise => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); await tools.report_finding!(finding); return "A source finding is ready for validation."; }),
      runner: new ScriptedRunner(async tools => {
        await startReview(tools);
        if (revise) {
          await tools.report_finding!(finding);
          await tools.assess_finding!({ findingId: "addition", verdict: "confirmed", blueFindingId: "addition", evidence: ["src/add.ts"], summary: "Arithmetic mismatch observed." });
          await tools.report_finding!({ ...finding, confidence: "potential" });
        }
        return "I assessed every Red finding in prose.";
      }),
    });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record.unassessedFindingIds).toEqual(["addition"]);
    expect(record.assessments).toEqual([]);
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it("hands Red findings to Blue and requires Blue's own source evidence before editing", async () => {
    const f = fixture();
    const phases: string[] = [];
    let sharedBudget: RunBudget | undefined;
    const record = await executeRepositoryReview({
      ...f.options, remediate: true, reviewModel,
      reviewRunner: { run: async input => {
        phases.push(input.role!); sharedBudget = input.budget;
        expect(input.system).toContain("You are Red");
        expect(input.handoffAfter).toBeUndefined();
        expect(input.maxOutputTokens).toBeUndefined();
        expect(input.requestPolicy).toEqual({ maxRetries: 2, timeoutMs: 90_000, transport: "stream", progressEverySteps: 6, contextCheckpointBytes: 64_000 });
        return new ScriptedRunner(async tools => {
          for (const name of ["write_file", "edit_file", "inspect_diff", "run_regression", "shell", "fetch"]) expect(tools[name]).toBeUndefined();
          await startReview(tools);
          await tools.report_finding!(finding);
          await expect(tools.use_skill!({ skillId: "source-remediation", reason: "Try changing source." })).rejects.toThrow();
          await tools.report_progress!(progress(["src/add.ts"], true));
          return "Red observed subtraction in src/add.ts; Blue must independently check the arithmetic behavior.";
        }).run(input);
      } },
      runner: { run: async input => {
        phases.push(input.role!);
        expect(input.budget).toBe(sharedBudget);
        expect(input.requestPolicy).toEqual({ maxRetries: 2, timeoutMs: 90_000, transport: "stream", progressEverySteps: 6, contextCheckpointBytes: 64_000 });
        expect(input.prompt).toContain("Red source-review handoff");
        expect(input.prompt).toContain('"findingId": "addition"');
        expect(input.system).toContain("Independently validate every Red finding");
        return new ScriptedRunner(async tools => {
          await tools.use_skill!({ skillId: "source-security-review", reason: "Check Red's arithmetic observation." });
          await tools.report_progress!(progress());
          await expect(tools.report_finding!(finding)).rejects.toThrow("observed file");
          await tools.use_skill!({ skillId: "source-remediation", reason: "Check whether Red's finding authorizes a patch." });
          await expect(tools.write_file!({ path: "src/add.ts", content: corrected })).rejects.toThrow("confirmed source-backed finding");
          await startReview(tools);
          await edit(tools);
          await tools.assess_finding!({ findingId: "addition", verdict: "confirmed", blueFindingId: "addition", evidence: ["src/add.ts"], summary: "Independently confirmed the arithmetic mismatch." });
          await inspect(tools);
          await tools.report_progress!(progress(["src/add.ts"], true));
          return "Blue independently confirmed Red's arithmetic observation and inspected the proposed correction. Tests were not run.";
        }).run(input);
      } },
    });
    expect(phases).toEqual(["red", "blue"]);
    expect(record.status).toBe("PATCH_PROPOSED");
    expect(record.reviewModel).toEqual(reviewModel);
    expect(record.reviewSummary).toContain("Red observed subtraction");
    expect(record.reviewStatus).toBe("complete");
    expect(record).not.toHaveProperty("reviewHandoffAfter");
    expect(record.requestPolicy).toEqual({ maxRetries: 2, timeoutMs: 90_000, transport: "stream", progressEverySteps: 6, contextCheckpointBytes: 64_000 });
    expect(record.usage.steps).toBe(2);
    expect(record.findings.map(finding => [finding.agentRole, finding.findingId])).toEqual([["red", "addition"], ["blue", "addition"]]);
    expect(record.changes.findingIdsByFile).toEqual({ "src/add.ts": ["addition"] });
    expect(f.events.filter(event => event.type === "role_assigned").map(event => event.role)).toEqual(["red", "blue"]);
    expect(f.events.filter(event => event.type === "skill_call")).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentRole: "red", skillId: "source-security-review", stage: "REVIEW" }),
      expect.objectContaining({ agentRole: "blue", skillId: "source-remediation", stage: "PATCH" }),
    ]));
    expect(JSON.parse(readFileSync(record.artifacts.redReviewHandoff!, "utf8"))).toMatchObject({ sourceEvidenceObserved: true, testsRun: false, findings: [expect.objectContaining({ findingId: "addition" })] });
    expect(readFileSync(record.artifacts.redReviewSummary!, "utf8")).toBe(record.reviewSummary);
    assertFinal(record, f);
  });

  it.each(["I assume the source is fine.", ""])("does not start Blue without Red source evidence, regardless of final text: %j", async finalText => {
    const f = fixture();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async () => finalText),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected Blue run"; }),
    });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record.reason).toContain("Blue was not started");
    expect(blueInvoked).toBe(false);
    expect(record.summary).toBe("");
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it.each([true, false])("passes an explicitly partial Red handoff without a fabricated summary; Blue source validation: %s", async blueReadsSource => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); return ""; }),
      runner: { run: async input => {
        expect(input.prompt).toContain('"reviewStatus": "partial"');
        expect(input.prompt).toContain("Red returned no final summary");
        expect(input.prompt).toContain('"observedFiles": [\n    "src/add.ts"\n  ]');
        return new ScriptedRunner(async tools => {
          if (blueReadsSource) await startReview(tools);
          else {
            await tools.use_skill!({ skillId: "source-security-review", reason: "Inspect the partial Red handoff." });
            await tools.report_progress!(progress());
          }
          return blueReadsSource ? "Blue independently inspected the source. No tests were run." : "I accept the handoff without reading source.";
        }).run(input);
      } },
    });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record.reviewStatus).toBe("partial");
    expect(record.reviewSummary).toBe("");
    expect(readFileSync(record.artifacts.redReviewSummary!, "utf8")).toBe("");
    expect(JSON.parse(readFileSync(record.artifacts.redReviewHandoff!, "utf8"))).toMatchObject({ reviewStatus: "partial", summary: "", observedFiles: ["src/add.ts"], sourceEvidenceObserved: true, findings: [], harnessNote: expect.stringContaining("Red returned no final summary") });
    expect(f.events.filter(event => event.type === "agent_summary" && event.agentRole === "red")).toEqual([]);
    expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "action_summary", summary: expect.stringContaining("partial handoff") })]));
    expect(record.findings).toEqual([]);
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it("does not count Red's observations as Blue's completed validation", async () => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); return "Reviewed arithmetic source; Blue must validate."; }),
      runner: new ScriptedRunner(async tools => {
        await tools.use_skill!({ skillId: "source-security-review", reason: "Review Red's summary." });
        await tools.report_progress!(progress());
        return "I agree with Red without reading source.";
      }),
    });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it("preserves observed Red evidence after exhausted transient retries while requiring Blue's own validation", async () => {
    const f = fixture();
    const failure = new ProviderRequestError("Model API request failed (HTTP 502).", true);
    const record = await executeRepositoryReview({
      ...f.options, remediate: true, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); await tools.report_finding!(finding); throw failure; }),
      runner: { run: async input => {
        expect(input.prompt).toContain('"reviewStatus": "partial"');
        expect(input.prompt).toContain("failed after retries");
        expect(input.prompt).toContain("HTTP 502");
        return new ScriptedRunner(async tools => {
          await tools.use_skill!({ skillId: "source-security-review", reason: "Independently assess the partial handoff." });
          await tools.report_progress!(progress());
          await tools.use_skill!({ skillId: "source-remediation", reason: "Check the partial handoff." });
          await expect(tools.write_file!({ path: "src/add.ts", content: corrected })).rejects.toThrow("confirmed source-backed finding");
          await startReview(tools);
          await edit(tools);
          await tools.assess_finding!({ findingId: "addition", verdict: "confirmed", blueFindingId: "addition", evidence: ["src/add.ts"], summary: "Independently confirmed the arithmetic mismatch." });
          await inspect(tools);
          return "Blue independently confirmed the observed arithmetic mismatch and inspected the correction. Tests were not run.";
        }).run(input);
      } },
    });
    expect(record.status, record.reason).toBe("INCOMPLETE_REVIEW");
    expect(record.reason).toContain("Red did not complete");
    expect(record).not.toHaveProperty("delivery");
    expect(readFileSync(record.artifacts.patch, "utf8")).toContain("+export");
    expect(record.reviewStatus).toBe("partial");
    expect(record.reviewSummary).toBe("");
    expect(record.reviewFailure).toBe(failure.message);
    expect(record.findings.map(item => item.agentRole)).toEqual(["red", "blue"]);
    expect(JSON.parse(readFileSync(record.artifacts.redReviewHandoff!, "utf8"))).toMatchObject({ reviewStatus: "partial", summary: "", providerError: failure.message, sourceEvidenceObserved: true, observedFiles: ["src/add.ts"], findings: [expect.objectContaining({ findingId: "addition" })] });
    expect(f.events.filter(event => event.type === "agent_summary" && event.agentRole === "red")).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "action_summary", summary: expect.stringContaining("failed after retries") }));
    assertFinal(record, f);
  });

  it.each([
    { observed: false, error: new ProviderRequestError("HTTP 502", true) },
    { observed: true, error: new ProviderRequestError("HTTP 401", false) },
    { observed: true, error: new Error("Local tool failure") },
  ])("stops on Red failure without usable source or a transient transport classification: $observed / $error.message", async ({ observed, error }) => {
    const f = fixture();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { if (observed) await startReview(tools); throw error; }),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected"; }),
    });
    expect(record.status).toBe("INFRA_ERROR");
    expect(record.reason).toBe(error.message);
    expect(blueInvoked).toBe(false);
    expect(record).not.toHaveProperty("reviewStatus");
    assertFinal(record, f);
  });

  it("does not bypass the shared step limit with a partial handoff after a Red API failure", async () => {
    const f = fixture();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, budgets: { ...f.options.budgets, maxSteps: 1 }, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); throw new ProviderRequestError("HTTP 502", true); }),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected"; }),
    });
    expect(record.status).toBe("BUDGET_TIMEOUT");
    expect(record.reviewStatus).toBe("partial");
    expect(record.reason).toContain("steps");
    expect(blueInvoked).toBe(false);
    assertFinal(record, f);
  });

  it.each(["read", "search"])("accepts Red's handoff from an actual %s without inventing a final progress event", async sourceTool => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => {
        await tools.use_skill!({ skillId: "source-security-review", reason: "Inspect the selected arithmetic source." });
        await tools.report_progress!(progress());
        if (sourceTool === "read") await tools.read_file!({ path: "src/add.ts" });
        else await tools.grep!({ pattern: "a - b", path: "src/add.ts" });
        return "Observed subtraction in src/add.ts. This bounded review did not establish wider coverage; Blue should independently review the source.";
      }),
      runner: new ScriptedRunner(async tools => { await startReview(tools); return "Independently inspected the source; no tests were run."; }),
    });
    expect(record.status).toBe("REVIEW_COMPLETE");
    expect(f.events.filter(event => event.type === "agent_update" && event.agentRole === "red")).toEqual([expect.objectContaining({ evidence: [] })]);
    expect(JSON.parse(readFileSync(record.artifacts.redReviewHandoff!, "utf8"))).toMatchObject({ observedFiles: ["src/add.ts"], sourceEvidenceObserved: true, findings: [] });
    expect(record.findings).toEqual([]);
    assertFinal(record, f);
  });

  it("does not count a listing or an empty search as observed Red source evidence", async () => {
    const f = fixture();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => {
        await tools.use_skill!({ skillId: "source-security-review", reason: "Locate the relevant source." });
        await tools.report_progress!(progress());
        await tools.list_dir!({ path: "." });
        await tools.grep!({ pattern: "nonexistent-expression", path: "src/add.ts" });
        return "No source contents were inspected before this handoff.";
      }),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected"; }),
    });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(blueInvoked).toBe(false);
    expect(JSON.parse(readFileSync(record.artifacts.redReviewHandoff!, "utf8"))).toMatchObject({ observedFiles: [], sourceEvidenceObserved: false });
    assertFinal(record, f);
  });

  it("lets Blue reject Red's claim without making a source change", async () => {
    const f = fixture();
    const record = await executeRepositoryReview({
      ...f.options, remediate: true, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => {
        await startReview(tools); await tools.report_finding!({ ...finding, id: "wrong-claim", title: "The function multiplies operands", summary: "Potential arithmetic mismatch.", confidence: "potential" });
        return "Please check the potential wrong-claim finding.";
      }),
      runner: new ScriptedRunner(async tools => {
        await startReview(tools); await tools.report_progress!(progress(["src/add.ts"], true));
        await tools.assess_finding!({ findingId: "wrong-claim", verdict: "dismissed", blueFindingId: null, evidence: ["src/add.ts"], summary: "The inspected function subtracts its second operand; it does not multiply." });
        return "Rejected wrong-claim: the observed source subtracts and does not multiply. No change proposed under this claim; tests were not run.";
      }),
    });
    expect(record.status).toBe("REVIEW_COMPLETE");
    expect(record.findings).toEqual([expect.objectContaining({ findingId: "wrong-claim", agentRole: "red", confidence: "potential" })]);
    expect(record.changes.files).toEqual([]);
    expect(record.verification.protectedFilesUnchanged).toBe(true);
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it("shares the run budget across Red and Blue rather than resetting it at handoff", async () => {
    const f = fixture();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, budgets: { ...f.options.budgets, maxSteps: 1 }, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); return "Source inspected; handoff prepared."; }),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected"; }),
    });
    expect(record.status).toBe("BUDGET_TIMEOUT");
    expect(record.reason).toContain("steps");
    expect(record.reviewSummary).toContain("handoff prepared");
    expect(record.usage.steps).toBe(1);
    expect(blueInvoked).toBe(false);
    assertFinal(record, f);
  });

  it("stops before Blue when Red is cancelled and cleans the shared snapshot", async () => {
    const f = fixture();
    const controller = new AbortController();
    let blueInvoked = false;
    const record = await executeRepositoryReview({
      ...f.options, signal: controller.signal, reviewModel,
      reviewRunner: new ScriptedRunner(async tools => { await startReview(tools); controller.abort(); return "Late Red answer"; }),
      runner: new ScriptedRunner(async () => { blueInvoked = true; return "Unexpected"; }),
    });
    expect(record.status).toBe("CANCELLED");
    expect(blueInvoked).toBe(false);
    expect(record.summary).toBe("");
    assertFinal(record, f);
  });

  it("persists a setup failure and final event when model configuration is invalid", async () => {
    const f = fixture();
    let invoked = false;
    const record = await executeRepositoryReview({
      ...f.options, model: { provider: "openai", model: "" },
      runner: new ScriptedRunner(async () => { invoked = true; return "unexpected"; }),
    });
    expect(record.status).toBe("SETUP_ERROR");
    expect(record.verification.protectedFilesUnchanged).toBe(false);
    expect(record.reason).toContain("nonempty model ID");
    expect(record.configHash).toBe("invalid-config");
    expect(invoked).toBe(false);
    expect(JSON.parse(readFileSync(record.artifacts.record, "utf8"))).toEqual(record);
    expect(f.events[0]?.type).toBe("run_start");
    expect(f.events.at(-1)).toMatchObject({ type: "run_end", status: "SETUP_ERROR", reason: record.reason });
    expect(existsSync(f.options.workspacesDir!)).toBe(false);
  });

  it("completes a source-backed review without a report, regression, dependency install or execution tools", async () => {
    const f = fixture();
    const record = await executeRepositoryReview({ ...f.options, runner: new ScriptedRunner(async tools => {
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(["use_skill", "report_progress", "read_file", "grep", "list_dir", "report_finding"]));
      for (const name of ["write_file", "inspect_diff", "run_regression", "run_functional_tests", "shell", "exec", "fetch"]) expect(tools[name]).toBeUndefined();
      await startReview(tools);
      await tools.report_finding!(finding);
      await tools.report_progress!(progress(["src/add.ts"], true));
      return "The inspected add function subtracts. Recommend adding the operands; no runtime checks were run.";
    }) });
    expect(record.status).toBe("REVIEW_COMPLETE");
    expect(record.workflow).toBe("repository_review");
    expect(record.findings).toEqual([expect.objectContaining({ findingId: "addition", confidence: "confirmed", evidence: ["src/add.ts"] })]);
    expect(record.verification.scope).toBe("source_review");
    expect(record).not.toHaveProperty("delivery");
    expect(record.repository).not.toHaveProperty("regressionPath");
    expect(readFileSync(record.artifacts.report, "utf8")).toBe("");
    expect(readFileSync(join(record.artifacts.dir, "source/src/add.ts"), "utf8")).toBe(original);
    expect(existsSync(join(record.artifacts.dir, "source/.env"))).toBe(false);
    expect(f.events.filter(event => event.type === "skill_call" || event.type === "agent_update" || event.type === "finding_reported")).toEqual(expect.arrayContaining([expect.objectContaining({ agentRole: "blue", stage: "REVIEW" })]));
    expect(f.git("status", "--porcelain")).toBe("");
    assertFinal(record, f);
  });

  it("marks a prose-only answer incomplete when no source file was observed", async () => {
    const f = fixture();
    const record = await executeRepositoryReview({ ...f.options, runner: new ScriptedRunner(async tools => {
      await tools.use_skill!({ skillId: "source-security-review", reason: "Plan a source review." });
      await tools.report_progress!(progress());
      await expect(tools.report_progress!(progress(["src/add.ts"], true))).rejects.toThrow("observed repository file");
      return "The repository looks fine.";
    }) });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record.findings).toEqual([]);
    expect(record).not.toHaveProperty("delivery");
    assertFinal(record, f);
  });

  it("retains the source-only correction and delivery hashes after the final diff is inspected", async () => {
    const f = fixture();
    writeFileSync(join(f.repoPath, "settings.config.ts"), "// unrelated user change\n");
    const before = f.git("status", "--porcelain");
    const record = await executeRepositoryReview({ ...f.options, remediate: true, runner: new ScriptedRunner(async tools => {
      expect(tools.run_regression).toBeUndefined();
      expect(tools.run_functional_tests).toBeUndefined();
      await startReview(tools);
      await edit(tools);
      const diff = await inspect(tools);
      expect(diff).toMatchObject({ changedFiles: ["src/add.ts"], checks: { protectedFilesUnchanged: true, testsRun: false } });
      await tools.report_progress!(progress(["src/add.ts"], true));
      return "Proposed addition correction. Inspected the final diff; tests were not run.";
    }) });
    expect(record.status).toBe("PATCH_PROPOSED");
    expect(record.workflow).toBe("repository_remediation");
    expect(record.verification).toMatchObject({ scope: "source_patch", testsRun: false, protectedFilesUnchanged: true });
    const patch = readFileSync(record.artifacts.patch);
    expect(record.delivery).toEqual({ patchHash: sha256(patch), files: [{ path: "src/add.ts", deleted: false, sha256: sha256(corrected) }] });
    expect(readFileSync(join(record.artifacts.dir, "source/src/add.ts"), "utf8")).toBe(original);
    expect(readFileSync(join(record.artifacts.dir, "candidate/src/add.ts"), "utf8")).toBe(corrected);
    expect(readFileSync(join(f.repoPath, "src/add.ts"), "utf8")).toBe(original);
    expect(f.git("status", "--porcelain")).toBe(before);
    expect(f.events.filter(event => event.type === "skill_call").map(event => event.skillId)).toEqual(["source-security-review", "source-remediation", "change-validation"]);
    expect(f.events.filter(event => event.type === "finding_reported")).toEqual([expect.objectContaining({ agentRole: "blue", stage: "REVIEW" })]);
    expect(record.changes.findingIdsByFile).toEqual({ "src/add.ts": ["addition"] });
    expect(record.findings).toEqual(f.events.filter(event => event.type === "finding_reported"));
    expect(f.events.filter(event => event.type === "state_change").map(event => event.to)).toEqual(["CONTEXT", "REVIEW", "PATCH", "DONE"]);
    assertFinal(record, f);
  });

  it.each([false, true])("does not offer delivery when the final patch lacks current diff inspection (edit after inspection: %s)", async editAgain => {
    const f = fixture();
    const record = await executeRepositoryReview({ ...f.options, remediate: true, runner: new ScriptedRunner(async tools => {
      await startReview(tools);
      await edit(tools);
      if (editAgain) {
        await inspect(tools);
        await tools.use_skill!({ skillId: "source-remediation", reason: "Adjust the candidate after reviewing the first diff." });
        await tools.write_file!({ path: "src/add.ts", content: corrected + "\n" });
      }
      await tools.report_progress!(progress(["src/add.ts"], true));
      return "A source correction is proposed, with follow-up validation needed.";
    }) });
    expect(record.status).toBe("INCOMPLETE_REVIEW");
    expect(record.reason).toContain("final patch was not inspected");
    expect(record.changes.files).toEqual(["src/add.ts"]);
    expect(readFileSync(record.artifacts.patch, "utf8")).toContain("a + b");
    expect(record).not.toHaveProperty("delivery");
    expect(existsSync(join(record.artifacts.dir, "candidate"))).toBe(false);
    assertFinal(record, f);
  });

  it("blocks edits without the right skill and confirmed evidence, plus protected paths", async () => {
    const f = fixture();
    const record = await executeRepositoryReview({ ...f.options, remediate: true, runner: new ScriptedRunner(async tools => {
      await startReview(tools);
      await expect(tools.write_file!({ path: "src/add.ts", content: corrected })).rejects.toThrow("source-remediation");
      await expect(tools.report_finding!({ ...finding, evidence: ["settings.config.ts"] })).rejects.toThrow("observed file");
      await tools.use_skill!({ skillId: "source-remediation", reason: "Check whether a justified edit is available." });
      await expect(tools.write_file!({ path: "src/add.ts", content: corrected })).rejects.toThrow("confirmed source-backed finding");
      await tools.report_finding!({ ...finding, confidence: "potential" });
      await expect(tools.write_file!({ path: "src/add.ts", content: corrected })).rejects.toThrow("confirmed source-backed finding");
      await tools.report_finding!(finding);
      await expect(tools.write_file!({ path: "src/unrelated.ts", content: corrected })).rejects.toThrow("findingId");
      for (const path of ["settings.config.ts", "tests/existing.test.ts", "package.json", ".env"]) {
        await expect(tools.write_file!({ path, content: "unchanged" })).rejects.toThrow("only application source files");
      }
      await expect(tools.inspect_diff!({})).rejects.toThrow("change-validation");
      await tools.report_progress!(progress(["src/add.ts"], true));
      return "Recorded a source observation; no permitted change was made.";
    }) });
    expect(record.status).toBe("REVIEW_COMPLETE");
    expect(record.changes.files).toEqual([]);
    expect(record).not.toHaveProperty("delivery");
    expect(f.events.filter(event => event.type === "tool_error").length).toBeGreaterThanOrEqual(8);
    expect(readFileSync(join(f.repoPath, "src/add.ts"), "utf8")).toBe(original);
    assertFinal(record, f);
  });

  it("cancels a pending model, cleans snapshots and rejects late tools after run_end", async () => {
    const f = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    let lateFinished!: () => void;
    const atModel = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const late = new Promise<void>(resolve => { lateFinished = resolve; });
    const run = executeRepositoryReview({ ...f.options, signal: controller.signal, runner: new ScriptedRunner(async tools => {
      await startReview(tools);
      entered();
      await gate;
      try { await expect(tools.read_file!({ path: "src/add.ts" })).rejects.toThrow("cancelled"); }
      finally { lateFinished(); }
      return "late model answer";
    }) });
    await atModel;
    controller.abort();
    const record = await run;
    expect(record.status).toBe("CANCELLED");
    assertFinal(record, f);
    const before = readFileSync(record.artifacts.events, "utf8");
    release();
    await late;
    expect(readFileSync(record.artifacts.events, "utf8")).toBe(before);
    expect(record).not.toHaveProperty("delivery");
    expect(f.git("status", "--porcelain")).toBe("");
  });
});
