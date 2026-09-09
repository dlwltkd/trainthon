import { resolve } from "node:path";
import { DEFAULT_BUDGETS, type Condition, type ExecutionMode, type HarnessEvent } from "@vouch/protocol";
import { executeLocalRun, executeRun, loadTask } from "@vouch/engine";
import { readBoundedRegularFile } from "@vouch/sandbox";
import { resolveLiveRoleModels } from "../../cli/src/run-options.js";
import { readBoundedText, resolveInside, type ActiveRun, type RunRegistry } from "./registry.js";

export interface BenchStartRequest {
  kind: "bench";
  taskId: string;
  condition: Condition;
  seed?: number;
}

export interface RepositoryStartRequest {
  kind: "repository";
  repoPath: string;
  regressionPath: string;
  reportPath?: string;
  reportText?: string;
  ref?: string;
  mode: ExecutionMode;
  patchPath?: string;
  seed?: number;
  review?: boolean;
}

export type StartRequest = BenchStartRequest | RepositoryStartRequest;

export interface RunnerPaths {
  repoRoot: string;
  benchDir: string;
  runsDir: string;
}

function validateSeed(seed: number | undefined): number {
  const value = seed ?? 1;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("seed must be a nonnegative integer");
  return value;
}

/**
 * Start a run in-process. Resolves once the engine has emitted `run_start`, so the caller
 * learns the real run ID; the run keeps executing in the background and streams to listeners.
 */
export async function startRun(
  request: StartRequest,
  paths: RunnerPaths,
  registry: RunRegistry,
): Promise<ActiveRun> {
  if (!request || typeof request !== "object") throw new Error("invalid run request");
  const controller = new AbortController();
  const pending: ActiveRun = {
    runId: "",
    events: [],
    listeners: new Set(),
    controller,
    done: false,
    sidecar: {},
  };

  let resolveStart!: (run: ActiveRun) => void;
  let rejectStart!: (error: Error) => void;
  const started = new Promise<ActiveRun>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  let announced = false;

  const onEvent = (event: HarnessEvent) => {
    if (!announced) {
      announced = true;
      pending.runId = event.runId;
      registry.register(pending);
      resolveStart(pending);
    }
    pending.events.push(event);
    for (const listener of pending.listeners) listener(event);
  };

  const finish = (error?: unknown) => {
    const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    if (!announced) {
      announced = true;
      rejectStart(new Error(message ?? "run ended before emitting any event"));
      return;
    }
    if (pending.sidecar.repoPath || pending.sidecar.taskId) {
      registry.writeSidecar(pending.runId, pending.sidecar);
    }
    registry.finish(pending.runId, message);
  };

  const seed = validateSeed(request.seed);
  if (request.kind === "bench") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.taskId)) throw new Error("invalid benchmark task ID");
    if (request.condition !== "A" && request.condition !== "B" && request.condition !== "C") {
      throw new Error("condition must be A, B, or C");
    }
    const task = loadTask(paths.benchDir, request.taskId);
    pending.sidecar.taskId = task.id;
    executeRun({
      task,
      config: {
        model: "scripted",
        provider: "scripted",
        mode: "scripted",
        seed,
        budgets: DEFAULT_BUDGETS,
        condition: request.condition,
        graderVersion: "0.0.0",
      },
      runsDir: paths.runsDir,
      repoRoot: paths.repoRoot,
      benchDir: paths.benchDir,
      signal: controller.signal,
      onEvent,
    }).then(() => finish(), finish);
    return started;
  }

  if (typeof request.repoPath !== "string" || !request.repoPath || typeof request.regressionPath !== "string" || !request.regressionPath) throw new Error("repoPath and regressionPath are required");
  if (request.reportText !== undefined && (typeof request.reportText !== "string" || Buffer.byteLength(request.reportText) > 200_000)) throw new Error("reportText must be at most 200 KB");
  if (request.mode !== "live" && request.mode !== "scripted") throw new Error("mode must be live or scripted");
  if (request.mode === "scripted" && !request.patchPath) throw new Error("scripted repository runs require patchPath");
  if (request.mode === "live" && request.patchPath) throw new Error("patchPath is only supported in scripted mode");

  const repoPath = resolve(request.repoPath);
  let report = request.reportText ?? "";
  if (!report.trim() && request.reportPath) {
    report = readBoundedRegularFile(resolve(request.reportPath), 200_000, "report").toString("utf8");
  }
  if (!report.trim()) throw new Error("a non-empty report (reportText or reportPath) is required");

  const liveModels = request.mode === "live" ? resolveLiveRoleModels({}, process.env) : undefined;
  pending.sidecar.repoPath = repoPath;
  executeLocalRun({
    repoPath,
    ref: request.ref ?? "HEAD",
    report,
    regressionPath: request.regressionPath,
    runsDir: paths.runsDir,
    mode: request.mode,
    model: liveModels?.blue ?? { model: "scripted", provider: "compatible" },
    reviewModel: request.review === false ? undefined : liveModels?.red,
    budgets: DEFAULT_BUDGETS,
    seed,
    patchPath: request.patchPath ? resolve(request.patchPath) : undefined,
    signal: controller.signal,
    onEvent,
  }).then(() => finish(), finish);
  return started;
}

export function readTaskFile(benchDir: string, taskId: string, relative: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) return null;
  const taskDir = resolveInside(benchDir, `tasks/${taskId}`);
  return taskDir ? readBoundedText(taskDir, relative, 512_000) : null;
}
