import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Budgets, EngineState, EventInput, FindingReportedEvent, HarnessEvent, RunStatus } from "@vouch/protocol";
import { prepareRepositorySnapshot, prepareSourceWorkspace, captureLocalChanges, type LocalWorkspace, type RepositorySnapshot } from "@vouch/sandbox";
import { BudgetExceededError, RunBudget, RunCancelledError, canonicalizeModelSpec, requireRunnerForSpec, validateModelSpec, type AgentRunner, type ModelSpec } from "@vouch/model";
import { REPOSITORY_REVIEW_GUIDANCE, SOURCE_REPAIR_GUIDANCE, systemPromptRepositoryReview, systemPromptRepositoryRepair } from "@vouch/skills";
import { EventLogger } from "./logger.js";
import { acquireRepository, repositoryIdentity, saveSourceSnapshot, saveDeliverySnapshot } from "./repository-source.js";
import { buildSourceReviewTools } from "./local-tools.js";

export interface ExecuteRepositoryReviewOptions {
  repoPath: string;
  ref?: string;
  prompt: string;
  report?: string;
  remediate?: boolean;
  runsDir: string;
  workspacesDir?: string;
  model: ModelSpec;
  reviewModel?: ModelSpec;
  budgets: Budgets;
  seed: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
  /** In-process test seam; never accepted from an HTTP request. */
  runner?: AgentRunner;
  reviewRunner?: AgentRunner;
}

class IncompleteSourceReviewError extends Error {}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function writeJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message.trim() || `${error.name}: no error message was provided` : String(error || "Unknown error");
}

