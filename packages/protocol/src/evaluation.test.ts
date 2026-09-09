import { describe, expect, it } from "vitest";
import { summarizeSourceEvaluation, type SourceEvaluation } from "./evaluation.js";

function fixture(): SourceEvaluation {
  const cases = ["before", "fixed", "before", "fixed"].map((variant, index) => ({ id: String(index), variant }));
  return {
    status: "completed", manifest: { cases },
    trials: cases.flatMap(task => (["codex", "vouch"] as const).map(arm => ({
      caseId: task.id, arm, status: "completed", evidenceValid: true,
      verdict: task.variant === "before" ? "issue_present" : "issue_absent", referenceMatch: true, syntaxValid: true, unchanged: task.variant === "fixed",
    }))),
  } as SourceEvaluation;
}

describe("paired source evaluation metrics", () => {
  it("computes percentage points and relative change separately from actual trial verdicts", () => {
    const evaluation = fixture();
    evaluation.trials[0]!.verdict = "uncertain";
    const result = summarizeSourceEvaluation(evaluation);
    expect(result.complete).toBe(true);
    expect(result.differencePp).toBe(25);
    expect(result.relativeChangePercent).toBeCloseTo(33.3333);
    expect(result.arms[0]).toMatchObject({ total: 4, correct: 3, referenceMatches: 1, controlsUnchanged: 2 });
  });

  it("retains failed trials in the denominator and ignores supplied score flags", () => {
    const evaluation = fixture();
    evaluation.trials[1]!.status = "error";
    evaluation.trials[1]!.labelCorrect = true;
    expect(summarizeSourceEvaluation(evaluation)).toMatchObject({ complete: true, differencePp: -25 });
    expect(summarizeSourceEvaluation(evaluation).arms[1]).toMatchObject({ errors: 1, correct: 3, accuracy: 0.75 });
  });

  it("does not publish an uplift for incomplete, duplicate, empty, or cancelled experiments", () => {
    for (const mutate of [
      (run: SourceEvaluation) => { run.trials.pop(); },
      (run: SourceEvaluation) => { run.trials[0]!.status = "pending"; },
      (run: SourceEvaluation) => { run.trials[0] = { ...run.trials[1]! }; },
      (run: SourceEvaluation) => { run.status = "cancelled"; },
      (run: SourceEvaluation) => { run.manifest.cases = []; run.trials = []; },
    ]) {
      const evaluation = fixture(); mutate(evaluation);
      expect(summarizeSourceEvaluation(evaluation)).toMatchObject({ complete: false, differencePp: null, relativeChangePercent: null });
    }
  });

  it("does not divide by zero or count citations that failed source validation", () => {
    const evaluation = fixture();
    for (const trial of evaluation.trials) if (trial.arm === "codex") trial.evidenceValid = false;
    expect(summarizeSourceEvaluation(evaluation)).toMatchObject({ differencePp: 100, relativeChangePercent: null });
  });
});
