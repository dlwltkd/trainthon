import { describe, expect, it } from "vitest";
import type { BenchRunRow, Task } from "@vouch/protocol";
import { summarizeBench } from "./bench.js";

const tasks: Task[] = [
  {
    id: "v1",
    group: "g",
    kind: "vuln",
    source: "synthetic",
    repoRef: { url: ".", commit: "HEAD" },
    report: { text: "x", hintLevel: 2 },
    publicTests: [],
    split: "dev",
  },
  {
    id: "c1",
    group: "g",
    kind: "control_fixed",
    source: "synthetic",
    repoRef: { url: ".", commit: "HEAD" },
    report: { text: "x", hintLevel: 2 },
    publicTests: [],
    split: "dev",
  },
];

function row(partial: Partial<BenchRunRow> & Pick<BenchRunRow, "taskId" | "condition" | "status">): BenchRunRow {
  return {
    runId: "r",
    kind: partial.taskId === "v1" ? "vuln" : "control_fixed",
    elapsedMs: 1000,
    costUsd: 0,
    metrics: null,
    scripted: true,
    ...partial,
  };
}

describe("summarizeBench", () => {
  it("splits verified-fix (vuln) from over-fix (control)", () => {
    const report = summarizeBench("dev", 1, ["B", "C"], tasks, [
      row({ taskId: "v1", condition: "B", status: "FIXED_VERIFIED" }),
      row({ taskId: "c1", condition: "B", status: "FAILED_NO_FIX" }),
      row({ taskId: "v1", condition: "C", status: "FIXED_VERIFIED" }),
      row({ taskId: "c1", condition: "C", status: "NOT_REPRODUCIBLE" }),
    ]);
    const b = report.cells.find((c) => c.condition === "B")!;
    const c = report.cells.find((c) => c.condition === "C")!;
    expect(b.verifiedFixRate).toBe(1);
    expect(b.overFixRate).toBe(1);
    expect(c.verifiedFixRate).toBe(1);
    expect(c.overFixRate).toBe(0);
  });
});