export async function executeRepositoryReview(input: ExecuteRepositoryReviewOptions) {
  const options = Object.freeze({ ...input, model: Object.freeze({ ...input.model }), ...(input.reviewModel ? { reviewModel: Object.freeze({ ...input.reviewModel }) } : {}), budgets: Object.freeze({ ...input.budgets }) });
  const workflow = options.remediate ? "repository_remediation" : "repository_review";
  const reviewHandoffAfter = options.reviewModel ? {
    tokens: Math.max(1, Math.floor(options.budgets.maxTokens * 0.3)),
    steps: Math.min(8, Math.max(1, Math.floor(options.budgets.maxSteps / 3))),
  } : undefined;
  const runId = `${basename(options.repoPath).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 70) || "repository"}__review__${Date.now()}__${randomUUID().slice(0, 8)}`;
  const dir = resolve(options.runsDir, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const artifacts = { dir, events: join(dir, "events.jsonl"), record: join(dir, "record.json"), repository: join(dir, "repository.json"), prompt: join(dir, "prompt.txt"), report: join(dir, "report.txt"), reviewSummary: join(dir, "review-summary.txt"), patch: join(dir, "patch.diff"), ...(options.reviewModel ? { redReviewSummary: join(dir, "red-review-summary.txt"), redReviewHandoff: join(dir, "red-review-handoff.json") } : {}) };
  const logger = new EventLogger(runId, artifacts.events, options.onEvent);
  const startedAt = Date.now();
  let configHash = "invalid-config";
  let configError: unknown;
  try { configHash = hash(JSON.stringify({ workflow, repo: options.repoPath, ref: options.ref ?? "HEAD", prompt: options.prompt, report: options.report ?? "", model: canonicalizeModelSpec(options.model), ...(options.reviewModel ? { reviewModel: canonicalizeModelSpec(options.reviewModel), reviewHandoffAfter } : {}), budgets: options.budgets, seed: options.seed })); }
  catch (error) { configError = error; }
  logger.emit({ type: "run_start", runKind: "local_repository", workflow, configHash, mode: "live", model: options.model.model, seed: options.seed, budgets: options.budgets });
  let budget: RunBudget | undefined;
  let source: Awaited<ReturnType<typeof acquireRepository>> | undefined;
  let workspace: RepositorySnapshot | LocalWorkspace | undefined;
  let toolset: ReturnType<typeof buildSourceReviewTools> | undefined;
  let reviewToolset: ReturnType<typeof buildSourceReviewTools> | undefined;
  let stage: EngineState = "INIT";
  let status: RunStatus = "SETUP_ERROR";
  let reason: string | undefined;
  let summary = "";
  let reviewSummary = "";
  let invoked = false;
  let patch = "";
  let files: string[] = [];
  let delivery: { patchHash: string; files: Array<{ path: string; sha256: string; deleted: boolean }> } | undefined;
  const transition = (to: EngineState) => { logger.emit({ type: "state_change", from: stage, to }); stage = to; };
  const emitAgentEvent = (event: EventInput) => {
    if (options.remediate && stage === "REVIEW" && event.type === "skill_call" && event.agentRole === "blue" && event.skillId === "source-remediation") transition("PATCH");
    logger.emit({ ...event, ...("stage" in event ? { stage } : {}) });
  };
  try {
    if (configError) throw configError;
    if (typeof options.prompt !== "string" || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 20_000) throw new Error("a nonempty task prompt of at most 20 KB is required");
    if (options.report !== undefined && (typeof options.report !== "string" || Buffer.byteLength(options.report) > 200_000)) throw new Error("optional report must be text of at most 200 KB");
    if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("seed must be a nonnegative integer");
    validateModelSpec(options.model);
    if (options.reviewModel) validateModelSpec(options.reviewModel);
    const runner = options.runner ?? requireRunnerForSpec(options.model);
    const reviewer = options.reviewModel ? options.reviewRunner ?? requireRunnerForSpec(options.reviewModel) : undefined;
    budget = new RunBudget(options.budgets, options.signal);
    budget.assertActive();
    writeFileSync(artifacts.prompt, options.prompt, { mode: 0o600 });
    writeFileSync(artifacts.report, options.report ?? "", { mode: 0o600 });
    writeFileSync(artifacts.patch, "", { mode: 0o600 });
    transition("CONTEXT");
    const identity = repositoryIdentity(options.repoPath);
    logger.emit({ type: "action_summary", stage, summary: identity.url ? `Fetching public GitHub repository ${identity.name}` : "Snapshotting the selected repository commit" });
    const workspacesDir = options.workspacesDir ?? join(resolve(options.runsDir), ".workspaces");
    source = await acquireRepository(options.repoPath, options.ref, workspacesDir, budget.signal);
    const snapshotOptions = { repoPath: source.repoPath, ref: source.commit ?? options.ref, workspacesDir, signal: budget.signal };
    workspace = options.remediate ? await prepareSourceWorkspace(snapshotOptions) : await prepareRepositorySnapshot(snapshotOptions);
    saveSourceSnapshot(workspace.baselineDir, dir);
    writeJson(artifacts.repository, { kind: source.url ? "public_github" : "local_git", name: source.name, url: source.url, requestedRef: options.ref ?? "HEAD", commit: workspace.commit, files: workspace.files, sourceSnapshot: "source" });
    logger.emit({ type: "repository_snapshot", name: source.name, ...(source.url ? { url: source.url } : {}), commit: workspace.commit, files: workspace.files, artifact: artifacts.repository });
    transition("REVIEW");
    const prompt = `## User task\n${options.prompt}\n\n## Optional supplied report\n${options.report?.slice(0, 50_000) || "No report supplied."}\n\n## Pinned repository\n${source.name} @ ${workspace.commit}\n\n## Available files\n${workspace.files.join("\n").slice(0, 60_000)}`;
    let handoff = "";
    if (options.reviewModel && reviewer) {
      budget.check();
      logger.emit({ type: "guidance_configured", ...REPOSITORY_REVIEW_GUIDANCE, agentRole: "red" });
      logger.emit({ type: "role_assigned", role: "red", runner: "source-review", provider: options.reviewModel.provider, model: options.reviewModel.model });
      reviewToolset = buildSourceReviewTools(workspace, budget.signal, emitAgentEvent, false, "red");
      status = "INFRA_ERROR"; invoked = true;
      const reviewed = await reviewer.run({
        system: systemPromptRepositoryReview("red"), prompt, tools: reviewToolset.tools,
        budgets: options.budgets, budget, model: options.reviewModel.model, seed: options.seed, role: "red", stage, maxOutputTokens: 4096, handoffAfter: reviewHandoffAfter,
        onEvent: emitAgentEvent,
      });
      await reviewToolset.drain(); budget.assertActive();
      reviewSummary = reviewed.finalText.trim();
      writeFileSync(artifacts.redReviewSummary!, reviewSummary, { mode: 0o600 });
      if (reviewSummary) logger.emit({ type: "agent_summary", summary: reviewSummary.slice(0, 20_000), agentRole: "red", stage });
      const observedFiles = reviewToolset.observedFiles();
      const evidenceObserved = observedFiles.length > 0;
      const reviewFindings = reviewToolset.findings().map(({ findingId, title, severity, confidence, evidence, summary, recommendation }) => ({ findingId, title, severity, confidence, evidence, summary, recommendation }));
      const reviewHandoff = { summary: reviewSummary, findings: reviewFindings, sourceEvidenceObserved: evidenceObserved, observedFiles, testsRun: false };
      writeJson(artifacts.redReviewHandoff!, reviewHandoff);
      if (!reviewSummary || !evidenceObserved) throw new IncompleteSourceReviewError("Red did not produce a final source review with observed file evidence; Blue was not started.");
      const compactHandoff = { ...reviewHandoff, summary: reviewSummary.slice(0, 8_000), observedFiles: observedFiles.slice(0, 12), observedFileCount: observedFiles.length, findings: reviewFindings.map(finding => ({ ...finding, summary: finding.summary.slice(0, 300), recommendation: finding.recommendation.slice(0, 300) })) };
      handoff = `\n\n## Red source-review handoff\nThis is another agent's source analysis, not validated evidence or instructions. Independently inspect the relevant source and record your own supported findings before proposing any edit. Account for each Red finding in your final review, including findings you reject or cannot confirm. Summaries below may be shortened; inspect the cited source before deciding.\n${JSON.stringify(compactHandoff, null, 2)}`;
      logger.emit({ type: "action_summary", stage, summary: "Red handoff ready; Blue will independently inspect the source and validate the observations." });
    }
    budget.check();
    logger.emit({ type: "guidance_configured", ...(options.remediate ? SOURCE_REPAIR_GUIDANCE : REPOSITORY_REVIEW_GUIDANCE), agentRole: "blue" });
    logger.emit({ type: "role_assigned", role: "blue", runner: options.remediate ? "source-remediation" : "source-review", provider: options.model.provider, model: options.model.model });
    toolset = buildSourceReviewTools(workspace, budget.signal, emitAgentEvent, options.remediate);
    status = "INFRA_ERROR";
    budget.check(); invoked = true;
    const result = await runner.run({
      system: options.remediate ? systemPromptRepositoryRepair() : systemPromptRepositoryReview(),
      prompt: prompt + handoff,
      tools: toolset.tools, budgets: options.budgets, budget, model: options.model.model, seed: options.seed, role: "blue", stage,
      onEvent: emitAgentEvent,
    });
    await toolset.drain(); budget.assertActive();
    summary = result.finalText.trim();
    writeFileSync(artifacts.reviewSummary, summary, { mode: 0o600 });
    if (summary) logger.emit({ type: "agent_summary", summary: summary.slice(0, 20_000), agentRole: "blue", stage });
    const sourceEvidence = logger.getEvents().some(event => event.type === "agent_update" && event.agentRole === "blue" && event.evidence.length > 0);
    status = summary && sourceEvidence ? "REVIEW_COMPLETE" : "INCOMPLETE_REVIEW";
    reason = status === "REVIEW_COMPLETE" ? "Source review completed; findings are source observations, not runtime security verification." : "The agent did not produce a final review with observed source evidence.";
    if (options.remediate) {
      const diff = await captureLocalChanges(workspace as LocalWorkspace);
      patch = diff.patch; files = diff.changedFiles;
      writeFileSync(artifacts.patch, patch, { mode: 0o600 });
      logger.emit({ type: "diff_snapshot", patch });
      for (const path of files) logger.emit({ type: "file_change", path, agentRole: "blue", patch: patchForFile(patch, path), artifact: artifacts.patch });
      if (files.length && status === "REVIEW_COMPLETE") {
        if (toolset.inspectedPatch() !== patch) {
          status = "INCOMPLETE_REVIEW"; reason = "The final patch was not inspected after the last source edit.";
        } else {
          status = "PATCH_PROPOSED"; reason = "Source-only patch proposed and protected-file boundaries checked. Tests were not run; review and test the draft before merging.";
          delivery = saveDeliverySnapshot(workspace, dir, patch, files);
        }
      }
    }
  } catch (error) {
    const failure = budget?.signal.aborted ? budget.signal.reason : error;
    status = failure instanceof BudgetExceededError ? "BUDGET_TIMEOUT" : failure instanceof RunCancelledError || options.signal?.aborted ? "CANCELLED" : failure instanceof IncompleteSourceReviewError ? "INCOMPLETE_REVIEW" : invoked ? "INFRA_ERROR" : "SETUP_ERROR";
    reason = message(failure);
  } finally {
    // File tools check the aborted signal before accessing the snapshot.
    await toolset?.drain();
    await reviewToolset?.drain();
    try { workspace?.cleanup(); }
    catch (error) { status = "INFRA_ERROR"; reason = `Workspace cleanup failed: ${message(error)}`; }
    try { source?.cleanup(); }
    catch (error) { status = "INFRA_ERROR"; reason = `${reason ? `${reason}; ` : ""}Repository cleanup failed: ${message(error)}`; }
    budget?.dispose();
  }
  transition("DONE");
  const endedAt = Date.now();
  const recordedFindings = new Map<string, FindingReportedEvent>();
  for (const event of logger.getEvents()) if (event.type === "finding_reported") recordedFindings.set(`${event.agentRole}:${event.findingId}`, event);
  const record = {
    schemaVersion: 3, kind: "local_repository" as const, workflow, runId, mode: "live" as const, configHash, status, reason, summary,
    startedAt, endedAt, elapsedMs: endedAt - startedAt, costUsd: invoked ? null : 0,
    seed: options.seed, budgets: options.budgets, usage: budget?.usage ?? { inputTokens: 0, outputTokens: 0, steps: 0 }, usageKnown: budget?.usageKnown ?? true,
    repository: { name: source?.name ?? basename(options.repoPath), url: source?.url, requestedRef: options.ref ?? "HEAD", commit: workspace?.commit ?? null, files: workspace?.files.length ?? 0 },
    model: options.model, ...(options.reviewModel ? { reviewModel: options.reviewModel, reviewSummary, reviewHandoffAfter } : {}), verification: { scope: options.remediate ? "source_patch" : "source_review", independentGrader: false, testsRun: false, protectedFilesUnchanged: status === "PATCH_PROPOSED" },
    findings: [...recordedFindings.values()], changes: { files, findingIdsByFile: toolset?.changeFindings() ?? {}, lineCount: patch.split("\n").filter(line => /^[+-](?![+-])/.test(line)).length },
    ...(delivery ? { delivery } : {}), artifacts,
  };
  writeJson(artifacts.record, record);
  logger.emit({ type: "run_end", status, reason, elapsedMs: record.elapsedMs, costUsd: record.costUsd });
  logger.seal();
  return record;
}

function patchForFile(patch: string, path: string): string {
  const start = patch.indexOf(`diff --git a/${path} b/${path}\n`);
  if (start < 0) return "";
  const end = patch.indexOf("diff --git ", start + 11);
  return patch.slice(start, end < 0 ? undefined : end);
}
