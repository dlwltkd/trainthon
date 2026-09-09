import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.js";

const MAX_TOOL_RESULT_LOG = 8000;

/** Resolves a model id string to an AI SDK language model. */
export type ModelResolver = (modelId: string) => LanguageModel;

/**
 * Provider-agnostic agent runner over the Vercel AI SDK. Any provider whose
 * factory yields a `(modelId) => LanguageModel` resolver (Anthropic, OpenAI,
 * ...) plugs in here, so the tool loop, event emission, and budget handling
 * are shared across providers.
 */
export class SdkRunner implements AgentRunner {
  constructor(private readonly resolve: ModelResolver) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const tools: ToolSet = {};
    for (const spec of input.tools) {
      tools[spec.name] = tool({
        description: spec.description,
        inputSchema: spec.schema,
        execute: async (args: unknown) => {
          input.onEvent({ type: "tool_call", name: spec.name, args });
          const result = await spec.execute(args as never);
          const serialized =
            typeof result === "string" ? result : JSON.stringify(result);
          const truncated = serialized.length > MAX_TOOL_RESULT_LOG;
          input.onEvent({
            type: "tool_result",
            name: spec.name,
            result: truncated ? serialized.slice(0, MAX_TOOL_RESULT_LOG) : result,
            truncated,
          });
          return result;
        },
      });
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;

    const result = await generateText({
      model: this.resolve(input.model),
      system: input.system,
      prompt: input.prompt,
      tools,
      stopWhen: stepCountIs(input.budgets.maxSteps),
      onStepFinish: (step: { usage?: Record<string, number | undefined> }) => {
        steps++;
        const usage = step.usage ?? {};
        const inTok = usage.inputTokens ?? usage.promptTokens ?? 0;
        const outTok = usage.outputTokens ?? usage.completionTokens ?? 0;
        inputTokens += inTok;
        outputTokens += outTok;
        input.onEvent({
          type: "model_msg",
          role: "assistant",
          tokensIn: inTok,
          tokensOut: outTok,
        });
        input.onEvent({
          type: "budget_update",
          tokens: inputTokens + outputTokens,
          steps,
          elapsedMs: 0,
        });
      },
    });

    return { finalText: result.text, inputTokens, outputTokens, steps };
  }
}
