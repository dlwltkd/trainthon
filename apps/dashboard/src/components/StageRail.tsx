import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_HINT, STAGE_LABEL, isRepositoryReview, isRepositoryRemediation, type RunView, type StageView } from "@/lib/derive";
import { formatDuration } from "@/lib/format";

/**
 * The harness plan: a fixed state machine, so the audience can see where the run is and
 * which gate decided each transition. Nothing here is inferred — it is driven by state_change/gate events.
 */
export function StageRail({ view, now }: { view: RunView; now: number }) {
  const order = isRepositoryRemediation(view) ? ["CONTEXT", "REVIEW", "PATCH", "DONE"] : isRepositoryReview(view) ? ["CONTEXT", "REVIEW", "DONE"] : view.stages.filter((stage) => stage.id !== "INIT").map((stage) => stage.id);
  const visible = order.map((id) => view.stages.find((stage) => stage.id === id)).filter((stage): stage is StageView => stage !== undefined);
  return (
    <div className="border-b border-line bg-panel px-4 py-2.5">
      <ol className="flex items-stretch gap-1 overflow-x-auto">
        {visible.map((stage, index) => (
          <Stage key={stage.id} stage={stage} view={view} now={now} last={index === visible.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function Stage({ stage, view, now, last }: { stage: StageView; view: RunView; now: number; last: boolean }) {
  const active = stage.status === "active";
  const done = stage.status === "done";
  const skipped = stage.status === "skipped";
  const sourceWorkflow = isRepositoryReview(view) || isRepositoryRemediation(view);
  const hint = sourceWorkflow ? stage.id === "CONTEXT" ? "Snapshot the requested repository" : stage.id === "REVIEW" ? "Inspect source and report findings" : stage.id === "PATCH" ? "Propose source changes · no tests" : "Recorded outcome" : view.kind === "local_repository" && stage.id === "REPRODUCE" ? "Check the supplied regression" : view.kind === "local_repository" && stage.id === "REVIEW" ? "Review the test evidence" : STAGE_HINT[stage.id];
  const duration = active && stage.enteredAt !== undefined ? Math.max(0, (view.endedAt ?? now) - stage.enteredAt) : stage.durationMs;
  const gate = stage.id === "REPRODUCE" ? view.gates.reproduce : stage.id === "VERIFY" ? view.gates.verify : undefined;
  const gateTone = gate ? (gate.phase === "reproduce" ? (gate.reproduced ? "pass" : "info") : gate.passed ? "pass" : "fail") : undefined;

  return (
    <li className={cn("flex min-w-[8.5rem] flex-1 items-start gap-2", !last && "pr-1")}>
      <div className="flex flex-col items-center pt-1">
        <span
          className={cn(
            "relative flex size-4 items-center justify-center rounded-full border transition-colors",
            done && "border-ink bg-ink text-white",
            active && "border-info bg-info text-white pulse-dot",
            skipped && "border-line-2 bg-panel text-ink-3",
            stage.status === "pending" && "border-line-2 bg-panel",
          )}
        >
          {done && <Check className="size-2.5" strokeWidth={3} />}
          {skipped && <Minus className="size-2.5" strokeWidth={3} />}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("text-[0.9em] font-semibold tracking-tight", active ? "text-info" : done ? "text-ink" : "text-ink-3")}>{STAGE_LABEL[stage.id]}</span>
          {duration !== undefined && stage.id !== "DONE" && <span className="font-mono text-[0.75em] tabular-nums text-ink-3">{formatDuration(duration)}</span>}
        </div>
        <div className="secondary truncate text-[0.78em] text-ink-3">{hint}</div>
        {gate && (
          <div className={cn("mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.75em] font-medium", gateTone === "pass" && "bg-pass-soft text-pass", gateTone === "fail" && "bg-fail-soft text-fail", gateTone === "info" && "bg-info-soft text-info")}>
            {gate.phase === "reproduce" ? (gate.reproduced ? "gate · reproduced" : "gate · not reproduced") : gate.passed ? "gate · passed" : "gate · failed"}
          </div>
        )}
      </div>
      {!last && <div className={cn("mt-2.5 h-px w-4 shrink-0", done ? "bg-ink" : "bg-line-2")} />}
    </li>
  );
}
