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

function contextExceeded(body: string | undefined): boolean {
  if (!body) return false;
  try { return JSON.parse(body)?.error?.code === "context_length_exceeded"; }
  catch { return false; }
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
  const retryable = status === undefined ? error.isRetryable : status === 408 || status === 429 || status >= 500;
  const code = status === undefined ? connectionCode(error) : undefined;
  const diagnosis = status === undefined ? `connection error${code ? `: ${code}` : ""}` : `HTTP ${status}${contextExceeded(error.responseBody) ? "; provider context window exceeded" : ""}`;
  return new ProviderRequestError(
    `Model API request failed (${diagnosis})${safeId ? `; request ID ${safeId}` : ""}.`,
    retryable, retryAfterMs, status, { cause: error },
  );
}
