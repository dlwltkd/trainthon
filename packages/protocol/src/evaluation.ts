export type EvaluationArm = "codex" | "vouch";
export type SourceVerdict = "issue_present" | "issue_absent" | "uncertain";

export interface EvaluationCase {
  id: string;
  cve?: string;
  title?: string;
  sourcePath?: string;
  cwe: string;
  variant: "before" | "fixed";
  sourceUrl: string;
  sourceSha256: string;
  referenceUrl: string;
  referenceSha256: string;
  prompt: string;
}

export interface EvaluationTrial {
  caseId: string;
  arm: EvaluationArm;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  startedAt?: number;
  elapsedMs?: number;
  runId?: string;
  verdict?: SourceVerdict;
  evidenceValid?: boolean;
  labelCorrect?: boolean;
  referenceMatch?: boolean;
  syntaxValid?: boolean;
  unchanged?: boolean;
  summary?: string;
  error?: string;
  answerSha256?: string;
  candidateSha256?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SourceEvaluation {
  schemaVersion: 1;
  id: string;
  status: "running" | "completed" | "cancelled";
  createdAt: number;
  endedAt?: number;
  manifestHash: string;
  manifest: {
    suite: "cvefixes-source-pilot-v1" | "cvefixes-source-pilot-v2" | "cvefixes-source-pilot-v3" | "defensive-development20-v1" | "cvebench-source20-v1";
    cohortSha256?: string;
    maxConcurrentPairs?: number;
    datasetUrl: string;
    cohortUrl: string;
    selection: string;
    model: string;
    codeCommit: string;
    codexVersion: string;
    maxWallMs: number;
    cumulativeTokenLimit: null;
    vouchMaxSteps: number | null;
    seed: number;
    grader: "python-ast-reference-v1";
    runtimeTests: false;
    conditions: Record<EvaluationArm, string>;
    limitations: string[];
    cases: EvaluationCase[];
  };
  trials: EvaluationTrial[];
}

export function summarizeSourceEvaluation(evaluation: SourceEvaluation) {
  const cases = evaluation.manifest.cases;
  const vulnerableCases = cases.filter(task => task.variant === "before").length;
  const arms = (["codex", "vouch"] as const).map(arm => {
    let completed = 0, errors = 0, correct = 0, referenceMatches = 0, controlsUnchanged = 0;
    for (const task of cases) {
      const matches = evaluation.trials.filter(trial => trial.arm === arm && trial.caseId === task.id);
      const trial = matches.length === 1 ? matches[0] : undefined;
      if (trial?.status === "completed") {
        completed++;
        const labelCorrect = trial.evidenceValid === true && trial.verdict === (task.variant === "before" ? "issue_present" : "issue_absent");
        if (labelCorrect) correct++;
        if (task.variant === "before" && labelCorrect && trial.referenceMatch === true && trial.syntaxValid === true) referenceMatches++;
        if (task.variant === "fixed" && labelCorrect && trial.unchanged === true) controlsUnchanged++;
      } else if (trial?.status === "error" || trial?.status === "cancelled") errors++;
    }
    return { arm, total: cases.length, completed, errors, correct, referenceMatches, controlsUnchanged,
      accuracy: cases.length ? correct / cases.length : null,
      referenceAccuracy: vulnerableCases ? referenceMatches / vulnerableCases : null,
      elapsedMs: evaluation.trials.filter(trial => trial.arm === arm).reduce((sum, trial) => sum + (trial.elapsedMs ?? 0), 0) };
  });
  const baseline = arms[0]!, harness = arms[1]!;
  const complete = cases.length > 0 && new Set(cases.map(task => task.id)).size === cases.length
    && evaluation.status === "completed" && evaluation.trials.length === cases.length * 2
    && arms.every(arm => arm.completed + arm.errors === cases.length);
  const differencePp = complete ? ((harness.accuracy ?? 0) - (baseline.accuracy ?? 0)) * 100 : null;
  const referenceDifferencePp = complete && vulnerableCases ? ((harness.referenceAccuracy ?? 0) - (baseline.referenceAccuracy ?? 0)) * 100 : null;
  return { arms, complete, differencePp, referenceDifferencePp,
    relativeReferenceChangePercent: referenceDifferencePp !== null && baseline.referenceAccuracy ? referenceDifferencePp / baseline.referenceAccuracy : null,
    relativeChangePercent: differencePp !== null && baseline.accuracy ? differencePp / baseline.accuracy : null,
    vulnerableCases,
    controlCases: cases.filter(task => task.variant === "fixed").length };
}
