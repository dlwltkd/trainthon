import { describe, expect, it } from "vitest";
import { parseRunOptions } from "./run-options.js";

const repository = { repo: "/tmp/project", report: "/tmp/report.md", regression: "src/check.test.ts" };

describe("run CLI options", () => {
  it("defaults existing repository runs to live and HEAD", () => {
    const options = parseRunOptions(repository, {});
    expect(options).toMatchObject({ kind: "repository", mode: "live", ref: "HEAD", seed: 1 });
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
    expect(parseRunOptions({ task: "fixture", condition: "C", mode: "scripted" })).toMatchObject({ kind: "task", mode: "scripted" });
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

  it("does not activate an ambient review model in scripted local mode", () => {
    const flags = { ...repository, mode: "scripted", patch: "change.patch" };
    const options = parseRunOptions(flags, { VOUCH_RED_MODEL: "review", VOUCH_RED_PROVIDER: "invalid" });
    expect(options).not.toHaveProperty("reviewModel", expect.anything());
    expect(() => parseRunOptions({ ...flags, "red-model": "review" })).toThrow("only supported in live");
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
