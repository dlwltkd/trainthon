import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@vouch/protocol";
import type { RunPayload } from "./api";
import { initialRunState, runReducer } from "./run-state";

const event: HarnessEvent = { type: "action_summary", runId: "run-1", seq: 1, ts: 1000, summary: "Baseline tests" };
const payload: RunPayload = { runId: "run-1", active: true, streamable: true, observation: "active", controllable: true, events: [event], record: null, source: { kind: "local_repository", files: [], filesAvailable: false, artifactsAvailable: false } };

describe("dashboard stream state", () => {
  it("reloads final artifacts and ends live playback when the server completes", () => {
    let state = runReducer(initialRunState, { type: "loaded", payload });
    state = runReducer(state, { type: "event", event: { type: "run_end", runId: "run-1", seq: 2, ts: 2000, status: "NOT_REPRODUCIBLE", costUsd: 0, elapsedMs: 1000 } });
    const completed: RunPayload = { ...payload, active: false, streamable: false, observation: "completed", controllable: false, record: { status: "NOT_REPRODUCIBLE" }, source: { ...payload.source, artifactsAvailable: true } };
    state = runReducer(state, { type: "refreshed", payload: completed });
    expect(state.connection).toBe("recorded");
    expect(state.playback).toBe("recorded");
    expect(state.payload?.record).toEqual({ status: "NOT_REPRODUCIBLE" });
    expect(state.payload?.source.artifactsAvailable).toBe(true);
    expect(state.events.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("tails CLI logs without claiming control and preserves stale status", () => {
    const tailing = { ...payload, active: false, controllable: false, observation: "tailing" as const };
    let state = runReducer(initialRunState, { type: "loaded", payload: tailing });
    expect(state.playback).toBe("live");
    expect(state.payload?.controllable).toBe(false);
    state = runReducer(state, { type: "refreshed", payload: { ...tailing, streamable: false, observation: "stale" } });
    expect(state.connection).toBe("stale");
    expect(state.playback).toBe("recorded");
  });

  it("ignores duplicate reconnect events and events from another run", () => {
    const state = runReducer(initialRunState, { type: "loaded", payload });
    expect(runReducer(state, { type: "event", event })).toBe(state);
    expect(runReducer(state, { type: "event", event: { ...event, runId: "old-run", seq: 2 } })).toBe(state);
  });

  it("keeps live runs out of replay and restarts finished recorded playback", () => {
    let state = runReducer(initialRunState, { type: "loaded", payload });
    expect(runReducer(state, { type: "replay:start", speed: 1 })).toBe(state);
    state = runReducer(state, { type: "loaded", payload: { ...payload, active: false, streamable: false, events: [event, { ...event, seq: 2 }] } });
    state = runReducer(state, { type: "replay:start", speed: 1 });
    state = runReducer(state, { type: "replay:tick" });
    expect(state.replay).toMatchObject({ cursor: 2, playing: false });
    state = runReducer(state, { type: "replay:toggle" });
    expect(state.replay).toMatchObject({ cursor: 1, playing: true });
  });
});
