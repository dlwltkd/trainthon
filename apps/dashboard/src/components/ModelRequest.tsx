import { CircleDashed, RotateCw, Check, X } from "lucide-react";
import { modelRequestLabel, type ModelRequestItem } from "@/lib/derive";
import { formatDuration } from "@/lib/format";
import { Mono, RoleChip } from "./ui";

export function ModelRequest({ request, now, live = false }: { request: ModelRequestItem; now: number; live?: boolean }) {
  const active = !["completed", "failed"].includes(request.phase);
  const elapsed = active && live ? Math.max(request.elapsedMs, now - request.ts) : request.elapsedMs;
  const retryIn = request.retryAt === undefined ? undefined : Math.max(0, Math.ceil((request.retryAt - now) / 1000));
  const Icon = request.phase === "completed" ? Check : request.phase === "failed" ? X : request.phase === "retry_wait" ? RotateCw : CircleDashed;
  return <div className="min-w-0 space-y-1.5" aria-label={`${request.agentRole} model request`}>
    <div className="flex items-center gap-2">
      <RoleChip role={request.agentRole} />
      <Icon className={`size-3.5 shrink-0 ${active ? "text-info" : request.phase === "failed" ? "text-warn" : "text-ink-3"}`} />
      <span className="min-w-0 flex-1 text-[0.92em] font-medium">{modelRequestLabel(request)}</span>
      <Mono className="shrink-0 text-[0.8em] text-ink-3">{request.phase === "retry_wait" && retryIn !== undefined ? `${retryIn}s` : formatDuration(elapsed)}</Mono>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78em] text-ink-3">
      <span>{request.transport === "stream" ? "Streaming" : "Request"}{request.attempt > 1 ? ` · attempt ${request.attempt}` : ""}</span>
      {request.firstChunkMs !== undefined && <span>First response {formatDuration(request.firstChunkMs)}</span>}
      {request.outputChars > 0 && <span className="font-mono tabular-nums">{request.outputChars.toLocaleString()} chars received</span>}
    </div>
    {request.detail && request.phase !== "completed" && <p className="break-words text-[0.8em] leading-relaxed text-ink-3">{request.detail}</p>}
  </div>;
}
