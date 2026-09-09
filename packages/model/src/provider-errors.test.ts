import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { ProviderRequestError, providerRequestError, providerStreamError } from "./provider-errors.js";

const failure = (overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) => new APICallError({
  message: "no error message was provided",
  url: "https://provider.example/v1",
  requestBodyValues: {},
  statusCode: 502,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("provider error diagnostics", () => {
  it("distinguishes exhausted quota from a retryable HTTP rate limit", () => {
    const exhausted = providerRequestError(failure({ statusCode: 429, responseBody: JSON.stringify({ error: { code: "insufficient_quota", message: "private account detail" } }) })) as ProviderRequestError;
    expect(exhausted).toMatchObject({ retryable: false, httpStatus: 429 });
    expect(exhausted.message).toContain("provider quota exhausted");
    expect(exhausted.message).not.toContain("private account detail");
    expect(providerRequestError(failure({ statusCode: 429, responseBody: JSON.stringify({ error: { code: "rate_limit_exceeded" } }) }))).toMatchObject({ retryable: true });
  });

  it("recognizes nested stream quota and schema errors without persisting arbitrary messages or codes", () => {
    for (const code of ["insufficient_quota", "context_length_exceeded", "invalid_function_parameters"]) {
      const error = providerStreamError({ error: { code, message: "private source and account details" } }) as ProviderRequestError;
      expect(error.retryable).toBe(false);
      expect(error.message).toContain(code);
      expect(error.message).not.toContain("private source");
    }
    expect(providerStreamError({ code: "secret-provider-code", message: "private source" })).toMatchObject({ message: "Model stream failed.", retryable: false });
    expect(providerStreamError({ error: { code: "bad_gateway" } })).toMatchObject({ retryable: true });
  });
  it("distinguishes a provider context rejection without displaying the response body", () => {
    const error = providerRequestError(failure({ statusCode: 400, responseBody: JSON.stringify({ error: { code: "context_length_exceeded", message: "private source" } }) })) as ProviderRequestError;
    expect(error.message).toBe("Model API request failed (HTTP 400; provider context window exceeded).");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("private source");
  });

  it("reports known nested connection codes without exposing endpoint addresses or arbitrary error text", () => {
    const cause = new AggregateError([Object.assign(new Error("secret endpoint detail"), { code: "ECONNRESET", address: "private-address" })]);
    const error = providerRequestError(failure({ statusCode: undefined, cause })) as ProviderRequestError;
    expect(error.message).toBe("Model API request failed (connection error: ECONNRESET).");
    const unknown = Object.assign(new Error("secret"), { code: "SECRET_VALUE" });
    expect((providerRequestError(failure({ statusCode: undefined, cause: unknown })) as Error).message).toBe("Model API request failed (connection error).");
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect((providerRequestError(failure({ statusCode: undefined, cause: cycle })) as Error).message).toBe("Model API request failed (connection error).");
  });

  it("keeps the HTTP status and request ID without copying source or credentials into the message", () => {
    const original = failure({
      message: "provider echoed secret-value",
      requestBodyValues: { prompt: "private repository source" },
      responseBody: '{"error":"secret-value"}',
      responseHeaders: { "X-Request-Id": "request-123", "authorization": "Bearer secret-value" },
    });
    const error = providerRequestError(original) as ProviderRequestError;
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.message).toBe("Model API request failed (HTTP 502); request ID request-123.");
    expect(error).toMatchObject({ httpStatus: 502, retryable: true, cause: original });
    expect(String(error)).not.toContain("secret-value");
    expect(String(error)).not.toContain("private repository");
  });

  it.each(["request\nBearer secret", "<script>bad</script>", "x".repeat(151)])("drops unsafe request IDs", requestId => {
    const error = providerRequestError(failure({ responseHeaders: { "request-id": requestId } })) as Error;
    expect(error.message).toBe("Model API request failed (HTTP 502).");
  });

  it.each([408, 429, 500, 502, 503, 504])("classifies HTTP %s as transient", statusCode => {
    expect(providerRequestError(failure({ statusCode, isRetryable: false }))).toMatchObject({ retryable: true });
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %s", statusCode => {
    expect(providerRequestError(failure({ statusCode, isRetryable: true }))).toMatchObject({ retryable: false });
  });

  it("honors numeric and dated Retry-After headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    expect(providerRequestError(failure({ statusCode: 429, responseHeaders: { "Retry-After": "2.5" } }))).toMatchObject({ retryAfterMs: 2_500 });
    expect(providerRequestError(failure({ statusCode: 429, responseHeaders: { "retry-after": "Wed, 09 Sep 2026 12:00:05 GMT" } }))).toMatchObject({ retryAfterMs: 5_000 });
    expect(providerRequestError(failure({ responseHeaders: { "retry-after": "invalid" } }))).toMatchObject({ retryAfterMs: undefined });
  });

  it("preserves non-API exceptions and the provider's connection-error classification", () => {
    const local = new Error("local failure");
    expect(providerRequestError(local)).toBe(local);
    expect(providerRequestError(failure({ statusCode: undefined, isRetryable: true }))).toMatchObject({ message: "Model API request failed (connection error).", retryable: true });
    expect(providerRequestError(failure({ statusCode: undefined, isRetryable: false }))).toMatchObject({ retryable: false });
  });
});
