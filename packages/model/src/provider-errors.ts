import { APICallError } from "ai";

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
  return new ProviderRequestError(
    `Model API request failed${status === undefined ? " (connection error)" : ` (HTTP ${status})`}${safeId ? `; request ID ${safeId}` : ""}.`,
    retryable, retryAfterMs, status, { cause: error },
  );
}
