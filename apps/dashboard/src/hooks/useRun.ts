import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { HarnessEvent } from "@vouch/protocol";
import { api, type RunPayload, type RunSource } from "@/lib/api";
import { deriveRun, type RunView } from "@/lib/derive";
import { initialRunState, runReducer, type Connection, type PlaybackMode, type RunState } from "../lib/run-state";
export type { Connection, PlaybackMode } from "../lib/run-state";

export interface RunController {
  view: RunView | null;
  source: RunSource | null;
  record: Record<string, unknown> | null;
  connection: Connection;
  playback: PlaybackMode;
  error?: string;
  totalEvents: number;
  replay: RunState["replay"];
  observation: RunPayload["observation"];
  controllable: boolean;
  startReplay: (speed?: number) => void;
  toggleReplay: () => void;
  setReplaySpeed: (speed: number) => void;
  seekReplay: (cursor: number) => void;
  exitReplay: () => void;
  reload: () => void;
}

const REPLAY_MIN_MS = 140;
const REPLAY_MAX_MS = 1400;

export function useRun(runId: string | null): RunController {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const generation = useRef(0);

  const load = useCallback(() => {
    const requestGeneration = ++generation.current;
    dispatch({ type: "reset" });
    if (!runId) return;
    api
      .run(runId)
      .then((payload) => {
        if (generation.current === requestGeneration) dispatch({ type: "loaded", payload });
      })
      .catch((error: Error) => {
        if (generation.current === requestGeneration) dispatch({ type: "connection", connection: "error", error: error.message });
      });
  }, [runId]);

  useEffect(() => {
    load();
    return () => { generation.current++; };
  }, [load]);

  const active = state.payload?.runId === runId && (state.payload?.streamable ?? state.payload?.active ?? false);
  const observation = state.payload?.observation;
  useEffect(() => {
    if (!runId || !active || state.playback === "replay") return;
    const lastSeq = state.events.at(-1)?.seq;
    const source = new EventSource(api.streamUrl(runId, lastSeq));
    let disposed = false;
    let opened = false;
    source.onopen = () => {
      opened = true;
      if (!disposed) dispatch({ type: "connection", connection: observation === "tailing" ? "tailing" : "live" });
    };
    source.addEventListener("harness", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as HarnessEvent;
        if (!disposed && event.runId === runId && Number.isInteger(event.seq)) dispatch({ type: "event", event });
      } catch {
        // Ignore malformed frames; the next reconnect resends from the last seq.
      }
    });
    source.addEventListener("end", () => {
      source.close();
      api.run(runId).then((payload) => {
        if (!disposed) dispatch({ type: "refreshed", payload });
      }).catch((error: Error) => {
        if (!disposed) dispatch({ type: "connection", connection: "error", error: `Run ended; final record could not be loaded: ${error.message}` });
      });
    });
    source.onerror = () => {
      if (disposed) return;
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: "connection", connection: "error", error: "stream closed" });
      } else {
        dispatch({ type: "connection", connection: opened ? "reconnecting" : "connecting" });
      }
    };
    return () => {
      disposed = true;
      source.close();
    };
    // Reconnect only when the run identity or its active flag changes; EventSource handles retries itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, active, state.playback, observation]);

  const replayEvents = useMemo(
    () => (state.playback === "replay" ? state.events.slice(0, state.replay.cursor) : state.events),
    [state.events, state.playback, state.replay.cursor],
  );

  useEffect(() => {
    if (state.playback !== "replay" || !state.replay.playing) return;
    const current = state.events[state.replay.cursor - 1];
    const next = state.events[state.replay.cursor];
    if (!current || !next) return;
    const gap = Math.max(0, next.ts - current.ts) / state.replay.speed;
    const delay = Math.min(REPLAY_MAX_MS, Math.max(REPLAY_MIN_MS, gap));
    const timer = setTimeout(() => dispatch({ type: "replay:tick" }), delay);
    return () => clearTimeout(timer);
  }, [state.playback, state.replay.playing, state.replay.cursor, state.replay.speed, state.events]);

  const view = useMemo(() => {
    const finalUsageKnown = state.payload?.record?.usageKnown;
    const derived = deriveRun(replayEvents, typeof finalUsageKnown === "boolean" ? finalUsageKnown : undefined, state.payload?.record?.reviewStatus);
    if (!derived) return null;
    const workflow = state.payload?.source.workflow ?? state.payload?.record?.workflow;
    if (!derived.workflow && (workflow === "repository_review" || workflow === "repository_repair" || workflow === "repository_remediation")) derived.workflow = workflow;
    return derived;
  }, [replayEvents, state.payload?.source.workflow, state.payload?.record?.workflow, state.payload?.record?.usageKnown, state.payload?.record?.reviewStatus]);

  return {
    view,
    source: state.payload?.source ?? null,
    record: state.payload?.record ?? null,
    connection: state.playback === "replay" ? "recorded" : state.connection,
    playback: state.playback,
    error: state.error,
    totalEvents: state.events.length,
    replay: state.replay,
    observation,
    controllable: state.payload?.controllable ?? false,
    startReplay: (speed = 1) => dispatch({ type: "replay:start", speed }),
    toggleReplay: () => dispatch({ type: "replay:toggle" }),
    setReplaySpeed: (speed) => dispatch({ type: "replay:speed", speed }),
    seekReplay: (cursor) => dispatch({ type: "replay:seek", cursor }),
    exitReplay: () => dispatch({ type: "replay:exit" }),
    reload: load,
  };
}
