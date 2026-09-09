import type { HarnessEvent } from "@vouch/protocol";
import type { RunPayload } from "./api";

export type Connection = "idle" | "loading" | "connecting" | "live" | "tailing" | "stale" | "recorded" | "reconnecting" | "error";
export type PlaybackMode = "live" | "recorded" | "replay";

export interface RunState {
  payload: RunPayload | null;
  events: HarnessEvent[];
  connection: Connection;
  error?: string;
  playback: PlaybackMode;
  replay: { cursor: number; playing: boolean; speed: number };
}

export type RunAction =
  | { type: "reset" }
  | { type: "loaded"; payload: RunPayload }
  | { type: "refreshed"; payload: RunPayload }
  | { type: "event"; event: HarnessEvent }
  | { type: "connection"; connection: Connection; error?: string }
  | { type: "replay:start"; speed: number }
  | { type: "replay:tick" }
  | { type: "replay:toggle" }
  | { type: "replay:speed"; speed: number }
  | { type: "replay:seek"; cursor: number }
  | { type: "replay:exit" };

export const initialRunState: RunState = {
  payload: null,
  events: [],
  connection: "idle",
  playback: "recorded",
  replay: { cursor: 0, playing: false, speed: 1 },
};

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "reset":
      return { ...initialRunState, connection: "loading" };
    case "loaded":
    case "refreshed": {
      const active = action.payload.streamable ?? action.payload.active;
      const sameRun = state.payload?.runId === action.payload.runId;
      const merged = action.type === "refreshed" && sameRun ? new Map(state.events.map((event) => [event.seq, event])) : new Map<number, HarnessEvent>();
      for (const event of action.payload.events) merged.set(event.seq, event);
      return {
        ...state,
        payload: action.payload,
        events: [...merged.values()].sort((a, b) => a.seq - b.seq),
        connection: active ? "connecting" : action.payload.observation === "stale" ? "stale" : "recorded",
        playback: active ? "live" : "recorded",
        error: undefined,
      };
    }
    case "event": {
      if (action.event.runId !== state.payload?.runId || state.events.some((event) => event.seq === action.event.seq)) return state;
      return { ...state, events: [...state.events, action.event].sort((a, b) => a.seq - b.seq) };
    }
    case "connection":
      return { ...state, connection: action.connection, error: action.error };
    case "replay:start":
      if ((state.payload?.streamable ?? state.payload?.active) || state.events.length === 0) return state;
      return { ...state, playback: "replay", replay: { cursor: 1, playing: state.events.length > 1, speed: action.speed } };
    case "replay:tick": {
      const total = state.events.length;
      const cursor = Math.min(total, state.replay.cursor + 1);
      return { ...state, replay: { ...state.replay, cursor, playing: cursor < total && state.replay.playing } };
    }
    case "replay:toggle": {
      const atEnd = state.replay.cursor >= state.events.length;
      return { ...state, replay: { ...state.replay, cursor: atEnd ? 1 : state.replay.cursor, playing: !state.replay.playing && state.events.length > 1 } };
    }
    case "replay:speed":
      return { ...state, replay: { ...state.replay, speed: action.speed } };
    case "replay:seek": {
      const cursor = Math.max(1, Math.min(state.events.length, action.cursor));
      return { ...state, replay: { ...state.replay, cursor, playing: cursor < state.events.length && state.replay.playing } };
    }
    case "replay:exit":
      return { ...state, playback: "recorded", replay: { cursor: state.events.length, playing: false, speed: state.replay.speed } };
  }
}
