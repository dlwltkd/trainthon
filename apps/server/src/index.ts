import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Condition, HarnessEvent, RunConfig, Split } from "@vouch/protocol";
import { DEFAULT_BUDGETS } from "@vouch/protocol";
import {
  executeBench,
  executeRun,
  listRuns,
  listTasks,
  loadRun,
  loadTask,
  makeRunId,
} from "@vouch/engine";
import { RunHub } from "./hub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const BENCH_DIR = resolve(REPO_ROOT, "bench");
const RUNS_DIR = resolve(REPO_ROOT, "runs");
const PORT = Number(process.env["PORT"] ?? "8787");
const DEFAULT_MODEL = "claude-sonnet-5";
const GRADER_VERSION = "0.0.0";

const hub = new RunHub();
const app = new Hono();
app.use("*", cors());

function isCondition(v: unknown): v is Condition {
  return v === "A" || v === "B" || v === "C";
}

function runSummary(record: ReturnType<typeof loadRun>) {
  return {
    runId: record.runId,
    taskId: record.taskId,
    condition: record.condition,
    model: record.model,
    seed: record.seed,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedMs: record.elapsedMs,
    costUsd: record.costUsd,
    metrics: record.metrics,
    eventCount: record.events.length,
  };
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/tasks", (c) => {
  const split = c.req.query("split") as Split | undefined;
  return c.json(listTasks(BENCH_DIR, split));
});

app.get("/api/runs", (c) => {
  return c.json(listRuns(RUNS_DIR).map(runSummary));
});

app.get("/api/runs/:id", (c) => {
  try {
    return c.json(loadRun(RUNS_DIR, c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
});

app.get("/api/runs/:id/events", (c) => {
  const runId = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const send = async (event: HarnessEvent) => {
      await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
    };

    if (hub.isLive(runId)) {
      await new Promise<void>((resolve) => {
        let chain = Promise.resolve();
        const unsub = hub.subscribe(runId, (event) => {
          chain = chain
            .then(() => send(event))
            .then(() => {
              if (event.type === "run_end") {
                unsub();
                resolve();
              }
            });
        });
        c.req.raw.signal.addEventListener("abort", () => {
          unsub();
          resolve();
        });
      });
      return;
    }

    try {
      const record = loadRun(RUNS_DIR, runId);
      for (const event of record.events) await send(event);
    } catch {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "run not found" }) });
    }
  });
});

app.post("/api/runs", async (c) => {
  const body = (await c.req.json()) as {
    taskId?: string;
    condition?: string;
    seed?: number;
    model?: string;
    provider?: string;
  };
  if (!body.taskId) return c.json({ error: "taskId required" }, 400);
  if (!isCondition(body.condition)) return c.json({ error: "condition must be A|B|C" }, 400);

  const task = loadTask(BENCH_DIR, body.taskId);
  const seed = body.seed ?? 1;
  const runId = makeRunId(task.id, body.condition, seed);
  const config: RunConfig = {
    model: body.model ?? DEFAULT_MODEL,
    provider: body.provider,
    seed,
    budgets: DEFAULT_BUDGETS,
    condition: body.condition,
    graderVersion: GRADER_VERSION,
  };

  hub.start(runId);
  void executeRun({
    task,
    config,
    runsDir: RUNS_DIR,
    repoRoot: REPO_ROOT,
    benchDir: BENCH_DIR,
    runId,
    onEvent: (e) => hub.emit(runId, e),
  })
    .catch((err) => {
      process.stderr.write(`run ${runId} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    })
    .finally(() => hub.finish(runId));

  return c.json({ runId }, 202);
});

app.get("/api/bench/latest", (c) => {
  try {
    const raw = readFileSync(resolve(RUNS_DIR, "bench-latest.json"), "utf8");
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({ error: "no bench report yet" }, 404);
  }
});

app.post("/api/bench", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    split?: Split;
    repeats?: number;
    conditions?: Condition[];
    seed?: number;
    model?: string;
    provider?: string;
  };
  const split: Split = body.split === "eval" ? "eval" : "dev";
  const conditions = (body.conditions ?? ["B", "C"]).filter(isCondition);
  const report = await executeBench({
    split,
    conditions,
    repeats: body.repeats ?? 1,
    seed: body.seed ?? 1,
    model: body.model ?? DEFAULT_MODEL,
    provider: body.provider,
    runsDir: RUNS_DIR,
    repoRoot: REPO_ROOT,
    benchDir: BENCH_DIR,
  });
  return c.json(report);
});

if (!existsSync(BENCH_DIR)) {
  process.stderr.write(`bench dir missing: ${BENCH_DIR}\n`);
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  process.stdout.write(`vouch server http://127.0.0.1:${info.port}\n`);
});
