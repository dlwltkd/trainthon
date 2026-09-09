import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceEvaluation } from "@vouch/protocol";
import { evaluationCases } from "../../cli/src/evaluation-cohort.js";
import { createApp } from "./index.js";
import { listSourceEvaluations, readEvaluationArtifact, readSourceEvaluation } from "./evaluations.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vouch-evaluation-api-")); roots.push(root);
  const id = "cvefixes-100-1234abcd", dir = join(root, "evaluations", id);
  mkdirSync(dir, { recursive: true });
  const manifest = { suite: "cvefixes-source-pilot-v1", grader: "python-ast-reference-v1", runtimeTests: false,
    model: "test-only", codeCommit: "a".repeat(40), codexVersion: "test", conditions: { codex: "test", vouch: "test" }, limitations: [], cases: evaluationCases() } as unknown as SourceEvaluation["manifest"];
  const record: SourceEvaluation = { schemaVersion: 1, id, status: "running", createdAt: 100, manifest,
    manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    trials: manifest.cases.flatMap(task => (["codex", "vouch"] as const).map(arm => ({ caseId: task.id, arm, status: "pending" }))) };
  const save = () => writeFileSync(join(dir, "evaluation.json"), JSON.stringify(record)); save();
  return { root, dir, id, record, save };
}

describe("source evaluation evidence API", () => {
  it("serves intact registered records through the existing local-only API boundary", async () => {
    const { root, id } = fixture();
    const app = createApp({ runsDir: root, repoRoot: root, port: 8787 });
    const records = await (await app.request("http://127.0.0.1:8787/api/evaluations")).json() as SourceEvaluation[];
    expect(records.map(value => value.id)).toEqual([id]);
    expect((await app.request(`http://127.0.0.1:8787/api/evaluations/${id}`, { headers: { Origin: "https://external.example" } })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:8787/api/evaluations/unknown")).status).toBe(404);
  });

  it("rejects modified manifests and duplicate trials instead of displaying their claimed score", () => {
    const { root, id, record, save } = fixture();
    record.trials[0] = { ...record.trials[1]! }; save();
    expect(readSourceEvaluation(root, id)).toBeNull();
    record.trials[0]!.arm = "codex";
    record.manifest.model = "different-model"; save();
    expect(listSourceEvaluations(root)).toEqual([]);
  });

  it("limits artifacts to registered trials and rejects traversal and symlinks", () => {
    const { root, dir, id } = fixture();
    const trialDir = join(dir, "sample-1-codex"); mkdirSync(trialDir);
    writeFileSync(join(trialDir, "answer.json"), "{}\n");
    writeFileSync(join(root, "private.txt"), "private");
    symlinkSync(join(root, "private.txt"), join(trialDir, "candidate.py"));
    expect(readEvaluationArtifact(root, id, "sample-1", "codex", "answer.json")).toBe("{}\n");
    expect(readEvaluationArtifact(root, id, "sample-1", "codex", "candidate.py")).toBeNull();
    expect(readEvaluationArtifact(root, id, "../..", "codex", "private.txt")).toBeNull();
    expect(readSourceEvaluation(root, "../private.txt")).toBeNull();
    symlinkSync(dir, join(root, "evaluations", "cvefixes-999-1234abcd"));
    expect(listSourceEvaluations(root)).toHaveLength(1);
  });
});
