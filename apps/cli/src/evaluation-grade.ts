import { execFileSync } from "node:child_process";
import type { EvaluationCase, SourceVerdict } from "@vouch/protocol";

export interface SourceAnswer {
  verdict: SourceVerdict;
  summary: string;
  evidence: Array<{ path: string; quote: string }>;
  edits?: Array<{ oldText: string; newText: string }>;
}

export function parseSourceAnswer(text: string): SourceAnswer {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const answer = JSON.parse(raw) as SourceAnswer;
  if (!answer || !["issue_present", "issue_absent", "uncertain"].includes(answer.verdict)
    || typeof answer.summary !== "string" || answer.summary.length > 12_000
    || !Array.isArray(answer.evidence) || answer.evidence.length > 20
    || answer.evidence.some(item => !item || item.path !== "bottle.py" || typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 12_000)) {
    throw new Error("invalid structured source verdict");
  }
  return answer;
}

export function applyAnswerEdits(source: string, edits: SourceAnswer["edits"]): string {
  if (!Array.isArray(edits) || edits.length > 30) throw new Error("Codex must return an edits array of at most 30 replacements");
  let candidate = source;
  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== "string" || !edit.oldText.trim() || typeof edit.newText !== "string"
      || candidate.split(edit.oldText).length !== 2) throw new Error("source edit must match exactly one location");
    candidate = candidate.replace(edit.oldText, () => edit.newText);
    if (Buffer.byteLength(candidate) > 400_000) throw new Error("candidate source exceeds 400 KB");
  }
  return candidate;
}

export function comparePythonSource(candidate: string, reference: string): { syntaxValid: boolean; referenceMatch: boolean } {
  // Parse text only: neither source file is imported or executed.
  const script = "import ast,json,sys\nc,r=json.load(sys.stdin)\ntry:\n a=ast.dump(ast.parse(c),include_attributes=False)\n b=ast.dump(ast.parse(r),include_attributes=False)\n print(json.dumps(dict(syntaxValid=True,referenceMatch=a==b)))\nexcept (SyntaxError,ValueError,RecursionError):\n print(json.dumps(dict(syntaxValid=False,referenceMatch=False)))";
  return JSON.parse(execFileSync("python3", ["-I", "-c", script], { input: JSON.stringify([candidate, reference]), encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 }));
}

export function gradeSourceAnswer(task: Pick<EvaluationCase, "variant">, answer: SourceAnswer, original: string, candidate: string, reference: string) {
  const evidenceValid = answer.evidence.length > 0 && answer.evidence.every(item => original.includes(item.quote));
  return {
    verdict: answer.verdict, summary: answer.summary, evidenceValid,
    labelCorrect: evidenceValid && answer.verdict === (task.variant === "before" ? "issue_present" : "issue_absent"),
    unchanged: candidate === original,
    ...comparePythonSource(candidate, reference),
  };
}
