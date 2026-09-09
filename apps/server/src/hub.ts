import type { HarnessEvent } from "@vouch/protocol";

type Listener = (event: HarnessEvent) => void;

/**
 * In-memory fan-out for live runs. JSONL on disk remains the record;
 * the hub only exists so SSE clients can attach before/during executeRun.
 */
export class RunHub {
  private readonly buffers = new Map<string, HarnessEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly live = new Set<string>();

  start(runId: string): void {
    this.buffers.set(runId, []);
    this.listeners.set(runId, new Set());
    this.live.add(runId);
  }

  emit(runId: string, event: HarnessEvent): void {
    this.buffers.get(runId)?.push(event);
    for (const cb of this.listeners.get(runId) ?? []) cb(event);
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  buffer(runId: string): HarnessEvent[] {
    return this.buffers.get(runId) ?? [];
  }

  subscribe(runId: string, cb: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(cb);
    this.listeners.set(runId, set);
    for (const e of this.buffers.get(runId) ?? []) cb(e);
    return () => set.delete(cb);
  }

  finish(runId: string): void {
    this.live.delete(runId);
  }
}
