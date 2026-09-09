import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeRepositoryReview } from "@vouch/engine";
import { summarizeSourceEvaluation, type EvaluationCase, type EvaluationTrial, type SourceEvaluation } from "@vouch/protocol";
import { COHORT_URL, evaluationCases, prepareEvaluationSources, sha256 } from "./evaluation-cohort.js";
import { runCodexSource } from "./evaluation-codex.js";
import { applyAnswerEdits, gradeSourceAnswer, parseSourceAnswer } from "./evaluation-grade.js";
import { createRunProgress } from "./progress.js";

function writeJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function runSourceEvaluation(flags: Record<string, string | boolean>, repoRoot: string): Promise<void> {
  for (const key of Object.keys(flags)) if (!["suite", "prepare"].includes(key)) throw new Error(`unknown evaluation flag: --${key}`);
  if (flags.suite !== "cvefixes") throw new Error("use --suite cvefixes");
  if (flags.prepare !== undefined && flags.prepare !== true) throw new Error("--prepare is a boolean flag");
  const runsDir = join(repoRoot, "runs"), cacheDir = join(runsDir, "evaluation-cache");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    process.stdout.write("Preparing four hash-pinned source snapshots from the CVEfixes example cohort.\n");
    await prepareEvaluationSources(cacheDir, controller.signal);
    if (flags.prepare) { process.stdout.write(`Prepared ${evaluationCases().length} cases in ${cacheDir}\n`); return; }
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for the paired live evaluation");
    const codexVersion = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    execFileSync("python3", ["-I", "-c", "import ast"], { timeout: 10_000 });
    const codeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 }).trim();
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 }).trim()) {
      throw new Error("commit the evaluation implementation before a measured run so code provenance is reproducible");
    }
    const id = `cvefixes-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const dir = join(runsDir, "evaluations", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest: SourceEvaluation["manifest"] = {
      suite: "cvefixes-source-pilot-v2", datasetUrl: "https://github.com/secureIT-project/CVEfixes", cohortUrl: COHORT_URL,
      selection: "Two Python source-fix cases from the official example cohort, selected before any evaluation: CWE-93 and CWE-755. Each fixing commit and its first parent provide a paired before/fixed control. This is a convenience sample from one project, not the full CVEfixes release.",
      model: "gpt-5.6-sol", codeCommit, codexVersion, maxWallMs: 8 * 60_000, cumulativeTokenLimit: null, vouchMaxSteps: null, seed: 1,
      grader: "python-ast-reference-v1", runtimeTests: false,
      conditions: {
        codex: "Native Codex CLI, source-only configuration: full file in the prompt, JSON replacements, tools/web/host skills disabled, read-only process workspace, provider defaults for reasoning. This is not unrestricted default Codex.",
        vouch: "Production Red review then Blue validation/repair, separate source workspaces, bounded file tools and skills, same model for both roles, provider defaults for reasoning. No source execution or tool network access.",
      },
      limitations: [
        "Development pilot v2: the 40-step Vouch cutoff was removed after inspecting v1's incomplete repair. The cohort, prompts, grader, model, and wall-time allowance are unchanged. This is a development-set re-evaluation, not a held-out performance result. Earlier experiments remain available.",
        "Four snapshots from two CVEs in one project; correlated samples and possible model training contamination. No general security-performance claim or statistical significance is established.",
        "The task names the CWE and relevant functions. Baseline receives the whole file inline; Vouch reads it through tools. Model-call counts and reasoning defaults differ. Equal model and wall-time allowance do not mean equal compute.",
        "Label agreement requires a verbatim source citation; the explanation still needs human review. Fixed controls are fixed only for the scoped concern, not certified free of all vulnerabilities.",
        "AST equality is a conservative comparison with the published correction. It can reject valid alternative fixes and is not a semantic or runtime regression test. Neither candidate nor reference code is executed.",
        "All planned trials remain in the denominator. Errors and uncertain answers earn no credit. No target uplift, best-of selection, or removal of unsuccessful trials.",
      ], cases: evaluationCases(),
    };
    const evaluation: SourceEvaluation = { schemaVersion: 1, id, status: "running", createdAt: Date.now(), manifestHash: sha256(JSON.stringify(manifest)), manifest,
      trials: manifest.cases.flatMap(task => (["codex", "vouch"] as const).map(arm => ({ caseId: task.id, arm, status: "pending" }))) };
    const save = () => writeJson(join(dir, "evaluation.json"), evaluation);
    writeJson(join(dir, "manifest.json"), { manifestHash: evaluation.manifestHash, manifest });
    save();
    process.stdout.write(`Evaluation ${id}\nFrozen manifest ${evaluation.manifestHash}\nDashboard: http://127.0.0.1:8787/#/bench\n`);

    const executeTrial = async (task: EvaluationCase, trial: EvaluationTrial) => {
      const trialDir = join(dir, `${task.id}-${trial.arm}`);
      mkdirSync(trialDir, { mode: 0o700 });
      trial.status = "running"; trial.startedAt = Date.now(); save();
      process.stdout.write(`${task.id} ${trial.arm}: started\n`);
      let stopProgress: (() => void) | undefined;
      try {
        controller.signal.throwIfAborted();
        const original = readFileSync(join(cacheDir, `${task.sourceSha256}.py`), "utf8");
        const reference = readFileSync(join(cacheDir, `${task.referenceSha256}.py`), "utf8");
        if (sha256(original) !== task.sourceSha256 || sha256(reference) !== task.referenceSha256) throw new Error("cached source integrity check failed");
        let text: string, candidate: string;
        if (trial.arm === "codex") {
          const result = await runCodexSource({ dir: trialDir, prompt: task.prompt, source: original, model: manifest.model, maxWallMs: manifest.maxWallMs, signal: controller.signal });
          text = result.text; trial.usage = result.usage;
          candidate = applyAnswerEdits(original, parseSourceAnswer(text).edits);
        } else {
          const repo = join(trialDir, "input");
          mkdirSync(repo);
          writeFileSync(join(repo, "bottle.py"), original, { mode: 0o600 });
          const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Vouch Evaluation", "-c", "user.email=evaluation@localhost", ...args], { cwd: repo, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
          git(["init", "--quiet"]); git(["add", "bottle.py"]); git(["commit", "--quiet", "-m", "source snapshot"]);
          const progress = createRunProgress(runsDir); stopProgress = progress.stop;
          const model = { model: manifest.model, provider: "openai" as const };
          const record = await executeRepositoryReview({ repoPath: repo, prompt: task.prompt, remediate: true, runsDir,
            model, reviewModel: model, seed: manifest.seed,
            budgets: { maxTokens: Number.MAX_SAFE_INTEGER, maxSteps: manifest.vouchMaxSteps ?? Number.MAX_SAFE_INTEGER, maxWallMs: manifest.maxWallMs }, signal: controller.signal,
            onEvent: event => { if (event.type === "run_start") { trial.runId = event.runId; save(); } progress.onEvent(event); } });
          trial.runId = record.runId;
          if (record.usageKnown) trial.usage = { inputTokens: record.usage.inputTokens, outputTokens: record.usage.outputTokens };
          text = record.summary;
          writeFileSync(join(trialDir, "answer.json"), text, { mode: 0o600 });
          if (!["REVIEW_COMPLETE", "PATCH_PROPOSED"].includes(record.status)) throw new Error(`Vouch ended with ${record.status}; see the linked execution trace`);
          const candidatePath = join(record.artifacts.dir, "candidate", "bottle.py");
          candidate = record.changes.files.length ? readFileSync(candidatePath, "utf8") : original;
        }
        const answer = parseSourceAnswer(text);
        writeFileSync(join(trialDir, "candidate.py"), candidate, { mode: 0o600 });
        Object.assign(trial, gradeSourceAnswer(task, answer, original, candidate, reference));
        trial.answerSha256 = sha256(text); trial.candidateSha256 = sha256(candidate);
        trial.status = "completed";
      } catch (error) {
        trial.status = controller.signal.aborted ? "cancelled" : "error";
        let message = error instanceof Error ? error.message : "evaluation failed";
        for (const [name, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value) message = message.replaceAll(value, "[redacted]");
        trial.error = message.slice(0, 1_000);
      } finally {
        stopProgress?.(); trial.elapsedMs = Date.now() - trial.startedAt!; save();
        process.stdout.write(`${task.id} ${trial.arm}: ${trial.status}; label=${trial.labelCorrect ?? false}; reference=${trial.referenceMatch ?? false}\n`);
      }
    };
    for (const [index, task] of manifest.cases.entries()) {
      if (controller.signal.aborted) break;
      // Alternate the first condition; each pair shares the same pre-registered task.
      const trials = evaluation.trials.filter(trial => trial.caseId === task.id);
      if (index % 2) trials.reverse();
      await Promise.all(trials.map(trial => executeTrial(task, trial)));
    }
    if (controller.signal.aborted) for (const trial of evaluation.trials) if (trial.status === "pending") trial.status = "cancelled";
    evaluation.status = controller.signal.aborted ? "cancelled" : "completed"; evaluation.endedAt = Date.now(); save();
    const summary = summarizeSourceEvaluation(evaluation);
    process.stdout.write(JSON.stringify({ evaluation: resolve(dir, "evaluation.json"), ...summary }, null, 2) + "\n");
    process.exitCode = controller.signal.aborted ? 130 : evaluation.trials.some(trial => trial.status === "error") ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}
