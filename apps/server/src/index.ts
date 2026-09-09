import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RepositoryEvent, RunStartEvent, ToolCallEvent } from "@vouch/protocol";
import { loadTask } from "@vouch/engine";
import { resolveLiveRoleModels } from "../../cli/src/run-options.js";
import { RUN_ID_PATTERN, RunRegistry, readBoundedText, resolveInside } from "./registry.js";
import { readTaskFile, startRun, type StartRequest } from "./runner.js";
import { observeRun } from "./stream.js";
import { createDraftPullRequest } from "./pull-request.js";
import { isHiddenPath } from "../../../packages/sandbox/src/fs-tools.js";
import { listSourceEvaluations, readEvaluationArtifact, readSourceEvaluation } from "./evaluations.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.VOUCH_SERVER_PORT ?? 8787);
const MAX_FILE_BYTES = 512_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".vite", ".worktrees"]);

export interface AppOptions {
  repoRoot?: string;
  runsDir?: string;
  benchDir?: string;
  dashboardDist?: string;
  port?: number;
  registry?: RunRegistry;
  start?: typeof startRun;
  streamOptions?: Parameters<typeof observeRun>[5];
}

export function createApp(options: AppOptions = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const BENCH_DIR = options.benchDir ?? resolve(repoRoot, "bench");
  const RUNS_DIR = options.runsDir ?? resolve(repoRoot, "runs");
  const DASHBOARD_DIST = options.dashboardDist ?? resolve(repoRoot, "apps/dashboard/dist");
  const port = options.port ?? PORT;
  const registry = options.registry ?? new RunRegistry(RUNS_DIR);
  const app = new Hono();
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    "http://localhost:5173", "http://127.0.0.1:5173",
  ]);
  let openStreams = 0;
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const origin = c.req.header("origin");
    if (!allowedHosts.has(host.toLowerCase()) || (origin !== undefined && !allowedOrigins.has(origin))) {
      return c.json({ error: "only the local dashboard may access this API" }, 403);
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("/api/*", cors({ origin: origin => allowedOrigins.has(origin) ? origin : undefined, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Last-Event-ID"] }));
  app.use("/api/*", bodyLimit({ maxSize: 512_000, onError: c => c.json({ error: "request body too large" }, 413) }));

  function walk(root: string, base = root, out: string[] = []): string[] {
    if (out.length >= 3_000) return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (isHiddenPath(entry.name) || IGNORED_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(root, entry.name);
      if (entry.isDirectory()) walk(full, base, out);
      else if (entry.isFile()) out.push(relative(base, full));
      if (out.length >= 3_000) break;
    }
    return out.sort();
  }

  function taskRepoDir(taskId: string): string | null {
    try {
      const task = loadTask(BENCH_DIR, taskId);
      const dir = resolveInside(repoRoot, task.repoRef.url);
      return dir && existsSync(dir) ? dir : null;
    } catch {
      return null;
    }
  }

  function liveConfiguration() {
    try {
      const models = resolveLiveRoleModels({}, process.env);
      const keyEnv = (spec: { provider: string; apiKeyEnv?: string }) =>
        spec.apiKeyEnv ?? (spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : spec.provider === "openai" ? "OPENAI_API_KEY" : "ROUTEWAY_API_KEY");
      const describe = (spec: { model: string; provider: string; baseURL?: string; apiKeyEnv?: string }) => ({
        model: spec.model,
        provider: spec.provider,
        baseURL: spec.baseURL,
        keyEnv: keyEnv(spec),
        keyPresent: Boolean(process.env[keyEnv(spec)]),
      });
      return { blue: describe(models.blue), red: describe(models.red) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      runsDir: RUNS_DIR,
      activeRuns: registry.activeCount,
      live: liveConfiguration(),
      github: { configured: Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()) },
    }),
  );

  app.get("/api/bench/tasks", (c) => {
    const tasksDir = join(BENCH_DIR, "tasks");
    if (!existsSync(tasksDir)) return c.json([]);
    const tasks = readdirSync(tasksDir)
      .filter((id) => existsSync(join(tasksDir, id, "task.json")))
      .map((id) => {
        try {
          const task = loadTask(BENCH_DIR, id);
          return { id: task.id, kind: task.kind, group: task.group, split: task.split, cveId: task.cveId, hintLevel: task.report.hintLevel, report: task.report.text };
        } catch {
          return null;
        }
      })
      .filter((task) => task !== null);
    return c.json(tasks);
  });

  app.get("/api/evaluations", c => c.json(listSourceEvaluations(RUNS_DIR)));
  app.get("/api/evaluations/:id", c => {
    const evaluation = readSourceEvaluation(RUNS_DIR, c.req.param("id"));
    return evaluation ? c.json(evaluation) : c.json({ error: "evaluation not found" }, 404);
  });
  app.get("/api/evaluations/:id/artifact", c => {
    const text = readEvaluationArtifact(RUNS_DIR, c.req.param("id"), c.req.query("case") ?? "", c.req.query("arm") ?? "", c.req.query("name") ?? "");
    return text === null ? c.json({ error: "artifact not found" }, 404) : c.text(text);
  });

  app.get("/api/runs", (c) => c.json(registry.list()));

  app.post("/api/runs", async (c) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "JSON content type required" }, 415);
    if (registry.activeCount >= 2) return c.json({ error: "two runs are already active" }, 429);
    let body: StartRequest;
    try {
      body = (await c.req.json()) as StartRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      if (!body || typeof body !== "object" || (body.kind !== "bench" && body.kind !== "repository")) return c.json({ error: "invalid run request" }, 400);
      const run = await (options.start ?? startRun)(body, { repoRoot, benchDir: BENCH_DIR, runsDir: RUNS_DIR }, registry);
      return c.json({ runId: run.runId }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    const stored = registry.load(id);
    if (!stored) return c.json({ error: "run not found" }, 404);
    const start = stored.events.find((e): e is RunStartEvent => e.type === "run_start");
    const snapshot = stored.events.find((e): e is RepositoryEvent => e.type === "repository_snapshot");
    const taskId = start?.taskId ?? stored.sidecar.taskId;

    let files: string[] | undefined = snapshot?.files?.filter(path => typeof path === "string" && !isHiddenPath(path));
    let report: string | undefined;
    let prompt: string | undefined;
    let regression: string | undefined;
    let regressionPath: string | undefined;
    let name = snapshot?.name ?? start?.repository?.name;
    let filesAvailable = false;

    if (taskId) {
      const repoDir = taskRepoDir(taskId);
      if (repoDir) {
        files ??= walk(repoDir);
        filesAvailable = true;
      }
      try {
        const task = loadTask(BENCH_DIR, taskId);
        report = task.report.text;
        name ??= `bench/${task.id}`;
      } catch {
        // Task definitions can be removed after a run was recorded; the run stays viewable.
      }
      const submit = stored.events.find(
        (e): e is ToolCallEvent => e.type === "tool_call" && e.name === "submit_repro",
      );
      const content = submit && typeof submit.args === "object" && submit.args !== null ? (submit.args as { content?: unknown }).content : undefined;
      if (typeof content === "string") {
        regression = content;
        regressionPath = "vouch.repro.test.ts";
      }
    }
    if (stored.dir) {
      prompt = readBoundedText(stored.dir, "prompt.txt", MAX_FILE_BYTES) ?? undefined;
      report ??= readBoundedText(stored.dir, "report.txt", MAX_FILE_BYTES) ?? undefined;
      const record = stored.record as { repository?: { regressionPath?: string } } | null;
      regressionPath ??= record?.repository?.regressionPath;
      const regressionFile = readdirSync(stored.dir).find(f => /^regression\.[a-z0-9]+$/i.test(f));
      if (regressionFile) regression ??= readBoundedText(stored.dir, regressionFile, MAX_FILE_BYTES) ?? undefined;
      if (stored.sidecar.repoPath && existsSync(stored.sidecar.repoPath) && files?.length) filesAvailable = true;
      if (resolveInside(stored.dir, "source") && existsSync(join(stored.dir, "source")) && files?.length) filesAvailable = true;
    }

    return c.json({
      runId: stored.runId,
      active: stored.active,
      observation: stored.observation,
      streamable: stored.streamable,
      controllable: stored.controllable,
      events: stored.events,
      record: stored.record,
      source: {
        workflow: start?.workflow ?? (stored.record as { workflow?: string } | null)?.workflow,
        url: snapshot?.url,
        prompt,
        kind: taskId ? "benchmark" : "local_repository",
        name,
        taskId,
        commit: snapshot?.commit ?? start?.repository?.commit,
        ref: start?.repository?.ref,
        files: files ?? [],
        filesAvailable,
        report,
        regression,
        regressionPath,
        artifactsAvailable: Boolean(stored.dir),
      },
    });
  });

  app.get("/api/runs/:id/stream", (c) => {
    const id = c.req.param("id");
    const stored = registry.load(id);
    if (!stored) return c.json({ error: "run not found" }, 404);
    const cursors = [c.req.query("after"), c.req.header("Last-Event-ID")].filter((value): value is string => value !== undefined).map(Number);
    if (cursors.some(value => !Number.isSafeInteger(value) || value < -1)) return c.json({ error: "invalid event cursor" }, 400);
    const after = Math.max(-1, ...cursors);
    if (openStreams >= 16) return c.json({ error: "too many event streams" }, 429);
    openStreams++;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        await observeRun(registry, id, after, frame => stream.writeSSE(frame), controller.signal, options.streamOptions);
      } finally {
        openStreams--;
      }
    });
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    const active = registry.getActive(id);
    if (!active || active.done) return c.json({ error: "run is not active" }, 409);
    active.controller.abort();
    return c.json({ ok: true });
  });

  app.post("/api/runs/:id/pull-request", async (c) => {
    const stored = registry.load(c.req.param("id"));
    if (!stored || stored.observation !== "completed" || !stored.record) return c.json({ error: "a completed patch run is required" }, 409);
    try { return c.json(await createDraftPullRequest(stored.record, { runsDir: RUNS_DIR })); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Draft PR creation failed" }, 400); }
  });

  app.get("/api/runs/:id/artifact", (c) => {
    const id = c.req.param("id");
    const name = c.req.query("name");
    if (!RUN_ID_PATTERN.test(id) || !name) return c.json({ error: "bad request" }, 400);
    const dir = registry.runDir(id);
    if (!dir) return c.json({ error: "no artifact directory for this run" }, 404);
    if (!/^(?:record\.json|events\.jsonl|patch\.diff|input-patch\.diff|prompt\.txt|report\.txt|repository\.json|red-review-handoff\.json|red-review-summary\.txt|regression\.[a-z0-9]+|(?:repair|review)-summary\.txt|tests\/[a-z0-9._-]+\.(?:json|txt))$/i.test(name)) {
      return c.json({ error: "artifact not available" }, 404);
    }
    const text = readBoundedText(dir, name, MAX_FILE_BYTES);
    if (text === null) return c.json({ error: "artifact unavailable or exceeds preview limit" }, 404);
    return c.json({ name, size: Buffer.byteLength(text), text });
  });

  app.get("/api/runs/:id/file", (c) => {
    const id = c.req.param("id");
    const path = c.req.query("path");
    if (!RUN_ID_PATTERN.test(id) || !path) return c.json({ error: "bad request" }, 400);
    const stored = registry.load(id);
    if (!stored) return c.json({ error: "run not found" }, 404);
    const start = stored.events.find((e): e is RunStartEvent => e.type === "run_start");
    const taskId = start?.taskId ?? stored.sidecar.taskId;
    const snapshot = stored.events.find((e): e is RepositoryEvent => e.type === "repository_snapshot");
    if (isHiddenPath(path) || path.includes("\\") || path.startsWith("/") || path.split("/").some(part => part === ".." || part === "." || !part)) {
      return c.json({ error: "file not available" }, 404);
    }

    if (taskId) {
      const repoDir = taskRepoDir(taskId);
      const files = snapshot?.files ?? (repoDir ? walk(repoDir) : []);
      if (!repoDir || !files.includes(path)) return c.json({ error: "file not in repository snapshot" }, 404);
      const text = readBoundedText(repoDir, path, MAX_FILE_BYTES);
      if (text === null) return c.json({ error: "file unavailable or exceeds preview limit" }, 404);
      return c.json({ path, text, revision: "task fixture" });
    }

    const repoPath = stored.sidecar.repoPath;
    const commit = snapshot?.commit ?? start?.repository?.commit;
    if (!snapshot?.files.includes(path)) return c.json({ error: "file not in repository snapshot" }, 404);
    if (stored.dir && existsSync(join(stored.dir, "source"))) {
      const text = readBoundedText(stored.dir, `source/${path}`, MAX_FILE_BYTES);
      if (text === null) return c.json({ error: "file unavailable or exceeds preview limit" }, 404);
      return c.json({ path, text, revision: commit });
    }
    if (!repoPath || !existsSync(repoPath) || !commit || !/^[a-f0-9]{40,64}$/i.test(commit)) {
      return c.json({ error: "file contents are not available for this run (repository path unknown)" }, 404);
    }
    if (!snapshot?.files.includes(path)) return c.json({ error: "file not in repository snapshot" }, 404);
    try {
      if (path === (stored.record as { repository?: { regressionPath?: string } } | null)?.repository?.regressionPath && stored.dir) {
        const regressionFile = readdirSync(stored.dir).find(f => /^regression\.[a-z0-9]+$/i.test(f));
        const text = regressionFile && readBoundedText(stored.dir, regressionFile, MAX_FILE_BYTES);
        if (text !== null && text !== undefined) return c.json({ path, text, revision: "supplied regression" });
      }
      const text = execFileSync("git", ["-C", repoPath, "show", `${commit}:${path}`], {
        encoding: "utf8",
        maxBuffer: MAX_FILE_BYTES,
        timeout: 3_000,
        env: { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return c.json({ path, text, revision: commit });
    } catch {
      return c.json({ error: "file not found at the checked commit" }, 404);
    }
  });

  app.get("/api/bench/tasks/:id/report", (c) => {
    const text = readTaskFile(BENCH_DIR, c.req.param("id"), "task.json");
    if (!text) return c.json({ error: "task not found" }, 404);
    return c.json(JSON.parse(text));
  });

  if (existsSync(DASHBOARD_DIST)) {
    app.use("/*", serveStatic({ root: relative(process.cwd(), DASHBOARD_DIST) || "." }));
    app.get("*", (c) => c.html(readFileSync(join(DASHBOARD_DIST, "index.html"), "utf8")));
  }

  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPath = resolve(REPO_ROOT, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
  serve({ fetch: createApp().fetch, port: PORT, hostname: "127.0.0.1" }, info => {
    process.stdout.write(`vouch server listening on http://127.0.0.1:${info.port}\n`);
  });
}
