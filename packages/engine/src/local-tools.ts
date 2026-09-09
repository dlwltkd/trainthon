import { z, type ZodType } from "zod";
import type { EventInput, FindingReportedEvent } from "@vouch/protocol";
import type { AgentTool } from "@vouch/model";
import { createAgentTrace, type AgentTrace, type TraceWorkspace } from "./agent-trace.js";
import { REPOSITORY_REVIEW_SKILLS, SOURCE_REPAIR_SKILLS } from "@vouch/skills";
import {
  listDirTool,
  readFileTool,
  writeLocalSource,
  isLocalSourcePath,
  captureLocalChanges,
  type LocalWorkspace,
  type ProjectTestRunner,
  type StructuredTestResult,
  type TestSelection,
} from "@vouch/sandbox";

interface LocalToolOptions {
  workspace: LocalWorkspace;
  runner: ProjectTestRunner;
  signal: AbortSignal;
  remainingTimeoutMs: () => number;
  onTestResult: (selection: TestSelection, result: StructuredTestResult, durationMs: number) => string | undefined;
  onEvent: (event: EventInput) => void;
}

function defineTool<S extends ZodType>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>) => Promise<unknown>,
): AgentTool {
  return {
    name,
    description,
    schema: schema as unknown as ZodType<unknown>,
    execute: execute as (args: unknown) => Promise<unknown>,
  };
}

/** Tool calls from one model response may arrive concurrently. Keep reads, writes,
 * and tests in a single deterministic sequence so tests never race an edit. */
class SerialToolQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

function literalSearch(workspace: TraceWorkspace, query: string) {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of listDirTool(workspace.dir)) {
    if (file.endsWith("/")) continue;
    let content: string;
    try { content = readFileTool(workspace.dir, file); }
    catch { continue; }
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.includes(query)) continue;
      hits.push({ file, line: index + 1, text: line.slice(0, 300) });
      if (hits.length === 200) return hits;
    }
  }
  return hits;
}

function readTools(
  workspace: TraceWorkspace,
  signal: AbortSignal,
  queue: SerialToolQueue,
  trace: AgentTrace,
): AgentTool[] {
  return [
    defineTool(
      "read_file",
      "Read a UTF-8 repository file. Args: { path }.",
      z.object({ path: z.string().min(1).max(500) }),
      ({ path }) => queue.run(() => {
        signal.throwIfAborted();
        trace.requireReady();
        const content = readFileTool(workspace.dir, path);
        trace.observe([path]);
        return { content };
      }),
    ),
    defineTool(
      "list_dir",
      "List repository files below a path, or the whole repository when omitted. Args: { path? }.",
      z.object({ path: z.string().min(1).max(500).optional() }),
      ({ path }) => queue.run(() => {
        signal.throwIfAborted();
        trace.requireReady();
        return { entries: listDirTool(workspace.dir, path ?? ".") };
      }),
    ),
    defineTool(
      "grep",
      "Search repository text for a literal substring. Args: { pattern }.",
      z.object({ pattern: z.string().min(1).max(500) }),
      ({ pattern }) => queue.run(() => {
        signal.throwIfAborted();
        trace.requireReady();
        const hits = literalSearch(workspace, pattern);
        trace.observe(hits.map(hit => hit.file));
        return { hits };
      }),
    ),
  ];
}

export function buildLocalReviewTools(workspace: LocalWorkspace, signal: AbortSignal, onEvent: (event: EventInput) => void): AgentTool[] {
  const queue = new SerialToolQueue();
  const trace = createAgentTrace({ workspace, signal, onEvent, role: "red", enqueue: operation => queue.run(operation) });
  return [...trace.tools, ...readTools(workspace, signal, queue, trace)];
}

