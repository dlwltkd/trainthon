import { describe, expect, it, vi } from "vitest";
import type { ModelProbeResult } from "@vouch/model";
import { runDoctor } from "./doctor.js";
import { parseDoctorOptions } from "./doctor-options.js";

const blue = { role: "blue" as const, model: { provider: "openai" as const, model: "gpt-test" } };
const red = {
  role: "red" as const,
  model: {
    provider: "compatible" as const,
    model: "glm-5.3-flash-uncensored",
    baseURL: "https://api.routeway.ai/v1",
  },
};

function passed(): ModelProbeResult {
  return { latencyMs: 12, inputTokens: 8, outputTokens: 3 };
}

describe("provider doctor", () => {
  it("resolves the same Blue and Red configuration used by live runs", () => {
    const options = parseDoctorOptions({ live: true }, {
      VOUCH_BLUE_MODEL: "gpt-test",
      VOUCH_RED_MODEL: "glm-5.3-flash-uncensored",
      VOUCH_RED_BASE_URL: "https://api.routeway.ai/v1",
    });
    expect(options).toMatchObject({
      live: true,
      checks: [
        { role: "blue", model: { provider: "openai", model: "gpt-test" } },
        { role: "red", model: { provider: "compatible", model: "glm-5.3-flash-uncensored" } },
      ],
    });
  });

  it("rejects unsupported flags and a value passed to --live", () => {
    const env = { VOUCH_BLUE_MODEL: "gpt-test" };
    expect(() => parseDoctorOptions({ typo: "x" }, env)).toThrow("unknown flag");
    expect(() => parseDoctorOptions({ live: "yes" }, env)).toThrow("does not take a value");
  });

  it("checks configuration without making a paid request", async () => {
    const probe = vi.fn(async () => passed());
    const result = await runDoctor({ live: false, checks: [blue, red] }, {
      env: { OPENAI_API_KEY: "openai-secret", ROUTEWAY_API_KEY: "routeway-secret" }, probe,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("configuration only");
    expect(result.output).toContain("blue: provider=openai model=gpt-test");
    expect(result.output).toContain("red: provider=compatible model=glm-5.3-flash-uncensored");
    expect(result.output).not.toContain("openai-secret");
    expect(result.output).not.toContain("routeway-secret");
    expect(probe).not.toHaveBeenCalled();
  });

  it("requires every configured credential", async () => {
    const result = await runDoctor({ live: false, checks: [blue, red] }, { env: {} });
    expect(result.ok).toBe(false);
    expect(result.output.match(/credential=missing/g)).toHaveLength(2);
  });

  it("runs one required tool-call probe per role", async () => {
    const probe = vi.fn(async () => passed());
    const result = await runDoctor({ live: true, checks: [blue, red] }, {
      env: { OPENAI_API_KEY: "openai-secret", ROUTEWAY_API_KEY: "routeway-secret" }, probe,
    });
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.output.match(/toolCall=passed/g)).toHaveLength(2);
  });

  it("labels a conservative usage bound when the provider omits token counts", async () => {
    const probe = vi.fn(async (): Promise<ModelProbeResult> => ({
      ...passed(), usageKnown: false,
    }));
    const result = await runDoctor({ live: true, checks: [red] }, {
      env: { ROUTEWAY_API_KEY: "routeway-secret" }, probe,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usageBound<=8+3 accounting=conservative");
  });

  it.each([
    [401, "authentication failed (401)"],
    [404, "model or endpoint was not found (404)"],
    [429, "provider rate limit or quota was reached (429)"],
  ])("maps provider status %s without printing response secrets", async (code, message) => {
    const probe = vi.fn(async () => {
      throw Object.assign(new Error("request with blue-secret failed"), { statusCode: code });
    });
    const result = await runDoctor({ live: true, checks: [blue] }, {
      env: { OPENAI_API_KEY: "blue-secret" }, probe,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain("blue-secret");
  });

  it("redacts secrets from non-HTTP errors", async () => {
    const probe = vi.fn(async () => { throw new Error("socket rejected secret-token"); });
    const result = await runDoctor({ live: true, checks: [blue] }, {
      env: { OPENAI_API_KEY: "secret-token" }, probe,
    });
    expect(result.output).toContain("socket rejected [redacted]");
    expect(result.output).not.toContain("secret-token");
  });
});
