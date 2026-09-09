import type { BenchReport, HarnessEvent, RunRecord, Task } from "@vouch/protocol";

export interface RunSummary {
  runId: string;
  taskId: string;
  condition: string;
  model: string;
  seed: number;
  status: string;
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number | null;
  costUsd: number;
  metrics: RunRecord["metrics"];
  eventCount: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  tasks: (split?: string) =>
    json<Task[]>(fetch(split ? `/api/tasks?split=${split}` : "/api/tasks")),
  runs: () => json<RunSummary[]>(fetch("/api/runs")),
  run: (id: string) => json<RunRecord>(fetch(`/api/runs/${id}`)),
  startRun: (body: { taskId: string; condition: "B" | "C" }) =>
    json<{ runId: string }>(
      fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  benchLatest: () => json<BenchReport>(fetch("/api/bench/latest")),
  runBench: () =>
    json<BenchReport>(
      fetch("/api/bench", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ split: "dev", conditions: ["B", "C"], repeats: 1 }),
      }),
    ),
};

export function subscribeRun(
  runId: string,
  onEvent: (event: HarnessEvent) => void,
  onDone: () => void,
): () => void {
  const es = new EventSource(`/api/runs/${runId}/events`);
  const seen = new Set<number>();
  es.onmessage = (msg) => {
    const event = JSON.parse(msg.data) as HarnessEvent;
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    onEvent(event);
    if (event.type === "run_end") {
      es.close();
      onDone();
    }
  };
  es.onerror = () => {
    es.close();
    onDone();
  };
  return () => es.close();
}
