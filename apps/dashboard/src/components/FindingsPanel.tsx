import { SearchCheck } from "lucide-react";
import { isExternalAssessment, type EvidenceTarget, type FindingItem, type RunView } from "@/lib/derive";
import { pluralize } from "@/lib/format";
import { EvidenceLinks } from "./EvidenceLinks";
import { Chip, Empty, Mono, Panel, PanelHeader, RoleChip, type Tone } from "./ui";

const severityTone: Record<FindingItem["severity"], Tone> = { info: "info", low: "neutral", medium: "warn", high: "fail", critical: "fail" };

export function FindingCard({ finding, view, files, onEvidence }: { finding: FindingItem; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  const assessment = finding.agentRole === "red" ? view.assessments.get(finding.findingId) : undefined;
  return <article className="space-y-3 rounded-lg border border-line bg-panel p-3.5">
    <div className="flex flex-wrap items-center gap-1.5"><Chip tone={severityTone[finding.severity]}>{finding.severity}</Chip><Chip tone={finding.confidence === "confirmed" ? "info" : "warn"}>{isExternalAssessment(view) ? finding.agentRole === "red" ? finding.confidence === "confirmed" ? view.mode === "live" ? "실제 응답 확인" : "관찰 기록 있음" : "추가 확인 필요" : "근거 검토 완료" : finding.agentRole === "red" ? finding.confidence === "confirmed" ? "Source-supported claim" : "Candidate" : finding.confidence === "confirmed" ? "Confirmed in source" : "Potential"}</Chip><RoleChip role={finding.agentRole} /><Mono className="ml-auto text-[0.75em] text-ink-3">{finding.findingId}</Mono></div>
    <h3 className="text-[1em] font-semibold">{finding.title}</h3>
    <p className="whitespace-pre-wrap text-[0.9em] leading-relaxed text-ink-2">{finding.summary}</p>
    <div><div className="mb-1.5 text-[0.75em] font-semibold uppercase tracking-wide text-ink-3">{isExternalAssessment(view) ? view.mode === "live" ? "실시간 비식별 근거" : "기록된 비식별 근거" : "Recorded source evidence"}</div><EvidenceLinks references={finding.evidence} view={view} files={files} onEvidence={onEvidence} /></div>
    <div className="rounded-md bg-canvas p-2.5"><div className="mb-1 text-[0.75em] font-semibold uppercase tracking-wide text-ink-3">{isExternalAssessment(view) ? "권고" : "Recommendation"}</div><p className="whitespace-pre-wrap text-[0.88em] leading-relaxed text-ink-2">{finding.recommendation}</p></div>
    {finding.agentRole === "red" && <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2"><RoleChip role="blue" /><span className="text-[0.85em] font-semibold">{isExternalAssessment(view) ? "독립 검토" : "Independent assessment"}</span><Chip tone={assessment?.verdict === "confirmed" ? "info" : assessment?.verdict === "dismissed" ? "neutral" : "warn"}>{assessment ? isExternalAssessment(view) ? assessment.verdict === "confirmed" ? "확인" : assessment.verdict === "dismissed" ? "기각" : "미확정" : assessment.verdict : isExternalAssessment(view) ? "미검토" : "Not assessed"}</Chip></div>
      {assessment && <><p className="text-[0.88em] leading-relaxed text-ink-2">{assessment.summary}</p><EvidenceLinks references={assessment.evidence} view={view} files={files} onEvidence={onEvidence} />{assessment.blueFindingId && <p className="text-[0.78em] text-ink-3">Linked Blue finding: <Mono>{assessment.blueFindingId}</Mono></p>}</>}
    </div>}
  </article>;
}

export function FindingsPanel({ view, files, onEvidence }: { view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  const redCount = view.findings.filter((finding) => finding.agentRole === "red").length;
  const blueCount = view.findings.filter((finding) => finding.agentRole === "blue").length;
  const external = isExternalAssessment(view);
  return <Panel className="overflow-hidden"><PanelHeader title={<><SearchCheck className="size-3.5" /> {external ? "발견 사항" : "Findings"}</>} aside={redCount ? <span className="flex gap-1"><Chip tone="red">{external ? `Red ${redCount}건` : pluralize(redCount, "Red claim")}</Chip><Chip tone="blue">{external ? `Blue ${blueCount}건` : pluralize(blueCount, "Blue assessment")}</Chip></span> : <Chip>{view.findings.length}</Chip>} />
    {view.findings.length ? <div className="space-y-3 p-3">{view.findings.map((finding) => <FindingCard key={`${finding.agentRole}:${finding.findingId}`} finding={finding} view={view} files={files} onEvidence={onEvidence} />)}</div> : <Empty title="No structured findings recorded" hint="Findings appear when the agent reports an observation with source evidence." />}
  </Panel>;
}
