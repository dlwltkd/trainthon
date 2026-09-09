import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound, X } from "lucide-react";
import { api, type BenchTask, type Health, type StartRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Chip, Mono, Spinner, Tabs } from "./ui";

type Kind = "bench" | "repository";

export function NewRunDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (runId: string) => void }) {
  const [kind, setKind] = useState<Kind>("repository");
  const [tasks, setTasks] = useState<BenchTask[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [taskId, setTaskId] = useState("");
  const [condition, setCondition] = useState<"B" | "C">("C");
  const [repoPath, setRepoPath] = useState("");
  const [regressionPath, setRegressionPath] = useState("");
  const [reportText, setReportText] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [mode, setMode] = useState<"live" | "scripted">("live");
  const [patchPath, setPatchPath] = useState("");
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    api.tasks().then((t) => {
      setTasks(t);
      if (!taskId && t[0]) setTaskId(t[0].id);
    }).catch(() => setTasks([]));
    api.health().then(setHealth).catch(() => setHealth(null));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, taskId]);

  if (!open) return null;
  const task = tasks.find((t) => t.id === taskId);
  const live = health && "blue" in health.live ? health.live : null;
  const liveError = health && "error" in health.live ? health.live.error : null;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const body: StartRequest =
      kind === "bench"
        ? { kind: "bench", taskId, condition }
        : { kind: "repository", repoPath, regressionPath, reportText, ref, mode, patchPath: mode === "scripted" ? patchPath : undefined, review };
    try {
      const { runId } = await api.start(body);
      onStarted(runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-panel shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <div className="text-[1.1em] font-semibold tracking-tight">{kind === "repository" ? "Repository repair" : "Benchmark run"}</div>
            <div className="text-[0.85em] text-ink-3">{kind === "repository" ? "Validate an existing report, apply a bounded repair, and check the evidence." : "Inspect a recorded fixture workflow with the same activity trace."}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="close">
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <Tabs
            value={kind}
            onChange={setKind}
            items={[
              { id: "bench", label: "Benchmark fixture" },
              { id: "repository", label: "Repository repair" },
            ]}
          />

          {kind === "bench" ? (
            <>
              <Field label="Task">
                <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={inputClass}>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id} · {t.kind} · {t.split}
                    </option>
                  ))}
                </select>
              </Field>
              {task && <p className="rounded-lg bg-canvas p-3 text-[0.88em] leading-relaxed text-ink-2">{task.report}</p>}
              <Field label="Condition" hint="B: plain tool loop. C: Vouch harness — Red proves, gate decides, Blue patches.">
                <div className="flex gap-2">
                  {(["B", "C"] as const).map((c) => (
                    <button key={c} onClick={() => setCondition(c)} className={cn("flex-1 rounded-lg border px-3 py-2 text-left transition-colors", condition === c ? "border-ink bg-ink text-white" : "border-line-2 hover:bg-zinc-50")}>
                      <div className="font-semibold">{c === "B" ? "B · Baseline" : "C · Vouch"}</div>
                      <div className={cn("text-[0.8em]", condition === c ? "text-white/70" : "text-ink-3")}>{c === "B" ? "single agent, declares done" : "Red → gate → Blue → gate"}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <Note>Benchmark fixtures run in <Mono>scripted</Mono> mode (no provider calls) — ideal for a deterministic on-stage demo of the harness flow.</Note>
            </>
          ) : (
            <>
              <Field label="Repository path" hint="Local Git root on the server machine. The checked commit is snapshotted; the original is never modified.">
                <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/repo" className={inputClass} spellCheck={false} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Regression test (repo-relative)">
                  <input value={regressionPath} onChange={(e) => setRegressionPath(e.target.value)} placeholder="tests/security.test.ts" className={inputClass} spellCheck={false} />
                </Field>
                <Field label="Ref">
                  <input value={ref} onChange={(e) => setRef(e.target.value)} className={inputClass} spellCheck={false} />
                </Field>
              </div>
              <Field label="Security report">
                <textarea value={reportText} onChange={(e) => setReportText(e.target.value)} rows={4} placeholder="Describe the vulnerability the regression test demonstrates…" className={cn(inputClass, "resize-y leading-relaxed")} />
              </Field>
              <Field label="Mode">
                <Tabs
                  value={mode}
                  onChange={setMode}
                  items={[
                    { id: "live", label: "Live (real model)" },
                    { id: "scripted", label: "Scripted (supplied patch)" },
                  ]}
                />
              </Field>
              {mode === "scripted" ? (
                <Field label="Patch file" hint="Applied as Blue's change instead of calling a model.">
                  <input value={patchPath} onChange={(e) => setPatchPath(e.target.value)} placeholder="/path/to/fix.diff" className={inputClass} spellCheck={false} />
                </Field>
              ) : (
                <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-[0.88em]">
                  <div className="flex items-center gap-1.5 font-medium text-ink-2">
                    <KeyRound className="size-3.5" /> Live models (from server environment)
                  </div>
                  {live ? (
                    <>
                      <ModelLine role="Blue" model={live.blue} />
                      <label className="flex items-center gap-2 text-ink-2">
                        <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} className="accent-ink" />
                        Red reviews the evidence first (read-only)
                      </label>
                      {review && <ModelLine role="Red" model={live.red} />}
                    </>
                  ) : (
                    <span className="text-fail">{liveError ?? "server unavailable"}</span>
                  )}
                </div>
              )}
              <Note icon={<AlertTriangle className="size-3.5 text-warn" />}>
                Requires Docker on the server. Supported: Node repos with one lockfile + Vitest, or Python 3.11 + pinned pytest. Success is <Mono>TESTS_PASSED</Mono> (repository tests, no independent grader).
              </Note>
            </>
          )}

          {error && <div className="rounded-lg border border-fail/30 bg-fail-soft px-3 py-2 text-[0.9em] text-fail">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || (kind === "bench" ? !taskId : !repoPath || !regressionPath || !reportText.trim() || (mode === "scripted" && !patchPath))}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Start run
          </Button>
        </div>
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-lg border border-line-2 bg-panel px-3 py-2 font-mono text-[0.92em] text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-offset-1 focus:outline-info";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[0.85em] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[0.8em] text-ink-3">{hint}</span>}
    </label>
  );
}

function Note({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-canvas p-3 text-[0.85em] leading-relaxed text-ink-2">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function ModelLine({ role, model }: { role: string; model: { model: string; provider: string; keyEnv: string; keyPresent: boolean } }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone={role === "Red" ? "red" : "blue"}>{role}</Chip>
      <Mono>{model.model}</Mono>
      <span className="text-ink-3">via {model.provider}</span>
      <Chip tone={model.keyPresent ? "pass" : "fail"} className="ml-auto">
        {model.keyEnv} {model.keyPresent ? "set" : "missing"}
      </Chip>
    </div>
  );
}
