import { describe, expect, it } from "vitest";
import { parseRunOptions } from "./run-options.js";

const repository = { repo: "/tmp/project", report: "/tmp/report.md", regression: "src/check.test.ts" };

describe("run CLI options", () => {
  it("defaults existing repository runs to live and HEAD with an explicit env model", () => {
    const options = parseRunOptions(repository, { VOUCH_BLUE_MODEL: "claude-test" });
    expect(options).toMatchObject({
      kind: "repository", mode: "live", ref: "HEAD", seed: 1,
      model: { model: "claude-test", provider: "anthropic" },
    });
  });

  it("requires an explicit Blue model for live repository runs", () => {
    expect(() => parseRunOptions(repository, {})).toThrow("explicit Blue model");
    expect(parseRunOptions({ ...repository, model: "gpt-repair" }, {})).toMatchObject({
      model: { model: "gpt-repair", provider: "openai" },
    });
  });

  it("reads Blue configuration from env and lets each CLI flag take precedence", () => {
    const env = {
      VOUCH_BLUE_MODEL: "env-model",
      VOUCH_BLUE_PROVIDER: "compatible",
      VOUCH_BLUE_BASE_URL: "https://env.example/v1",
      VOUCH_BLUE_API_KEY_ENV: "ENV_BLUE_KEY",
    };
    expect(parseRunOptions(repository, env)).toMatchObject({ model: {
      model: "env-model", provider: "compatible",
      baseURL: "https://env.example/v1", apiKeyEnv: "ENV_BLUE_KEY",
    } });
    expect(parseRunOptions({
      ...repository,
      model: "flag-model",
      provider: "compatible",
      "base-url": "https://flag.example/v1",
      "api-key-env": "FLAG_BLUE_KEY",
    }, env)).toMatchObject({ model: {
      model: "flag-model", provider: "compatible",
      baseURL: "https://flag.example/v1", apiKeyEnv: "FLAG_BLUE_KEY",
    } });
  });

  it("requires exactly one input kind", () => {
    expect(() => parseRunOptions({})).toThrow("exactly one");
    expect(() => parseRunOptions({ ...repository, task: "example" })).toThrow("exactly one");
  });

  it("requires a supplied report and regression", () => {
    expect(() => parseRunOptions({ repo: "/tmp/project" })).toThrow("--report");
  });

  it("never silently switches legacy tasks to scripted mode", () => {
    expect(() => parseRunOptions({ task: "fixture", condition: "C" })).toThrow("--mode scripted");
    expect(parseRunOptions({ task: "fixture", condition: "C", mode: "scripted" }, {
      VOUCH_BLUE_MODEL: "ambient-blue", VOUCH_BLUE_PROVIDER: "invalid",
      VOUCH_RED_PROVIDER: "orphaned",
    })).toMatchObject({ kind: "task", mode: "scripted", model: { model: "scripted" } });
  });

  it("does not accept or record an unused model in scripted mode", () => {
    const task = parseRunOptions({ task: "fixture", condition: "C", mode: "scripted" });
    expect(task.model.model).toBe("scripted");
    expect(() => parseRunOptions({ task: "fixture", condition: "C", mode: "scripted", model: "claude-unused" })).toThrow("only supported in live mode");
    expect(() => parseRunOptions({ ...repository, mode: "scripted", patch: "change.patch", provider: "openai" })).toThrow("only supported in live mode");
  });

  it("rejects task IDs that escape the benchmark directory", () => {
    expect(() => parseRunOptions({ task: "../fixture", mode: "scripted", condition: "C" })).toThrow("invalid benchmark task ID");
  });

  it("requires an explicit patch for scripted local runs", () => {
    expect(() => parseRunOptions({ ...repository, mode: "scripted" })).toThrow("--patch");
    expect(() => parseRunOptions({ ...repository, patch: "change.patch" })).toThrow("only supported in scripted");
    expect(parseRunOptions({ ...repository, mode: "scripted", patch: "change.patch" })).toMatchObject({ patchPath: "change.patch" });
  });

  it("keeps report review configuration separate from the repair model", () => {
    const options = parseRunOptions({ ...repository, model: "gpt-repair", "red-model": "glm-review" }, {
      VOUCH_RED_BASE_URL: "https://provider.example/v1", VOUCH_RED_API_KEY_ENV: "REVIEW_KEY",
    });
    expect(options).toMatchObject({ model: { model: "gpt-repair", provider: "openai" }, reviewModel: {
      model: "glm-review", provider: "compatible", baseURL: "https://provider.example/v1", apiKeyEnv: "REVIEW_KEY",
    } });
  });

  it("accepts complete Red configuration from flags with precedence over env", () => {
    const options = parseRunOptions({
      ...repository,
      model: "gpt-repair",
      "red-model": "flag-review",
      "red-provider": "compatible",
      "red-base-url": "https://flag.example/v1",
      "red-api-key-env": "FLAG_RED_KEY",
    }, {
      VOUCH_RED_MODEL: "env-review",
      VOUCH_RED_PROVIDER: "anthropic",
      VOUCH_RED_BASE_URL: "https://env.example/v1",
      VOUCH_RED_API_KEY_ENV: "ENV_RED_KEY",
    });
    expect(options).toMatchObject({ reviewModel: {
      model: "flag-review", provider: "compatible",
      baseURL: "https://flag.example/v1", apiKeyEnv: "FLAG_RED_KEY",
    } });
  });

  it.each([
    ["flag provider", { "red-provider": "compatible" }, {}],
    ["flag base URL", { "red-base-url": "https://provider.example/v1" }, {}],
    ["flag key env", { "red-api-key-env": "RED_KEY" }, {}],
    ["env provider", {}, { VOUCH_RED_PROVIDER: "compatible" }],
    ["env base URL", {}, { VOUCH_RED_BASE_URL: "https://provider.example/v1" }],
    ["env key env", {}, { VOUCH_RED_API_KEY_ENV: "RED_KEY" }],
  ])("rejects orphaned Red %s configuration", (_label, redFlags, env) => {
    expect(() => parseRunOptions({ ...repository, model: "gpt-repair", ...redFlags }, env)).toThrow(
      "Red provider configuration requires --red-model or VOUCH_RED_MODEL",
    );
  });

  it("does not activate ambient live role configuration in scripted local mode", () => {
    const flags = { ...repository, mode: "scripted", patch: "change.patch" };
    const options = parseRunOptions(flags, {
      VOUCH_BLUE_MODEL: "ambient-blue", VOUCH_BLUE_PROVIDER: "invalid",
      VOUCH_RED_MODEL: "ambient-red", VOUCH_RED_PROVIDER: "invalid",
      VOUCH_RED_BASE_URL: "invalid", VOUCH_RED_API_KEY_ENV: "invalid",
    });
    expect(options).not.toHaveProperty("reviewModel", expect.anything());
    expect(options.model.model).toBe("scripted");
  });

  it.each(["red-model", "red-provider", "red-base-url", "red-api-key-env"])(
    "rejects --%s in scripted mode",
    (flag) => {
      const flags = { ...repository, mode: "scripted", patch: "change.patch", [flag]: "configured" };
      expect(() => parseRunOptions(flags)).toThrow("only supported in live");
    },
  );

  it("defaults a configured Red model to the compatible provider", () => {
    expect(parseRunOptions({ ...repository, model: "gpt-repair", "red-model": "glm-review" }, {})).toMatchObject({
      reviewModel: { model: "glm-review", provider: "compatible" },
    });
  });

  it("accepts an explicit compatible provider without guessing credentials", () => {
    expect(parseRunOptions({ ...repository, provider: "compatible", model: "custom", "api-key-env": "CUSTOM_KEY" })).toMatchObject({
      model: { provider: "compatible", model: "custom", apiKeyEnv: "CUSTOM_KEY" },
    });
    expect(() => parseRunOptions({ ...repository, model: "custom" })).toThrow("explicit provider");
  });

  it.each(["NaN", "-1", "1.5", "Infinity"])("rejects invalid seed %s", (seed) => {
    expect(() => parseRunOptions({ ...repository, seed })).toThrow("nonnegative integer");
  });

  it("rejects missing values, unsupported flags, and mixed mode flags", () => {
    expect(() => parseRunOptions({ ...repository, model: true })).toThrow("requires a value");
    expect(() => parseRunOptions({ ...repository, typo: "value" })).toThrow("unknown flag");
    expect(() => parseRunOptions({ ...repository, condition: "C" })).toThrow("only supported with --task");
  });
});
