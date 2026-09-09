import { FileCode2 } from "lucide-react";
import { resolveEvidence, type EvidenceTarget, type RunView } from "@/lib/derive";

export function EvidenceLinks({ references, view, files, onEvidence }: { references: string[]; view: RunView; files: string[]; onEvidence: (target: EvidenceTarget) => void }) {
  if (references.length === 0) return <span className="text-[0.85em] text-ink-3">No evidence references supplied</span>;
  return <div className="flex flex-wrap gap-1.5">{references.map((reference, index) => {
    const target = resolveEvidence(reference, view, files);
    return target ? <button key={`${reference}-${index}`} onClick={() => onEvidence(target)} className="inline-flex max-w-full items-center gap-1 rounded-md border border-info/20 bg-info-soft/50 px-2 py-1 text-[0.82em] text-info hover:bg-info-soft" title={reference}><FileCode2 className="size-3 shrink-0" /><span className="truncate font-mono">{reference}</span></button> : <span key={`${reference}-${index}`} className="max-w-full break-words rounded-md bg-canvas px-2 py-1 font-mono text-[0.82em] text-ink-2">{reference}</span>;
  })}</div>;
}
