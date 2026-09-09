import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEVELOPMENT_COHORT_SHA256, developmentCases, prepareDevelopmentSources } from "./evaluation-development.js";
import { sha256 } from "./evaluation-cohort.js";
import { comparePythonSource, gradeSourceAnswer, parseSourceAnswer } from "./evaluation-grade.js";

const roots: string[] = [];
const root = resolve(import.meta.dirname, "../../..");
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("fixed defensive development cohort", () => {
  it("pins twenty distinct tasks, keeps reference answers out of prompts, and retains controls", () => {
    const cases = developmentCases(root);
    expect(cases).toHaveLength(20);
    expect(new Set(cases.map(task => task.sourceSha256)).size).toBe(20);
    expect(new Set(cases.map(task => task.prompt)).size).toBe(20);
    expect(cases.filter(task => task.variant === "before")).toHaveLength(12);
    expect(cases.filter(task => task.variant === "fixed")).toHaveLength(8);
    expect(sha256(readFileSync(join(root, "bench/development20/cases.json")))).toBe(DEVELOPMENT_COHORT_SHA256);
    for (const task of cases) {
      expect(task.prompt).not.toContain(task.id);
      expect(task.prompt).not.toContain(task.referenceSha256);
      expect(task.prompt).not.toContain(task.referenceUrl);
      expect(task.prompt).not.toContain(task.title);
    }
  });

  it("grades all registered corrections and unchanged controls through the same passive grader", () => {
    const cache = mkdtempSync(join(tmpdir(), "vouch-dev20-grade-")); roots.push(cache);
    prepareDevelopmentSources(root, cache);
    for (const task of developmentCases(root)) {
      const original = readFileSync(join(cache, `${task.sourceSha256}.py`), "utf8");
      const reference = readFileSync(join(cache, `${task.referenceSha256}.py`), "utf8");
      const answer = parseSourceAnswer(JSON.stringify({ verdict: task.variant === "before" ? "issue_present" : "issue_absent", summary: "Test fixture", evidence: [{ path: "policy.py", quote: original.split("\n")[0] }] }), "policy.py");
      expect(gradeSourceAnswer(task, answer, original, reference, reference)).toMatchObject({ labelCorrect: true, referenceMatch: true, syntaxValid: true, unchanged: task.variant === "fixed" });
      expect(comparePythonSource(original, reference)).toMatchObject({ syntaxValid: true, referenceMatch: task.variant === "fixed" });
      expect(() => parseSourceAnswer(JSON.stringify(answer))).toThrow("invalid structured source verdict");
    }
  });

  it("refuses edited problems instead of silently updating the cohort hash", () => {
    const changed = mkdtempSync(join(tmpdir(), "vouch-dev20-tamper-")); roots.push(changed);
    mkdirSync(join(changed, "bench/development20"), { recursive: true });
    writeFileSync(join(changed, "bench/development20/cases.json"), readFileSync(join(root, "bench/development20/cases.json"), "utf8") + " ");
    expect(() => developmentCases(changed)).toThrow("create a new suite version");
  });
});
