import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import type {
  Budgets,
  EngineState,
  ExecutionMode,
  HarnessEvent,
  RunStatus,
} from "@vouch/protocol";
import {
  applyLocalPatch,
  captureLocalChanges,
  createVerificationWorkspace,
  DockerProjectRunner,
  prepareLocalWorkspace,
  readBoundedRegularFile,
  readFileTool,
  type DiffResult,
  type LocalWorkspace,
  type ProjectTestRunner,
  type ProjectRuntime,
  type StructuredTestResult,
  type TestSelection,
} from "@vouch/sandbox";
import {
  BudgetExceededError,
  estimateCost,
  requireRunnerForSpec,
  RunBudget,
  RunCancelledError,
  ScriptedRunner,
  validateModelSpec,
  type AgentRunner,
  type AgentRunResult,
  type AgentTool,
  type ModelSpec,
  type Pricing,
} from "@vouch/model";
import {
  buildLocalRepairPrompt,
  buildLocalReviewPrompt,
  LOCAL_REPAIR_GUIDANCE,
  LOCAL_REVIEW_GUIDANCE,
  systemPromptLocalRepair,
  systemPromptLocalReview,
  type LocalRepairContext,
} from "@vouch/skills";
import { EventLogger } from "./logger.js";
import { buildLocalRepairTools, buildLocalReviewTools } from "./local-tools.js";

const TEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 180_000;
const MAX_REPORT_BYTES = 200_000;
const MAX_PROMPT_INPUT = 50_000;
const MAX_PATCH_BYTES = 30_000_000;
const SETTLE_TIMEOUT_MS = 10_000;

export interface ExecuteLocalRunOptions {
  repoPath: string;
  ref?: string;
  report: string;
  regressionPath: string;
  runsDir: string;
  workspacesDir?: string;
  mode: ExecutionMode;
  model: ModelSpec;
  reviewModel?: ModelSpec;
  budgets: Budgets;
  seed: number;
  patchPath?: string;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
  /** Test seam. Production runs use DockerProjectRunner. */
  testRunner?: ProjectTestRunner;
  /** Test seam. Live production runs resolve the exact configured model. */
  repairRunner?: AgentRunner;
  /** Test seam for the optional read-only evidence reviewer. */
  reviewRunner?: AgentRunner;
  pricing?: { repair?: Pricing; review?: Pricing };
}

export interface LocalRunArtifacts {
  dir: string;
  events: string;
  record: string;
  patch: string;
  inputPatch: string;
  report: string;
  repository: string;
  regression: string;
  tests: string;
  repairSummary: string;
  reviewSummary: string;
}

export interface StoredTestEvidence {
  artifact: string;
  result: StructuredTestResult;
}

