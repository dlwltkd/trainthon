import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, FileCode2, FileDiff, FlaskConical, FolderTree, ListChecks, Pause, Play, RotateCcw, SkipForward, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useRun } from "@/hooks/useRun";
import { useTicker } from "@/hooks/useTicker";
import { ActivityFeed } from "./ActivityFeed";
import { AgentIntent, type EvidenceTarget } from "./AgentActivity";
import { CodeView } from "./CodeView";
import { DiffView } from "./DiffView";
import { EvidencePanel } from "./EvidencePanel";
import { FileTree } from "./FileTree";
import { RepoHeader } from "./RepoHeader";
import { StageRail } from "./StageRail";
import { Button, Empty, PanelHeader, Spinner, Tabs } from "./ui";

type CenterTab = "agent" | "changes" | "file" | "evidence";
type MobileTab = "activity" | "files" | "results";

export function RunView({ runId }: { runId: string }) {
  const run = useRun(runId);
  const { view, source } = run;
  const live = run.playback === "live" && (run.connection === "live" || run.connection === "tailing" || run.connection === "connecting" || run.connection === "reconnecting");
  const now = useTicker(live || (run.playback === "replay" && run.replay.playing), live ? 1000 : 250);

  const [center, setCenter] = useState<CenterTab>("agent");
  const [mobile, setMobile] = useState<MobileTab>("activity");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [focusDiff, setFocusDiff] = useState<string | null>(null);
  const [focusPhase, setFocusPhase] = useState<string | null>(null);
  const [userPinned, setUserPinned] = useState(false);

  const changedPaths = useMemo(() => new Set(view?.changedFiles.keys() ?? []), [view]);
  const files = view?.repository?.files.length ? view.repository.files : source?.files ?? [];

  // Auto-focus follows the run only until the viewer picks something themselves.
  useEffect(() => {
    if (!view || userPinned) return;
    if (view.currentDecision) setCenter("agent");
    else if (view.changedFiles.size > 0 && view.status === "RUNNING") setCenter("changes");
    else if (view.status !== "RUNNING" && view.endedAt) setCenter(view.changedFiles.size > 0 ? "changes" : "evidence");
  }, [view?.changedFiles.size, view?.status, view?.endedAt, userPinned, view]);

  const openFile = useCallback((path: string) => {
    setUserPinned(true);
    setSelectedFile(path);
    setCenter("file");
    setMobile("files");
  }, []);
  const openDiff = useCallback((path?: string) => {
    setUserPinned(true);
    setFocusDiff(path ?? null);
    if (path) setSelectedFile(path);
    setCenter("changes");
    setMobile("results");
  }, []);
  const openEvidence = useCallback((phase?: string) => {
    setUserPinned(true);
    setFocusPhase(phase ?? null);
    setCenter("evidence");
    setMobile("results");
  }, []);
  const navigateEvidence = useCallback((target: EvidenceTarget) => {
    if (target.kind === "file") openFile(target.value);
    else if (target.kind === "test") openEvidence(target.value);
    else {
      const entry = [...document.querySelectorAll<HTMLElement>("[data-activity-id]")].find((node) => node.dataset.activityId === target.value && node.getClientRects().length > 0);
      entry?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [openFile, openEvidence]);

  if (run.connection === "error" && !view) {
    return <Empty title="Could not load this run" hint={run.error} action={<Button onClick={run.reload}>Retry</Button>} />;
  }
  if (!view) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-ink-3">
        <Spinner /> loading run
      </div>
    );
  }

  const centerTabs = (
    <Tabs
      value={center}
      onChange={(tab) => {
        setUserPinned(true);
        setCenter(tab);
      }}
      items={[
        { id: "agent", label: <span className="inline-flex items-center gap-1"><ListChecks className="size-3.5" /> Plan & skills</span>, badge: view.skills.length || undefined },
        { id: "changes", label: <span className="inline-flex items-center gap-1"><FileDiff className="size-3.5" /> Changes</span>, badge: view.changedFiles.size || undefined },
        { id: "file", label: <span className="inline-flex items-center gap-1"><FileCode2 className="size-3.5" /> File</span> },
        { id: "evidence", label: <span className="inline-flex items-center gap-1"><FlaskConical className="size-3.5" /> Evidence</span>, badge: view.tests.length || undefined },
      ]}
    />
  );

  const centerBody = (
    <div className="min-h-0 flex-1 overflow-auto">
      {center === "agent" && <div className="p-3"><AgentIntent view={view} files={files} onEvidence={navigateEvidence} /></div>}
      {center === "changes" && <DiffView files={view.diff} focusPath={focusDiff} emptyHint={view.status === "RUNNING" ? "Diffs appear here as soon as the agent writes to a source file." : "This run ended without touching source files."} />}
      {center === "file" && <CodeView runId={runId} path={selectedFile} available={source?.filesAvailable ?? false} changed={selectedFile ? changedPaths.has(selectedFile) : false} onShowDiff={() => openDiff(selectedFile ?? undefined)} />}
      {center === "evidence" && <EvidencePanel view={view} source={source} focusPhase={focusPhase} />}
    </div>
  );

  const fileTree = (
    <FileTree files={files} inspected={view.inspectedFiles} changed={changedPaths} selected={selectedFile} onSelect={openFile} />
  );

  const clock = run.playback === "live" ? now : view.lastTs;
  const feed = <ActivityFeed view={view} files={files} now={clock} live={live} actions={{ openFile, openDiff, openEvidence }} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepoHeader view={view} source={source} now={now} connection={run.connection} playback={run.playback} />
      <StageRail view={view} now={clock} />
      <ReplayBar run={run} />

      {/* Desktop: repository | code & evidence | agent activity */}
      <div className="hidden min-h-0 flex-1 gap-px bg-line lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_24rem] xl:grid-cols-[16rem_minmax(0,1fr)_27rem]">
        <aside className="flex min-h-0 flex-col bg-panel">
          <PanelHeader title={<><FolderTree className="size-3.5" /> Repository</>} aside={<span className="secondary text-[0.8em] text-ink-3">{files.length}</span>} />
          <div className="min-h-0 flex-1 overflow-auto">{fileTree}</div>
          <Legend />
        </aside>
        <section className="flex min-h-0 flex-col bg-panel">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">{centerTabs}</div>
          {centerBody}
        </section>
        <aside className="relative flex min-h-0 flex-col bg-panel">
          <PanelHeader title={<><Activity className="size-3.5" /> Agent activity</>} aside={<span className="secondary text-[0.8em] tabular-nums text-ink-3">{view.tools.size} tool calls · {view.eventCount} events</span>} />
          {feed}
        </aside>
      </div>

      {/* Mobile: current action stays on top; Activity / Files / Results tabs below */}
      <div className="flex min-h-0 flex-1 flex-col lg:hidden">
        <div className="flex h-11 shrink-0 items-center justify-center border-b border-line bg-panel px-3">
          <Tabs
            value={mobile}
            onChange={setMobile}
            className="w-full justify-between"
            items={[
              { id: "activity", label: "Activity", badge: view.tools.size || undefined },
              { id: "files", label: "Files", badge: changedPaths.size || undefined },
              { id: "results", label: "Plan & results" },
            ]}
          />
        </div>
        <div className="relative min-h-0 flex-1 bg-panel">
          {mobile === "activity" && feed}
          {mobile === "files" && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="max-h-[40%] overflow-auto border-b border-line">{fileTree}</div>
              <div className="min-h-0 flex-1 overflow-auto">
                <CodeView runId={runId} path={selectedFile} available={source?.filesAvailable ?? false} changed={selectedFile ? changedPaths.has(selectedFile) : false} onShowDiff={() => openDiff(selectedFile ?? undefined)} />
              </div>
            </div>
          )}
          {mobile === "results" && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center border-b border-line px-3">
                <Tabs
                  value={center === "file" ? "changes" : center}
                  onChange={(tab) => setCenter(tab)}
                  items={[
                    { id: "agent", label: "Plan & skills" },
                    { id: "changes", label: "Changes", badge: view.changedFiles.size || undefined },
                    { id: "evidence", label: "Evidence" },
                  ]}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {center === "agent" ? <div className="p-3"><AgentIntent view={view} files={files} onEvidence={navigateEvidence} /></div> : center === "evidence" ? <EvidencePanel view={view} source={source} focusPhase={focusPhase} /> : <DiffView files={view.diff} focusPath={focusDiff} emptyHint="No source changes recorded." />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="secondary flex items-center gap-3 border-t border-line px-3 py-1.5 text-[0.75em] text-ink-3">
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-blue-role" /> changed
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-ink-3" /> inspected
      </span>
    </div>
  );
}

