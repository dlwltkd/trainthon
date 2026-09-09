import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { SdkRunner } from "./sdk-runner.js";
import type { AgentRunner } from "./types.js";

export type ProviderName = "anthropic" | "openai";

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

export function createRunner(provider: ProviderName, apiKey: string): AgentRunner {
  switch (provider) {
    case "anthropic":
      return createAnthropicRunner(apiKey);
    case "openai":
      return createOpenAIRunner(apiKey);
  }
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
