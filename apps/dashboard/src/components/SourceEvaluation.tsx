import { useEffect, useState } from "react";
import { summarizeSourceEvaluation, type EvaluationCase, type EvaluationTrial, type SourceEvaluation } from "@vouch/protocol";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { routeHref } from "@/hooks/useHashRoute";
import { Chip, Mono, Panel, Spinner } from "./ui";

const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(0)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

export function SourceEvaluations() {
  const [evaluations, setEvaluations] = useState<SourceEvaluation[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () => api.evaluations().then(value => { if (!cancelled) { setEvaluations(value); setError(undefined); } }, reason => { if (!cancelled) setError(String(reason)); });
    void load();
    const timer = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  if (error) return <Panel className="p-5 text-fail">Could not refresh evaluation records: {error}</Panel>;
  if (!evaluations) return <div className="flex items-center gap-2 text-ink-3"><Spinner /> Loading measured evaluations</div>;
  if (!evaluations.length) return <Panel className="p-6"><div className="font-semibold">CVEfixes source pilot</div><p className="mt-2 text-ink-2">Compare the same model on four pinned before/fixed snapshots. Results appear after a real execution starts.</p><pre className="mt-4 overflow-x-auto rounded-lg bg-canvas p-3 text-[0.85em]">pnpm cli eval --suite cvefixes</pre></Panel>;
  return <div className="flex flex-col gap-6"><SourceEvaluationCard evaluation={evaluations[0]!} />{evaluations.length > 1 && <details><summary className="cursor-pointer text-ink-3">Previous experiments ({evaluations.length - 1}) · includes interrupted runs</summary><div className="mt-4 space-y-6">{evaluations.slice(1).map(evaluation => <SourceEvaluationCard key={evaluation.id} evaluation={evaluation} />)}</div></details>}</div>;
}

export function SourceEvaluationCard({ evaluation }: { evaluation: SourceEvaluation }) {
  const summary = summarizeSourceEvaluation(evaluation);
  const settled = evaluation.trials.filter(trial => !["pending", "running"].includes(trial.status)).length;
  const total = evaluation.manifest.cases.length * 2;
  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><Chip tone="info">CVEfixes · source pilot</Chip><Chip tone={evaluation.status === "running" ? "running" : evaluation.status === "cancelled" ? "warn" : "neutral"} dot>{evaluation.status}</Chip></div>
          <Mono className="text-ink-3">{evaluation.manifest.model} · both conditions</Mono>
        </div>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight">One model. Four source snapshots. Every result recorded.</h2>
        <p className="mt-2 max-w-3xl text-ink-2">Two historical CVEs, each paired with its published correction. Source verdicts and patch reference agreement are measured separately.</p>
        <div className="mt-5 flex items-center gap-3 text-[0.85em] text-ink-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100"><div className="h-full bg-ink transition-[width]" style={{ width: `${settled / total * 100}%` }} /></div><span>{settled}/{total} trials finished</span></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {summary.arms.map(arm => <div key={arm.arm} className={`rounded-xl border p-4 ${arm.arm === "vouch" ? "border-blue-role/25 bg-blue-role/5" : "border-line bg-canvas/50"}`}>
            <div className="text-[0.85em] font-medium text-ink-2">{arm.arm === "vouch" ? "Vouch · Red → Blue" : "Codex CLI · source-only"}</div>
            <div className="mt-2 flex items-end gap-2"><span className="text-4xl font-semibold tabular-nums tracking-tight">{percent(arm.completed + arm.errors ? arm.accuracy : null)}</span><span className="pb-1 text-ink-3">{arm.correct}/{arm.total}</span></div>
            <div className="mt-1 text-[0.85em] text-ink-3">Label agreement{!summary.complete && " · provisional"}</div>
            <div className="mt-4 border-t border-line pt-3 text-[0.85em] text-ink-2"><div>Reference agreement <strong>{arm.referenceMatches}/{summary.vulnerableCases}</strong></div><div className="mt-1">Fixed controls preserved <strong>{arm.controlsUnchanged}/{summary.controlCases}</strong></div><div className="mt-1">{arm.errors} failed or cancelled · {formatDuration(arm.elapsedMs)} total</div></div>
          </div>)}
          <div className="rounded-xl bg-ink p-4 text-white">
            <div className="text-[0.85em] text-white/65">Label agreement difference</div>
            <div className="mt-2 text-4xl font-semibold tabular-nums tracking-tight">{summary.differencePp === null ? evaluation.status === "cancelled" ? "Cancelled" : "Pending" : `${signed(summary.differencePp)} pp`}</div>
            <p className="mt-3 text-[0.85em] leading-relaxed text-white/70">{summary.differencePp === null ? evaluation.status === "cancelled" ? "This experiment was interrupted. No paired comparison is published." : "A comparison appears after both conditions finish the complete registered set." : summary.relativeChangePercent === null ? "Relative change is undefined because baseline accuracy is zero." : `${signed(summary.relativeChangePercent)}% relative change from the baseline.`}</p>
            <p className="mt-3 text-[0.85em] text-white/70">Small, correlated pilot. No general performance advantage established.</p>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[0.9em]">
          <thead className="border-b border-line bg-canvas/50 text-[0.8em] uppercase tracking-wide text-ink-3"><tr><th className="px-5 py-3">Pinned case</th><th className="px-5 py-3">Codex CLI · source-only</th><th className="px-5 py-3">Vouch · Red → Blue</th></tr></thead>
          <tbody className="divide-y divide-line">{evaluation.manifest.cases.map(task => <tr key={task.id}>
            <td className="px-5 py-4 align-top"><a className="font-medium hover:underline" href={task.sourceUrl} target="_blank" rel="noreferrer">{task.cve}</a><div className="mt-1 text-[0.85em] text-ink-3">{task.cwe} · {task.variant === "before" ? "before correction" : "fixed control"}</div><Mono className="mt-2 block text-[0.75em] text-ink-3" title={task.sourceSha256}>{task.sourceSha256.slice(0, 12)}</Mono></td>
            {(["codex", "vouch"] as const).map(arm => <td key={arm} className="max-w-sm px-5 py-4 align-top"><TrialResult task={task} trial={evaluation.trials.find(trial => trial.caseId === task.id && trial.arm === arm)} evaluationId={evaluation.id} /></td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="border-t border-line bg-canvas/40 p-5 text-[0.85em] text-ink-2">
        <div className="flex flex-wrap items-center justify-between gap-3"><span>Source-only assessment · runtime regression tests not performed</span><a href={`/api/evaluations/${encodeURIComponent(evaluation.id)}`} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">Open result JSON</a></div>
        <details className="mt-4"><summary className="cursor-pointer font-medium">Method, conditions, and provenance</summary><div className="mt-3 space-y-3 leading-relaxed">
          <p>{evaluation.manifest.selection}</p>
          <p><strong>Codex:</strong> {evaluation.manifest.conditions.codex}</p><p><strong>Vouch:</strong> {evaluation.manifest.conditions.vouch}</p>
          <p>Equal wall-time allowance: {formatDuration(evaluation.manifest.maxWallMs)} per case and condition. No cumulative token limit. {evaluation.manifest.codexVersion} · code {evaluation.manifest.codeCommit.slice(0, 12)}.</p>
          {evaluation.manifest.limitations.map(note => <p key={note}>{note}</p>)}
          <p className="break-all">Manifest SHA-256: <Mono>{evaluation.manifestHash}</Mono></p>
          <a href="https://github.com/secureIT-project/CVEfixes" target="_blank" rel="noreferrer" className="underline">CVEfixes dataset and publication</a>
        </div></details>
      </div>
    </Panel>
  );
}

function TrialResult({ task, trial, evaluationId }: { task: EvaluationCase; trial?: EvaluationTrial; evaluationId: string }) {
  if (!trial || trial.status === "pending") return <span className="text-ink-3">Queued</span>;
  if (trial.status === "running") return <div className="flex flex-col items-start gap-2"><Chip tone="running" dot>Running</Chip>{trial.startedAt && <span className="text-[0.8em] text-ink-3">{formatDuration(Math.max(0, Date.now() - trial.startedAt))} elapsed</span>}{trial.runId && <a href={routeHref({ name: "run", runId: trial.runId })} className="text-[0.85em] underline">Watch agent activity</a>}</div>;
  const correct = trial.status === "completed" && trial.evidenceValid === true && trial.verdict === (task.variant === "before" ? "issue_present" : "issue_absent");
  const artifact = (name: string) => `/api/evaluations/${encodeURIComponent(evaluationId)}/artifact?case=${encodeURIComponent(task.id)}&arm=${trial.arm}&name=${name}`;
  return <div className="space-y-2">
    <Chip tone={trial.status !== "completed" ? "warn" : correct ? "pass" : "fail"}>{trial.status === "completed" ? correct ? "Label agrees" : "No label credit" : trial.status}</Chip>
    {trial.status === "completed" && <div className="text-[0.85em] text-ink-2">{task.variant === "before" ? `Reference ${trial.referenceMatch ? "matches" : "differs"}` : `Control ${trial.unchanged ? "unchanged" : "modified"}`} · {trial.syntaxValid ? "syntax valid" : "syntax invalid"}</div>}
    <div className="text-[0.8em] text-ink-3">{formatDuration(trial.elapsedMs)}{trial.usage ? ` · ${(trial.usage.inputTokens + trial.usage.outputTokens).toLocaleString()} tokens` : " · token usage unavailable"}</div>
    {(trial.summary || trial.error) && <details className="text-[0.85em]"><summary className="cursor-pointer text-ink-2">{trial.error ? "Failure detail" : "Decision and evidence"}</summary><p className="mt-2 max-w-md whitespace-pre-wrap break-words text-ink-3">{trial.error ?? trial.summary}</p></details>}
    <div className="flex flex-wrap gap-3 text-[0.8em]">
      {trial.runId && <a href={routeHref({ name: "run", runId: trial.runId })} className="underline">Agent trace</a>}
      {trial.answerSha256 && <a href={artifact("answer.json")} target="_blank" rel="noreferrer" className="underline">Answer</a>}
      {trial.candidateSha256 && <a href={artifact("candidate.py")} target="_blank" rel="noreferrer" className="underline">Candidate</a>}
    </div>
  </div>;
}
