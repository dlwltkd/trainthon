import type { HarnessEvent } from "@vouch/protocol";
import type { RunRegistry } from "./registry.js";

interface Frame { event: "harness" | "ping" | "end"; id?: string; data: string }

export async function observeRun(
  registry: RunRegistry,
  runId: string,
  after: number,
  send: (frame: Frame) => Promise<void>,
  signal: AbortSignal,
  options: { pollMs?: number; heartbeatMs?: number; maxDurationMs?: number } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 750;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const deadline = Date.now() + (options.maxDurationMs ?? 30 * 60_000);
  const active = registry.getActive(runId);
  const queued: HarnessEvent[] = [];
  let wake: (() => void) | undefined;
  let overflow = false;
  const listener = (event: HarnessEvent | null) => {
    if (event) {
      if (queued.length >= 1_000) overflow = true;
      else queued.push(event);
    }
    wake?.();
  };
  // Subscribe before reading the backlog: events emitted during writes are queued and deduplicated.
  active?.listeners.add(listener);
  const aborted = () => wake?.();
  signal.addEventListener("abort", aborted, { once: true });
  let lastSeq = after;
  let lastHeartbeat = Date.now();
  const end = (reason: string) => send({ event: "end", data: JSON.stringify({ reason }) });

  try {
    for (;;) {
      if (signal.aborted) return;
      const stored = registry.load(runId);
      if (!stored) { await end("unavailable"); return; }
      const batch = [...stored.events.filter(event => event.seq > lastSeq), ...queued.splice(0)].sort((a, b) => a.seq - b.seq);
      for (const event of batch) {
        if (signal.aborted) return;
        if (event.seq <= lastSeq) continue;
        await send({ id: String(event.seq), event: "harness", data: JSON.stringify(event) });
        lastSeq = event.seq;
      }
      if (queued.length) continue;
      if (stored.events.some(event => event.type === "run_end") || active?.done || stored.observation === "completed") {
        await end(active?.error ?? "completed");
        return;
      }
      if (overflow) { await end("slow_consumer"); return; }
      if (!stored.streamable) { await end(stored.observation); return; }
      if (Date.now() >= deadline) { await end("observation_window_ended"); return; }
      if (Date.now() - lastHeartbeat >= heartbeatMs) {
        await send({ event: "ping", data: JSON.stringify({ at: Date.now(), observation: stored.observation }) });
        lastHeartbeat = Date.now();
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, pollMs);
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
        if (signal.aborted || queued.length || active?.done) done();
      });
    }
  } finally {
    active?.listeners.delete(listener);
    signal.removeEventListener("abort", aborted);
  }
}
