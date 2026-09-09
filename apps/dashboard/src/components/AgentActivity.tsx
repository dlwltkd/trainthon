import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, Circle, FileCode2, GitBranch, ListChecks, MessageSquareText, Play, Puzzle, Terminal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { groupActivity, roleLabel, resolveEvidence, STAGE_LABEL, type EvidenceTarget, type ActivityItem, type DecisionItem, type RunView, type SkillItem, type ToolCallItem } from "@/lib/derive";
import { formatClock, formatDuration, stringify } from "@/lib/format";
import { Button, Chip, Empty, Mono, Panel, PanelHeader, RoleChip, Spinner } from "./ui";

export type { EvidenceTarget } from "@/lib/derive";

function EvidenceLinks({ references, view, files, onEvidence }: { references: string[]; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  if (references.length === 0) return <span className="text-[0.85em] text-ink-3">No evidence references supplied</span>;
  return <div className="flex flex-wrap gap-1.5">{references.map((reference, index) => {
    const target = resolveEvidence(reference, view, files);
    return target ? <button key={`${reference}-${index}`} onClick={() => onEvidence(target)} className="inline-flex max-w-full items-center gap-1 rounded-md border border-info/20 bg-info-soft/50 px-2 py-1 text-[0.82em] text-info hover:bg-info-soft" title={reference}><FileCode2 className="size-3 shrink-0" /><span className="truncate font-mono">{reference}</span></button> : <span key={`${reference}-${index}`} className="max-w-full break-words rounded-md bg-canvas px-2 py-1 font-mono text-[0.82em] text-ink-2">{reference}</span>;
  })}</div>;
}

export function AgentIntent({ view, files, onEvidence }: { view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  const decision = view.currentDecision;
  const invokedModel = view.usage.modelTurns > 0;
  const latestNote = [...view.activity].reverse().find((item) => item.kind === "note" && !item.final);
  const active = view.status === "RUNNING";
  return <div className="flex flex-col gap-3">
    <Panel className="overflow-hidden">
      <PanelHeader title={<><MessageSquareText className="size-3.5" /> {active ? "Current intention" : "Last agent decision"}</>} aside={decision && <RoleChip role={decision.agentRole} />} />
      <div className="space-y-3 p-4">
        {decision ? <>
          <p className="leading-relaxed text-ink">{decision.summary}</p>
          <div className="rounded-lg bg-info-soft/60 p-3"><div className="mb-1 flex items-center gap-1.5 text-[0.8em] font-semibold uppercase tracking-wide text-info"><ArrowRight className="size-3.5" /> Next action {active ? "" : "· at this point in the run"}</div><p className="text-[0.94em] text-ink-2">{decision.nextAction}</p></div>
          <EvidenceLinks references={decision.evidence} view={view} files={files} onEvidence={onEvidence} />
          <p className="text-[0.78em] text-ink-3">Agent-reported decision summary · event #{decision.seq}</p>
        </> : <>
          <p className="font-medium">{!active && !invokedModel ? (view.mode === "scripted" ? "Scripted run · no model invoked" : "No model invoked") : invokedModel ? "Awaiting an agent decision update" : "Harness checks are running"}</p>
          <p className="text-[0.9em] leading-relaxed text-ink-2">{view.status === "NOT_REPRODUCIBLE" && !invokedModel ? "The supplied regression already passed. The harness finished before calling a model or requesting a patch." : active && latestNote?.kind === "note" ? latestNote.text : !invokedModel ? "This record contains no model turns. Test results and harness actions are shown in the activity feed." : "This record does not contain structured decision updates."}</p>
        </>}
        {view.currentAction && <div className="flex items-start gap-2 border-t border-line pt-3 text-[0.87em]"><Spinner className="mt-0.5 size-3 shrink-0 text-info" /><div className="min-w-0"><span className="font-medium text-info">Tool in progress</span><p className="mt-0.5 break-words text-ink-2">{view.currentAction.summary}</p></div></div>}
      </div>
    </Panel>
    <Panel className="overflow-hidden">
      <PanelHeader title={<><ListChecks className="size-3.5" /> Agent plan</>} aside={decision?.plan.length ? <Chip>{decision.plan.filter((step) => step.status === "completed").length}/{decision.plan.length}</Chip> : undefined} />
      {decision?.plan.length ? <ol className="space-y-3 p-4">{decision.plan.map((step) => <li key={step.id} className="flex items-start gap-2.5"><span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full", step.status === "completed" ? "bg-pass-soft text-pass" : step.status === "in_progress" ? "bg-info-soft text-info" : "text-ink-3")}>{step.status === "completed" ? <Check className="size-3" /> : step.status === "in_progress" ? <Play className="size-2.5 fill-current" /> : <Circle className="size-3" />}</span><div><p className={cn("text-[0.9em] leading-relaxed", step.status === "pending" && "text-ink-3")}>{step.title}</p><span className="text-[0.75em] text-ink-3">{step.status.replace(/_/g, " ")}</span></div></li>)}</ol> : <p className="p-4 text-[0.88em] leading-relaxed text-ink-3">No agent plan has been reported. The stage rail above shows the harness workflow.</p>}
    </Panel>
    <Panel className="overflow-hidden">
      <PanelHeader title={<><Puzzle className="size-3.5" /> Skills</>} aside={<Chip>{view.skills.length} calls</Chip>} />
      <div className="space-y-3 p-4">
        {view.skills.length ? view.skills.map((skill) => <div key={skill.id} className="space-y-1.5"><div className="flex items-center gap-2"><RoleChip role={skill.agentRole} /><Mono className="break-all font-medium">{skill.skillId}</Mono></div><div className="text-[0.8em] text-ink-3">v{skill.version} · {STAGE_LABEL[skill.stage]}</div><p className="text-[0.87em] leading-relaxed text-ink-2">{skill.reason}</p></div>) : <p className="text-[0.88em] text-ink-3">No skill calls recorded.</p>}
        {view.guidance.length > 0 && <details className="border-t border-line pt-3"><summary className="cursor-pointer text-[0.82em] text-ink-3">Configured guidance · {view.guidance.length}</summary><div className="mt-2 space-y-2">{view.guidance.map((guidance) => <div key={guidance.id} className="text-[0.8em] text-ink-2"><Mono>{guidance.guidanceId}</Mono><div className="mt-0.5 text-ink-3">v{guidance.version} · {roleLabel(guidance.agentRole)}</div></div>)}</div></details>}
      </div>
    </Panel>
  </div>;
}

export function AgentActivity({ view, files, onEvidence }: { view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<"all" | "agent" | "tests">("all");
  const scroller = useRef<HTMLDivElement>(null);
  const items = view.activity.filter((item) => filter === "all" || (filter === "agent" ? ["tool", "decision", "skill", "handoff", "note", "guidance", "change"].includes(item.kind) : ["check", "end", "grade"].includes(item.kind)));
  useEffect(() => { if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [view.eventCount, follow]);
  return <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <PanelHeader title={<><GitBranch className="size-3.5" /> Agent activity</>} aside={<><span className="secondary text-[0.8em] text-ink-3">{view.eventCount} events</span><Button size="sm" variant={follow ? "default" : "ghost"} onClick={() => setFollow(!follow)} aria-pressed={follow}><ArrowDown className="size-3" /> Follow</Button></>} />
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2" role="group" aria-label="Activity filter">{(["all", "agent", "tests"] as const).map((value) => <button key={value} onClick={() => setFilter(value)} aria-pressed={filter === value} className={cn("rounded-md px-2.5 py-1 text-[0.8em] font-medium capitalize", filter === value ? "bg-ink text-white" : "text-ink-3 hover:bg-canvas")}>{value === "tests" ? "Tests & gates" : value}</button>)}<span className="ml-auto text-[0.78em] text-ink-3">Recorded events only</span></div>
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Agent activity events">
      {items.length === 0 && <Empty title="No matching activity yet" hint="Events appear here as the harness and agent work." />}
      <ol className="space-y-3">{groupActivity(items).map((item) => <li key={item.id} id={`activity-${item.id}`} className="scroll-mt-3">
        {item.kind === "group" ? <details className="rounded-lg border border-line bg-canvas/50 p-3"><summary className="flex cursor-pointer list-none items-center gap-2 text-[0.9em]"><ChevronDown className="size-3.5 text-ink-3" /><RoleChip role={item.agentRole} /> Inspected the repository <Chip>{item.items.length} calls</Chip></summary><div className="mt-3 space-y-3">{item.items.map((tool) => <div key={tool.id} id={`activity-${tool.id}`}><ToolCard item={tool} files={files} onEvidence={onEvidence} /></div>)}</div></details> : <ActivityCard item={item} view={view} files={files} onEvidence={onEvidence} />}
      </li>)}</ol>
    </div>
  </Panel>;
}

function ActivityCard({ item, view, files, onEvidence }: { item: ActivityItem; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  if (item.kind === "stage") return <div className="flex items-center gap-2 py-1 text-[0.78em] font-medium uppercase tracking-wide text-ink-3"><span className="h-px flex-1 bg-line" /><span>{STAGE_LABEL[item.to]}</span><span className="font-mono">{formatClock(item.ts - view.startedAt)}</span><span className="h-px flex-1 bg-line" /></div>;
  if (item.kind === "tool") return <ToolCard item={item} files={files} onEvidence={onEvidence} />;
  if (item.kind === "decision") return <DecisionCard item={item} view={view} files={files} onEvidence={onEvidence} />;
  if (item.kind === "skill") return <SkillCard item={item} />;
  if (item.kind === "guidance") return <div className="flex flex-wrap items-center gap-2 px-1 text-[0.82em] text-ink-3"><Puzzle className="size-3.5" /> Guidance configured <Mono>{item.guidanceId}</Mono><span>v{item.version}</span></div>;
  if (item.kind === "handoff") return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3"><RoleChip role={item.role} /><span className="text-[0.9em]">{item.from ? `${roleLabel(item.from)} → ${roleLabel(item.role)}` : `${roleLabel(item.role)} assigned`}</span><Mono className="text-[0.85em] text-ink-2">{item.model ?? item.runner}</Mono>{item.provider && <span className="text-[0.78em] text-ink-3">via {item.provider}</span>}</div>;
  if (item.kind === "note") return <div className="flex gap-2 px-1"><MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-ink-3" /><div><div className="mb-1 flex items-center gap-2"><span className="text-[0.78em] font-medium text-ink-3">{item.agentRole ? `${roleLabel(item.agentRole)} ${item.final ? "summary" : "update"}` : "Harness"}</span><span className="font-mono text-[0.72em] text-ink-3">{formatClock(item.ts - view.startedAt)}</span></div><p className="whitespace-pre-wrap text-[0.9em] leading-relaxed text-ink-2">{item.text}</p></div></div>;
  if (item.kind === "change") return <button onClick={() => onEvidence({ kind: "file", value: item.path })} className="flex w-full items-center gap-2 rounded-lg border border-line p-3 text-left"><FileCode2 className="size-3.5 text-blue-role" /><Mono className="min-w-0 flex-1 truncate">{item.path}</Mono><span className="font-mono text-[0.8em] text-pass">+{item.additions}</span><span className="font-mono text-[0.8em] text-fail">−{item.deletions}</span></button>;
  if (item.kind === "check") return <div className={cn("rounded-lg border p-3", item.status === "failed" ? "border-fail/25 bg-fail-soft/30" : item.status === "passed" ? "border-pass/25 bg-pass-soft/30" : "border-line bg-canvas/40")}><div className="flex items-start gap-2"><span className="mt-0.5">{item.status === "failed" ? <X className="size-3.5 text-fail" /> : item.status === "passed" ? <Check className="size-3.5 text-pass" /> : <ListChecks className="size-3.5 text-info" />}</span><div className="min-w-0 flex-1"><p className="text-[0.9em] font-medium">{item.label}</p>{item.detail && <p className="mt-1 text-[0.82em] text-ink-2">{item.detail}</p>}{item.test && <button className="mt-2 text-[0.8em] font-medium text-info hover:underline" onClick={() => onEvidence({ kind: "test", value: item.test!.phase })}>Open test evidence →</button>}</div>{item.durationMs !== undefined && <Mono className="text-[0.78em] text-ink-3">{formatDuration(item.durationMs)}</Mono>}</div></div>;
  if (item.kind === "end") return <div className="rounded-lg border border-line bg-canvas p-3"><div className="mb-1 text-[0.8em] font-semibold uppercase tracking-wide text-ink-3">Run finished · {formatDuration(item.elapsedMs)}</div><p className="text-[0.92em] font-medium">{item.status.replace(/_/g, " ")}</p>{item.reason && <p className="mt-1 text-[0.85em] text-ink-2">{item.reason}</p>}</div>;
  return <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-[0.9em]">Recorded grade</summary><pre className="code mt-2 overflow-auto">{stringify(item.metrics)}</pre></details>;
}

export function DecisionCard({ item, view, files, onEvidence }: { item: DecisionItem; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  return <div className="space-y-2.5 rounded-lg border border-info/25 bg-info-soft/25 p-3.5"><div className="flex items-center gap-2"><MessageSquareText className="size-3.5 text-info" /><span className="text-[0.85em] font-semibold">Decision update</span><RoleChip role={item.agentRole} /><span className="ml-auto font-mono text-[0.72em] text-ink-3">#{item.seq}</span></div><p className="whitespace-pre-wrap text-[0.93em] leading-relaxed">{item.summary}</p><div className="flex items-start gap-2 text-[0.87em] text-ink-2"><ArrowRight className="mt-0.5 size-3.5 shrink-0 text-info" /><p><span className="font-medium">Next: </span>{item.nextAction}</p></div><EvidenceLinks references={item.evidence} view={view} files={files} onEvidence={onEvidence} /></div>;
}

export function SkillCard({ item }: { item: SkillItem }) {
  return <div className="space-y-2 rounded-lg border border-blue-role/20 p-3"><div className="flex flex-wrap items-center gap-2"><Puzzle className="size-3.5 text-blue-role" /><span className="text-[0.85em] font-semibold">Skill invoked</span><RoleChip role={item.agentRole} /><Mono className="break-all">{item.skillId}</Mono><Chip>v{item.version}</Chip></div><p className="text-[0.88em] leading-relaxed text-ink-2">{item.reason}</p><div className="text-[0.75em] text-ink-3">{STAGE_LABEL[item.stage]} · call <Mono>{item.callId}</Mono></div></div>;
}

function ToolCard({ item, files, onEvidence }: { item: ToolCallItem; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  const target = item.target && files.includes(item.target) ? item.target : undefined;
  return <div className={cn("rounded-lg border p-3", item.outcome === "running" ? "border-info/40 bg-info-soft/20" : item.outcome === "failed" ? "border-fail/25" : "border-line")}><div className="flex flex-wrap items-center gap-2">{item.outcome === "running" ? <Spinner className="size-3 text-info" /> : item.outcome === "failed" ? <X className="size-3.5 text-fail" /> : item.outcome === "unresolved" ? <Circle className="size-3.5 text-warn" /> : <Check className="size-3.5 text-pass" />}<Mono className="text-[0.85em] font-medium">{item.name}</Mono><RoleChip role={item.agentRole} /><span className="ml-auto font-mono text-[0.75em] text-ink-3">{item.durationMs !== undefined ? formatDuration(item.durationMs) : item.outcome === "unresolved" ? "no result recorded" : "in progress"}</span></div><p className="mt-2 break-words text-[0.9em] text-ink-2">{item.summary}</p>{target && <button onClick={() => onEvidence({ kind: "file", value: target })} className="mt-2 inline-flex max-w-full items-center gap-1 text-[0.82em] text-info hover:underline"><FileCode2 className="size-3 shrink-0" /><Mono className="truncate">{target}</Mono></button>}<details className="mt-2"><summary className="flex cursor-pointer list-none items-center gap-1 text-[0.77em] text-ink-3"><Terminal className="size-3" /> Arguments & result <ChevronDown className="size-3" /></summary><div className="mt-2 space-y-2 rounded-md bg-canvas p-2.5"><div className="text-[0.72em] font-medium uppercase tracking-wide text-ink-3">Call ID · <Mono>{item.id}</Mono></div><pre className="code max-h-56 overflow-auto whitespace-pre-wrap break-words">{stringify(item.args, 8000)}</pre>{item.result !== undefined && <><div className="border-t border-line pt-2 text-[0.72em] uppercase tracking-wide text-ink-3">Result{item.truncated ? " · truncated by harness" : ""}</div><pre className="code max-h-56 overflow-auto whitespace-pre-wrap break-words">{stringify(item.result, 8000)}</pre></>}{item.error && <p className="whitespace-pre-wrap text-[0.85em] text-fail">{item.error}</p>}</div></details></div>;
}
