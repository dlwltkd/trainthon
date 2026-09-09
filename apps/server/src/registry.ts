import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync, writeFileSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessEvent, RunEndEvent, RunStartEvent, RunStatus } from "@vouch/protocol";
import { sourceReviewOutcome } from "@vouch/protocol";
import { safePath } from "../../../packages/sandbox/src/fs-tools.js";

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_EVENTS_BYTES = 16_000_000;
const MAX_METADATA_BYTES = 2_000_000;
const MAX_EVENTS = 25_000;
export type RunObservation = "active" | "tailing" | "completed" | "stale";

export interface RunSummary {
  runId: string;
  kind: "benchmark" | "local_repository";
  status: RunStatus;
  mode?: string;
  workflow?: RunStartEvent["workflow"];
  model?: string;
  condition?: string;
  taskId?: string;
  repository?: string;
  startedAt: number;
  endedAt?: number;
  elapsedMs?: number;
  eventCount: number;
  active: boolean;
  observation: RunObservation;
  streamable: boolean;
  controllable: boolean;
}

export interface RunSidecar { repoPath?: string; taskId?: string }

export interface ActiveRun {
  runId: string;
  events: HarnessEvent[];
  listeners: Set<(event: HarnessEvent | null) => void>;
  controller: AbortController;
  done: boolean;
  sidecar: RunSidecar;
  error?: string;
}

export interface StoredRun {
  runId: string;
  events: HarnessEvent[];
  record: unknown | null;
  dir: string | null;
  sidecar: RunSidecar;
  active: boolean;
  observation: RunObservation;
  streamable: boolean;
  controllable: boolean;
}

