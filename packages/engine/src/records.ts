import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RunRecord, RunStatus } from "@vouch/protocol";

export function eventsFromJsonl(filePath: string): HarnessEvent[] {
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as HarnessEvent);
}

export function recordFromEvents(events: HarnessEvent[]): RunRecord {
  const start = events.find((e) => e.type === "run_start");
  if (!start || start.type !== "run_start") {
    throw new Error("run log is missing run_start");
  }
  const end = events.find((e) => e.type === "run_end");
  const grade = events.find((e) => e.type === "grade");
  const status: RunStatus =
    end && end.type === "run_end" ? end.status : "RUNNING";
  return {
    runId: start.runId,
    taskId: start.taskId,
    condition: start.condition,
    model: start.model,
    seed: start.seed,
    configHash: start.configHash,
    status,
    startedAt: start.ts,
    endedAt: end && end.type === "run_end" ? end.ts : null,
    elapsedMs: end && end.type === "run_end" ? end.elapsedMs : null,
    costUsd: end && end.type === "run_end" ? end.costUsd : 0,
    metrics: grade && grade.type === "grade" ? grade.metrics : null,
    events,
  };
}

export function loadRun(runsDir: string, runId: string): RunRecord {
  const path = join(runsDir, `${runId}.jsonl`);
  if (!existsSync(path)) throw new Error(`run not found: ${runId}`);
  return recordFromEvents(eventsFromJsonl(path));
}

export function listRuns(runsDir: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      try {
        return recordFromEvents(eventsFromJsonl(join(runsDir, f)));
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function summarizeEvent(event: HarnessEvent): string {
  switch (event.type) {
    case "run_start":
      return `${event.condition} ${event.taskId} model=${event.model} seed=${event.seed}`;
    case "state_change":
      return `${event.from} → ${event.to}`;
    case "role_assigned":
      return `${event.role} = ${event.runner}`;
    case "tool_call":
      return event.name;
    case "tool_result":
      return event.name;
    case "gate":
      if (event.phase === "reproduce") {
        return `reproduce reproduced=${event.reproduced} submissions=${event.submissions}`;
      }
      return `verify poc=${event.pocNeutralized} functional=${event.functionalPassed} passed=${event.passed}`;
    case "diff_snapshot": {
      const lines = event.patch.split("\n").length;
      return `patch ${lines} lines`;
    }
    case "grade":
      return `exploitNeutralized=${event.metrics.exploitNeutralized} functional=${event.metrics.functionalPass} diff=${event.metrics.diffLineCount}`;
    case "run_end":
      return `${event.status} ${event.elapsedMs}ms $${event.costUsd.toFixed(4)}`;
    case "model_msg":
      return event.role;
    case "budget_update":
      return `tokens=${event.tokens} steps=${event.steps}`;
  }
}

export function formatReplay(record: RunRecord): string {
  const t0 = record.startedAt;
  const lines: string[] = [
    `run ${record.runId}`,
    `  task=${record.taskId} condition=${record.condition} status=${record.status}`,
    `  events=${record.events.length} elapsedMs=${record.elapsedMs ?? "?"} costUsd=${record.costUsd.toFixed(4)}`,
    "",
  ];
  for (const e of record.events) {
    const rel = ((e.ts - t0) / 1000).toFixed(1).padStart(6);
    const type = e.type.padEnd(14);
    lines.push(`${rel}s  ${type}  ${summarizeEvent(e)}`);
  }
  return lines.join("\n") + "\n";
}
