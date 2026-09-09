import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationCase } from "@vouch/protocol";
import { sha256 } from "./evaluation-cohort.js";

export const DEVELOPMENT_COHORT_SHA256 = "bae6cc9c56e533f9cccdc5ea81608b5555f0daf0bbb26d3c6022fde4169fd8b7";
export const DEVELOPMENT_COHORT_URL = "fixture://defensive-development20-v1/cases.json";

interface DevelopmentFixture {
  id: string;
  title: string;
  cwe: string;
  variant: "before" | "fixed";
  contract: string;
  source: string;
  reference: string;
}

function readFixtures(repoRoot: string): DevelopmentFixture[] {
  const content = readFileSync(join(repoRoot, "bench/development20/cases.json"));
  if (sha256(content) !== DEVELOPMENT_COHORT_SHA256) throw new Error("development20 cohort changed; create a new suite version instead of changing the fixed problems");
  const { cases } = JSON.parse(content.toString("utf8")) as { cases: DevelopmentFixture[] };
  if (cases.length !== 20 || new Set(cases.map(task => task.source)).size !== 20
    || cases.some((task, index) => task.id !== `case-${String(index + 1).padStart(2, "0")}`)) throw new Error("development20 requires twenty distinct ordered source tasks");
  return cases;
}

export function developmentCases(repoRoot: string): EvaluationCase[] {
  return readFixtures(repoRoot).map(task => ({
    id: task.id, title: task.title, cwe: task.cwe, variant: task.variant, sourcePath: "policy.py",
    sourceUrl: `fixture://defensive-development20-v1/${task.id}/policy.py`, sourceSha256: sha256(task.source),
    referenceUrl: `fixture://defensive-development20-v1/${task.id}/reference.py`, referenceSha256: sha256(task.reference),
    prompt: `Perform a passive defensive source review of policy.py against the following application contract. The implementation may already satisfy it. Review only this contract and propose a minimal source repair if needed; preserve unrelated behavior and public interfaces.\nContract: ${task.contract}\nDo not run source code, construct attack inputs, use network tools, or look up reference patches. If the contract is already satisfied, leave the source unchanged.\nFinish with ONLY a JSON object: {"verdict":"issue_present"|"issue_absent"|"uncertain","summary":"brief source-based explanation","evidence":[{"path":"policy.py","quote":"an exact nonempty excerpt of the ORIGINAL source supporting the verdict"}]}.`,
  }));
}

export function prepareDevelopmentSources(repoRoot: string, cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  for (const task of readFixtures(repoRoot)) for (const source of [task.source, task.reference]) {
    const path = join(cacheDir, `${sha256(source)}.py`);
    writeFileSync(`${path}.tmp`, source, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}
