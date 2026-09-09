import { GitBranch, GitCommitHorizontal, ExternalLink, Cpu, Timer, Coins, Files } from "lucide-react";
import { isExternalAssessment, repositoryWorkflowLabel, statusLabel, statusTone, type RunView } from "@/lib/derive";
import type { RunSource } from "@/lib/api";
import { formatClock, formatCost, formatTokens, shortSha } from "@/lib/format";
import { githubRepositoryUrl, githubCommitUrl } from "@/lib/repository-source";
import { Chip, Meter, Mono, RoleChip, StatusChip } from "./ui";
import type { Connection, PlaybackMode } from "@/hooks/useRun";

export function RepoHeader({
  view,
  source,
  now,
  connection,
  playback,
}: {
  view: RunView;
  source: RunSource | null;
  now: number;
  connection: Connection;
  playback: PlaybackMode;
}) {
  const name = view.repository?.name ?? source?.name ?? view.taskId ?? view.runId;
  const commit = view.repository?.commit ?? source?.commit;
  const origin = githubRepositoryUrl(view.repository?.url ?? source?.url);
  const commitLink = githubCommitUrl(origin ?? undefined, commit);
  const ref = view.repository?.ref ?? source?.ref ?? (view.kind === "benchmark" ? "fixture" : "HEAD");
  const elapsed = view.endedAt ? view.elapsedMs ?? view.endedAt - view.startedAt : Math.max(0, (playback === "live" ? now : view.lastTs) - view.startedAt);
  const budgets = view.budgets;
  const fileCount = view.repository?.files.length || source?.files.length || 0;
  const external = isExternalAssessment(view);
  const externalUrl = external ? view.repository?.url ?? source?.url : undefined;

  return (
    <div className="flex flex-col gap-3 border-b border-line bg-panel px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-[1.25em] font-semibold tracking-tight">{name}</h1>
          {external ? <Chip tone={statusTone(view.status)} dot className="uppercase tracking-wide">{view.status === "REVIEW_COMPLETE" ? "검토 완료" : view.status === "RUNNING" ? "검토 중" : statusLabel(view.status, view.reason)}</Chip> : <StatusChip status={view.status} reason={view.reason} />}
          <ModeChip view={view} playback={playback} connection={connection} />
          {view.kind === "local_repository" && <Chip tone="neutral">{repositoryWorkflowLabel(view)}</Chip>}
          {view.condition && (
            <Chip tone="neutral" className="secondary">
              condition {view.condition}
            </Chip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.9em] text-ink-2">
          {origin && <a href={origin} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-info hover:underline" title={origin}><ExternalLink className="size-3.5" /><Mono>{origin.slice("https://github.com/".length)}</Mono></a>}
          {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-info hover:underline" title={externalUrl}><ExternalLink className="size-3.5" /><Mono>실제 대상 행사</Mono></a>}
          <span className="inline-flex items-center gap-1.5">
            <GitBranch className="size-3.5 text-ink-3" />
            <Mono>{ref}</Mono>
          </span>
          {commitLink ? <a href={commitLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-info hover:underline" title={`Exact commit: ${commit}`}><GitCommitHorizontal className="size-3.5" /><Mono>{shortSha(commit)}</Mono></a> : <span className="inline-flex items-center gap-1.5" title={commit}>
            <GitCommitHorizontal className="size-3.5 text-ink-3" />
            <Mono>{shortSha(commit)}</Mono>
          </span>}
          <span className="inline-flex items-center gap-1.5">
            <Files className="size-3.5 text-ink-3" />
            {fileCount}{external ? "개 파일" : " files"}
          </span>
          {view.roles.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Cpu className="size-3.5 text-ink-3" />
              {view.roles.map((r) => (
                <span key={r.role} className="inline-flex items-center gap-1">
                  <RoleChip role={r.role} />
                  <Mono className="text-ink-2">{r.model ?? r.runner}</Mono>
                  {r.provider && <span className="secondary text-ink-3">{external ? "·" : "via"} {r.provider}</span>}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-stretch gap-3">
        <Stat icon={<Timer className="size-3.5" />} label={external ? "실행 시간" : "elapsed"} value={formatClock(elapsed)}>
          {budgets && <Meter value={elapsed} max={budgets.maxWallMs} tone={elapsed / budgets.maxWallMs > 0.85 ? "warn" : "info"} />}
        </Stat>
        <Stat icon={<Cpu className="size-3.5" />} label={external ? "단계" : "steps"} value={`${view.usage.steps}${budgets && budgets.maxSteps < Number.MAX_SAFE_INTEGER / 2 ? ` / ${budgets.maxSteps}` : ""}`}>
          {budgets && budgets.maxSteps < Number.MAX_SAFE_INTEGER / 2 && <Meter value={view.usage.steps} max={budgets.maxSteps} />}
          {budgets && budgets.maxSteps >= Number.MAX_SAFE_INTEGER / 2 && <span className="text-[0.7em] text-ink-3">No step ceiling</span>}
        </Stat>
        <Stat icon={<Coins className="size-3.5" />} label={external ? "모델 토큰" : view.usageKnown === false ? "token estimate" : "run tokens"} value={`${formatTokens(view.usage.tokens)}${budgets && budgets.maxTokens < Number.MAX_SAFE_INTEGER / 2 ? ` / ${formatTokens(budgets.maxTokens)}` : ""}`} hint={!external && view.usageKnown !== false && view.endedAt ? formatCost(view.costUsd) : undefined}>
          {budgets && budgets.maxTokens < Number.MAX_SAFE_INTEGER / 2 && <Meter value={view.usage.tokens} max={budgets.maxTokens} />}
          {budgets && budgets.maxTokens >= Number.MAX_SAFE_INTEGER / 2 && <span className="text-[0.7em] text-ink-3">No token ceiling</span>}
          {view.usageKnown === false && <span className="text-[0.7em] leading-tight text-ink-3" title="Token accounting includes conservative estimates where provider usage was unavailable.">Conservative accounting</span>}
        </Stat>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint, children }: { icon: React.ReactNode; label: string; value: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex w-28 flex-col justify-between gap-1 rounded-lg border border-line bg-canvas/60 px-2.5 py-1.5">
      <div className="flex items-center justify-between text-[0.75em] uppercase tracking-wider text-ink-3">
        <span className="inline-flex items-center gap-1">
          {icon}
          {label}
        </span>
        {hint && <span className="normal-case tracking-normal">{hint}</span>}
      </div>
      <div className="font-mono text-[1em] tabular-nums text-ink">{value}</div>
      {children}
    </div>
  );
}

function ModeChip({ view, playback, connection }: { view: RunView; playback: PlaybackMode; connection: Connection }) {
  const external = isExternalAssessment(view);
  if (playback === "replay") {
    return (
      <Chip tone="warn" dot className="uppercase tracking-wide">
        {external ? "재생" : "Replay"}
      </Chip>
    );
  }
  if (playback === "live") {
    const label = connection === "live" ? "Live" : connection === "tailing" ? "CLI stream" : connection === "error" ? "Disconnected" : connection === "reconnecting" ? "Reconnecting" : "Connecting";
    return (
      <Chip tone={connection === "live" || connection === "tailing" ? "info" : "warn"} dot className="uppercase tracking-wide">
        {label}
      </Chip>
    );
  }
  return (
    <Chip tone="neutral" className="uppercase tracking-wide">
      {external ? `${view.mode === "live" ? "실제 실행 기록" : "기록"} · ${view.mode ?? "run"}` : `Recorded · ${view.mode ?? "run"}`}
    </Chip>
  );
}
