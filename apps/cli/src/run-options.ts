import type { Condition, ExecutionMode } from "@vouch/protocol";
import { providerForModel, type ModelSpec, type ProviderKind } from "@vouch/model";
import { getString } from "./args.js";

type Flags = Record<string, string | boolean>;

interface CommonOptions {
  mode: ExecutionMode;
  seed: number;
  model: ModelSpec;
}

export type RunOptions = CommonOptions & (
  | { kind: "task"; taskId: string; condition: Condition }
  | { kind: "repository"; repoPath: string; reportPath: string; regressionPath: string; ref: string; patchPath?: string; reviewModel?: ModelSpec }
);

function value(flags: Flags, key: string): string | undefined {
  if (flags[key] === true) throw new Error(`--${key} requires a value`);
  return getString(flags, key);
}

function provider(value: string | undefined, model: string): ProviderKind {
  const selected = value ?? providerForModel(model);
  if (selected !== "anthropic" && selected !== "openai" && selected !== "compatible") {
    throw new Error("--provider must be anthropic, openai, or compatible; unknown model IDs require an explicit provider");
  }
  return selected;
}

export function parseRunOptions(flags: Flags, env: NodeJS.ProcessEnv = process.env): RunOptions {
  const allowed = new Set(["task", "condition", "repo", "report", "regression", "ref", "mode", "model", "provider", "base-url", "api-key-env", "red-model", "patch", "seed"]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`unknown flag: --${key}`);
    value(flags, key);
  }
  const taskId = value(flags, "task");
  const repoPath = value(flags, "repo");
  if (Boolean(taskId) === Boolean(repoPath)) throw new Error("provide exactly one of --task <id> or --repo <path>");
  const mode = value(flags, "mode") ?? "live";
  if (mode !== "live" && mode !== "scripted") throw new Error("--mode must be live or scripted");
  const seed = Number(value(flags, "seed") ?? "1");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a nonnegative integer");
  if (mode === "scripted") {
    for (const key of ["model", "provider", "base-url", "api-key-env"]) {
      if (flags[key] !== undefined) throw new Error(`--${key} is only supported in live mode`);
    }
  }
  const modelId = mode === "scripted" ? "scripted" : value(flags, "model") ?? "claude-sonnet-5";
  const model: ModelSpec = mode === "scripted" ? { model: modelId, provider: "compatible" } : {
    model: modelId,
    provider: provider(value(flags, "provider"), modelId),
    baseURL: value(flags, "base-url"),
    apiKeyEnv: value(flags, "api-key-env"),
  };
  if (taskId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) throw new Error("invalid benchmark task ID");
    for (const key of ["report", "regression", "ref", "patch", "red-model", "base-url", "api-key-env"]) {
      if (flags[key] !== undefined) throw new Error(`--${key} is only supported with --repo`);
    }
    if (mode !== "scripted") throw new Error("benchmark fixtures require --mode scripted; for live repair use --repo with a supplied --report and --regression");
    const condition = value(flags, "condition");
    if (condition !== "A" && condition !== "B" && condition !== "C") throw new Error("--condition must be A, B, or C");
    return { kind: "task", taskId, condition, mode, model, seed };
  }
  if (flags["condition"] !== undefined) throw new Error("--condition is only supported with --task");
  const reportPath = value(flags, "report");
  const regressionPath = value(flags, "regression");
  if (!reportPath || !regressionPath) throw new Error("--repo requires --report <file> and --regression <repository-relative path>");
  const patchPath = value(flags, "patch");
  if (mode === "scripted" && !patchPath) throw new Error("scripted local runs require an explicit --patch <file>");
  if (mode === "live" && patchPath) throw new Error("--patch is only supported in scripted mode");
  if (mode === "scripted" && flags["red-model"] !== undefined) throw new Error("--red-model is only supported in live mode");
  const reviewModelId = mode === "live" ? value(flags, "red-model") ?? env["VOUCH_RED_MODEL"] : undefined;
  const reviewModel = reviewModelId ? {
    model: reviewModelId,
    provider: provider(env["VOUCH_RED_PROVIDER"] ?? "compatible", reviewModelId),
    baseURL: env["VOUCH_RED_BASE_URL"],
    apiKeyEnv: env["VOUCH_RED_API_KEY_ENV"],
  } : undefined;
  return {
    kind: "repository", repoPath: repoPath!, reportPath, regressionPath,
    ref: value(flags, "ref") ?? "HEAD", mode, model, seed, patchPath, reviewModel,
  };
}