export function buildSourceReviewTools(workspace: TraceWorkspace, signal: AbortSignal, onEvent: (event: EventInput) => void, remediate = false) {
  const queue = new SerialToolQueue();
  const stage = remediate ? "PATCH" : "REVIEW";
  const trace = createAgentTrace({ workspace, signal, onEvent, role: "blue", stage, skills: remediate ? SOURCE_REPAIR_SKILLS : REPOSITORY_REVIEW_SKILLS, enqueue: operation => queue.run(operation) });
  const findings = new Map<string, Omit<FindingReportedEvent, "runId" | "seq" | "ts">>();
  const changeFindings = new Map<string, string[]>();
  let inspectedPatch: string | undefined;
  const findingSchema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), title: z.string().trim().min(1).max(180),
    severity: z.enum(["info", "low", "medium", "high", "critical"]), confidence: z.enum(["confirmed", "potential"]),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(6),
    summary: z.string().trim().min(1).max(1500), recommendation: z.string().trim().min(1).max(1500),
  }).strict();
  const tools: AgentTool[] = [...trace.tools, ...readTools(workspace, signal, queue, trace), {
    name: "report_finding", description: "Record a source-backed defensive finding. Evidence contains exact paths already read. Confirmed means source-supported, not runtime-tested. Up to 30 distinct findings; reuse an ID to update it.", schema: findingSchema,
    execute: (args, context) => queue.run(() => {
      signal.throwIfAborted(); trace.requireReady();
      const finding = findingSchema.parse(args);
      trace.assertEvidence(finding.evidence);
      if (!context?.callId) throw new Error("a logged call is required");
      if (findings.size >= 30 && !findings.has(finding.id)) throw new Error("finding limit reached");
      const { id, ...details } = finding;
      const event = { type: "finding_reported", findingId: id, ...details, callId: context.callId, agentRole: "blue", stage } as const;
      findings.set(id, event); onEvent(event);
      return { recorded: true, findingId: id };
    }),
  }];
  if (remediate) {
    const repair = workspace as LocalWorkspace;
    tools.push(defineTool("write_file", "Apply a minimal application source change for a confirmed finding. Provide findingId when adding a file or changing a related file outside the finding's evidence. Requires source-remediation skill. Tests and configuration are protected.", z.object({ path: z.string().min(1).max(500), content: z.string().max(2_000_000), findingId: z.string().max(60).optional() }), ({ path, content, findingId }) => queue.run(() => {
      signal.throwIfAborted(); trace.requireReady();
      if (trace.activeSkill() !== "source-remediation") throw new Error("load source-remediation before editing");
      if (!isLocalSourcePath(repair, path)) throw new Error(`only application source files may be edited: ${path}`);
      const related = [...findings.values()].filter(f => f.confidence === "confirmed" && f.severity !== "info" && (findingId ? f.findingId === findingId : f.evidence.includes(path)));
      if (!related.length) throw new Error("record a confirmed source-backed finding for this file or supply its findingId before editing");
      writeLocalSource(repair, path, content); trace.observe([path], true); inspectedPatch = undefined;
      changeFindings.set(path, related.map(f => f.findingId));
      return { ok: true, path, findingIds: changeFindings.get(path) };
    })));
    tools.push(defineTool("inspect_diff", "Inspect the exact candidate diff and enforce protected file boundaries. Does not run tests or prove the patch correct. Requires change-validation skill.", z.object({}), () => queue.run(async () => {
      signal.throwIfAborted(); trace.requireReady();
      if (trace.activeSkill() !== "change-validation") throw new Error("load change-validation before inspecting the final diff");
      const diff = await captureLocalChanges(repair); signal.throwIfAborted(); inspectedPatch = diff.patch;
      return { ...diff, checks: { protectedFilesUnchanged: true, testsRun: false } };
    })));
  }
  return { tools, drain: () => queue.drain(), findings: () => [...findings.values()], inspectedPatch: () => inspectedPatch, changeFindings: () => Object.fromEntries(changeFindings) };
}

export interface LocalRepairToolset {
  tools: AgentTool[];
  drain(): Promise<void>;
}

export function buildLocalRepairTools(options: LocalToolOptions): LocalRepairToolset {
  const queue = new SerialToolQueue();
  const trace = createAgentTrace({ ...options, role: "blue", enqueue: operation => queue.run(operation) });
  const tools = [...trace.tools, ...readTools(options.workspace, options.signal, queue, trace)];
  tools.push(
    defineTool(
      "write_file",
      "Overwrite or create an application source file. Test, configuration, setup, manifest, lock, hidden, and regression files are rejected. Args: { path, content }.",
      z.object({ path: z.string().min(1).max(500), content: z.string().max(2_000_000) }),
      ({ path, content }) => queue.run(() => {
        options.signal.throwIfAborted();
        trace.requireReady();
        writeLocalSource(options.workspace, path, content);
        trace.observe([path], true);
        return { ok: true, path };
      }),
    ),
  );
  for (const [name, description, selection] of [
    ["run_regression", "Run only the exact supplied security regression test in the isolated project container. No args.", "regression"],
    ["run_functional_tests", "Run the project's functional test suite while excluding the supplied regression. No args.", "functional"],
  ] as const) {
    tools.push(defineTool(name, description, z.object({}), () => queue.run(async () => {
      options.signal.throwIfAborted();
      trace.requireReady();
      const startedAt = performance.now();
      const result = await options.runner.runTests(options.workspace.dir, selection, {
        signal: options.signal,
        timeoutMs: Math.max(1, options.remainingTimeoutMs()),
      });
      const artifact = options.onTestResult(selection, result, Math.floor(performance.now() - startedAt));
      return { ...result, ...(artifact ? { artifact } : {}) };
    })));
  }
  return { tools, drain: () => queue.drain() };
}
