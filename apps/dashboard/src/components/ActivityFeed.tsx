import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileDiff,
  Flag,
  FlaskConical,
  Locate,
  MessageSquareText,
  Puzzle,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { AgentRole, EngineState } from "@vouch/protocol";
import { cn } from "@/lib/cn";
import {
  STAGE_LABEL,
  statusLabel,
  groupActivity,
  roleLabel,
  statusTone,
  type ActivityItem,
  type CheckItem,
  type FeedEntry,
  type RunView,
  type ToolCallItem,
  type EvidenceTarget,
} from "@/lib/derive";
import { formatDuration, formatTime, stringify } from "@/lib/format";
import { Button, Chip, Mono, RoleChip } from "./ui";
import { DecisionCard, SkillCard } from "./AgentActivity";
import { FindingCard } from "./FindingsPanel";
import { MarkdownSummary } from "./MarkdownSummary";
import { ModelRequest } from "./ModelRequest";

export interface FeedSelection {
  openFile: (path: string) => void;
  openDiff: (path?: string) => void;
  openEvidence: (phase?: string) => void;
}

export function ActivityFeed({ view, files, now, live, actions }: { view: RunView; files: string[]; now: number; live: boolean; actions: FeedSelection }) {
  const entries = useMemo(() => groupActivity(view.activity), [view.activity]);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const lastSeq = view.activity.at(-1)?.seq;

  useEffect(() => {
    if (!follow || !scroller.current) return;
    scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [follow, lastSeq]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (!atBottom && follow) setFollow(false);
    if (atBottom && !follow) setFollow(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <NowCard view={view} now={now} live={live} />
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} view={view} files={files} actions={actions} now={now} />
          ))}
        </ol>
        {view.status === "RUNNING" && (
          <div className="flex items-center gap-2 py-3 pl-2 text-[0.85em] text-ink-3">
            <span className="relative inline-block size-1.5 rounded-full bg-info pulse-dot" />
            {live ? "waiting for the next event" : "run ended without a final event"}
          </div>
        )}
      </div>
      {!follow && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="sm" className="pointer-events-auto shadow-md" onClick={() => setFollow(true)}>
            <Locate className="size-3.5" /> Follow agent
          </Button>
        </div>
      )}
    </div>
  );
}

function NowCard({ view, now, live }: { view: RunView; now: number; live: boolean }) {
  const running = view.status === "RUNNING";
  const action = view.currentAction;
  const role = action?.agentRole ?? view.currentRole;
  const tone = statusTone(view.status);
  const runningSince = action && action.outcome === "running" ? Math.max(0, (live ? now : view.lastTs) - action.ts) : undefined;
  const decision = view.currentDecision;
  const skill = [...view.skills].reverse().find((item) => item.agentRole === (decision?.agentRole ?? role));

  return (
    <div className="border-b border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2 text-[0.75em] font-semibold uppercase tracking-wider text-ink-3">
        {running ? (
          <>
            <span className="relative inline-block size-1.5 rounded-full bg-info pulse-dot" />
            Now · {STAGE_LABEL[view.currentStage]}
          </>
        ) : (
          <>
            <Flag className="size-3" />
            Finished · {STAGE_LABEL[view.currentStage]}
          </>
        )}
      </div>
      {running && action ? (
        <div className="mt-1 flex items-start gap-2">
          <RoleChip role={role} size="md" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[1.05em] font-medium tracking-tight">{action.summary}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[0.85em] text-ink-3">
              <Mono>{action.name}</Mono>
              {action.target && <Mono className="truncate text-ink-2">{action.target}</Mono>}
              {runningSince !== undefined && <span className="ml-auto font-mono tabular-nums">{formatDuration(runningSince)}</span>}
            </div>
          </div>
        </div>
      ) : running && view.currentModel ? (
        <div className="mt-2"><ModelRequest request={view.currentModel} now={live ? now : view.lastTs} live={live} /></div>
      ) : running ? (
        <div className="mt-1 flex items-center gap-2 text-[1.05em] font-medium tracking-tight text-ink-2">
          <CircleDashed className="size-4 animate-spin text-ink-3" style={{ animationDuration: "3s" }} />
          Harness is working…
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <Chip tone={tone} dot className="px-2 py-1 text-[0.95em] uppercase tracking-wide">
            {statusLabel(view.status, view.reason)}
          </Chip>
          <span className="truncate text-[0.9em] text-ink-2">{view.reason}</span>
        </div>
      )}
      {decision && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-[0.85em]">
          <div className="flex items-center gap-1.5 text-ink-3"><MessageSquareText className="size-3" /> Decision summary <RoleChip role={decision.agentRole} /></div>
          <p className="line-clamp-3 leading-relaxed text-ink-2">{decision.summary}</p>
          <p className="line-clamp-2 text-ink-2"><span className="font-medium text-info">Next: </span>{decision.nextAction}</p>
          {skill && <div className="flex items-center gap-1.5 text-[0.9em] text-ink-3"><Puzzle className="size-3 shrink-0" /><Mono className="truncate">{skill.skillId}</Mono><span className="shrink-0">v{skill.version}</span></div>}
        </div>
      )}
      {!running && view.usage.modelTurns === 0 && !decision && <p className="mt-2 text-[0.83em] text-ink-3">{view.mode === "scripted" ? "Scripted run · no model invoked." : "No model invoked."}{view.status === "NOT_REPRODUCIBLE" ? " The supplied regression already passed." : ""}</p>}
    </div>
  );
}

