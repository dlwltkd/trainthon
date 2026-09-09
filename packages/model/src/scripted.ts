import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.js";

/** A tool callable exposed to a script: name -> invoke(args). */
export type ScriptToolMap = Record<string, (args: unknown) => Promise<unknown>>;

export type Script = (tools: ScriptToolMap) => Promise<string>;

/**
 * Deterministic runner used to smoke-test the sandbox/grader wiring when no
 * API key is present. It executes a fixed script of tool calls; it does NOT
 * consult a model and is never used for benchmark scoring.
 */
export class ScriptedRunner implements AgentRunner {
  constructor(private readonly script: Script) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const toolMap: ScriptToolMap = {};
    for (const tool of input.tools) {
      toolMap[tool.name] = async (args: unknown) => {
        input.onEvent({ type: "tool_call", name: tool.name, args });
        const result = await tool.execute(args as never);
        input.onEvent({
          type: "tool_result",
          name: tool.name,
          result,
          truncated: false,
        });
        return result;
      };
    }
    const finalText = await this.script(toolMap);
    input.onEvent({ type: "model_msg", role: "assistant", tokensIn: 0, tokensOut: 0 });
    return { finalText, inputTokens: 0, outputTokens: 0, steps: 1 };
  }
}
