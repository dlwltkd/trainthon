import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnswerEdits, comparePythonSource, gradeSourceAnswer, parseSourceAnswer } from "./evaluation-grade.js";
import { evaluationCases, prepareEvaluationSources } from "./evaluation-cohort.js";

describe("source-only evaluation grading", () => {
  it("compares syntax trees without running either input", () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-static-grade-"));
    const marker = join(dir, "marker");
    writeFileSync(marker, "unchanged");
    const source = `open(${JSON.stringify(marker)}, 'w').write('executed')\n`;
    try {
      expect(comparePythonSource(source, source)).toEqual({ syntaxValid: true, referenceMatch: true });
      expect(readFileSync(marker, "utf8")).toBe("unchanged");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores formatting, rejects syntax errors, and does not award semantic equivalence", () => {
    expect(comparePythonSource("answer = 42 # value\n", "answer=42\n").referenceMatch).toBe(true);
    expect(comparePythonSource("answer=40+2\n", "answer=42\n")).toEqual({ syntaxValid: true, referenceMatch: false });
    expect(comparePythonSource("answer = (", "answer=42\n").syntaxValid).toBe(false);
  });

  it("requires source-backed evidence and counts fixed controls only for the scoped verdict", () => {
    const answer = parseSourceAnswer('{"verdict":"issue_absent","summary":"checked","evidence":[{"path":"bottle.py","quote":"answer=42"}]}');
    expect(gradeSourceAnswer({ variant: "fixed" }, answer, "answer=42\n", "answer=42\n", "answer=42\n")).toMatchObject({ evidenceValid: true, labelCorrect: true, unchanged: true });
    expect(gradeSourceAnswer({ variant: "before" }, answer, "answer=41\n", "answer=42\n", "answer=42\n")).toMatchObject({ evidenceValid: false, labelCorrect: false, referenceMatch: true });
  });

  it("accepts only unique source replacements, preserving literal replacement characters", () => {
    expect(applyAnswerEdits("answer=41\n", [{ oldText: "41", newText: "$&42" }])).toBe("answer=$&42\n");
    expect(() => applyAnswerEdits("xx", [{ oldText: "x", newText: "y" }])).toThrow("exactly one");
    expect(() => applyAnswerEdits("x", [{ oldText: "missing", newText: "y" }])).toThrow("exactly one");
    expect(() => applyAnswerEdits("x", undefined)).toThrow("edits array");
    expect(() => parseSourceAnswer('{"verdict":"fixed_verified"}')).toThrow();
  });

  it("pins two complete before/fixed pairs with identical prompts and no labels in model input", () => {
    const cases = evaluationCases();
    expect(cases).toHaveLength(4);
    for (const index of [0, 2]) {
      expect(cases[index]!.prompt).toBe(cases[index + 1]!.prompt);
      expect(cases[index]!.referenceSha256).toBe(cases[index + 1]!.sourceSha256);
      expect(cases[index]!.prompt).not.toContain(cases[index]!.cve);
    }
  });

  it("rejects a source download that does not match its pinned content hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-source-integrity-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("untrusted different snapshot")));
    try { await expect(prepareEvaluationSources(dir)).rejects.toThrow("hash mismatch"); }
    finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
  });
});
