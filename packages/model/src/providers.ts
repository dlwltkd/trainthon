import { randomBytes } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { RunBudget } from "./budget.js";
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

export const ROUTEWAY_GLM_FLASH_UNCENSORED = "glm-5.3-flash-uncensored";

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

function normalizeSecret(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("API key must be nonempty");
  return normalized;
}

export function createAnthropicRunner(apiKey: string): AgentRunner {
  return new SdkRunner(createAnthropic({ apiKey: normalizeSecret(apiKey) }));
}

export function createOpenAIRunner(apiKey: string): AgentRunner {
  return new SdkRunner(createOpenAI({ apiKey: normalizeSecret(apiKey) }));
}

/** Runner for an explicitly configured OpenAI-compatible gateway. */
export function createCompatibleRunner(opts: {
  apiKey: string;
  baseURL: string;
  name?: string;
  fetch?: OpenAICompatibleProviderSettings["fetch"];
}): AgentRunner {
  const baseURL = normalizeCompatibleBaseURL(opts.baseURL);
  const provider = createOpenAICompatible({
    name: opts.name ?? "compatible",
    apiKey: normalizeSecret(opts.apiKey),
    baseURL,
    fetch: opts.fetch,
    transformRequestBody: (body) => {
      if (baseURL !== GATEWAYS.routeway || body.model !== ROUTEWAY_GLM_FLASH_UNCENSORED) return body;
      const { seed: _seed, max_tokens: maxTokens, ...rest } = body;
      if (maxTokens === undefined || rest.max_completion_tokens !== undefined) return rest;
      return { ...rest, max_completion_tokens: maxTokens };
    },
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

export interface CanonicalModelSpec {
  provider: ProviderKind;
  model: string;
  apiKeyEnv: string;
  /** Always present for compatible providers. */
  baseURL?: string;
}

function normalizeCompatibleBaseURL(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Compatible provider baseURL must be an absolute URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Compatible provider baseURL requires HTTPS (HTTP is allowed for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Compatible provider baseURL cannot contain credentials, query parameters, or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export function canonicalizeModelSpec(spec: ModelSpec): CanonicalModelSpec {
  if (!["anthropic", "openai", "compatible"].includes(spec.provider)) {
    throw new Error(`Unsupported model provider: ${spec.provider}`);
  }
  if (!spec.model || spec.model.trim() !== spec.model) throw new Error("A nonempty model ID is required");
  if (spec.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.apiKeyEnv)) {
    throw new Error("apiKeyEnv must name an environment variable");
  }
  if (spec.provider === "compatible") {
    const baseURL = normalizeCompatibleBaseURL(spec.baseURL ?? GATEWAYS.routeway);
    const routeway = baseURL === GATEWAYS.routeway;
    if (!routeway && !spec.apiKeyEnv) {
      throw new Error("A non-Routeway compatible baseURL requires an explicit apiKeyEnv");
    }
    return {
      provider: "compatible",
      model: spec.model,
      baseURL,
      apiKeyEnv: spec.apiKeyEnv ?? "ROUTEWAY_API_KEY",
    };
  } else {
    if (spec.baseURL) throw new Error("baseURL requires provider: compatible");
    const inferred = providerForModel(spec.model);
    if (inferred && inferred !== spec.provider) throw new Error(`Model ${spec.model} does not match provider ${spec.provider}`);
    return {
      provider: spec.provider,
      model: spec.model,
      apiKeyEnv: spec.apiKeyEnv ?? PROVIDERS[spec.provider].apiKeyEnv,
    };
  }
}

export function validateModelSpec(spec: ModelSpec): void {
  canonicalizeModelSpec(spec);
}

/** Build a runner from a spec, or null when its API key is absent. */
export function createRunnerForSpec(
  spec: ModelSpec,
  env: NodeJS.ProcessEnv = process.env,
): AgentRunner | null {
  const canonical = canonicalizeModelSpec(spec);
  const key = env[canonical.apiKeyEnv]?.trim();
  if (!key) return null;
  if (canonical.provider === "compatible") {
    return createCompatibleRunner({
      apiKey: key,
      baseURL: canonical.baseURL!,
      name: "gateway",
    });
  }
  return createRunner(canonical.provider, key);
}

export function requireRunnerForSpec(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): AgentRunner {
  const canonical = canonicalizeModelSpec(spec);
  const runner = createRunnerForSpec(spec, env);
  if (!runner) throw new Error(`Live model ${spec.model} requires ${canonical.apiKeyEnv}`);
  return runner;
}

export interface ModelProbeResult {
  provider?: ProviderKind;
  model?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  steps?: 1;
  toolCalls?: 1;
}

/** Verify credentials, model selection, usage reporting, and one required tool call. */
export async function probeModel(
  spec: ModelSpec,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; runner?: AgentRunner } = {},
): Promise<ModelProbeResult> {
  const canonical = canonicalizeModelSpec(spec);
  const runner = options.runner ?? requireRunnerForSpec(canonical, options.env);
  const nonce = randomBytes(16).toString("hex");
  const limits = { maxTokens: 4_096, maxSteps: 1, maxWallMs: 15_000 } as const;
  const budget = new RunBudget(limits, options.signal);
  let attempts = 0;
  let completed = 0;
  const startedAt = performance.now();
  try {
    const result = await runner.run({
      system: "You are checking an API connection. Call the supplied connection_probe tool exactly once.",
      prompt: `Call connection_probe once with this exact nonce: ${nonce}`,
      tools: [{
        name: "connection_probe",
        description: "Return the supplied connection nonce.",
        schema: z.object({ nonce: z.literal(nonce) }),
        execute: async () => {
          attempts++;
          if (attempts !== 1) throw new Error("Provider called connection_probe more than once");
          completed++;
          return { ok: true };
        },
      }],
      budgets: limits,
      budget,
      model: canonical.model,
      seed: 1,
      toolChoice: "required",
      onEvent: () => undefined,
    });
    if (attempts !== 1 || completed !== 1 || result.steps !== 1) {
      throw new Error("Provider did not complete exactly one required connection_probe tool call");
    }
    return {
      provider: canonical.provider,
      model: canonical.model,
      apiKeyEnv: canonical.apiKeyEnv,
      ...(canonical.baseURL ? { baseURL: canonical.baseURL } : {}),
      latencyMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      steps: 1,
      toolCalls: 1,
    };
  } finally {
    budget.dispose();
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
