import { useEffect, useMemo, useState } from "react";
import type {
  BenchReport,
  EngineState,
  GateEvent,
  HarnessEvent,
  Task,
} from "@vouch/protocol";
import { api, subscribeRun, type RunSummary } from "./api";

type View = "studio" | "bench";

const STATES: EngineState[] = [
  "INIT",
  "CONTEXT",
  "REPRODUCE",
  "PATCH",
  "VERIFY",
  "REVIEW",
  "DONE",
];

function statusTone(status: string): string {
  if (status === "FIXED_VERIFIED") return "text-prove border-prove/40 bg-prove/10";
  if (status === "NOT_REPRODUCIBLE") return "text-blue border-blue/40 bg-blue/10";
  if (status === "RUNNING") return "text-warn border-warn/40 bg-warn/10";
  if (status === "INFRA_ERROR" || status === "BROKE_FUNCTION") {
    return "text-red border-red/40 bg-red/10";
  }
  return "text-mute border-line bg-paper-2";
}

function summarize(event: HarnessEvent): string {
  switch (event.type) {
    case "run_start":
      return `${event.condition} · ${event.taskId}`;
    case "state_change":
      return `${event.from} → ${event.to}`;
    case "role_assigned":
      return `${event.role} · ${event.runner}`;
    case "tool_call":
      return event.name;
    case "tool_result":
      return event.name;
    case "gate":
      return event.phase === "reproduce"
        ? `reproduce · ${event.reproduced ? "proved" : "not reproduced"}`
        : `verify · ${event.passed ? "pass" : "fail"}`;
    case "diff_snapshot":
      return `diff · ${event.patch.split("\n").length} lines`;
    case "grade":
      return `grade · neutralized=${event.metrics.exploitNeutralized} functional=${event.metrics.functionalPass} Δ${event.metrics.diffLineCount}`;
    case "run_end":
      return event.status;
    default:
      return event.type;
  }
}

function currentState(events: HarnessEvent[]): EngineState {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "state_change") return e.to;
  }
  return "INIT";
}

