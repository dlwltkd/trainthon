import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { SdkRunner } from "./sdk-runner.js";
import type { AgentRunner } from "./types.js";

export type ProviderName = "anthropic" | "openai";

/** Any provider selectable for a run or a harness role. */
export type ProviderKind = ProviderName | "compatible";

/** Base URLs for known OpenAI-compatible gateways. */
export const GATEWAYS = {
  routeway: "https://api.routeway.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
  zai: "https://api.z.ai/api/paas/v4",
} as const;

export interface ProviderInfo {
  name: ProviderName;
  /** Env var holding the API key. */
  apiKeyEnv: string;
  /** Default model id used when the caller does not specify one. */
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderName, ProviderInfo> = {
  anthropic: {
    name: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
  },
  openai: {
    name: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.1",
  },
};

export function createAnthropicRunner(apiKey: string): AgentRunner {
  return new SdkRunner(createAnthropic({ apiKey }));
}

export function createOpenAIRunner(apiKey: string): AgentRunner {
  return new SdkRunner(createOpenAI({ apiKey }));
}

/** Runner for an explicitly configured OpenAI-compatible gateway. */
export function createCompatibleRunner(opts: {
  apiKey: string;
  baseURL: string;
  name?: string;
}): AgentRunner {
  const provider = createOpenAICompatible({
    name: opts.name ?? "compatible",
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });
  return new SdkRunner((modelId: string) => provider(modelId));
}

export function createRunner(provider: ProviderName, apiKey: string): AgentRunner {
  switch (provider) {
    case "anthropic":
      return createAnthropicRunner(apiKey);
    case "openai":
      return createOpenAIRunner(apiKey);
  }
}

/** A fully-specified model choice for a run or a harness role. */
export interface ModelSpec {
  provider: ProviderKind;
  model: string;
  /** For `compatible`: the gateway base URL. Defaults to Routeway. */
  baseURL?: string;
  /** Env var holding the API key. Defaults to the provider's standard var. */
  apiKeyEnv?: string;
}

function apiKeyEnvFor(spec: ModelSpec): string {
  if (spec.apiKeyEnv) return spec.apiKeyEnv;
  if (spec.provider === "compatible") return "ROUTEWAY_API_KEY";
  return PROVIDERS[spec.provider].apiKeyEnv;
}

export function validateModelSpec(spec: ModelSpec): void {
  if (!["anthropic", "openai", "compatible"].includes(spec.provider)) {
    throw new Error(`Unsupported model provider: ${spec.provider}`);
  }
  if (!spec.model || spec.model.trim() !== spec.model) throw new Error("A nonempty model ID is required");
  if (spec.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.apiKeyEnv)) {
    throw new Error("apiKeyEnv must name an environment variable");
  }
  if (spec.provider === "compatible") {
    let url: URL;
    try { url = new URL(spec.baseURL ?? GATEWAYS.routeway); }
    catch { throw new Error("Compatible provider baseURL must be an absolute URL"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Compatible provider baseURL requires HTTPS (HTTP is allowed for loopback)");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Compatible provider baseURL cannot contain credentials, query parameters, or a fragment");
    }
  } else {
    if (spec.baseURL) throw new Error("baseURL requires provider: compatible");
    const inferred = providerForModel(spec.model);
    if (inferred && inferred !== spec.provider) throw new Error(`Model ${spec.model} does not match provider ${spec.provider}`);
  }
}

/** Build a runner from a spec, or null when its API key is absent. */
export function createRunnerForSpec(
  spec: ModelSpec,
  env: NodeJS.ProcessEnv = process.env,
): AgentRunner | null {
  validateModelSpec(spec);
  const key = env[apiKeyEnvFor(spec)];
  if (!key?.trim()) return null;
  if (spec.provider === "compatible") {
    return createCompatibleRunner({
      apiKey: key,
      baseURL: spec.baseURL ?? GATEWAYS.routeway,
      name: "gateway",
    });
  }
  return createRunner(spec.provider, key);
}

export function requireRunnerForSpec(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const runner = createRunnerForSpec(spec, env);
  if (!runner) throw new Error(`Live model ${spec.model} requires ${apiKeyEnvFor(spec)}`);
  return runner;
}

/** Infer the provider from a model id when one is not given explicitly. */
export function providerForModel(modelId: string): ProviderName | undefined {
  if (/^claude/i.test(modelId)) return "anthropic";
  if (/^(gpt|o\d|chatgpt|text-)/i.test(modelId)) return "openai";
  return undefined;
}

export interface ResolvedRunner {
  runner: AgentRunner;
  provider: ProviderName;
  model: string;
}

/** Resolve the requested provider only; missing credentials never change models. */
export function resolveRunnerFromEnv(opts?: {
  preferred?: ProviderName;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedRunner | null {
  const env = opts?.env ?? process.env;
  const inferred = opts?.model ? providerForModel(opts.model) : undefined;
  if (opts?.model && !opts.preferred && !inferred) {
    throw new Error(`Model ${opts.model} requires an explicit provider specification`);
  }
  const provider = opts?.preferred ?? inferred ?? "anthropic";
  const model = opts?.model ?? PROVIDERS[provider].defaultModel;
  const runner = createRunnerForSpec({ provider, model }, env);
  return runner ? { runner, provider, model } : null;
}
