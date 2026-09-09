import { afterEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { ProviderRequestError, providerRequestError } from "./provider-errors.js";

const failure = (overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) => new APICallError({
  message: "no error message was provided",
  url: "https://provider.example/v1",
  requestBodyValues: {},
  statusCode: 502,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe("provider error diagnostics", () => {
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
