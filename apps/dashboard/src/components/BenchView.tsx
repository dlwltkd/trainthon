import { useEffect, useMemo, useState } from "react";
import type { GradeEvent, RunEndEvent } from "@vouch/protocol";
import { api, type RunSummary } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { routeHref } from "@/hooks/useHashRoute";
import { useRuns } from "./RunsHome";
import { Chip, Mono, Panel, Spinner, StatusChip } from "./ui";

interface BenchRow extends RunSummary {
  metrics?: GradeEvent["metrics"];
  reason?: string;
}

/**
 * Bench view: paired B vs C results per task from persisted benchmark runs.
 * Only recorded runs are shown; nothing is aggregated into a headline number without the eval set.
 */
export function BenchView() {
  const { runs } = useRuns(8000);
  const bench = useMemo(() => (runs ?? []).filter((r) => r.kind === "benchmark" && !r.active), [runs]);
  const [rows, setRows] = useState<BenchRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      bench.map(async (summary) => {
        try {
          const payload = await api.run(summary.runId);
          const grade = payload.events.find((e): e is GradeEvent => e.type === "grade");
          const end = payload.events.find((e): e is RunEndEvent => e.type === "run_end");
          return { ...summary, metrics: grade?.metrics, reason: end?.reason } satisfies BenchRow;
        } catch {
          return summary as BenchRow;
        }
      }),
    ).then((r) => !cancelled && setRows(r));
    return () => {
      cancelled = true;
    };
  }, [bench]);

  const byTask = useMemo(() => {
    const map = new Map<string, BenchRow[]>();
    for (const row of rows) {
      const key = row.taskId ?? "unknown";
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-[1.6em] font-semibold tracking-tight">Bench</h1>
        <p className="mt-1 max-w-2xl text-ink-2">
          Recorded benchmark runs grouped by task. B is the plain agent loop, C is the Vouch harness. Grades come from the hidden grader, never from the agent's own claim.
        </p>
      </div>
      {runs === null ? (
        <div className="flex items-center gap-2 text-ink-3">
          <Spinner /> loading
        </div>
      ) : byTask.length === 0 ? (
        <Panel className="p-6 text-ink-3">No benchmark runs recorded yet. Start one from the Runs page.</Panel>
      ) : (
        byTask.map(([taskId, taskRows]) => (
          <Panel key={taskId} className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line bg-canvas/60 px-4 py-2">
              <Mono className="font-semibold">{taskId}</Mono>
              <span className="text-[0.85em] text-ink-3">{taskRows.length} runs</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[0.9em]">
                <thead className="text-left text-[0.8em] uppercase tracking-wider text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Condition</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Exploit neutralized</th>
                    <th className="px-4 py-2 font-medium">Functional</th>
                    <th className="px-4 py-2 font-medium">Guarded touched</th>
                    <th className="px-4 py-2 font-medium text-right">Diff lines</th>
                    <th className="px-4 py-2 font-medium text-right">Time</th>
                    <th className="px-4 py-2 font-medium">Mode</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {taskRows
                    .sort((a, b) => (a.condition ?? "").localeCompare(b.condition ?? "") || b.startedAt - a.startedAt)
                    .map((row) => (
                      <tr key={row.runId} className="hover:bg-zinc-50">
                        <td className="px-4 py-2">
                          <a href={routeHref({ name: "run", runId: row.runId })} className="font-semibold hover:underline">
                            {row.condition === "C" ? "C · Vouch" : row.condition === "B" ? "B · Baseline" : row.condition ?? "?"}
                          </a>
                        </td>
                        <td className="px-4 py-2">
                          <StatusChip status={row.status} />
                        </td>
                        <td className="px-4 py-2">
                          <Bool value={row.metrics?.exploitNeutralized} />
                        </td>
                        <td className="px-4 py-2">
                          <Bool value={row.metrics?.functionalPass} />
                        </td>
                        <td className="px-4 py-2">
                          <Bool value={row.metrics?.guardedFilesTouched} invert />
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{row.metrics?.diffLineCount ?? "—"}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{formatDuration(row.elapsedMs)}</td>
                        <td className="px-4 py-2 text-ink-3">{row.mode}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))
      )}
    </div>
  );
}

function Bool({ value, invert = false }: { value: boolean | null | undefined; invert?: boolean }) {
  if (value === undefined || value === null) return <span className="text-ink-3">—</span>;
  const good = invert ? !value : value;
  return <Chip tone={good ? "pass" : "fail"}>{value ? "yes" : "no"}</Chip>;
}
