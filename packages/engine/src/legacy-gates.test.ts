import { describe, expect, it } from "vitest";
import type { RunConfig, Task } from "@vouch/protocol";
import type { TestOutcome } from "@vouch/sandbox";
import { configHash } from "./config.js";
import { isProtectedPath } from "./agent-tools.js";
import { classifyRegression } from "./repro-tools.js";
import { gatedStatus, selectRunner } from "./run.js";

function result(status: "passed" | "failed", message = "AssertionError: expected 3 to be 4"): TestOutcome {
  return {
    passed: status === "passed", timedOut: false, exitCode: status === "passed" ? 0 : 1,
    output: JSON.stringify({
      success: status === "passed", numTotalTests: 1, numPassedTests: status === "passed" ? 1 : 0,
      numFailedTests: status === "passed" ? 0 : 1, numPendingTests: 0, numTodoTests: 0,
      numRuntimeErrorTestSuites: 0, testResults: [{ assertionResults: [{ status, failureMessages: status === "failed" ? [message] : [] }] }],
    }),
  };
}

describe("legacy supplied-regression gate", () => {
  it("recognizes assertion failures and fully executed passes", () => {
    expect(classifyRegression(result("failed"))).toBe("assertion_failed");
    expect(classifyRegression(result("passed"))).toBe("passed");
  });

  it.each(["SyntaxError: invalid token", "Error: Cannot find module", "TypeError: invalid value"])("rejects %s as proof", (message) => {
    expect(classifyRegression(result("failed", message))).toBe("error");
  });

  it("rejects empty, skipped, malformed, and truncated reports", () => {
    for (const report of [
      {}, { success: true, numTotalTests: 0 },
      { numTotalTests: 1, numPendingTests: 1, testResults: [{ assertionResults: [{ status: "pending" }] }] },
    ]) expect(classifyRegression({ ...result("passed"), output: JSON.stringify(report) })).toBe("invalid");
    expect(classifyRegression({ ...result("failed"), output: "AssertionError: incomplete output" })).toBe("error");
  });

  it("keeps cancellation and timeouts separate from failures", () => {
    expect(classifyRegression({ ...result("failed"), timedOut: true })).toBe("timeout");
    expect(classifyRegression({ ...result("failed"), cancelled: true })).toBe("cancelled");
  });

  it("does not allow a successful grade to override failed verification", () => {
    expect(gatedStatus("FIXED_VERIFIED", false, true)).toBe("FAILED_NO_FIX");
    expect(gatedStatus("FIXED_VERIFIED", true, false)).toBe("BROKE_FUNCTION");
    expect(gatedStatus("FIXED_VERIFIED", true, true)).toBe("FIXED_VERIFIED");
  });
});

describe("source-only legacy repair", () => {
  it.each(["src/function.test.ts", "tests/custom.ts", "package.json", "pnpm-lock.yaml", "vitest.config.ts", ".git/config", "vouch.repro.test.ts"])("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });
  it("protects supplied paths and allows application source", () => {
    expect(isProtectedPath("checks/custom.ts", ["checks/custom.ts"])).toBe(true);
    expect(isProtectedPath("src/math.ts")).toBe(false);
  });
});

const config: RunConfig = { model: "configured-model", condition: "C", seed: 1, graderVersion: "0", budgets: { maxTokens: 100, maxSteps: 3, maxWallMs: 1000 } };

describe("explicit legacy execution", () => {
  it("does not fall back to scripted execution in default or live mode", () => {
    const task = { id: "fixture" } as Task;
    expect(() => selectRunner("red", task, "/missing", config)).toThrow("explicit scripted mode");
    expect(() => selectRunner("blue", task, "/missing", { ...config, mode: "live" })).toThrow("explicit scripted mode");
    expect(() => selectRunner("blue", task, "/missing", { ...config, mode: "scripted" })).toThrow("no supplied scripted");
  });
  it("includes execution mode in the configuration hash", () => {
    expect(configHash(config, "task")).toBe(configHash({ ...config, mode: "live" }, "task"));
    expect(configHash(config, "task")).not.toBe(configHash({ ...config, mode: "scripted" }, "task"));
  });
});
