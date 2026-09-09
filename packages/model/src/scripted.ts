import { randomUUID } from "node:crypto";
import { RunBudget, withCancellation } from "./budget.js";
import { emitUsage, executeLoggedTool } from "./events.js";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.js";

export type ScriptToolMap = Record<string, (args: unknown) => Promise<unknown>>;
export type Script = (tools: ScriptToolMap) => Promise<string>;

/** Explicit deterministic fixture runner; never a fallback for live models. */
export class ScriptedRunner implements AgentRunner {
  constructor(private readonly script: Script) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const budget = input.budget ?? new RunBudget(input.budgets);
    try {
      budget.check();
      budget.consumeStep(0, 0);
      emitUsage(input, budget, 0, 0);
      const toolMap: ScriptToolMap = {};
      for (const tool of input.tools) {
        toolMap[tool.name] = (args: unknown) => executeLoggedTool(input, budget, tool, args, randomUUID());
      }
      const finalText = await withCancellation(Promise.resolve().then(() => {
        budget.assertActive();
        return this.script(toolMap);
      }), budget.signal);
      budget.assertActive();
      return { finalText, inputTokens: 0, outputTokens: 0, steps: 1 };
    } finally {
      if (!input.budget) budget.dispose();
    }
  }
}
