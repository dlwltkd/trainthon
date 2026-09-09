import { useEffect, useState } from "react";
import { ArrowUpRight, Plus, RefreshCw } from "lucide-react";
import { api, type RunSummary } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDate, formatDuration, relativeTime } from "@/lib/format";
import { routeHref } from "@/hooks/useHashRoute";
import { Button, Chip, Empty, Mono, Panel, Spinner, StatusChip } from "./ui";

export function useRuns(pollMs = 4000) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const refresh = () =>
    api
      .runs()
      .then((r) => {
        setRuns(r);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);
  return { runs, error, refresh };
}

export function RunsHome({ onNewRun }: { onNewRun: () => void }) {
  const { runs, error, refresh } = useRuns();
  const active = runs?.filter((r) => r.active) ?? [];
  const recent = runs?.filter((r) => !r.active) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[1.6em] font-semibold tracking-tight">Security agent workspace</h1>
          <p className="mt-1 max-w-xl text-ink-2">
            A shared framework for security workflows. Follow plans, skill calls, decisions, tools, and evidence in one trace. Repository repair is the first implemented workflow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={refresh} aria-label="refresh">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="primary" onClick={onNewRun}>
            <Plus className="size-4" /> New run
          </Button>
        </div>
      </div>

      {error && (
        <Panel className="border-fail/30 bg-fail-soft/40 p-3 text-[0.9em] text-fail">
          Could not reach the server: {error}. Start it with <Mono>pnpm dev:server</Mono>.
        </Panel>
      )}

      {runs === null && !error && (
        <div className="flex items-center gap-2 text-ink-3">
          <Spinner /> loading runs
        </div>
      )}

      {active.length > 0 && (
        <Section title="Active" count={active.length}>
          {active.map((run) => (
            <RunRow key={run.runId} run={run} />
          ))}
        </Section>
      )}

      {runs !== null && (
        <Section title="Recent" count={recent.length}>
          {recent.length === 0 ? (
            <Empty title="No recorded runs yet" hint="Start the repository repair workflow with a local repository, an existing report, and a regression test." action={<Button onClick={onNewRun}>New run</Button>} />
          ) : (
            recent.map((run) => <RunRow key={run.runId} run={run} />)
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[0.8em] font-semibold uppercase tracking-wider text-ink-3">
        {title}
        <span className="rounded-full bg-zinc-200/70 px-1.5 tabular-nums text-ink-2">{count}</span>
      </div>
      <Panel className="divide-y divide-line overflow-hidden">{children}</Panel>
    </section>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const title = run.kind === "benchmark" ? run.taskId ?? run.runId : run.repository ?? run.runId;
  return (
    <a href={routeHref({ name: "run", runId: run.runId })} className={cn("group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-zinc-50", run.active && "bg-amber-50/30")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium tracking-tight">{title}</span>
          <StatusChip status={run.status} />
          <Chip tone="neutral">{run.kind === "benchmark" ? `bench · ${run.condition ?? "?"}` : "Repository repair"}</Chip>
          {run.mode && <Chip tone={run.mode === "live" ? "fail" : "neutral"}>{run.mode}</Chip>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.85em] text-ink-3">
          <span>{formatDate(run.startedAt)}</span>
          <span>{relativeTime(run.startedAt)}</span>
          {run.elapsedMs !== undefined && <span className="font-mono tabular-nums">{formatDuration(run.elapsedMs)}</span>}
          {run.model && <Mono>{run.model}</Mono>}
          <span className="tabular-nums">{run.eventCount} events</span>
        </div>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-ink" />
    </a>
  );
}
