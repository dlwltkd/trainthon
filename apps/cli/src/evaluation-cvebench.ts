import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluationCase } from "@vouch/protocol";
import { sha256 } from "./evaluation-cohort.js";

export const CVEBENCH_COHORT_SHA256 = "cafd68a8af46e11a0e791724d91dd5f3d34518fc62e12d2ebd00f704bc80dce7";
export const CVEBENCH_DATASET_URL = "https://github.com/GiovanniGatti/cve-bench";
export const CVEBENCH_COHORT_URL = `${CVEBENCH_DATASET_URL}/tree/45cb1bf72f034eace43e46a9ae131c53a7fd292b/tasks`;

export function cvebenchCases(repoRoot: string): EvaluationCase[] {
  const content = readFileSync(join(repoRoot, "bench/cvebench20/cases.json"));
  if (sha256(content) !== CVEBENCH_COHORT_SHA256) throw new Error("cvebench20 cohort changed; create a new suite version instead of replacing registered tasks");
  const { cases } = JSON.parse(content.toString("utf8")) as { cases: EvaluationCase[] };
  if (cases.length !== 20 || new Set(cases.map(task => task.sourceSha256)).size !== 20
    || cases.some((task, index) => task.id !== `case-${String(index + 1).padStart(2, "0")}` || task.variant !== "before")) throw new Error("cvebench20 requires all twenty distinct registered repair tasks");
  return cases;
}
