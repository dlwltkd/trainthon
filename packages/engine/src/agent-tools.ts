import { z, type ZodType } from "zod";
import type { AgentTool } from "@vouch/model";
import {
  grepTool,
  listDirTool,
  readFileTool,
  runTestCommand,
  writeFileTool,
} from "@vouch/sandbox";

export interface ToolContext {
  worktreeDir: string;
  testCmd: string;
  timeoutMs: number;
  extraPath?: string;
}

/** Localizes the unknown-cast so tool executes can use typed args. */
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

/** The tool surface shared by conditions B and C (same capabilities). */
export function buildTools(ctx: ToolContext): AgentTool[] {
  return [
    defineTool(
      "read_file",
      "Read a UTF-8 file from the repository. Args: { path }.",
      z.object({ path: z.string() }),
      async ({ path }) => ({ content: readFileTool(ctx.worktreeDir, path) }),
    ),
    defineTool(
      "list_dir",
      "List files and directories under a path (defaults to repo root). Args: { path? }.",
      z.object({ path: z.string().optional() }),
      async ({ path }) => ({ entries: listDirTool(ctx.worktreeDir, path ?? ".") }),
    ),
    defineTool(
      "grep",
      "Search file contents with a JavaScript regular expression. Args: { pattern }.",
      z.object({ pattern: z.string() }),
      async ({ pattern }) => ({ hits: grepTool(ctx.worktreeDir, pattern) }),
    ),
    defineTool(
      "write_file",
      "Overwrite (or create) a file with new contents. Args: { path, content }.",
      z.object({ path: z.string(), content: z.string() }),
      async ({ path, content }) => {
        writeFileTool(ctx.worktreeDir, path, content);
        return { ok: true };
      },
    ),
    defineTool(
      "run_tests",
      "Run the project's public test suite and return pass/fail with output. No args.",
      z.object({}),
      async () => {
        const r = await runTestCommand(ctx.worktreeDir, ctx.testCmd, {
          timeoutMs: ctx.timeoutMs,
          extraPath: ctx.extraPath,
        });
        return { passed: r.passed, output: r.output };
      },
    ),
  ];
}
