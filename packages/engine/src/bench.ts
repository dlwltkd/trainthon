import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BenchCell,
  BenchReport,
  BenchRunRow,
  Condition,
  RunConfig,
  Split,
  Task,
} from "@vouch/protocol";
import { DEFAULT_BUDGETS } from "@vouch/protocol";
import { executeRun } from "./run.js";
import { listTasks } from "./tasks.js";

const GRADER_VERSION = "0.0.0";

export interface ExecuteBenchOptions {
  split: Split;
  conditions: Condition[];
  repeats: number;
  seed: number;
  model: string;
  provider?: string;
  runsDir: string;
  repoRoot: string;
  benchDir: string;
  onRun?: (row: BenchRunRow) => void;
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function usedScripted(events: { type: string; runner?: string }[]): boolean {
  return events.some(
    (e) => e.type === "role_assigned" && typeof e.runner === "string" && e.runner.startsWith("scripted"),
  );
}

export function summarizeBench(
  split: Split,
  repeats: number,
  conditions: Condition[],
  tasks: Task[],
  rows: BenchRunRow[],
): BenchReport {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cells: BenchCell[] = conditions.map((condition) => {
    const subset = rows.filter((r) => r.condition === condition);
    const vuln = subset.filter((r) => (byId.get(r.taskId)?.kind ?? r.kind) === "vuln");
    const control = subset.filter((r) => {
      const k = byId.get(r.taskId)?.kind ?? r.kind;
      return k === "control_fixed" || k === "control_na";
    });
    const verifiedFix = vuln.filter((r) => r.status === "FIXED_VERIFIED").length;
    const overFix = control.filter((r) => r.status !== "NOT_REPRODUCIBLE").length;
    const elapsed = subset
      .map((r) => r.elapsedMs)
      .filter((n): n is number => typeof n === "number");
    return {
      condition,
      n: subset.length,
      nVuln: vuln.length,
      nControl: control.length,
      verifiedFix,
      verifiedFixRate: rate(verifiedFix, vuln.length),
      overFix,
      overFixRate: rate(overFix, control.length),
      brokeFunction: subset.filter((r) => r.status === "BROKE_FUNCTION").length,
      notReproducible: subset.filter((r) => r.status === "NOT_REPRODUCIBLE").length,
      infraError: subset.filter((r) => r.status === "INFRA_ERROR").length,
      meanElapsedMs:
        elapsed.length === 0 ? 0 : Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length),
      totalCostUsd: subset.reduce((a, r) => a + r.costUsd, 0),
    };
  });
  return {
    split,
    repeats,
    conditions,
    cells,
    runs: rows,
    generatedAt: Date.now(),
    scripted: rows.some((r) => r.scripted),
  };
}

export function formatBenchTable(report: BenchReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const frac = (n: number, d: number) => `${n}/${d} (${pct(d === 0 ? 0 : n / d)})`;
  const lines: string[] = [
    `bench split=${report.split} repeats=${report.repeats} conditions=${report.conditions.join(",")}`,
    report.scripted
      ? "note: one or more runs used the scripted runner (no API key) — pipeline wiring, not a model score"
      : "note: scored with a live model",
    "",
    [
      "cond".padEnd(6),
      "verified-fix".padEnd(18),
      "over-fix".padEnd(18),
      "broke".padEnd(8),
      "infra".padEnd(8),
      "mean-ms".padEnd(10),
      "cost",
    ].join(" "),
  ];
  for (const c of report.cells) {
    lines.push(
      [
        c.condition.padEnd(6),
        frac(c.verifiedFix, c.nVuln).padEnd(18),
        frac(c.overFix, c.nControl).padEnd(18),
        String(c.brokeFunction).padEnd(8),
        String(c.infraError).padEnd(8),
        String(c.meanElapsedMs).padEnd(10),
        c.totalCostUsd.toFixed(4),
      ].join(" "),
    );
  }
  lines.push("");
  lines.push("runs:");
  for (const r of report.runs) {
    lines.push(
      `  ${r.condition} ${r.taskId.padEnd(24)} ${r.status.padEnd(20)} ${r.elapsedMs ?? "?"}ms${r.scripted ? " [scripted]" : ""}`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function executeBench(opts: ExecuteBenchOptions): Promise<BenchReport> {
  const tasks = listTasks(opts.benchDir, opts.split);
  if (tasks.length === 0) {
    throw new Error(`no tasks in split "${opts.split}"`);
  }
  const rows: BenchRunRow[] = [];
  for (let i = 0; i < opts.repeats; i++) {
    const seed = opts.seed + i;
    for (const task of tasks) {
      for (const condition of opts.conditions) {
        const config: RunConfig = {
          model: opts.model,
          provider: opts.provider,
          seed,
          budgets: DEFAULT_BUDGETS,
          condition,
          graderVersion: GRADER_VERSION,
        };
        const record = await executeRun({
          task,
          config,
          runsDir: opts.runsDir,
          repoRoot: opts.repoRoot,
          benchDir: opts.benchDir,
        });
        const row: BenchRunRow = {
          runId: record.runId,
          taskId: record.taskId,
          kind: task.kind,
          condition: record.condition,
          status: record.status,
          elapsedMs: record.elapsedMs,
          costUsd: record.costUsd,
          metrics: record.metrics,
          scripted: usedScripted(record.events),
        };
        rows.push(row);
        opts.onRun?.(row);
      }
    }
  }
  const report = summarizeBench(opts.split, opts.repeats, opts.conditions, tasks, rows);
  writeFileSync(join(opts.runsDir, "bench-latest.json"), JSON.stringify(report, null, 2));
  return report;
}
