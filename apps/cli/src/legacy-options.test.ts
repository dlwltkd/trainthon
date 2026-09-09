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

  it("defaults live repository runs to the pinned Blue model", () => {
    expect(parseRunOptions(repository, {})).toMatchObject({
      model: { model: "gpt-5.6-sol", provider: "openai" },
    });
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

  it("requires a prompt or regression and keeps supplied reports optional", () => {
    expect(() => parseRunOptions({ repo: "/tmp/project" })).toThrow("--prompt");
    expect(() => parseRunOptions({ repo: "/tmp/project", report: "/tmp/report.md" })).toThrow("--prompt");
    expect(parseRunOptions({ repo: "/tmp/project", regression: "tests/security.test.ts" }, {}))
      .toMatchObject({ kind: "repository", regressionPath: "tests/security.test.ts", reportPath: undefined });
    expect(() => parseRunOptions({ ...repository, report: true })).toThrow("--report requires a value");
    expect(() => parseRunOptions({ ...repository, report: "" })).toThrow("non-empty file path");
  });

  it("configures Red discovery and Blue validation for prompt-based review", () => {
    const options = parseRunOptions({ repo: "../project", prompt: "Review session expiration checks.", ref: "release" }, {
      VOUCH_RED_MODEL: "glm-review", VOUCH_RED_PROVIDER: "compatible",
    });
    expect(options).toMatchObject({
      kind: "repository", repoPath: "../project", prompt: "Review session expiration checks.",
      mode: "live", ref: "release", seed: 1, model: { model: "gpt-5.6-sol", provider: "openai" },
      reviewModel: { model: "glm-review", provider: "compatible" },
    });
    expect(options).not.toHaveProperty("regressionPath");
    expect(() => parseRunOptions({ repo: "/tmp/project", prompt: "  " })).toThrow("non-empty review instructions");
    expect(() => parseRunOptions({ ...repository, regression: " " })).toThrow("repository-relative path");
  });

  it.each(["https://github.com/example/project", "https://github.com/example/project.git/"])(
    "preserves repository URL %s for engine acquisition",
    (repo) => {
      expect(parseRunOptions({ repo, prompt: "Review the authentication code." }, {})).toMatchObject({ repoPath: repo });
      expect(parseRunOptions({ repo, regression: "tests/test_security.py" }, {})).toMatchObject({ repoPath: repo });
    },
  );

  it("rejects unused repair flags and scripted mode for prompt-based review", () => {
    const flags = { repo: "/tmp/project", prompt: "Review input validation." };
    expect(() => parseRunOptions({ ...flags, mode: "scripted" })).toThrow("requires --mode live");
    expect(() => parseRunOptions({ ...flags, patch: "unused" })).toThrow("only supported with --regression");
    expect(parseRunOptions({ ...flags, "red-model": "custom-review", "red-provider": "compatible", "red-base-url": "https://provider.example/v1", "red-api-key-env": "REVIEW_KEY" }, {})).toMatchObject({
      reviewModel: { model: "custom-review", provider: "compatible", baseURL: "https://provider.example/v1", apiKeyEnv: "REVIEW_KEY" },
    });
    expect(() => parseRunOptions({ task: "fixture", mode: "scripted", condition: "C", prompt: "Review" }))
      .toThrow("--prompt is only supported with --repo");
  });

  it("opts into untested source remediation only with a boolean --fix flag", () => {
    const flags = { repo: "https://github.com/example/project", prompt: "Correct justified authorization defects." };
    expect(parseRunOptions(flags, {})).toMatchObject({ remediate: false });
    expect(parseRunOptions({ ...flags, fix: true }, {})).toMatchObject({ remediate: true, mode: "live" });
    expect(parseRunOptions({ ...flags, fix: false }, {})).toMatchObject({ remediate: false });
    for (const fix of ["true", "false", "yes"]) {
      expect(() => parseRunOptions({ ...flags, fix })).toThrow("boolean flag");
    }
    expect(() => parseRunOptions({ ...repository, fix: true })).toThrow("cannot be combined with --regression");
    expect(() => parseRunOptions({ repo: flags.repo, fix: true })).toThrow("--prompt");
    expect(() => parseRunOptions({ ...flags, fix: true, mode: "scripted" })).toThrow("requires --mode live");
    expect(() => parseRunOptions({ task: "fixture", condition: "C", mode: "scripted", fix: true }))
      .toThrow("--fix is only supported with --repo");
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

  it("defaults both roles to the same OpenAI model", () => {
    expect(parseRunOptions(repository, {})).toMatchObject({
      model: { model: "gpt-5.6-sol", provider: "openai" },
      reviewModel: {
        model: "gpt-5.6-sol",
        provider: "openai",
      },
    });
  });

  it("keeps the default reviewer on Blue's exact provider configuration", () => {
    const options = parseRunOptions({
      ...repository, model: "custom-model", provider: "compatible",
      "base-url": "https://provider.example/v1", "api-key-env": "CUSTOM_KEY",
    }, {});
    expect(options.kind).toBe("repository");
    if (options.kind !== "repository") throw new Error("expected repository options");
    expect(options.reviewModel).toEqual(options.model);
    expect(options.reviewModel).not.toBe(options.model);
  });

  it("infers an explicitly selected OpenAI reviewer without inheriting another gateway", () => {
    const options = parseRunOptions({
      ...repository, model: "custom-model", provider: "compatible",
      "base-url": "https://provider.example/v1", "api-key-env": "CUSTOM_KEY",
      "red-model": "gpt-5.6-sol",
    }, {});
    expect(options).toMatchObject({ reviewModel: {
      model: "gpt-5.6-sol", provider: "openai", baseURL: undefined, apiKeyEnv: undefined,
    } });
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

  it("defaults an overridden Red model to the compatible provider", () => {
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