function Entry({ entry, view, files, actions, now }: { entry: FeedEntry; view: RunView; files: string[]; actions: FeedSelection; now: number }) {
  const onEvidence = (target: EvidenceTarget) => {
    if (target.kind === "file") actions.openFile(target.value);
    else if (target.kind === "test") actions.openEvidence(target.value);
    else [...document.querySelectorAll<HTMLElement>("[data-activity-id]")].find((node) => node.dataset.activityId === target.value && node.getClientRects().length > 0)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  switch (entry.kind) {
    case "model":
      return <Row id={entry.id} icon={<CircleDashed className="size-3.5" />} accent={entry.agentRole}><ModelRequest request={entry} now={view.status === "RUNNING" ? now : view.lastTs} live={view.status === "RUNNING"} /></Row>;
    case "finding":
      return <Row id={entry.id} icon={<Search className="size-3.5" />} accent={entry.agentRole}><FindingCard finding={entry} view={view} files={files} onEvidence={onEvidence} /></Row>;
    case "skill":
      return <Row id={entry.id} icon={<Puzzle className="size-3.5" />} accent={entry.agentRole}><SkillCard item={entry} /></Row>;
    case "decision":
      return <Row id={entry.id} icon={<MessageSquareText className="size-3.5" />} accent={entry.agentRole}><DecisionCard item={entry} view={view} files={files} onEvidence={onEvidence} /></Row>;
    case "stage":
      return <StageDivider from={entry.from} to={entry.to} ts={entry.ts} start={view.startedAt} />;
    case "group":
      return <ExploreGroup items={entry.items} actions={actions} role={entry.agentRole} />;
    case "tool":
      return <ToolRow item={entry} actions={actions} now={now} live={view.status === "RUNNING"} />;
    case "check":
      return <CheckRow item={entry} actions={actions} />;
    case "handoff":
      return (
        <Row icon={<ArrowRight className="size-3.5" />} accent="harness" className="rise">
          <div className="flex flex-wrap items-center gap-1.5">
            {entry.from && (
              <>
                <RoleChip role={entry.from} />
                <ArrowRight className="size-3 text-ink-3" />
              </>
            )}
            <RoleChip role={entry.role} />
            <span className="text-ink-2">{entry.from ? "takes over" : "starts"}</span>
            <Mono className="text-ink-3">{entry.model ?? entry.runner}</Mono>
            {entry.provider && <span className="secondary text-[0.85em] text-ink-3">via {entry.provider}</span>}
          </div>
        </Row>
      );
    case "guidance":
      return (
        <Row icon={<BookOpenText className="size-3.5" />} accent="harness" className="rise">
          <div className="flex flex-wrap items-center gap-1.5 text-ink-2">
            <span>Guidance configured for</span>
            <RoleChip role={entry.agentRole} />
            <Mono className="text-ink">{entry.guidanceId}</Mono>
            <span className="secondary text-[0.85em] text-ink-3">v{entry.version}</span>
          </div>
        </Row>
      );
    case "note":
      return (
        <Row icon={<MessageSquareText className="size-3.5" />} accent={entry.agentRole} className="rise">
          <div className="flex items-start gap-1.5">
            <RoleChip role={entry.agentRole} className="mt-0.5" />
            {entry.final ? <MarkdownSummary text={entry.text} className="min-w-0 flex-1 text-ink" /> : <p className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed text-ink-2">{entry.text}</p>}
          </div>
        </Row>
      );
    case "change":
      return (
        <Row icon={<FileDiff className="size-3.5" />} accent={entry.agentRole} className="rise">
          <button onClick={() => actions.openDiff(entry.path)} className="flex w-full flex-wrap items-center gap-1.5 text-left hover:underline">
            <span className="text-ink-2">Changed</span>
            <Mono className="text-ink">{entry.path}</Mono>
            <span className="font-mono text-[0.85em] tabular-nums">
              <span className="text-pass">+{entry.additions}</span> <span className="text-fail">−{entry.deletions}</span>
            </span>
          </button>
        </Row>
      );
    case "grade":
      return (
        <Row icon={<ShieldCheck className="size-3.5" />} accent="harness" className="rise">
          <button onClick={() => actions.openEvidence()} className="flex w-full flex-wrap items-center gap-1.5 text-left">
            <span className="text-ink-2">Independent grade</span>
            <Chip tone={entry.metrics.exploitNeutralized ? "pass" : "fail"}>exploit {entry.metrics.exploitNeutralized ? "neutralized" : "alive"}</Chip>
            <Chip tone={entry.metrics.functionalPass ? "pass" : "fail"}>functional {entry.metrics.functionalPass ? "pass" : "fail"}</Chip>
            <span className="secondary font-mono text-[0.85em] text-ink-3">{entry.metrics.diffLineCount} diff lines</span>
          </button>
        </Row>
      );
    case "end":
      return (
        <Row icon={<Flag className="size-3.5" />} accent="harness" className="rise" last>
          <button onClick={() => actions.openEvidence()} className="flex w-full flex-col items-start gap-1 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={statusTone(entry.status)} dot className="uppercase tracking-wide">
                {statusLabel(entry.status, entry.reason)}
              </Chip>
              <span className="font-mono text-[0.85em] tabular-nums text-ink-3">{formatDuration(entry.elapsedMs)}</span>
            </div>
            {entry.reason && <span className="text-[0.9em] text-ink-2">{entry.reason}</span>}
          </button>
        </Row>
      );
  }
}

function StageDivider({ from, to, ts, start }: { from: EngineState; to: EngineState; ts: number; start: number }) {
  return (
    <li className="flex items-center gap-2 pt-4 pb-1.5 text-[0.75em] font-semibold uppercase tracking-wider text-ink-3">
      <span className="h-px flex-1 bg-line" />
      <span className="secondary">{STAGE_LABEL[from]}</span>
      <ArrowRight className="secondary size-3" />
      <span className="text-ink-2">{STAGE_LABEL[to]}</span>
      <span className="secondary font-mono font-normal normal-case tabular-nums">+{formatDuration(ts - start)}</span>
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

type Accent = AgentRole | "harness" | undefined;

function accentClass(accent: Accent): string {
  if (accent === "red") return "border-red-role/60 text-red-role";
  if (accent === "blue") return "border-blue-role/60 text-blue-role";
  if (accent === "solo") return "border-ink/40 text-ink-2";
  return "border-line-2 text-ink-3";
}

function Row({ id, icon, accent, children, className, last = false }: { id?: string; icon: ReactNode; accent: Accent; children: ReactNode; className?: string; last?: boolean }) {
  return (
    <li data-activity-id={id} className={cn("relative flex gap-2.5 py-1.5 pl-1", className)}>
      {!last && <span className="absolute top-7 bottom-[-6px] left-[13px] w-px bg-line" />}
      <span className={cn("relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-panel", accentClass(accent))}>{icon}</span>
      <div className="min-w-0 flex-1 text-[0.95em]">{children}</div>
    </li>
  );
}

function toolIcon(name: string): ReactNode {
  if (name === "grep" || name === "search") return <Search className="size-3.5" />;
  if (name.startsWith("run_") || name === "submit_repro") return <FlaskConical className="size-3.5" />;
  if (name === "write_file" || name === "apply_patch" || name === "apply_supplied_patch") return <FileDiff className="size-3.5" />;
  if (name === "run_cmd") return <Terminal className="size-3.5" />;
  return <Wrench className="size-3.5" />;
}

function OutcomeMark({ outcome }: { outcome: ToolCallItem["outcome"] }) {
  if (outcome === "running") return <span className="relative inline-block size-1.5 rounded-full bg-info pulse-dot" aria-label="running" />;
  if (outcome === "failed") return <X className="size-3.5 text-fail" strokeWidth={3} aria-label="failed" />;
  if (outcome === "unresolved") return <CircleDashed className="size-3.5 text-warn" aria-label="no result recorded" />;
  return <Check className="size-3.5 text-pass" strokeWidth={3} aria-label="succeeded" />;
}

function shortResult(item: ToolCallItem): string | undefined {
  if (item.outcome === "unresolved") return "no result recorded";
  if (item.error) return item.error;
  const result = item.result;
  if (result === undefined) return undefined;
  if (typeof result === "string") return result.split("\n")[0]?.slice(0, 120);
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    if (typeof r.outcome === "string") return r.outcome.replace(/_/g, " ");
    if (typeof r.passed === "boolean") return r.passed ? "passed" : "failed";
    if (typeof r.failsNow === "boolean") return r.failsNow ? "fails on current code" : "does not fail";
    if (r.ok === true) return "ok";
    if (typeof r.content === "string") return `${r.content.split("\n").length} lines`;
    if (Array.isArray(r.entries)) return `${r.entries.length} entries`;
    if (Array.isArray(r.matches)) return `${r.matches.length} matches`;
    if (Array.isArray(result)) return `${result.length} items`;
  }
  return undefined;
}

function ToolRow({ item, actions, now, live }: { item: ToolCallItem; actions: FeedSelection; now: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = item.outcome === "running";
  const duration = running ? Math.max(0, (live ? now : item.ts) - item.ts) : item.durationMs;
  const canOpenFile = Boolean(item.target && (item.name === "read_file" || item.name === "write_file" || item.name === "apply_patch"));
  const result = shortResult(item);

  return (
    <Row id={item.id} icon={toolIcon(item.name)} accent={item.agentRole} className={cn("rise", running && "shimmer rounded-lg")}>
      <div className="flex items-start gap-2">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left" aria-expanded={open}>
          <div className="flex w-full items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate font-medium", item.outcome === "failed" && "text-fail")}>{item.summary}</span>
            <span className="secondary font-mono text-[0.8em] tabular-nums text-ink-3">{formatDuration(duration)}</span>
            <OutcomeMark outcome={item.outcome} />
          </div>
          <div className="flex w-full items-center gap-1.5 text-[0.85em] text-ink-3">
            <Mono className="rounded bg-zinc-100 px-1 text-ink-2">{item.name}</Mono>
            {result && <span className={cn("truncate", item.outcome === "failed" && "text-fail")}>{result}</span>}
            {item.truncated && <span className="secondary">truncated</span>}
            {open ? <ChevronDown className="ml-auto size-3 shrink-0" /> : <ChevronRight className="ml-auto size-3 shrink-0" />}
          </div>
        </button>
        {canOpenFile && (
          <button onClick={() => actions.openFile(item.target!)} className="secondary mt-0.5 shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[0.8em] text-ink-3 hover:bg-zinc-50 hover:text-ink" title={`open ${item.target}`}>
            open
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <Detail title="arguments" value={item.args} />
          {item.error ? <Detail title="error" value={item.error} tone="fail" /> : item.result !== undefined ? <Detail title="result" value={item.result} /> : running ? <div className="text-[0.85em] text-ink-3">running…</div> : null}
          <div className="secondary flex items-center gap-3 text-[0.8em] text-ink-3">
            <span>{formatTime(item.ts)}</span>
            <span>seq {item.seq}</span>
            {item.stage && <span>{STAGE_LABEL[item.stage]}</span>}
            <span>{roleLabel(item.agentRole)}</span>
            <Mono className="truncate">{item.id}</Mono>
          </div>
        </div>
      )}
    </Row>
  );
}

function Detail({ title, value, tone }: { title: string; value: unknown; tone?: "fail" }) {
  return (
    <div className={cn("overflow-hidden rounded-md border", tone === "fail" ? "border-fail/30" : "border-line")}>
      <div className={cn("border-b px-2 py-0.5 text-[0.75em] font-semibold uppercase tracking-wider", tone === "fail" ? "border-fail/20 bg-fail-soft text-fail" : "border-line bg-canvas text-ink-3")}>{title}</div>
      <pre className="code max-h-64 overflow-auto whitespace-pre-wrap p-2 text-ink-2">{stringify(value, 6000)}</pre>
    </div>
  );
}

function ExploreGroup({ items, actions, role }: { items: ToolCallItem[]; actions: FeedSelection; role: AgentRole | undefined }) {
  const [open, setOpen] = useState(false);
  const files = new Set(items.map((i) => i.target).filter(Boolean));
  const reads = items.filter((i) => i.name === "read_file").length;
  const searches = items.filter((i) => i.name === "grep" || i.name === "search").length;
  const lists = items.filter((i) => i.name === "list_dir").length;
  const parts = [reads && `${reads} read${reads === 1 ? "" : "s"}`, searches && `${searches} search${searches === 1 ? "" : "es"}`, lists && `${lists} listing${lists === 1 ? "" : "s"}`].filter(Boolean);
  const total = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
  const failed = items.filter((i) => i.outcome === "failed").length;

  return (
    <Row icon={<Search className="size-3.5" />} accent={role} className="rise">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full flex-col items-start gap-0.5 text-left" aria-expanded={open}>
        <div className="flex w-full items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">
            Explored {files.size} file{files.size === 1 ? "" : "s"}
          </span>
          <span className="secondary font-mono text-[0.8em] tabular-nums text-ink-3">{formatDuration(total)}</span>
          {failed ? <X className="size-3.5 text-fail" strokeWidth={3} /> : <Check className="size-3.5 text-pass" strokeWidth={3} />}
        </div>
        <div className="flex w-full items-center gap-1.5 text-[0.85em] text-ink-3">
          <span>{parts.join(" · ")}</span>
          {open ? <ChevronDown className="ml-auto size-3 shrink-0" /> : <ChevronRight className="ml-auto size-3 shrink-0" />}
        </div>
      </button>
      {open && (
        <ol className="mt-1.5 flex flex-col gap-0.5 border-l border-line pl-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5 py-0.5 text-[0.9em]">
              <OutcomeMark outcome={item.outcome} />
              <Mono className="rounded bg-zinc-100 px-1 text-[0.85em] text-ink-2">{item.name}</Mono>
              {item.target ? (
                <button onClick={() => (item.name === "read_file" ? actions.openFile(item.target!) : undefined)} className={cn("min-w-0 truncate font-mono text-[0.9em]", item.name === "read_file" ? "text-ink hover:underline" : "text-ink-2")}>
                  {item.target}
                </button>
              ) : (
                <span className="truncate text-ink-2">{item.summary}</span>
              )}
              <span className="secondary ml-auto font-mono text-[0.8em] tabular-nums text-ink-3">{formatDuration(item.durationMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </Row>
  );
}

function CheckRow({ item, actions }: { item: CheckItem; actions: FeedSelection }) {
  const toneClass = item.status === "passed" ? "text-pass" : item.status === "failed" ? "text-fail" : item.status === "warn" ? "text-warn" : "text-info";
  const icon = item.gate ? <ShieldCheck className="size-3.5" /> : <FlaskConical className="size-3.5" />;
  return (
    <Row icon={icon} accent="harness" className="rise">
      <button onClick={() => actions.openEvidence(item.test?.phase)} className="flex w-full flex-col items-start gap-0.5 text-left">
        <div className="flex w-full items-center gap-1.5">
          <Chip tone="neutral" className="secondary">
            harness
          </Chip>
          <span className={cn("min-w-0 flex-1 truncate font-medium", toneClass)}>{item.label}</span>
          {item.durationMs !== undefined && <span className="secondary font-mono text-[0.8em] tabular-nums text-ink-3">{formatDuration(item.durationMs)}</span>}
        </div>
        {item.detail && <div className="text-[0.85em] text-ink-3">{item.detail}</div>}
      </button>
    </Row>
  );
}

export function activityCount(items: ActivityItem[]): number {
  return items.filter((i) => i.kind === "tool").length;
}
