import type { HarnessEvent, RunStatus } from "@vouch/protocol";

export interface RunSummary {
  runId: string;
  kind: "benchmark" | "local_repository";
  status: RunStatus;
  mode?: string;
  model?: string;
  condition?: string;
  taskId?: string;
  repository?: string;
  workflow?: "repository_review" | "repository_repair" | "repository_remediation";
  startedAt: number;
  endedAt?: number;
  elapsedMs?: number;
  eventCount: number;
  active: boolean;
  observation?: "active" | "tailing" | "completed" | "stale";
  streamable?: boolean;
  controllable?: boolean;
}

export interface RunSource {
  kind: "benchmark" | "local_repository";
  name?: string;
  url?: string;
  workflow?: "repository_review" | "repository_repair" | "repository_remediation";
  prompt?: string;
  taskId?: string;
  commit?: string;
  ref?: string;
  files: string[];
  filesAvailable: boolean;
  report?: string;
  regression?: string;
  regressionPath?: string;
  artifactsAvailable: boolean;
}

export interface RunPayload {
  runId: string;
  active: boolean;
  observation?: "active" | "tailing" | "completed" | "stale";
  streamable?: boolean;
  controllable?: boolean;
  events: HarnessEvent[];
  record: Record<string, unknown> | null;
  source: RunSource;
}

export interface BenchTask {
  id: string;
  kind: string;
  group: string;
  split: string;
  cveId?: string;
  hintLevel: number;
  report: string;
}

export interface Health {
  ok: boolean;
  runsDir: string;
  activeRuns: number;
  github?: { configured: boolean };
  live:
    | { blue: LiveModel; red: LiveModel }
    | { error: string };
}

export interface LiveModel {
  model: string;
  provider: string;
  baseURL?: string;
  keyEnv: string;
  keyPresent: boolean;
}

export type StartRequest =
  | { kind: "bench"; taskId: string; condition: "B" | "C"; seed?: number }
  | {
      kind: "repository";
      repoPath: string;
      workflow?: "review" | "repair" | "remediate";
      prompt?: string;
      regressionPath?: string;
      reportPath?: string;
      reportText?: string;
      ref?: string;
      mode: "live" | "scripted";
      patchPath?: string;
      seed?: number;
      review?: boolean;
    };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  runs: () => request<RunSummary[]>("/api/runs"),
  run: (id: string) => request<RunPayload>(`/api/runs/${encodeURIComponent(id)}`),
  tasks: () => request<BenchTask[]>("/api/bench/tasks"),
  start: (body: StartRequest) => request<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  cancel: (id: string) => request<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  pullRequest: (id: string) => request<{ url: string; number?: number }>(`/api/runs/${encodeURIComponent(id)}/pull-request`, { method: "POST", body: "{}" }),
  artifact: (id: string, name: string) => request<{ name: string; size: number; text: string }>(`/api/runs/${encodeURIComponent(id)}/artifact?name=${encodeURIComponent(name)}`),
  file: (id: string, path: string) => request<{ path: string; text: string; revision: string }>(`/api/runs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
  streamUrl: (id: string, after?: number) => `/api/runs/${encodeURIComponent(id)}/stream${after !== undefined ? `?after=${after}` : ""}`,
};