function lastGate(events: HarnessEvent[], phase: "reproduce" | "verify"): GateEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "gate" && e.phase === phase) return e;
  }
  return null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function App() {
  const [view, setView] = useState<View>("studio");
  return (
    <div className="min-h-screen">
      <header className="border-b border-line px-6 py-4 flex items-end justify-between gap-6">
        <div>
          <div className="font-mono text-[11px] tracking-[0.28em] text-mute uppercase">
            proof-carrying fixes
          </div>
          <h1 className="font-mono text-2xl tracking-tight mt-1">
            VOUCH
            <span className="text-mute font-sans text-sm ml-3 tracking-normal">
              every security fix, proven
            </span>
          </h1>
        </div>
        <nav className="flex gap-1 font-mono text-xs">
          {(["studio", "bench"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 border ${
                view === v ? "border-ink text-ink bg-paper" : "border-line text-mute hover:text-ink"
              }`}
            >
              {v}
            </button>
          ))}
        </nav>
      </header>
      {view === "studio" ? <Studio /> : <Bench />}
    </div>
  );
}

function Studio() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [taskId, setTaskId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.runs().then(setRuns).catch((e) => setError(String(e)));

  useEffect(() => {
    api.tasks("dev").then((t) => {
      setTasks(t);
      setTaskId((cur) => cur || t[0]?.id || "");
    });
    refresh();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setEvents([]);
    return subscribeRun(
      activeId,
      (e) => setEvents((prev) => [...prev, e]),
      () => {
        setBusy(false);
        refresh();
      },
    );
  }, [activeId]);

  const start = async (condition: "B" | "C") => {
    if (!taskId) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.startRun({ taskId, condition });
      setActiveId(runId);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const end = events.find((e) => e.type === "run_end");
  const startEv = events.find((e) => e.type === "run_start");
  const state = currentState(events);
  const repro = lastGate(events, "reproduce");
  const verify = lastGate(events, "verify");
  const grade = [...events].reverse().find((e) => e.type === "grade");
  const selected = tasks.find((t) => t.id === taskId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_300px] gap-px bg-line min-h-[calc(100vh-73px)]">
      <aside className="bg-paper p-4 space-y-4">
        <h2 className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase">dev tasks</h2>
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setTaskId(t.id)}
                className={`w-full text-left px-3 py-2 border ${
                  taskId === t.id ? "border-ink bg-paper-2" : "border-transparent hover:border-line"
                }`}
              >
                <div className="font-mono text-sm">{t.id}</div>
                <div className="text-[11px] text-mute">
                  {t.kind} · {t.group}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <p className="text-[12px] text-mute leading-relaxed border-t border-line pt-3">
            {selected.report.text.slice(0, 220)}
            {selected.report.text.length > 220 ? "…" : ""}
          </p>
        )}
        <div className="flex gap-2">
          <button
            disabled={busy || !taskId}
            onClick={() => start("B")}
            className="flex-1 font-mono text-xs py-2 border border-line hover:border-ink disabled:opacity-40"
          >
            run B
          </button>
          <button
            disabled={busy || !taskId}
            onClick={() => start("C")}
            className="flex-1 font-mono text-xs py-2 border border-red/60 text-red hover:bg-red/10 disabled:opacity-40"
          >
            run C
          </button>
        </div>
        <h2 className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase pt-2">recent</h2>
        <ul className="space-y-1 max-h-64 overflow-auto">
          {runs.slice(0, 12).map((r) => (
            <li key={r.runId}>
              <button
                onClick={() => {
                  setActiveId(r.runId);
                  setBusy(false);
                }}
                className="w-full text-left px-2 py-1.5 hover:bg-paper-2"
              >
                <div className="font-mono text-[11px] truncate">{r.taskId}</div>
                <div className="text-[10px] text-mute">
                  {r.condition} · {r.status}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="bg-[#111110] p-5 flex flex-col gap-4 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-sm">
            {startEv && startEv.type === "run_start"
              ? `${startEv.taskId} · ${startEv.condition}`
              : activeId ?? "no run selected"}
          </div>
          {end && end.type === "run_end" && (
            <span className={`font-mono text-[11px] px-2 py-1 border ${statusTone(end.status)}`}>
              {end.status}
            </span>
          )}
          {busy && !end && (
            <span className={`font-mono text-[11px] px-2 py-1 border ${statusTone("RUNNING")}`}>
              RUNNING
            </span>
          )}
        </div>
        <ol className="flex flex-wrap gap-1">
          {STATES.map((s) => (
            <li
              key={s}
              className={`font-mono text-[10px] tracking-wide px-2 py-1 border ${
                s === state ? "border-ink text-ink bg-paper" : "border-line text-mute"
              }`}
            >
              {s}
            </li>
          ))}
        </ol>
        {error && <div className="text-red text-sm font-mono">{error}</div>}
        <div className="flex-1 border border-line bg-paper overflow-auto font-mono text-[12px] leading-6">
          {events.length === 0 && (
            <div className="p-4 text-mute">Start a run, or replay one from the left.</div>
          )}
          {events.map((e) => (
            <div
              key={`${e.runId}-${e.seq}`}
              className={`px-3 py-0.5 border-b border-line/60 flex gap-3 ${
                e.type === "gate"
                  ? "bg-prove/5"
                  : e.type === "role_assigned" && "role" in e && e.role === "red"
                    ? "bg-red/5"
                    : e.type === "role_assigned" && "role" in e && e.role === "blue"
                      ? "bg-blue/5"
                      : ""
              }`}
            >
              <span className="text-mute w-8 shrink-0">{String(e.seq).padStart(2, "0")}</span>
              <span className="text-mute w-28 shrink-0">{e.type}</span>
              <span className="truncate">{summarize(e)}</span>
            </div>
          ))}
        </div>
      </main>

      <aside className="bg-paper p-4 space-y-4">
        <h2 className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase">gate</h2>
        <GateCard
          title="REPRODUCE"
          body={
            repro && repro.phase === "reproduce"
              ? repro.reproduced
                ? `proved in ${repro.submissions} submit(s)`
                : `not reproduced · ${repro.submissions} submit(s) · no patch`
              : "waiting"
          }
          tone={
            repro && repro.phase === "reproduce" ? (repro.reproduced ? "prove" : "blue") : "mute"
          }
        />
        <GateCard
          title="VERIFY"
          body={
            verify && verify.phase === "verify"
              ? `poc ${verify.pocNeutralized ? "dead" : "live"} · tests ${verify.functionalPassed ? "pass" : "fail"}`
              : "waiting"
          }
          tone={verify && verify.phase === "verify" ? (verify.passed ? "prove" : "red") : "mute"}
        />
        <h2 className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase pt-2">grader</h2>
        {grade && grade.type === "grade" ? (
          <dl className="font-mono text-xs space-y-1">
            <Row k="neutralized" v={String(grade.metrics.exploitNeutralized)} />
            <Row k="functional" v={String(grade.metrics.functionalPass)} />
            <Row k="diff lines" v={String(grade.metrics.diffLineCount)} />
            <Row k="guarded" v={String(grade.metrics.guardedFilesTouched)} />
          </dl>
        ) : (
          <div className="text-mute text-xs">not graded yet</div>
        )}
      </aside>
    </div>
  );
}

function GateCard({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: "prove" | "blue" | "red" | "mute";
}) {
  const cls =
    tone === "prove"
      ? "border-prove/50 text-prove"
      : tone === "blue"
        ? "border-blue/50 text-blue"
        : tone === "red"
          ? "border-red/50 text-red"
          : "border-line text-mute";
  return (
    <div className={`border px-3 py-3 ${cls}`}>
      <div className="font-mono text-[10px] tracking-[0.2em]">{title}</div>
      <div className="text-sm mt-1 text-ink">{body}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-mute">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Bench() {
  const [report, setReport] = useState<BenchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.benchLatest().then(setReport).catch(() => undefined);
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.runBench());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cells = report?.cells ?? [];

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-mono text-lg">dev set · B vs C</h2>
          <p className="text-mute text-sm mt-1 max-w-xl">
            Verified-fix rate on vuln tasks (up is better). Over-fix rate on controls (down is
            better). Same model, tools, budget; only the harness differs.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={run}
          className="font-mono text-xs px-4 py-2 border border-ink hover:bg-paper disabled:opacity-40"
        >
          {busy ? "running…" : "cli bench --set dev"}
        </button>
      </div>
      {error && <div className="text-red font-mono text-sm">{error}</div>}
      {report?.scripted && (
        <div className="border border-warn/40 text-warn font-mono text-xs px-3 py-2">
          scripted runner — pipeline wiring, not a live-model score
        </div>
      )}
      <div className="overflow-auto border border-line">
        <table className="w-full font-mono text-sm">
          <thead className="bg-paper text-mute text-[11px] tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">cond</th>
              <th className="text-left px-3 py-2">verified-fix</th>
              <th className="text-left px-3 py-2">over-fix</th>
              <th className="text-left px-3 py-2">broke</th>
              <th className="text-left px-3 py-2">infra</th>
              <th className="text-left px-3 py-2">mean ms</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((c) => (
              <tr key={c.condition} className="border-t border-line">
                <td className="px-3 py-3">{c.condition}</td>
                <td className="px-3 py-3 text-prove">
                  {c.verifiedFix}/{c.nVuln} ({pct(c.verifiedFixRate)})
                </td>
                <td className="px-3 py-3 text-red">
                  {c.overFix}/{c.nControl} ({pct(c.overFixRate)})
                </td>
                <td className="px-3 py-3">{c.brokeFunction}</td>
                <td className="px-3 py-3">{c.infraError}</td>
                <td className="px-3 py-3">{c.meanElapsedMs}</td>
              </tr>
            ))}
            {cells.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-mute">
                  No report yet. Run the bench.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Scatter cells={cells} />
      {report && (
        <ul className="font-mono text-[11px] text-mute space-y-1 max-h-72 overflow-auto border border-line p-3 bg-paper">
          {report.runs.map((r) => (
            <li key={r.runId}>
              {r.condition} {r.taskId.padEnd(24, " ")} {r.status}
              {r.scripted ? "  [scripted]" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Scatter({ cells }: { cells: BenchReport["cells"] }) {
  const points = useMemo(
    () =>
      cells.map((c) => ({
        condition: c.condition,
        x: c.overFixRate,
        y: c.verifiedFixRate,
      })),
    [cells],
  );
  if (points.length === 0) return null;
  return (
    <div>
      <h3 className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase mb-2">
        2d · over-fix → · verified-fix ↑
      </h3>
      <svg viewBox="0 0 320 220" className="w-full max-w-md border border-line bg-paper">
        <line x1="40" y1="190" x2="300" y2="190" stroke="#2e2c28" />
        <line x1="40" y1="20" x2="40" y2="190" stroke="#2e2c28" />
        <text x="160" y="212" fill="#8a8478" fontSize="9" fontFamily="IBM Plex Mono">
          over-fix rate
        </text>
        <text
          x="12"
          y="110"
          fill="#8a8478"
          fontSize="9"
          fontFamily="IBM Plex Mono"
          transform="rotate(-90 12 110)"
        >
          verified-fix
        </text>
        {points.map((p) => {
          const cx = 40 + p.x * 250;
          const cy = 190 - p.y * 160;
          const fill = p.condition === "C" ? "#c23b22" : "#3d6b8a";
          return (
            <g key={p.condition}>
              <circle cx={cx} cy={cy} r="6" fill={fill} />
              <text x={cx + 10} y={cy + 4} fill={fill} fontSize="11" fontFamily="IBM Plex Mono">
                {p.condition}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
