import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SourceEvaluation } from "@vouch/protocol";
import { SourceEvaluationCard } from "./SourceEvaluation";

function fixture(): SourceEvaluation {
  const cases = ["before", "fixed", "before", "fixed"].map((variant, i) => ({ id: `sample-${i + 1}`, cve: "CVE-2000-0000", cwe: "CWE-000", variant, sourceUrl: "https://example.com/source", sourceSha256: "a".repeat(64) }));
  return { id: "test-only", status: "completed", manifestHash: "b".repeat(64), manifest: { model: "gpt-5.6-sol", codeCommit: "c".repeat(40), codexVersion: "codex test", cases,
    conditions: { codex: "source-only", vouch: "Red review and Blue repair" }, limitations: ["Test fixture only"], maxWallMs: 480_000 },
    trials: cases.flatMap(task => (["codex", "vouch"] as const).map(arm => ({ caseId: task.id, arm, status: "completed", evidenceValid: true,
      verdict: task.variant === "before" ? "issue_present" : "issue_absent", unchanged: true, syntaxValid: true, referenceMatch: true }))),
  } as SourceEvaluation;
}

describe("measured source evaluation display", () => {
  it("uses reference agreement for the repair-only cohort instead of rewarding all-positive labels", () => {
    const run = fixture(); run.manifest.suite = "cvebench-source20-v1";
    run.trials[0]!.referenceMatch = false;
    const html = renderToStaticMarkup(<SourceEvaluationCard evaluation={run} />);
    expect(html).toContain("CVE-Bench · 20 source repair tasks");
    expect(html).toContain("Module AST reference agreement");
    expect(html).toContain("+50.0 pp");
    expect(html).toContain("No reference agreement");
    expect(html).toContain("separate from the original benchmark");
    expect(html).not.toContain("CVEfixes dataset and publication");
  });

  it("labels development tuning separately from the external CVEfixes pilot", () => {
    const run = fixture(); run.manifest.suite = "defensive-development20-v1";
    run.manifest.cases[0]!.title = "Tenant boundary";
    const html = renderToStaticMarkup(<SourceEvaluationCard evaluation={run} />);
    expect(html).toContain("Development 20 · fixed tuning set");
    expect(html).toContain("This is not held-out performance");
    expect(html).toContain("Tenant boundary");
    expect(html).not.toContain("CVEfixes dataset and publication");
    expect(html).not.toContain("https://example.com/source");
  });

  it("shows a computed paired result with sample size and verification scope", () => {
    const run = fixture(); run.trials[0]!.verdict = "uncertain";
    const html = renderToStaticMarkup(<SourceEvaluationCard evaluation={run} />);
    expect(html).toContain("+25.0 pp");
    expect(html).toContain("+33.3% relative change");
    expect(html).toContain("Codex CLI · source-only");
    expect(html).toContain("runtime regression tests not performed");
    expect(html).not.toContain("14%");
  });

  it("withholds the comparison for an unfinished experiment and links the live trace", () => {
    const run = fixture(); run.status = "running"; run.trials[1]!.status = "running"; run.trials[1]!.runId = "live-run";
    const html = renderToStaticMarkup(<SourceEvaluationCard evaluation={run} />);
    expect(html).toContain("Pending");
    expect(html).toContain("Watch agent activity");
    expect(html).toContain("#/runs/live-run");
    expect(html).not.toContain("relative change from");
  });

  it("keeps a cancelled experiment visibly incomplete", () => {
    const run = fixture(); run.status = "cancelled";
    const html = renderToStaticMarkup(<SourceEvaluationCard evaluation={run} />);
    expect(html).toContain("No paired comparison is published");
    expect(html).not.toContain("+0.0 pp");
  });
});
