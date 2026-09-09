import type { Condition, ExecutionMode } from "@vouch/protocol";
import { providerForModel, type ModelSpec, type ProviderKind } from "@vouch/model";
import { getString } from "./args.js";

export type Flags = Record<string, string | boolean>;

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

function provider(value: string | undefined, model: string, role: "Blue" | "Red"): ProviderKind {
  const selected = value ?? providerForModel(model);
  if (selected !== "anthropic" && selected !== "openai" && selected !== "compatible") {
    throw new Error(`${role} provider must be anthropic, openai, or compatible; unknown model IDs require an explicit provider`);
  }
  return selected;
}

function configuredValue(
  flags: Flags,
  flag: string,
  env: NodeJS.ProcessEnv,
  envName: string,
): string | undefined {
  return flags[flag] === undefined ? env[envName] : value(flags, flag);
}

export interface LiveRoleModels {
  blue: ModelSpec;
  red?: ModelSpec;
}

/** Resolve the exact live role configuration without reading or exposing key values. */
export function resolveLiveRoleModels(
  flags: Flags,
  env: NodeJS.ProcessEnv = process.env,
): LiveRoleModels {
  const blueModel = configuredValue(flags, "model", env, "VOUCH_BLUE_MODEL");
  if (!blueModel) {
    throw new Error("live repository runs require an explicit Blue model via --model or VOUCH_BLUE_MODEL");
  }
  const blue: ModelSpec = {
    model: blueModel,
    provider: provider(configuredValue(flags, "provider", env, "VOUCH_BLUE_PROVIDER"), blueModel, "Blue"),
    baseURL: configuredValue(flags, "base-url", env, "VOUCH_BLUE_BASE_URL"),
    apiKeyEnv: configuredValue(flags, "api-key-env", env, "VOUCH_BLUE_API_KEY_ENV"),
  };

  const redModel = configuredValue(flags, "red-model", env, "VOUCH_RED_MODEL");
  const redProvider = configuredValue(flags, "red-provider", env, "VOUCH_RED_PROVIDER");
  const redBaseURL = configuredValue(flags, "red-base-url", env, "VOUCH_RED_BASE_URL");
  const redApiKeyEnv = configuredValue(flags, "red-api-key-env", env, "VOUCH_RED_API_KEY_ENV");
  if (!redModel) {
    if ([redProvider, redBaseURL, redApiKeyEnv].some(item => item !== undefined)) {
      throw new Error("Red provider configuration requires --red-model or VOUCH_RED_MODEL");
    }
    return { blue };
  }

  return {
    blue,
    red: {
      model: redModel,
      provider: provider(redProvider ?? "compatible", redModel, "Red"),
      baseURL: redBaseURL,
      apiKeyEnv: redApiKeyEnv,
    },
  };
}

export function parseRunOptions(flags: Flags, env: NodeJS.ProcessEnv = process.env): RunOptions {
  const allowed = new Set([
    "task", "condition", "repo", "report", "regression", "ref", "mode",
    "model", "provider", "base-url", "api-key-env",
    "red-model", "red-provider", "red-base-url", "red-api-key-env",
    "patch", "seed",
  ]);
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
    for (const key of [
      "model", "provider", "base-url", "api-key-env",
      "red-model", "red-provider", "red-base-url", "red-api-key-env",
    ]) {
      if (flags[key] !== undefined) throw new Error(`--${key} is only supported in live mode`);
    }
  }
  if (taskId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) throw new Error("invalid benchmark task ID");
    for (const key of [
      "report", "regression", "ref", "patch", "base-url", "api-key-env",
      "red-model", "red-provider", "red-base-url", "red-api-key-env",
    ]) {
      if (flags[key] !== undefined) throw new Error(`--${key} is only supported with --repo`);
    }
    if (mode !== "scripted") throw new Error("benchmark fixtures require --mode scripted; for live repair use --repo with a supplied --report and --regression");
    const condition = value(flags, "condition");
    if (condition !== "A" && condition !== "B" && condition !== "C") throw new Error("--condition must be A, B, or C");
    return { kind: "task", taskId, condition, mode, model: { model: "scripted", provider: "compatible" }, seed };
  }
  if (flags["condition"] !== undefined) throw new Error("--condition is only supported with --task");
  const reportPath = value(flags, "report");
  const regressionPath = value(flags, "regression");
  if (!reportPath || !regressionPath) throw new Error("--repo requires --report <file> and --regression <repository-relative path>");
  const patchPath = value(flags, "patch");
  if (mode === "scripted" && !patchPath) throw new Error("scripted local runs require an explicit --patch <file>");
  if (mode === "live" && patchPath) throw new Error("--patch is only supported in scripted mode");
  const liveModels = mode === "live" ? resolveLiveRoleModels(flags, env) : undefined;
  return {
    kind: "repository", repoPath: repoPath!, reportPath, regressionPath,
    ref: value(flags, "ref") ?? "HEAD", mode,
    model: liveModels?.blue ?? { model: "scripted", provider: "compatible" },
    seed, patchPath, reviewModel: liveModels?.red,
  };
}
