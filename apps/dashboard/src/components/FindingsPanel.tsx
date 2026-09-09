import { SearchCheck } from "lucide-react";
import { type EvidenceTarget, type FindingItem, type RunView } from "@/lib/derive";
import { EvidenceLinks } from "./EvidenceLinks";
import { Chip, Empty, Mono, Panel, PanelHeader, RoleChip, type Tone } from "./ui";

const severityTone: Record<FindingItem["severity"], Tone> = { info: "info", low: "neutral", medium: "warn", high: "fail", critical: "fail" };

export function FindingCard({ finding, view, files, onEvidence }: { finding: FindingItem; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  return <article className="space-y-3 rounded-lg border border-line bg-panel p-3.5">
    <div className="flex flex-wrap items-center gap-1.5"><Chip tone={severityTone[finding.severity]}>{finding.severity}</Chip><Chip tone={finding.confidence === "confirmed" ? "info" : "warn"}>{finding.confidence === "confirmed" ? "Confirmed in source" : "Potential"}</Chip><RoleChip role={finding.agentRole} /><Mono className="ml-auto text-[0.75em] text-ink-3">{finding.findingId}</Mono></div>
    <h3 className="text-[1em] font-semibold">{finding.title}</h3>
    <p className="whitespace-pre-wrap text-[0.9em] leading-relaxed text-ink-2">{finding.summary}</p>
    <div><div className="mb-1.5 text-[0.75em] font-semibold uppercase tracking-wide text-ink-3">Recorded source evidence</div><EvidenceLinks references={finding.evidence} view={view} files={files} onEvidence={onEvidence} /></div>
    <div className="rounded-md bg-canvas p-2.5"><div className="mb-1 text-[0.75em] font-semibold uppercase tracking-wide text-ink-3">Recommendation</div><p className="whitespace-pre-wrap text-[0.88em] leading-relaxed text-ink-2">{finding.recommendation}</p></div>
  </article>;
}

export function FindingsPanel({ view, files, onEvidence }: { view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  return <Panel className="overflow-hidden"><PanelHeader title={<><SearchCheck className="size-3.5" /> Findings</>} aside={<Chip>{view.findings.length}</Chip>} />
    {view.findings.length ? <div className="space-y-3 p-3">{view.findings.map((finding) => <FindingCard key={finding.findingId} finding={finding} view={view} files={files} onEvidence={onEvidence} />)}</div> : <Empty title="No structured findings recorded" hint="Findings appear when the agent reports an observation with source evidence." />}
  </Panel>;
}
