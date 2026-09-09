import { useEffect, useState } from "react";
import type { TestRunEvent } from "@vouch/protocol";
import { ShieldCheck, ShieldAlert, ShieldQuestion, FlaskConical, ScrollText, Scale } from "lucide-react";
import { api, type RunSource } from "@/lib/api";
import { cn } from "@/lib/cn";
import { STATUS_LABEL, isRepositoryReview, isRepositoryRemediation, statusDescription, statusTone, type RunView } from "@/lib/derive";
import { formatDuration, stringify } from "@/lib/format";
import { Source } from "./CodeView";
import { Chip, Mono, Panel, Spinner } from "./ui";
import { MarkdownSummary } from "./MarkdownSummary";

export function EvidencePanel({ view, source, focusPhase }: { view: RunView; source: RunSource | null; focusPhase: string | null }) {
  const tone = statusTone(view.status);
  const Icon = tone === "pass" ? ShieldCheck : tone === "fail" ? ShieldAlert : ShieldQuestion;
  const sourceReview = isRepositoryReview(view);
  const sourcePatch = isRepositoryRemediation(view);
  const finalSummary = [...view.activity].reverse().find((item) => item.kind === "note" && item.final);
  const scope = sourcePatch ? "source patch · tests not run" : sourceReview ? "source review · model-reported findings" : view.kind === "local_repository" ? "repository tests · no independent grader" : view.grade ? "hidden grader" : "benchmark gate";

  return (
    <div className="flex flex-col gap-3 p-3">
      <Panel
        className={cn(
          "flex gap-3 p-4",
          tone === "pass" && "border-pass/30 bg-pass-soft/40",
          tone === "fail" && "border-fail/30 bg-fail-soft/40",
          tone === "info" && "border-info/30 bg-info-soft/40",
          tone === "warn" && "border-warn/30 bg-warn-soft/40",
          tone === "running" && "border-amber-200 bg-amber-50/40",
        )}
      >
        <Icon className={cn("mt-0.5 size-6 shrink-0", tone === "pass" && "text-pass", tone === "fail" && "text-fail", tone === "info" && "text-info", tone === "warn" && "text-warn", (tone === "neutral" || tone === "running") && "text-ink-3")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[1.15em] font-semibold tracking-tight">{STATUS_LABEL[view.status]}</span>
            <Chip tone="neutral" className="secondary">
              scope · {scope}
            </Chip>
          </div>
          <p className="mt-1 text-[0.95em] text-ink-2">{statusDescription(view)}</p>
          {view.reason && view.status !== "RUNNING" && (
            <p className="secondary mt-1.5 text-[0.85em] text-ink-3">
              harness: <span className="italic">{view.reason}</span>
            </p>
          )}
        </div>
      </Panel>

      {(sourceReview || sourcePatch) && <Panel className="p-4"><SectionTitle icon={<ScrollText className="size-3.5" />}>{sourcePatch ? "Review & patch notes" : "Review findings"}</SectionTitle>{finalSummary?.kind === "note" ? <MarkdownSummary text={finalSummary.text} className="mt-3 text-[0.94em] text-ink-2" /> : <p className="mt-3 text-[0.94em] leading-relaxed text-ink-2">A final summary has not been recorded. Current decisions and source references are available in Plan & skills.</p>}</Panel>}

      {!sourceReview && !sourcePatch && <div className="grid gap-3 lg:grid-cols-2">
        <Panel className="p-3">
          <SectionTitle icon={<Scale className="size-3.5" />}>Gates</SectionTitle>
          <div className="mt-2 flex flex-col gap-2">
            <GateRow label="Reproduce" value={view.gates.reproduce ? (view.gates.reproduce.reproduced ? "reproduced" : "not reproduced") : "pending"} tone={view.gates.reproduce ? (view.gates.reproduce.reproduced ? "pass" : "info") : "neutral"} detail={view.gates.reproduce ? `${view.gates.reproduce.submissions} submission${view.gates.reproduce.submissions === 1 ? "" : "s"}` : "waits for a failing regression on the checked commit"} />
            <GateRow label="Verify" value={view.gates.verify ? (view.gates.verify.passed ? "passed" : "failed") : "pending"} tone={view.gates.verify ? (view.gates.verify.passed ? "pass" : "fail") : "neutral"} detail={view.gates.verify ? `PoC neutralized ${view.gates.verify.pocNeutralized ? "✓" : "✗"} · functional ${view.gates.verify.functionalPassed ? "✓" : "✗"}` : "regression must pass and functional suite must stay green"} />
          </div>
        </Panel>
        {view.grade ? (
          <Panel className="p-3">
            <SectionTitle icon={<ShieldCheck className="size-3.5" />}>Independent grade</SectionTitle>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.9em]">
              <Metric label="exploit neutralized" value={view.grade.exploitNeutralized} />
              <Metric label="functional pass" value={view.grade.functionalPass} />
              <Metric label="guarded files touched" value={view.grade.guardedFilesTouched} invert />
              <div className="flex items-center justify-between rounded-md bg-canvas px-2 py-1">
                <dt className="text-ink-3">diff lines</dt>
                <dd className="font-mono tabular-nums">{view.grade.diffLineCount}</dd>
              </div>
            </dl>
          </Panel>
        ) : (
          <Panel className="p-3">
            <SectionTitle icon={<FlaskConical className="size-3.5" />}>Change summary</SectionTitle>
            <div className="mt-2 text-[0.9em] text-ink-2">
              {view.changedFiles.size === 0 ? (
                "No source files changed."
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...view.changedFiles.entries()].map(([path, c]) => (
                    <li key={path} className="flex items-center justify-between gap-2 rounded-md bg-canvas px-2 py-1">
                      <Mono className="truncate">{path}</Mono>
                      <span className="shrink-0 font-mono text-[0.9em] tabular-nums">
                        <span className="text-pass">+{c.additions}</span> <span className="text-fail">−{c.deletions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        )}
      </div>}

      {!sourceReview && view.tests.length > 0 && <BeforeAfter view={view} focusPhase={focusPhase} />}

      {source?.prompt && <Panel className="p-3"><SectionTitle icon={<ScrollText className="size-3.5" />}>Task prompt</SectionTitle><p className="mt-2 whitespace-pre-wrap text-[0.92em] leading-relaxed text-ink-2">{source.prompt}</p></Panel>}

      {(source?.report || source?.regression) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {source?.report && (
            <Panel className="p-3">
              <SectionTitle icon={<ScrollText className="size-3.5" />}>Security report (input)</SectionTitle>
              <p className="mt-2 whitespace-pre-wrap text-[0.92em] leading-relaxed text-ink-2">{source.report}</p>
            </Panel>
          )}
          {source?.regression && (
            <Panel className="overflow-hidden">
              <div className="p-3 pb-0">
                <SectionTitle icon={<FlaskConical className="size-3.5" />}>
                  Regression test <Mono className="ml-1 normal-case tracking-normal text-ink-3">{source.regressionPath}</Mono>
                </SectionTitle>
              </div>
              <div className="mt-2 max-h-72 overflow-auto border-t border-line">
                <Source text={source.regression} />
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[0.8em] font-semibold uppercase tracking-wider text-ink-3">
      {icon}
      {children}
    </div>
  );
}

function GateRow({ label, value, tone, detail }: { label: string; value: string; tone: "pass" | "fail" | "info" | "neutral"; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-canvas px-2.5 py-1.5">
      <div className="min-w-0">
        <div className="text-[0.92em] font-medium">{label}</div>
        <div className="secondary truncate text-[0.8em] text-ink-3">{detail}</div>
      </div>
      <Chip tone={tone}>{value}</Chip>
    </div>
  );
}

function Metric({ label, value, invert = false }: { label: string; value: boolean | null; invert?: boolean }) {
  const good = value === null ? null : invert ? !value : value;
  return (
    <div className="flex items-center justify-between rounded-md bg-canvas px-2 py-1">
      <dt className="text-ink-3">{label}</dt>
      <dd>
        <Chip tone={good === null ? "neutral" : good ? "pass" : "fail"}>{value === null ? "n/a" : value ? "yes" : "no"}</Chip>
      </dd>
    </div>
  );
}

type Column = "baseline" | "verification";
type Row = "regression" | "functional";

function classify(phase: string): { column: Column; row: Row } | null {
  const [column, row] = phase.split("-");
  if ((column === "baseline" || column === "verification") && (row === "regression" || row === "functional")) return { column, row };
  return null;
}

function BeforeAfter({ view, focusPhase }: { view: RunView; focusPhase: string | null }) {
  const grid = new Map<string, TestRunEvent>();
  const other: TestRunEvent[] = [];
  for (const test of view.tests) {
    const slot = classify(test.phase);
    if (slot) grid.set(test.phase, test);
    else other.push(test);
  }
  const [open, setOpen] = useState<string | null>(focusPhase);
  useEffect(() => setOpen(focusPhase), [focusPhase]);

  return (
    <Panel className="p-3">
      <SectionTitle icon={<FlaskConical className="size-3.5" />}>Before / after test evidence</SectionTitle>
      <div className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-1.5 text-[0.9em]">
        <div />
        <div className="text-center text-[0.8em] font-medium uppercase tracking-wider text-ink-3">Before patch</div>
        <div className="text-center text-[0.8em] font-medium uppercase tracking-wider text-ink-3">After patch</div>
        {(["regression", "functional"] as Row[]).map((row) => (
          <RowCells key={row} row={row} baseline={grid.get(`baseline-${row}`)} verification={grid.get(`verification-${row}`)} open={open} setOpen={setOpen} />
        ))}
      </div>
      {other.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {other.map((t) => (
            <TestCell key={t.seq} test={t} open={open === t.phase} onToggle={() => setOpen(open === t.phase ? null : t.phase)} />
          ))}
        </div>
      )}
      {open && <TestOutput runId={view.runId} test={view.tests.find((t) => t.phase === open)} />}
    </Panel>
  );
}

function RowCells({ row, baseline, verification, open, setOpen }: { row: Row; baseline?: TestRunEvent; verification?: TestRunEvent; open: string | null; setOpen: (p: string | null) => void }) {
  return (
    <>
      <div className="flex items-center pr-2 font-medium capitalize text-ink-2">{row}</div>
      {[baseline, verification].map((test, i) => (
        <div key={i}>
          {test ? (
            <TestCell test={test} open={open === test.phase} onToggle={() => setOpen(open === test.phase ? null : test.phase)} expectFail={row === "regression" && i === 0} />
          ) : (
            <div className="flex h-full min-h-12 items-center justify-center rounded-md border border-dashed border-line text-[0.85em] text-ink-3">—</div>
          )}
        </div>
      ))}
    </>
  );
}

function TestCell({ test, open, onToggle, expectFail = false }: { test: TestRunEvent; open: boolean; onToggle: () => void; expectFail?: boolean }) {
  const failedAsExpected = expectFail && test.outcome === "assertion_failed";
  const tone = test.passed ? (expectFail ? "info" : "pass") : failedAsExpected ? "warn" : "fail";
  return (
    <button
      onClick={onToggle}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-50",
        open ? "border-info/50 ring-2 ring-info/15" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Chip tone={tone}>{test.outcome.replace(/_/g, " ")}</Chip>
        <span className="secondary font-mono text-[0.8em] tabular-nums text-ink-3">{formatDuration(test.durationMs)}</span>
      </div>
      <div className="font-mono text-[0.85em] tabular-nums text-ink-2">
        {test.testsPassed} passed{test.testsFailed ? ` · ${test.testsFailed} failed` : ""}{test.testsSkipped ? ` · ${test.testsSkipped} skipped` : ""}
      </div>
      {failedAsExpected && <div className="secondary text-[0.8em] text-warn">baseline regression assertion failed</div>}
    </button>
  );
}

function TestOutput({ runId, test }: { runId: string; test: TestRunEvent | undefined }) {
  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; text?: string }>({ status: "loading" });
  useEffect(() => {
    if (!test) return;
    let cancelled = false;
    setState({ status: "loading" });
    const name = test.artifact.includes("/tests/") ? `tests/${test.artifact.split("/tests/").pop()}` : test.artifact;
    api
      .artifact(runId, name)
      .then((res) => {
        if (cancelled) return;
        let text = res.text;
        try {
          const parsed = JSON.parse(res.text) as Record<string, unknown>;
          const output = typeof parsed.output === "string" && parsed.output.trim() ? stringify(parsed.output) : "";
          const rest = { ...parsed };
          delete rest.output;
          text = `${output ? `${output}\n\n` : ""}${stringify(rest)}`;
        } catch {
          // not JSON; show raw
        }
        setState({ status: "ok", text });
      })
      .catch((error: Error) => !cancelled && setState({ status: "error", text: error.message }));
    return () => {
      cancelled = true;
    };
  }, [runId, test]);
  if (!test) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center justify-between border-b border-line bg-canvas px-2.5 py-1 text-[0.8em] text-ink-3">
        <span>
          {test.phase} · <Mono>{test.artifact.split("/").pop()}</Mono>
        </span>
        {state.status === "loading" && <Spinner className="size-3" />}
      </div>
      <pre className="code max-h-72 overflow-auto whitespace-pre-wrap p-3 text-ink-2">{state.text ?? ""}</pre>
    </div>
  );
}