export interface LocalRunRecord {
  schemaVersion: 2;
  kind: "local_repository";
  runId: string;
  mode: ExecutionMode;
  configHash: string;
  inputHash: string | null;
  status: RunStatus;
  reason?: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  costUsd: number | null;
  seed: number;
  budgets: Budgets;
  usage: { inputTokens: number; outputTokens: number; steps: number };
  usageKnown: boolean;
  modelUsage: {
    repair: { invoked: boolean; usageKnown: boolean; inputTokens: number; outputTokens: number };
    review: { invoked: boolean; usageKnown: boolean; inputTokens: number; outputTokens: number };
  };
  repository: {
    name: string;
    requestedRef: string;
    commit: string | null;
    regressionPath: string;
    regressionHash: string | null;
    files: number;
  };
  models: {
    repair: ModelSpec | { provider: "scripted"; model: "supplied-patch" };
    review?: ModelSpec;
  };
  runtime: ProjectRuntime | null;
  verification: {
    reproduced: boolean | null;
    regressionPassed: boolean | null;
    functionalPassed: boolean | null;
    regressionManifestMatched: boolean | null;
    functionalManifestMatched: boolean | null;
  };
  changes: { files: string[]; lineCount: number };
  tests: Record<string, StoredTestEvidence>;
  artifacts: LocalRunArtifacts;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function localConfigHash(options: ExecuteLocalRunOptions, patchHash: string | null): string {
  const canonical = JSON.stringify({
    kind: "local_repository",
    mode: options.mode,
    requestedRef: options.ref ?? "HEAD",
    reportHash: sha256(options.report),
    regressionPath: options.regressionPath,
    patchHash,
    model: options.mode === "live" ? options.model : { provider: "scripted", model: "supplied-patch" },
    reviewModel: options.mode === "live" ? options.reviewModel ?? null : null,
    budgets: options.budgets,
    seed: options.seed,
  });
  return sha256(canonical).slice(0, 16);
}

function makeRunId(repoPath: string, seed: number): string {
  const name = basename(resolve(repoPath)).replace(/[^A-Za-z0-9._-]+/g, "-") || "repository";
  return `${name}__local__seed${seed}__${Date.now()}__${randomUUID().slice(0, 8)}`;
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
}

function clip(value: string, limit = MAX_PROMPT_INPUT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... [truncated by harness]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchForFile(patch: string, path: string): string {
  const marker = `diff --git a/${path} b/${path}\n`;
  const start = patch.indexOf(marker);
  if (start < 0) return "";
  const end = patch.indexOf("diff --git a/", start + marker.length);
  return patch.slice(start, end < 0 ? undefined : end);
}

function scriptedPatchTool(workspace: LocalWorkspace, patchPath: string, signal: AbortSignal): {
  tool: AgentTool;
  drain: () => Promise<void>;
} {
  let pending: Promise<void> | undefined;
  return {
    tool: {
      name: "apply_supplied_patch",
      description: "Apply the explicitly supplied source-only patch. No args.",
      schema: z.object({}),
      execute: async () => {
        signal.throwIfAborted();
        pending = applyLocalPatch(workspace, patchPath, { signal });
        await pending;
        signal.throwIfAborted();
        return { ok: true };
      },
    },
    drain: async () => { await pending?.catch(() => undefined); },
  };
}

function modelMetadata(spec: ModelSpec): ModelSpec {
  return {
    provider: spec.provider,
    model: spec.model,
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}),
  };
}

function validatePricing(pricing: Pricing | undefined): void {
  if (!pricing) return;
  if (![pricing.inputPerMTok, pricing.outputPerMTok].every(rate => Number.isFinite(rate) && rate >= 0)) {
    throw new Error("model pricing must contain finite nonnegative rates");
  }
}

function usageDelta(
  before: { inputTokens: number; outputTokens: number },
  after: { inputTokens: number; outputTokens: number },
) {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
  };
}

function sameManifest(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((value, index) => value === after[index]);
}

