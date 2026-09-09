import { APICallError } from "ai";

const CONNECTION_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

function connectionCode(error: unknown): string | undefined {
  const pending = [error];
  for (let count = 0; pending.length && count < 16; count++) {
    const next = pending.shift();
    if (!next || typeof next !== "object") continue;
    const item = next as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.code === "string" && CONNECTION_CODES.has(item.code)) return item.code;
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  return undefined;
}

const PROVIDER_CODES: Record<string, { diagnosis: string; retryable: boolean }> = {
  bad_gateway: { diagnosis: "provider gateway unavailable", retryable: true },
  service_unavailable: { diagnosis: "provider unavailable", retryable: true },
  server_error: { diagnosis: "provider server error", retryable: true },
  internal_error: { diagnosis: "provider internal error", retryable: true },
  rate_limit_exceeded: { diagnosis: "provider rate limit reached", retryable: true },
  timeout: { diagnosis: "provider timed out", retryable: true },
  invalid_api_key: { diagnosis: "provider rejected the API key", retryable: false },
  authentication_error: { diagnosis: "provider authentication failed", retryable: false },
  invalid_request_error: { diagnosis: "provider rejected the request", retryable: false },
  insufficient_quota: { diagnosis: "provider quota exhausted", retryable: false },
  model_not_found: { diagnosis: "provider model unavailable", retryable: false },
  context_length_exceeded: { diagnosis: "provider context window exceeded", retryable: false },
  invalid_function_parameters: { diagnosis: "provider rejected a tool schema", retryable: false },
  invalid_json_schema: { diagnosis: "provider rejected a JSON schema", retryable: false },
};

function knownProviderCode(value: unknown): { code: string; diagnosis: string; retryable: boolean } | undefined {
  let current = value;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const item = current as { code?: unknown; error?: unknown };
    if (typeof item.code === "string" && Object.hasOwn(PROVIDER_CODES, item.code)) return { code: item.code, ...PROVIDER_CODES[item.code]! };
    current = item.error;
  }
  return undefined;
}

function responseCode(body: string | undefined) {
  try { return body ? knownProviderCode(JSON.parse(body)) : undefined; }
  catch { return undefined; }
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderRequestError";
  }
}

/** Persist transport metadata without echoing provider bodies, headers, or prompts. */
export function providerRequestError(error: unknown): unknown {
  if (error instanceof ProviderRequestError || !APICallError.isInstance(error)) return error;
  const status = error.statusCode;
  const requestId = Object.entries(error.responseHeaders ?? {}).find(([name]) => ["x-request-id", "request-id", "cf-ray"].includes(name.toLowerCase()))?.[1];
  const safeId = requestId && /^[A-Za-z0-9:_.-]{1,150}$/.test(requestId) ? requestId : undefined;
  const retryAfter = Object.entries(error.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  let retryAfterMs: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) retryAfterMs = Math.min(delay, 2_147_483_647);
  }
  const providerCode = responseCode(error.responseBody);
  const retryable = providerCode?.retryable ?? (status === undefined ? error.isRetryable : status === 408 || status === 429 || status >= 500);
  const code = status === undefined ? connectionCode(error) : undefined;
  const diagnosis = status === undefined ? `connection error${code ? `: ${code}` : ""}` : `HTTP ${status}${providerCode ? `; ${providerCode.diagnosis}` : ""}`;
  return new ProviderRequestError(
    `Model API request failed (${diagnosis})${safeId ? `; request ID ${safeId}` : ""}.`,
    retryable, retryAfterMs, status, { cause: error },
  );
}

export function providerStreamError(error: unknown): unknown {
  const converted = providerRequestError(error);
  if (converted instanceof ProviderRequestError) return converted;
  const known = knownProviderCode(error);
  return new ProviderRequestError(`Model stream failed${known ? ` (${known.code}; ${known.diagnosis})` : ""}.`, known?.retryable ?? false, undefined, undefined, { cause: error });
}
