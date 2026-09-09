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

/**
 * Runner for any OpenAI-compatible gateway (Routeway, Vercel AI Gateway,
 * OpenRouter, z.ai, ...). One abstraction covers every gateway and unlocks
 * models a native provider does not expose — including less-restricted models
 * useful for the harness Red (attack) role, which safety-tuned frontier models
 * often refuse to run.
 */
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

/** Build a runner from a spec, or null when its API key is absent. */
export function createRunnerForSpec(
  spec: ModelSpec,
  env: NodeJS.ProcessEnv = process.env,
): AgentRunner | null {
  const key = env[apiKeyEnvFor(spec)];
  if (!key) return null;
  if (spec.provider === "compatible") {
    return createCompatibleRunner({
      apiKey: key,
      baseURL: spec.baseURL ?? GATEWAYS.routeway,
      name: "gateway",
    });
  }
  return createRunner(spec.provider, key);
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

/**
 * Selects a live provider from the environment. If `preferred` is given it is
 * used when its API key is present; otherwise the first provider with a key
 * wins. `model` overrides the provider default. Returns null when no key is
 * available (callers may fall back to a scripted runner).
 */
export function resolveRunnerFromEnv(opts?: {
  preferred?: ProviderName;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedRunner | null {
  const env = opts?.env ?? process.env;
  const order: ProviderName[] = opts?.preferred
    ? [opts.preferred, ...(Object.keys(PROVIDERS) as ProviderName[]).filter((p) => p !== opts.preferred)]
    : (Object.keys(PROVIDERS) as ProviderName[]);

  for (const name of order) {
    const info = PROVIDERS[name];
    const key = env[info.apiKeyEnv];
    if (key) {
      return {
        runner: createRunner(name, key),
        provider: name,
        model: opts?.model ?? info.defaultModel,
      };
    }
  }
  return null;
}