async function settleWithin(operation: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeLocalRun(inputOptions: ExecuteLocalRunOptions): Promise<LocalRunRecord> {
  const options: ExecuteLocalRunOptions = Object.freeze({
    ...inputOptions,
    budgets: Object.freeze({ ...inputOptions.budgets }),
    model: Object.freeze({ ...inputOptions.model }),
    ...(inputOptions.reviewModel ? { reviewModel: Object.freeze({ ...inputOptions.reviewModel }) } : {}),
    ...(inputOptions.pricing ? {
      pricing: Object.freeze({
        ...(inputOptions.pricing.repair ? { repair: Object.freeze({ ...inputOptions.pricing.repair }) } : {}),
        ...(inputOptions.pricing.review ? { review: Object.freeze({ ...inputOptions.pricing.review }) } : {}),
      }),
    } : {}),
  });
  const runId = makeRunId(options.repoPath, options.seed);
  const artifactDir = resolve(options.runsDir, runId);
  const testsDir = join(artifactDir, "tests");
  mkdirSync(testsDir, { recursive: true, mode: 0o700 });
  const artifacts: LocalRunArtifacts = {
    dir: artifactDir,
    events: join(artifactDir, "events.jsonl"),
    record: join(artifactDir, "record.json"),
    patch: join(artifactDir, "patch.diff"),
    inputPatch: join(artifactDir, "input-patch.diff"),
    report: join(artifactDir, "report.txt"),
    repository: join(artifactDir, "repository.json"),
    regression: join(artifactDir, `regression${extname(options.regressionPath) || ".txt"}`),
    tests: testsDir,
    repairSummary: join(artifactDir, "repair-summary.txt"),
    reviewSummary: join(artifactDir, "review-summary.txt"),
  };
  writePrivate(artifacts.report, options.report);
  writePrivate(artifacts.patch, "");
  writePrivate(artifacts.inputPatch, "");
  writePrivate(artifacts.regression, "");
  writePrivate(artifacts.repairSummary, "");
  writePrivate(artifacts.reviewSummary, "");

  const logger = new EventLogger(runId, artifacts.events, options.onEvent);
  const startedAt = Date.now();
  let hash = "invalid-config";
  let configHashError: unknown;
  let immutablePatchPath: string | undefined;
  try {
    let patchHash: string | null = null;
    if (options.patchPath) {
      const bytes = readBoundedRegularFile(resolve(options.patchPath), MAX_PATCH_BYTES, "supplied patch");
      writePrivate(artifacts.inputPatch, bytes);
      immutablePatchPath = artifacts.inputPatch;
      patchHash = sha256(bytes);
    }
    hash = localConfigHash(options, patchHash);
  } catch (error) {
    configHashError = error;
  }
  logger.emit({
    type: "run_start",
    runKind: "local_repository",
    configHash: hash,
    mode: options.mode,
    model: options.mode === "live" ? options.model.model : "supplied-patch",
    seed: options.seed,
    budgets: options.budgets,
  });

  let budget: RunBudget | undefined;
  let workspace: LocalWorkspace | undefined;
  let runner: ProjectTestRunner | undefined;
  let state: EngineState = "INIT";
  let status: RunStatus = "INFRA_ERROR";
  let reason: string | undefined;
  let setupComplete = false;
  let reproduced: boolean | null = null;
  let regressionPassed: boolean | null = null;
  let functionalPassed: boolean | null = null;
  let regressionManifestMatched: boolean | null = null;
  let functionalManifestMatched: boolean | null = null;
  let baselineRegressionManifest: string[] = [];
  let baselineFunctionalManifest: string[] = [];
  let diff: DiffResult = { patch: "", changedFiles: [], lineCount: 0 };
  let inputHash: string | null = null;
  let runtime: ProjectRuntime | null = null;
  let diffRecorded = false;
  let repairProviderInvoked = false;
  let reviewProviderInvoked = false;
  let repairUsage = { inputTokens: 0, outputTokens: 0 };
  let reviewUsage = { inputTokens: 0, outputTokens: 0 };
  let repairUsageKnown = true;
  let reviewUsageKnown = true;
  let configuredRepairRunner: AgentRunner | undefined;
  let configuredReviewRunner: AgentRunner | undefined;
  let drainRepairTools = async () => {};
  const testEvidence: Record<string, StoredTestEvidence> = {};
  let testSequence = 0;
  let acceptingEvidence = true;

  const transition = (next: EngineState) => {
    if (state === next) return;
    logger.emit({ type: "state_change", from: state, to: next });
    state = next;
  };

  const remaining = (cap = TEST_TIMEOUT_MS): number => {
    if (!budget) throw new Error("run budget is not initialized");
    budget.assertActive();
    return Math.max(1, Math.min(cap, options.budgets.maxWallMs - budget.elapsedMs));
  };

  const storeTest = (phase: string, result: StructuredTestResult, durationMs?: number): string | undefined => {
    if (!acceptingEvidence) return undefined;
    const safePhase = phase.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const path = join(testsDir, `${String(++testSequence).padStart(2, "0")}-${safePhase}.json`);
    writeJson(path, result);
    testEvidence[phase] = { artifact: path, result };
    const stage: EngineState = phase.startsWith("baseline-functional") ? "CONTEXT"
      : phase.startsWith("baseline-regression") ? "REPRODUCE"
        : phase.startsWith("verification-") ? "VERIFY" : "PATCH";
    logger.emit({
      type: "test_run",
      phase,
      outcome: result.status,
      passed: result.passed,
      testsPassed: result.testsPassed,
      testsFailed: result.testsFailed,
      testsSkipped: result.testsSkipped,
      artifact: path,
      stage,
      ...(phase.startsWith("agent-") ? { agentRole: "blue" as const } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    return path;
  };

  const runTest = async (
    phase: string,
    directory: string,
    selection: TestSelection,
  ): Promise<StructuredTestResult> => {
    if (!runner || !budget) throw new Error("project test runner is not prepared");
    budget.assertActive();
    const testStartedAt = performance.now();
    const result = await runner.runTests(directory, selection, {
      signal: budget.signal,
      timeoutMs: remaining(),
    });
    storeTest(phase, result, Math.floor(performance.now() - testStartedAt));
    if (result.cancelled) throw budget.signal.reason ?? new RunCancelledError();
    budget.assertActive();
    return result;
  };

  const recordDiff = async (): Promise<void> => {
    if (!workspace || diffRecorded) return;
    diff = await captureLocalChanges(workspace);
    writePrivate(artifacts.patch, diff.patch);
    logger.emit({ type: "diff_snapshot", patch: diff.patch });
    for (const path of diff.changedFiles) {
      logger.emit({
        type: "file_change",
        path,
        agentRole: "blue",
        patch: patchForFile(diff.patch, path),
        artifact: artifacts.patch,
      });
    }
    diffRecorded = true;
  };

  try {
    if (configHashError) throw configHashError;
    if (options.mode !== "live" && options.mode !== "scripted") throw new Error("mode must be live or scripted");
    if (!options.report.trim()) throw new Error("the supplied report is empty");
    if (Buffer.byteLength(options.report) > MAX_REPORT_BYTES) throw new Error("the supplied report exceeds 200 KB");
    if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("seed must be a nonnegative safe integer");
    validateModelSpec(options.model);
    if (options.reviewModel) validateModelSpec(options.reviewModel);
    validatePricing(options.pricing?.repair);
    validatePricing(options.pricing?.review);
    if (options.mode === "live" && options.patchPath) throw new Error("live mode cannot use a supplied patch");
    if (options.mode === "scripted" && !options.patchPath) throw new Error("scripted mode requires a supplied patch");
    if (options.mode === "scripted" && options.reviewModel) throw new Error("scripted mode cannot configure a live evidence reviewer");
    if (options.mode === "live") {
      configuredRepairRunner = options.repairRunner ?? requireRunnerForSpec(options.model);
      if (options.reviewModel) configuredReviewRunner = options.reviewRunner ?? requireRunnerForSpec(options.reviewModel);
    }

    budget = new RunBudget(options.budgets, options.signal);
    transition("CONTEXT");
    workspace = await prepareLocalWorkspace({
      repoPath: options.repoPath,
      ref: options.ref,
      regressionPath: options.regressionPath,
      workspacesDir: options.workspacesDir ?? join(resolve(options.runsDir), ".workspaces"),
      signal: budget.signal,
    });
    inputHash = sha256(JSON.stringify({
      configHash: hash,
      commit: workspace.commit,
      regressionHash: workspace.regressionHash,
    }));
    const repository = {
      kind: "local_git",
      name: basename(resolve(options.repoPath)),
      requestedRef: options.ref ?? "HEAD",
      commit: workspace.commit,
      regressionPath: workspace.regressionPath,
      regressionHash: workspace.regressionHash,
      inputHash,
      files: workspace.files,
    };
    writeJson(artifacts.repository, repository);
    writePrivate(artifacts.regression, readFileSync(join(workspace.baselineDir, workspace.regressionPath)));
    logger.emit({
      type: "repository_snapshot",
      name: repository.name,
      commit: repository.commit,
      files: repository.files,
      artifact: artifacts.repository,
      inputHash,
    });

    runner = options.testRunner ?? new DockerProjectRunner();
    await runner.prepare(workspace, { signal: budget.signal, timeoutMs: remaining(SETUP_TIMEOUT_MS) });
    runtime = runner.runtime ?? null;
    writeJson(artifacts.repository, { ...repository, runtime });
    setupComplete = true;

    const baselineFunctional = await runTest("baseline-functional", workspace.baselineDir, "functional");
    if (!baselineFunctional.passed) {
      status = "SETUP_ERROR";
      reason = `baseline functional suite did not pass: ${baselineFunctional.reason ?? baselineFunctional.status}`;
      transition("DONE");
    } else if (baselineFunctional.collectedFiles.some(path => !workspace!.protectedPaths.includes(path))) {
      const paths = baselineFunctional.collectedFiles.filter(path => !workspace!.protectedPaths.includes(path));
      status = "SETUP_ERROR";
      reason = `collected functional tests must use protected test paths: ${paths.join(", ")}`;
      transition("DONE");
    } else {
      baselineFunctionalManifest = [...baselineFunctional.testManifest];
      transition("REPRODUCE");
      const baselineRegression = await runTest("baseline-regression", workspace.baselineDir, "regression");
      baselineRegressionManifest = [...baselineRegression.testManifest];
      reproduced = baselineRegression.status === "assertion_failed";
      logger.emit({ type: "gate", phase: "reproduce", reproduced, submissions: 1 });

      if (baselineRegression.status === "passed") {
        status = "NOT_REPRODUCIBLE";
        reason = "the exact supplied regression passed on the checked commit; no repair was attempted";
        await recordDiff();
        transition("DONE");
      } else if (baselineRegression.status !== "assertion_failed") {
        status = "INVALID_REPRODUCTION";
        reason = `the supplied regression did not produce a valid assertion failure: ${baselineRegression.reason ?? baselineRegression.status}`;
        await recordDiff();
        transition("DONE");
      } else {
        const regressionSource = clip(readFileTool(workspace.baselineDir, workspace.regressionPath));
        const promptContext: LocalRepairContext = {
          report: clip(options.report),
          regressionPath: workspace.regressionPath,
          regressionSource,
          fileTree: workspace.files,
          baselineRegression: clip(baselineRegression.output, 16_000),
        };

        if (options.mode === "live" && options.reviewModel) {
          logger.emit({ type: "guidance_configured", ...LOCAL_REVIEW_GUIDANCE, agentRole: "red" });
          const reviewer = configuredReviewRunner!;
          logger.emit({
            type: "role_assigned",
            role: "red",
            runner: options.reviewRunner ? "injected-read-only-review" : "read-only-evidence-review",
            model: options.reviewModel.model,
            provider: options.reviewRunner ? "injected" : options.reviewModel.provider,
          });
          reviewProviderInvoked = true;
          const beforeReview = budget.usage;
          let reviewed: AgentRunResult;
          try {
            reviewed = await reviewer.run({
              system: systemPromptLocalReview(),
              prompt: buildLocalReviewPrompt(promptContext),
              tools: buildLocalReviewTools(workspace, budget.signal),
              budgets: options.budgets,
              budget,
              role: "red",
              stage: "REPRODUCE",
              seed: options.seed,
              model: options.reviewModel.model,
              onEvent: (event) => logger.emit(event),
            });
          } finally {
            reviewUsage = usageDelta(beforeReview, budget.usage);
            reviewUsageKnown = budget.usageKnown;
          }
          promptContext.review = clip(reviewed.finalText, 20_000);
          writePrivate(artifacts.reviewSummary, reviewed.finalText);
          logger.emit({ type: "action_summary", summary: "Read-only evidence review completed", agentRole: "red", stage: "REPRODUCE" });
        }

        transition("PATCH");
        logger.emit({ type: "guidance_configured", ...LOCAL_REPAIR_GUIDANCE, agentRole: "blue" });
        let repairRunner: AgentRunner;
        let tools: AgentTool[];
        let repairModel: string;
        if (options.mode === "scripted") {
          repairRunner = new ScriptedRunner(async (scriptTools) => {
            await scriptTools["apply_supplied_patch"]?.({});
            return "Applied the explicitly supplied source patch.";
          });
          const patchTool = scriptedPatchTool(workspace, immutablePatchPath!, budget.signal);
          tools = [patchTool.tool];
          drainRepairTools = patchTool.drain;
          repairModel = "supplied-patch";
          logger.emit({ type: "role_assigned", role: "blue", runner: "scripted-patch", model: repairModel, provider: "scripted" });
        } else {
          repairRunner = configuredRepairRunner!;
          repairModel = options.model.model;
          logger.emit({
            type: "role_assigned",
            role: "blue",
            runner: options.repairRunner ? "injected-tool-loop" : "live-tool-loop",
            model: repairModel,
            provider: options.repairRunner ? "injected" : options.model.provider,
          });
          let toolRun = 0;
          const toolset = buildLocalRepairTools({
            workspace,
            runner,
            signal: budget.signal,
            remainingTimeoutMs: () => remaining(),
            onTestResult: (selection, result, durationMs) => storeTest(`agent-${selection}-${++toolRun}`, result, durationMs),
          });
          tools = toolset.tools;
          drainRepairTools = () => toolset.drain();
          repairProviderInvoked = true;
        }
        const beforeRepair = budget.usage;
        let repaired: AgentRunResult;
        try {
          repaired = await repairRunner.run({
            system: systemPromptLocalRepair(),
            prompt: buildLocalRepairPrompt(promptContext),
            tools,
            budgets: options.budgets,
            budget,
            role: "blue",
            stage: "PATCH",
            seed: options.seed,
            model: repairModel,
            onEvent: (event) => logger.emit(event),
          });
        } finally {
          repairUsage = usageDelta(beforeRepair, budget.usage);
          repairUsageKnown = budget.usageKnown;
        }
        writePrivate(artifacts.repairSummary, repaired.finalText);
        logger.emit({
          type: "agent_summary",
          summary: clip(repaired.finalText.trim() || "Repair agent completed", 1_000),
          agentRole: "blue",
          stage: "PATCH",
        });

        await recordDiff();
        const verificationDir = await createVerificationWorkspace(workspace);
        transition("VERIFY");
        const verifiedRegression = await runTest("verification-regression", verificationDir, "regression");
        regressionManifestMatched = sameManifest(baselineRegressionManifest, verifiedRegression.testManifest);
        regressionPassed = verifiedRegression.passed && regressionManifestMatched;
        const verifiedFunctional = await runTest("verification-functional", verificationDir, "functional");
        functionalManifestMatched = sameManifest(baselineFunctionalManifest, verifiedFunctional.testManifest);
        functionalPassed = verifiedFunctional.passed && functionalManifestMatched;
        const gatePassed = regressionPassed && functionalPassed && diff.changedFiles.length > 0;
        logger.emit({
          type: "gate",
          phase: "verify",
          pocNeutralized: regressionPassed,
          functionalPassed,
          passed: gatePassed,
        });
        if (!functionalPassed) {
          status = !functionalManifestMatched || verifiedFunctional.status === "assertion_failed" ? "BROKE_FUNCTION" : "INFRA_ERROR";
          reason = !functionalManifestMatched
            ? "functional test inventory changed between baseline and verification"
            : `functional verification did not pass: ${verifiedFunctional.reason ?? verifiedFunctional.status}`;
        } else if (!regressionPassed) {
          status = !regressionManifestMatched || verifiedRegression.status === "assertion_failed" ? "FAILED_NO_FIX" : "INFRA_ERROR";
          reason = !regressionManifestMatched
            ? "supplied regression test inventory changed between reproduction and verification"
            : `regression verification did not pass: ${verifiedRegression.reason ?? verifiedRegression.status}`;
        } else if (!diff.changedFiles.length) {
          status = "FAILED_NO_FIX";
          reason = "verification passed without a source change; the harness will not claim a verified fix";
        } else {
          status = "FIXED_VERIFIED";
          reason = "the exact supplied regression and protected functional suite passed in a fresh verification workspace";
        }
        transition("DONE");
      }
    }
  } catch (error) {
    const effectiveError = budget?.signal.aborted ? budget.signal.reason : error;
    if (effectiveError instanceof RunCancelledError || options.signal?.aborted) {
      status = "CANCELLED";
    } else if (effectiveError instanceof BudgetExceededError) {
      status = "BUDGET_TIMEOUT";
    } else if (setupComplete && /(?:protected (?:file|path)|only application source files|patch targets an unsupported)/i.test(errorMessage(effectiveError))) {
      status = "FAILED_NO_FIX";
    } else if (!setupComplete) {
      status = "SETUP_ERROR";
    } else {
      status = "INFRA_ERROR";
    }
    reason = errorMessage(effectiveError);
  }

  let drainSettled = true;
  try {
    await settleWithin(drainRepairTools(), SETTLE_TIMEOUT_MS, "repair tool queue");
  } catch (error) {
    drainSettled = false;
    acceptingEvidence = false;
    if (status === "FIXED_VERIFIED" || status === "NOT_REPRODUCIBLE") status = "INFRA_ERROR";
    reason = reason ? `${reason}; ${errorMessage(error)}` : errorMessage(error);
  }

  if (workspace && !diffRecorded && drainSettled) {
    try {
      await recordDiff();
    } catch (error) {
      if (status === "FIXED_VERIFIED" || status === "NOT_REPRODUCIBLE") status = "INFRA_ERROR";
      reason = reason ? `${reason}; artifact capture failed: ${errorMessage(error)}` : `artifact capture failed: ${errorMessage(error)}`;
    }
  }

  const usage = budget?.usage ?? { inputTokens: 0, outputTokens: 0, steps: 0 };
  let costUsd: number | null = 0;
  if ((reviewProviderInvoked || repairProviderInvoked) && budget?.usageKnown) {
    const roleCosts: Array<number | null> = [];
    if (reviewProviderInvoked) {
      roleCosts.push(estimateCost(reviewUsage.inputTokens, reviewUsage.outputTokens, options.pricing?.review));
    }
    if (repairProviderInvoked) {
      roleCosts.push(estimateCost(repairUsage.inputTokens, repairUsage.outputTokens, options.pricing?.repair));
    }
    costUsd = roleCosts.every((cost): cost is number => cost !== null)
      ? roleCosts.reduce((total, cost) => total + cost, 0)
      : null;
  } else if (reviewProviderInvoked || repairProviderInvoked) costUsd = null;

  transition("DONE");
  const buildRecord = (endedAt: number): LocalRunRecord => ({
      schemaVersion: 2,
      kind: "local_repository",
      runId,
      mode: options.mode,
      configHash: hash,
      inputHash,
      status,
      ...(reason ? { reason } : {}),
      startedAt,
      endedAt,
      elapsedMs: endedAt - startedAt,
      costUsd,
      seed: options.seed,
      budgets: { ...options.budgets },
      usage: { ...usage },
      usageKnown: budget?.usageKnown ?? true,
      modelUsage: {
        repair: { invoked: repairProviderInvoked, usageKnown: repairUsageKnown, ...repairUsage },
        review: { invoked: reviewProviderInvoked, usageKnown: reviewUsageKnown, ...reviewUsage },
      },
      repository: {
        name: basename(resolve(options.repoPath)),
        requestedRef: options.ref ?? "HEAD",
        commit: workspace?.commit ?? null,
        regressionPath: options.regressionPath,
        regressionHash: workspace?.regressionHash ?? null,
        files: workspace?.files.length ?? 0,
      },
      models: {
        repair: options.mode === "live" ? modelMetadata(options.model) : { provider: "scripted", model: "supplied-patch" },
        ...(options.mode === "live" && options.reviewModel ? { review: modelMetadata(options.reviewModel) } : {}),
      },
      runtime,
      verification: { reproduced, regressionPassed, functionalPassed, regressionManifestMatched, functionalManifestMatched },
      changes: { files: [...diff.changedFiles], lineCount: diff.lineCount },
      tests: { ...testEvidence },
      artifacts,
    });
  if (!workspace) {
    writeJson(artifacts.repository, {
      kind: "local_git",
      name: basename(resolve(options.repoPath)),
      requestedRef: options.ref ?? "HEAD",
      commit: null,
      regressionPath: options.regressionPath,
      error: reason,
    });
  }
  writeJson(artifacts.record, { ...buildRecord(Date.now()), provisional: true });

  acceptingEvidence = false;
  try {
    if (runner) await settleWithin(runner.cleanup(), SETTLE_TIMEOUT_MS, "runner cleanup");
  } catch (error) {
    if (status === "FIXED_VERIFIED" || status === "NOT_REPRODUCIBLE") status = "INFRA_ERROR";
    reason = reason ? `${reason}; runner cleanup failed: ${errorMessage(error)}` : `runner cleanup failed: ${errorMessage(error)}`;
  }
  try {
    workspace?.cleanup();
  } catch (error) {
    if (status === "FIXED_VERIFIED" || status === "NOT_REPRODUCIBLE") status = "INFRA_ERROR";
    reason = reason ? `${reason}; workspace cleanup failed: ${errorMessage(error)}` : `workspace cleanup failed: ${errorMessage(error)}`;
  }
  budget?.dispose();

  const endedAt = Date.now();
  const record = buildRecord(endedAt);
  writeJson(artifacts.record, record);
  logger.emit({ type: "run_end", status, costUsd, elapsedMs: record.elapsedMs, reason });
  logger.seal();
  return record;
}
