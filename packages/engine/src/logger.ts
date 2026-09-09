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

  constructor(
    private readonly runId: string,
    private readonly filePath: string,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  emit(event: EventInput): HarnessEvent {
    const full = {
      ...event,
      runId: this.runId,
      seq: this.seq++,
      ts: Date.now(),
    } as HarnessEvent;
    appendFileSync(this.filePath, JSON.stringify(full) + "\n");
    this.events.push(full);
    return full;
  }

  getEvents(): readonly HarnessEvent[] {
    return this.events;
  }
}