export function readBoundedText(root: string, name: string, maxBytes: number): string | null {
  const path = resolveInside(root, name);
  if (!path) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readJson(root: string, name: string): Record<string, unknown> | null {
  try {
    const text = readBoundedText(root, name, MAX_METADATA_BYTES);
    const value: unknown = text === null ? null : JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseJsonl(text: string, runId: string): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const seen = new Set<number>();
  // The writer appends newline-terminated records. Hold a partial tail until the next read.
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as HarnessEvent;
      if (!event || event.runId !== runId || !Number.isSafeInteger(event.seq) || event.seq < 0 ||
          !Number.isFinite(event.ts) || typeof event.type !== "string" || seen.has(event.seq)) continue;
      seen.add(event.seq);
      events.push(event);
      if (events.length >= MAX_EVENTS) break;
    } catch {
      // A malformed record must not prevent the remaining observable events from loading.
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
}

export class RunRegistry {
  private readonly active = new Map<string, ActiveRun>();
  private readonly diskEvents = new Map<string, { signature: string; events: HarnessEvent[] }>();
  readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly runsDir: string, options: { staleAfterMs?: number; now?: () => number } = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 90_000;
    this.now = options.now ?? Date.now;
  }

  get activeCount(): number { return [...this.active.values()].filter(run => !run.done).length; }

  register(run: ActiveRun): void {
    if (!RUN_ID_PATTERN.test(run.runId)) throw new Error("invalid run ID");
    this.active.set(run.runId, run);
  }

  getActive(runId: string): ActiveRun | undefined { return this.active.get(runId); }

  finish(runId: string, error?: string): void {
    const run = this.active.get(runId);
    if (!run) return;
    run.done = true;
    run.error = error;
    for (const listener of run.listeners) listener(null);
    run.listeners.clear();
    setTimeout(() => this.active.delete(runId), 30_000).unref();
  }

  runDir(runId: string): string | null {
    if (!RUN_ID_PATTERN.test(runId)) return null;
    const dir = resolveInside(this.runsDir, runId);
    if (!dir) return null;
    const hasEvents = resolveInside(dir, "events.jsonl") && existsSync(join(dir, "events.jsonl"));
    const hasRecord = resolveInside(dir, "record.json") && existsSync(join(dir, "record.json"));
    return hasEvents || hasRecord ? dir : null;
  }

  private readSidecar(dir: string | null): RunSidecar {
    if (!dir) return {};
    const server = readJson(dir, "server.json");
    const repository = readJson(dir, "repository.json");
    const repoPath = server?.repoPath ?? repository?.sourcePath;
    return {
      repoPath: typeof repoPath === "string" && isAbsolute(repoPath) ? repoPath : undefined,
      taskId: typeof server?.taskId === "string" ? server.taskId : undefined,
    };
  }

  writeSidecar(runId: string, sidecar: RunSidecar): void {
    const dir = this.runDir(runId);
    const target = dir && resolveInside(dir, "server.json");
    if (target) writeFileSync(target, JSON.stringify(sidecar, null, 2), { mode: 0o600 });
  }

  load(runId: string): StoredRun | null {
    if (!RUN_ID_PATTERN.test(runId)) return null;
    const live = this.active.get(runId);
    const dir = this.runDir(runId);
    const record = dir ? readJson(dir, "record.json") : null;
    const eventRoot = dir ?? this.runsDir;
    const eventName = dir ? "events.jsonl" : `${runId}.jsonl`;
    let events = live?.events;
    let recent = false;
    try {
      const path = resolveInside(eventRoot, eventName);
      const stat = path ? statSync(path) : null;
      const age = stat ? this.now() - stat.mtimeMs : Infinity;
      recent = age >= -5_000 && age < this.staleAfterMs;
      if (!live && stat) {
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.diskEvents.get(runId);
        if (cached?.signature === signature) events = cached.events;
        else {
          const text = readBoundedText(eventRoot, eventName, MAX_EVENTS_BYTES);
          if (text !== null) {
            events = parseJsonl(text, runId);
            // Bound retained payloads independently of the number of historical runs on disk.
            this.diskEvents.clear();
            this.diskEvents.set(runId, { signature, events });
          }
        }
      }
    } catch { /* A file may disappear while its writer exits. */ }
    if (!events) return null;
    const completed = events.some(e => e.type === "run_end") || live?.done === true;
    const observation: RunObservation = completed ? "completed" : live ? "active" : recent ? "tailing" : "stale";
    return {
      runId, events, record, dir,
      sidecar: { ...this.readSidecar(dir), ...live?.sidecar },
      active: observation === "active",
      observation,
      streamable: observation === "active" || observation === "tailing",
      controllable: observation === "active",
    };
  }

  list(): RunSummary[] {
    const summaries = new Map<string, RunSummary>();
    let readBudget = 32_000_000;
    if (existsSync(this.runsDir)) {
      for (const entry of readdirSync(this.runsDir, { withFileTypes: true }).slice(0, 500)) {
        if (entry.isSymbolicLink()) continue;
        const runId = entry.isDirectory() ? entry.name : entry.name.endsWith(".jsonl") ? entry.name.slice(0, -6) : "";
        if (!RUN_ID_PATTERN.test(runId)) continue;
        const root = entry.isDirectory() ? this.runDir(runId) : this.runsDir;
        const path = root && resolveInside(root, entry.isDirectory() ? "events.jsonl" : entry.name);
        try {
          if (!path) continue;
          readBudget -= statSync(path).size;
          if (readBudget < 0) break;
        } catch { continue; }
        const stored = this.load(runId);
        const summary = stored && summarize(stored);
        if (summary) summaries.set(runId, summary);
      }
    }
    for (const run of this.active.values()) {
      const stored = this.load(run.runId);
      const summary = stored && summarize(stored);
      if (summary) summaries.set(run.runId, summary);
    }
    return [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}

function summarize(stored: StoredRun): RunSummary | null {
  const { runId, events, active, observation, streamable, controllable } = stored;
  const start = events.find((e): e is RunStartEvent => e.type === "run_start");
  if (!start) return null;
  const end = events.find((e): e is RunEndEvent => e.type === "run_end");
  const snapshot = events.find(e => e.type === "repository_snapshot");
  const reviewStatus = stored.record && typeof stored.record === "object" && "reviewStatus" in stored.record ? stored.record.reviewStatus : undefined;
  return {
    runId,
    kind: start.runKind ?? (start.taskId ? "benchmark" : "local_repository"),
    workflow: start.workflow,
    status: sourceReviewOutcome(end?.status ?? "RUNNING", reviewStatus).status,
    mode: start.mode, model: start.model, condition: start.condition, taskId: start.taskId,
    repository: snapshot?.type === "repository_snapshot" ? snapshot.name : start.repository?.name,
    startedAt: start.ts, endedAt: end?.ts, elapsedMs: end?.elapsedMs, eventCount: events.length,
    active, observation, streamable, controllable,
  };
}

export function resolveInside(root: string, path: string): string | null {
  try { return safePath(root, path); } catch { return null; }
}
