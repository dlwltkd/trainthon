import { z, type ZodType } from "zod";
import type { AgentTool } from "@vouch/model";
import {
  listDirTool,
  readFileTool,
  writeLocalSource,
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

function literalSearch(workspace: LocalWorkspace, query: string) {
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
  workspace: LocalWorkspace,
  signal: AbortSignal,
  queue: SerialToolQueue,
): AgentTool[] {
  return [
    defineTool(
      "read_file",
      "Read a UTF-8 repository file. Args: { path }.",
      z.object({ path: z.string().min(1).max(500) }),
      ({ path }) => queue.run(() => {
        signal.throwIfAborted();
        return { content: readFileTool(workspace.dir, path) };
      }),
    ),
    defineTool(
      "list_dir",
      "List repository files below a path, or the whole repository when omitted. Args: { path? }.",
      z.object({ path: z.string().min(1).max(500).optional() }),
      ({ path }) => queue.run(() => {
        signal.throwIfAborted();
        return { entries: listDirTool(workspace.dir, path ?? ".") };
      }),
    ),
    defineTool(
      "grep",
      "Search repository text for a literal substring. Args: { pattern }.",
      z.object({ pattern: z.string().min(1).max(500) }),
      ({ pattern }) => queue.run(() => {
        signal.throwIfAborted();
        return { hits: literalSearch(workspace, pattern) };
      }),
    ),
  ];
}

export function buildLocalReviewTools(workspace: LocalWorkspace, signal: AbortSignal): AgentTool[] {
  return readTools(workspace, signal, new SerialToolQueue());
}

export interface LocalRepairToolset {
  tools: AgentTool[];
  drain(): Promise<void>;
}

export function buildLocalRepairTools(options: LocalToolOptions): LocalRepairToolset {
  const queue = new SerialToolQueue();
  const tools = readTools(options.workspace, options.signal, queue);
  tools.push(
    defineTool(
      "write_file",
      "Overwrite or create an application source file. Test, configuration, setup, manifest, lock, hidden, and regression files are rejected. Args: { path, content }.",
      z.object({ path: z.string().min(1).max(500), content: z.string().max(2_000_000) }),
      ({ path, content }) => queue.run(() => {
        options.signal.throwIfAborted();
        writeLocalSource(options.workspace, path, content);
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
