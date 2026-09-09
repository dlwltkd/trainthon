import type { Condition, ExecutionMode } from "@vouch/protocol";
import {
  PROVIDERS,
  providerForModel,
  type ModelSpec,
  type ProviderKind,
} from "@vouch/model";
import { getString } from "./args.js";

export type Flags = Record<string, string | boolean>;

interface CommonOptions {
  mode: ExecutionMode;
  seed: number;
  model: ModelSpec;
}

export type RunOptions = CommonOptions & (
  | { kind: "task"; taskId: string; condition: Condition }
  | { kind: "repository"; repoPath: string; reportPath?: string; regressionPath?: string; prompt?: string; remediate?: boolean; ref: string; patchPath?: string; reviewModel?: ModelSpec }
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
  red: ModelSpec;
}

export function resolveLiveBlueModel(
  flags: Flags,
  env: NodeJS.ProcessEnv = process.env,
): ModelSpec {
  const blueModel = configuredValue(flags, "model", env, "VOUCH_BLUE_MODEL")
    || PROVIDERS.openai.defaultModel;
  return {
    model: blueModel,
    provider: provider(configuredValue(flags, "provider", env, "VOUCH_BLUE_PROVIDER"), blueModel, "Blue"),
    baseURL: configuredValue(flags, "base-url", env, "VOUCH_BLUE_BASE_URL"),
    apiKeyEnv: configuredValue(flags, "api-key-env", env, "VOUCH_BLUE_API_KEY_ENV"),
  };
}

/** Resolve the exact live role configuration without reading or exposing key values. */
export function resolveLiveRoleModels(
  flags: Flags,
  env: NodeJS.ProcessEnv = process.env,
): LiveRoleModels {
  const blue = resolveLiveBlueModel(flags, env);
  const redModel = configuredValue(flags, "red-model", env, "VOUCH_RED_MODEL")
    || blue.model;
  const redProvider = configuredValue(flags, "red-provider", env, "VOUCH_RED_PROVIDER");
  const redBaseURL = configuredValue(flags, "red-base-url", env, "VOUCH_RED_BASE_URL");
  const redApiKeyEnv = configuredValue(flags, "red-api-key-env", env, "VOUCH_RED_API_KEY_ENV");
  const selectedRedProvider = provider(
    redProvider ?? (redModel === blue.model ? blue.provider : providerForModel(redModel) ?? "compatible"),
    redModel,
    "Red",
  );
  const sharesBlueProvider = redModel === blue.model && selectedRedProvider === blue.provider;
  return {
    blue,
    red: {
      model: redModel,
      provider: selectedRedProvider,
      baseURL: redBaseURL ?? (sharesBlueProvider ? blue.baseURL : undefined),
      apiKeyEnv: redApiKeyEnv ?? (sharesBlueProvider ? blue.apiKeyEnv : undefined),
    },
  };
}

export function parseRunOptions(flags: Flags, env: NodeJS.ProcessEnv = process.env): RunOptions {
  const allowed = new Set([
    "task", "condition", "repo", "report", "regression", "prompt", "fix", "ref", "mode",
    "model", "provider", "base-url", "api-key-env",
    "red-model", "red-provider", "red-base-url", "red-api-key-env",
    "patch", "seed",
  ]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`unknown flag: --${key}`);
    if (key === "fix") {
      if (typeof flags[key] !== "boolean") throw new Error("--fix is a boolean flag; use --fix without a value");
    } else {
      value(flags, key);
    }
  }
  const taskId = value(flags, "task");
  const repoPath = value(flags, "repo");
  if (Boolean(taskId) === Boolean(repoPath)) throw new Error("provide exactly one of --task <id> or --repo <path|GitHub URL>");
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
      "report", "regression", "prompt", "fix", "ref", "patch", "base-url", "api-key-env",
      "red-model", "red-provider", "red-base-url", "red-api-key-env",
    ]) {
      if (flags[key] !== undefined) throw new Error(`--${key} is only supported with --repo`);
    }
    if (mode !== "scripted") throw new Error("benchmark fixtures require --mode scripted; use --repo with --prompt for live review or --regression for live repair");
    const condition = value(flags, "condition");
    if (condition !== "A" && condition !== "B" && condition !== "C") throw new Error("--condition must be A, B, or C");
    return { kind: "task", taskId, condition, mode, model: { model: "scripted", provider: "compatible" }, seed };
  }
  if (flags["condition"] !== undefined) throw new Error("--condition is only supported with --task");
  const reportPath = value(flags, "report");
  const regressionPath = value(flags, "regression");
  const prompt = value(flags, "prompt");
  if (reportPath !== undefined && !reportPath.trim()) throw new Error("--report requires a non-empty file path");
  if (prompt !== undefined && !prompt.trim()) throw new Error("--prompt requires non-empty review instructions");
  if (regressionPath !== undefined && !regressionPath.trim()) throw new Error("--regression requires a repository-relative path");
  const patchPath = value(flags, "patch");
  if (!regressionPath) {
    if (!prompt) throw new Error("--repo requires --prompt <review instructions> or --regression <repository-relative path>");
    if (mode !== "live") throw new Error("prompt-based repository review requires --mode live");
    if (flags["patch"] !== undefined) throw new Error("--patch is only supported with --regression");
    const liveModels = resolveLiveRoleModels(flags, env);
    return {
      kind: "repository", repoPath: repoPath!, reportPath, prompt, remediate: flags["fix"] === true,
      ref: value(flags, "ref") ?? "HEAD", mode,
      model: liveModels.blue, reviewModel: liveModels.red, seed,
    };
  }
  if (flags["fix"] !== undefined) throw new Error("--fix cannot be combined with --regression; regression runs already permit source repair");
  if (mode === "scripted" && !patchPath) throw new Error("scripted local runs require an explicit --patch <file>");
  if (mode === "live" && patchPath) throw new Error("--patch is only supported in scripted mode");
  const liveModels = mode === "live" ? resolveLiveRoleModels(flags, env) : undefined;
  return {
    kind: "repository", repoPath: repoPath!, reportPath, regressionPath, prompt,
    ref: value(flags, "ref") ?? "HEAD", mode,
    model: liveModels?.blue ?? { model: "scripted", provider: "compatible" },
    seed, patchPath, reviewModel: liveModels?.red,
  };
}