function ReplayBar({ run }: { run: ReturnType<typeof useRun> }) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const { view } = run;
  if (!view) return null;
  const finished = view.status !== "RUNNING" || run.playback === "recorded" || run.playback === "replay";
  const isActiveLive = run.playback === "live" && view.status === "RUNNING";
  const cancel = async () => {
    setCancelling(true);
    setCancelError(undefined);
    try { await api.cancel(view.runId); }
    catch (error) { setCancelError(error instanceof Error ? error.message : "Could not cancel run"); }
    finally { setCancelling(false); }
  };

  if (run.playback === "replay") {
    const { cursor, playing, speed } = run.replay;
    const total = run.totalEvents;
    return (
      <div className="flex items-center gap-2 border-b border-warn/30 bg-warn-soft/60 px-4 py-1.5 text-[0.9em]">
        <span className="font-semibold uppercase tracking-wider text-warn">Replay</span>
        <span className="secondary text-ink-2">saved run · same events as live</span>
        <Button size="sm" variant="ghost" onClick={run.toggleReplay} aria-label={playing ? "pause" : "play"}>
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <input type="range" min={1} max={total} value={cursor} onChange={(e) => run.seekReplay(Number(e.target.value))} className="h-1 w-40 accent-warn sm:w-64" aria-label="replay position" />
        <span className="font-mono text-[0.85em] tabular-nums text-ink-2">
          {cursor}/{total}
        </span>
        <div className="flex items-center gap-0.5">
          {[1, 2, 4, 8].map((s) => (
            <button key={s} onClick={() => run.setReplaySpeed(s)} className={cn("rounded px-1.5 py-0.5 font-mono text-[0.8em]", speed === s ? "bg-warn text-white" : "text-ink-2 hover:bg-warn/15")}>
              {s}×
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => run.seekReplay(total)} title="skip to end">
          <SkipForward className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={run.exitReplay}>
          <X className="size-3.5" /> Exit replay
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-line bg-canvas/60 px-4 py-1 text-[0.85em] text-ink-3">
      {isActiveLive ? (
        <>
          <span>
            {run.connection === "live" ? "Streaming events from the harness." : run.connection === "tailing" ? "Following CLI events from disk." : run.connection === "reconnecting" ? "Connection lost — reconnecting…" : run.connection === "error" ? run.error : "Connecting to the run…"}
          </span>
          {cancelError && <span className="text-fail" role="alert">{cancelError}</span>}
          {run.controllable && <Button size="sm" variant="danger" className="ml-auto" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? <Spinner className="size-3" /> : <Square className="size-3" />} {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>}
        </>
      ) : (
        <>
          <span>{run.connection === "stale" ? "Stream inactive · no completion event" : "Recorded run"} · {view.eventCount} events{run.connection === "error" ? ` · ${run.error}` : ""}</span>
          {finished && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => run.startReplay(2)}>
              <RotateCcw className="size-3.5" /> Replay
            </Button>
          )}
        </>
      )}
    </div>
  );
}
