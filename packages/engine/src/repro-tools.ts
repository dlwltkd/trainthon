import { z, type ZodType } from "zod";
import type { AgentTool } from "@vouch/model";
import { runTestCommand, writeFileTool } from "@vouch/sandbox";

/** Where the Red role's proof-of-concept test lives inside the worktree. */
export const REPRO_PATH = "vouch.repro.test.ts";

/**
 * Shared between the Red and Blue roles. `reproduced` is set only during
 * REPRODUCE: true iff the submitted PoC fails on the unmodified code.
 */
export interface ReproState {
  path: string;
  reproduced: boolean;
  submissions: number;
}

export interface ReproToolContext {
  worktreeDir: string;
  timeoutMs: number;
  extraPath?: string;
  state: ReproState;
}

function cast<S extends ZodType>(
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

async function runRepro(ctx: ReproToolContext) {
  return runTestCommand(ctx.worktreeDir, `vitest run ${ctx.state.path}`, {
    timeoutMs: ctx.timeoutMs,
    extraPath: ctx.extraPath,
  });
}

/** Red: save the PoC test and run it; a failure now is the proof we want. */
export function buildSubmitReproTool(ctx: ReproToolContext): AgentTool {
  return cast(
    "submit_repro",
    `Save a reproduction test to ${ctx.state.path} and run it against the current code. Args: { content }. Returns { failsNow, output }; failsNow=true means the vulnerability is reproduced.`,
    z.object({ content: z.string() }),
    async ({ content }) => {
      writeFileTool(ctx.worktreeDir, ctx.state.path, content);
      const r = await runRepro(ctx);
      ctx.state.submissions += 1;
      ctx.state.reproduced = !r.passed;
      return { failsNow: !r.passed, output: r.output };
    },
  );
}

/** Blue: re-run the saved PoC; it must pass once the fix is correct. */
export function buildRunReproTool(ctx: ReproToolContext): AgentTool {
  return cast(
    "run_repro",
    `Run the reproduction test at ${ctx.state.path}. No args. Returns { passed, output }.`,
    z.object({}),
    async () => {
      const r = await runRepro(ctx);
      return { passed: r.passed, output: r.output };
    },
  );
}

/** Harness-side check used by the completion gate (not exposed to the model). */
export async function reproPasses(ctx: ReproToolContext): Promise<boolean> {
  return (await runRepro(ctx)).passed;
}
