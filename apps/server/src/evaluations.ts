import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SourceEvaluation } from "@vouch/protocol";
import { readBoundedText, resolveInside } from "./registry.js";

export const EVALUATION_ID = /^(?:cvefixes|dev20)-\d+-[a-f0-9]{8}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export function readSourceEvaluation(runsDir: string, id: string): SourceEvaluation | null {
  if (!EVALUATION_ID.test(id)) return null;
  try {
    const text = readBoundedText(runsDir, `evaluations/${id}/evaluation.json`, 1_000_000);
    if (!text) return null;
    const value = JSON.parse(text) as SourceEvaluation;
    if (value.schemaVersion !== 1 || value.id !== id || !["running", "completed", "cancelled"].includes(value.status)
      || !Number.isFinite(value.createdAt) || !hashPattern.test(value.manifestHash)) return null;
    const manifest = value.manifest;
    const development = manifest?.suite === "defensive-development20-v1";
    const count = development ? 20 : 4;
    if (development !== id.startsWith("dev20-") || development && !hashPattern.test(manifest.cohortSha256 ?? "")) return null;
    if (!["cvefixes-source-pilot-v1", "cvefixes-source-pilot-v2", "cvefixes-source-pilot-v3", "defensive-development20-v1"].includes(manifest?.suite) || manifest.grader !== "python-ast-reference-v1" || manifest.runtimeTests !== false
      || typeof manifest.model !== "string" || typeof manifest.codeCommit !== "string" || typeof manifest.codexVersion !== "string"
      || typeof manifest.conditions?.codex !== "string" || typeof manifest.conditions.vouch !== "string"
      || !Array.isArray(manifest.limitations) || manifest.limitations.some(item => typeof item !== "string")
      || !Array.isArray(manifest.cases) || manifest.cases.length !== count || !Array.isArray(value.trials) || value.trials.length !== count * 2) return null;
    if (createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== value.manifestHash) return null;
    const ids = new Set<string>();
    for (const task of manifest.cases) {
      if (!(development ? /^case-(?:0[1-9]|1[0-9]|20)$/ : /^sample-[1-4]$/).test(task.id) || ids.has(task.id) || !["before", "fixed"].includes(task.variant)
        || !/^CWE-\d+$/.test(task.cwe) || typeof task.prompt !== "string"
        || !hashPattern.test(task.sourceSha256) || !hashPattern.test(task.referenceSha256)) return null;
      if (development) {
        if (typeof task.title !== "string" || !task.title.trim() || task.cve !== undefined || task.sourcePath !== "policy.py"
          || task.sourceUrl !== `fixture://defensive-development20-v1/${task.id}/policy.py`
          || task.referenceUrl !== `fixture://defensive-development20-v1/${task.id}/reference.py`) return null;
      } else if (!/^CVE-\d{4}-\d+$/.test(task.cve ?? "") || task.sourcePath !== undefined && task.sourcePath !== "bottle.py"
        || !/^https:\/\/raw\.githubusercontent\.com\/bottlepy\/bottle\/[a-f0-9]{40}\/bottle\.py$/.test(task.sourceUrl)
        || !/^https:\/\/raw\.githubusercontent\.com\/bottlepy\/bottle\/[a-f0-9]{40}\/bottle\.py$/.test(task.referenceUrl)) return null;
      ids.add(task.id);
    }
    const seen = new Set<string>();
    for (const trial of value.trials) {
      const key = `${trial.caseId}:${trial.arm}`;
      if (!ids.has(trial.caseId) || !["codex", "vouch"].includes(trial.arm) || seen.has(key)
        || !["pending", "running", "completed", "error", "cancelled"].includes(trial.status)
        || (trial.verdict !== undefined && !["issue_present", "issue_absent", "uncertain"].includes(trial.verdict))
        || [trial.elapsedMs, trial.startedAt].some(item => item !== undefined && (!Number.isFinite(item) || item < 0))
        || [trial.error, trial.summary, trial.runId].some(item => item !== undefined && typeof item !== "string")
        || [trial.evidenceValid, trial.referenceMatch, trial.syntaxValid, trial.unchanged].some(item => item !== undefined && typeof item !== "boolean")) return null;
      seen.add(key);
    }
    return value;
  } catch { return null; }
}

export function listSourceEvaluations(runsDir: string): SourceEvaluation[] {
  const root = resolveInside(runsDir, "evaluations");
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && EVALUATION_ID.test(entry.name))
    .flatMap(entry => { const value = readSourceEvaluation(runsDir, entry.name); return value ? [value] : []; })
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
}

export function readEvaluationArtifact(runsDir: string, id: string, caseId: string, arm: string, name: string): string | null {
  const evaluation = readSourceEvaluation(runsDir, id);
  if (!evaluation || !evaluation.manifest.cases.some(task => task.id === caseId) || !["codex", "vouch"].includes(arm)
    || !["answer.json", "candidate.py", "source.py", "events.jsonl", "invocation.json"].includes(name)) return null;
  return readBoundedText(runsDir, join("evaluations", id, `${caseId}-${arm}`, name), 1_000_000);
}
