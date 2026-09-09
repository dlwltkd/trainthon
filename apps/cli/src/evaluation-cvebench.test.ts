import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CVEBENCH_COHORT_SHA256, cvebenchCases } from "./evaluation-cvebench.js";
import { prepareEvaluationSources, sha256 } from "./evaluation-cohort.js";

const root = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("CVE-Bench source cohort", () => {
  it("registers every published task with immutable complete-module inputs and no reference contents in prompts", () => {
    const cases = cvebenchCases(root);
    expect(cases).toHaveLength(20);
    expect(new Set(cases.map(task => task.sourceSha256)).size).toBe(20);
    expect(sha256(readFileSync(join(root, "bench/cvebench20/cases.json")))).toBe(CVEBENCH_COHORT_SHA256);
    for (const task of cases) {
      expect(task.variant).toBe("before");
      expect(task.sourceSha256).not.toBe(task.referenceSha256);
      expect(task.sourceUrl.endsWith(`/${task.sourcePath}`)).toBe(true);
      expect(task.prompt).toContain(task.sourcePath!);
      expect(task.prompt).not.toContain(task.referenceSha256);
      expect(task.prompt).not.toContain(task.referenceUrl);
      expect(task.prompt).not.toMatch(/test_security\.py|run_tests\.sh|setup\.sh/);
    }
  });

  it("refuses changes to task selection or prompts after registration", () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-cvebench-tamper-")); roots.push(dir);
    mkdirSync(join(dir, "bench/cvebench20"), { recursive: true });
    const value = JSON.parse(readFileSync(join(root, "bench/cvebench20/cases.json"), "utf8"));
    value.cases.pop();
    writeFileSync(join(dir, "bench/cvebench20/cases.json"), JSON.stringify(value));
    expect(() => cvebenchCases(dir)).toThrow("create a new suite version");
  });

  it("prepares both source and withheld reference for an all-repair cohort and rejects hash mismatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-cvebench-download-")); roots.push(dir);
    const original = "def identity(value): return value\n", reference = "def identity(value):\n    return value\n";
    const task = { ...cvebenchCases(root)[0]!, sourceSha256: sha256(original), referenceSha256: sha256(reference) };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(original)).mockResolvedValueOnce(new Response(reference));
    vi.stubGlobal("fetch", fetch);
    await prepareEvaluationSources(dir, undefined, [task]);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([task.sourceUrl, task.referenceUrl]);
    expect(readFileSync(join(dir, `${task.referenceSha256}.py`), "utf8")).toBe(reference);
    fetch.mockResolvedValueOnce(new Response("unexpected contents"));
    await expect(prepareEvaluationSources(dir, undefined, [{ ...task, sourceSha256: "0".repeat(64) }])).rejects.toThrow("pinned source hash mismatch");
  });
});
