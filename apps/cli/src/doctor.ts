import {
  canonicalizeModelSpec,
  probeModel,
  type ModelProbeResult,
  type ModelSpec,
} from "@vouch/model";

export type ProviderCheckRole = "blue" | "red";

export interface ProviderCheck {
  role: ProviderCheckRole;
  model: ModelSpec;
}

export interface DoctorOptions {
  live: boolean;
  checks: ProviderCheck[];
}

type Probe = (
  spec: ModelSpec,
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ModelProbeResult>;

function nativeEndpoint(provider: ModelSpec["provider"]): string {
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openai") return "https://api.openai.com/v1";
  throw new Error("compatible provider is missing a base URL");
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function safeError(error: unknown, secret: string | undefined): string {
  const status = statusCode(error);
  if (status === 401) return "authentication failed (401)";
  if (status === 403) return "credential cannot access this model (403)";
  if (status === 404) return "model or endpoint was not found (404)";
  if (status === 429) return "provider rate limit or quota was reached (429)";
  if (status === 400 || status === 422) return `provider rejected the tool-call request (${status})`;
  if (status !== undefined && status >= 500) return `provider is unavailable (${status})`;

  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, "[redacted]");
  message = message.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  return message.slice(0, 500);
}

export async function runDoctor(
  options: DoctorOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    probe?: Probe;
  } = {},
): Promise<{ ok: boolean; output: string }> {
  const env = dependencies.env ?? process.env;
  const invokeProbe = dependencies.probe ?? probeModel;
  const lines = [`provider check (${options.live ? "live tool call" : "configuration only"})`];
  let ok = true;

  for (const check of options.checks) {
    try {
      const model = canonicalizeModelSpec(check.model);
      const endpoint = model.provider === "compatible"
        ? model.baseURL
        : nativeEndpoint(model.provider);
      const secret = env[model.apiKeyEnv];
      const credentialPresent = Boolean(secret?.trim());
      lines.push(`  ${check.role}: provider=${model.provider} model=${model.model}`);
      lines.push(`    endpoint=${endpoint} keyEnv=${model.apiKeyEnv} credential=${credentialPresent ? "present" : "missing"}`);
      if (!credentialPresent) {
        ok = false;
        continue;
      }
      if (!options.live) continue;

      try {
        const result = await invokeProbe(model, { env, signal: dependencies.signal });
        const usage = result.usageKnown === false
          ? `usageBound<=${result.inputTokens}+${result.outputTokens} accounting=conservative`
          : `usage=${result.inputTokens}+${result.outputTokens}`;
        lines.push(
          `    toolCall=passed${result.responseValidated ? " roundTrip=passed" : ""} latencyMs=${result.latencyMs} ${usage}`,
        );
      } catch (error) {
        ok = false;
        lines.push(`    toolCall=failed error=${safeError(error, secret)}`);
      }
    } catch (error) {
      ok = false;
      lines.push(`  ${check.role}: configuration=failed error=${safeError(error, undefined)}`);
    }
  }

  return { ok, output: `${lines.join("\n")}\n` };
}
