import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventInput, HarnessEvent } from "@vouch/protocol";

/**
 * Append-only JSONL event logger. One line per event.
 * The file at `filePath` IS the run record source (used by replay + bench).
 */
export class EventLogger {
  private seq = 0;
  private readonly events: HarnessEvent[] = [];
  private sealed = false;

  constructor(
    private readonly runId: string,
    private readonly filePath: string,
    private readonly onEvent?: (event: HarnessEvent) => void,
  ) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }

  emit(event: EventInput): HarnessEvent {
    const full = {
      ...event,
      schemaVersion: 2,
      runId: this.runId,
      seq: this.seq++,
      ts: Date.now(),
    } as HarnessEvent;
    if (this.sealed) return full;
    const serialized = JSON.stringify(full);
    const stored = deepFreeze(JSON.parse(serialized) as HarnessEvent);
    appendFileSync(this.filePath, serialized + "\n", { mode: 0o600 });
    this.events.push(stored);
    // A disconnected observer must not interrupt a persisted run.
    try {
      this.onEvent?.(structuredClone(stored));
    } catch {
      // Consumers can reconnect from the JSONL sequence.
    }
    return stored;
  }

  seal(): void {
    this.sealed = true;
  }

  getEvents(): readonly HarnessEvent[] {
    return this.events;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
