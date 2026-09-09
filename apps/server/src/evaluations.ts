import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SourceEvaluation } from "@vouch/protocol";
import { readBoundedText, resolveInside } from "./registry.js";

export const EVALUATION_ID = /^cvefixes-\d+-[a-f0-9]{8}$/;
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
    if (manifest?.suite !== "cvefixes-source-pilot-v1" || manifest.grader !== "python-ast-reference-v1" || manifest.runtimeTests !== false
      || typeof manifest.model !== "string" || typeof manifest.codeCommit !== "string" || typeof manifest.codexVersion !== "string"
      || typeof manifest.conditions?.codex !== "string" || typeof manifest.conditions.vouch !== "string"
      || !Array.isArray(manifest.limitations) || manifest.limitations.some(item => typeof item !== "string")
      || !Array.isArray(manifest.cases) || manifest.cases.length !== 4 || !Array.isArray(value.trials) || value.trials.length !== 8) return null;
    if (createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== value.manifestHash) return null;
    const ids = new Set<string>();
    for (const task of manifest.cases) {
      if (!/^sample-[1-4]$/.test(task.id) || ids.has(task.id) || !["before", "fixed"].includes(task.variant)
        || !/^CVE-\d{4}-\d+$/.test(task.cve) || !/^CWE-\d+$/.test(task.cwe) || typeof task.prompt !== "string"
        || !hashPattern.test(task.sourceSha256) || !hashPattern.test(task.referenceSha256)
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
    .map(entry => entry.name).sort().reverse().slice(0, 30)
    .flatMap(id => { const value = readSourceEvaluation(runsDir, id); return value ? [value] : []; });
}

export function readEvaluationArtifact(runsDir: string, id: string, caseId: string, arm: string, name: string): string | null {
  const evaluation = readSourceEvaluation(runsDir, id);
  if (!evaluation || !evaluation.manifest.cases.some(task => task.id === caseId) || !["codex", "vouch"].includes(arm)
    || !["answer.json", "candidate.py", "events.jsonl", "invocation.json"].includes(name)) return null;
  return readBoundedText(runsDir, join("evaluations", id, `${caseId}-${arm}`, name), 1_000_000);
}
