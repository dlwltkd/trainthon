import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedRunner, type ScriptToolMap } from "@vouch/model";
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
  it("persists a setup failure and final event when model configuration is invalid", async () => {
    const f = fixture();
    let invoked = false;
    const record = await executeRepositoryReview({
      ...f.options, model: { provider: "openai", model: "" },
      runner: new ScriptedRunner(async () => { invoked = true; return "unexpected"; }),
    });
    expect(record.status).toBe("SETUP_ERROR");
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
