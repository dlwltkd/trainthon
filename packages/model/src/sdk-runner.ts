import { generateText, tool, wrapLanguageModel, type LanguageModel, type ToolSet } from "ai";
import { RunBudget, withCancellation } from "./budget.js";
import { emitUsage, eventContext, executeLoggedTool, toolEventArgs } from "./events.js";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.js";

export type ModelResolver = (modelId: string) => LanguageModel;

type RequestForEstimate = {
  prompt: readonly unknown[];
  tools?: readonly unknown[];
  responseFormat?: unknown;
  toolChoice?: unknown;
  stopSequences?: readonly string[];
  providerOptions?: unknown;
};

const REQUEST_OVERHEAD = 256;
const MESSAGE_OVERHEAD = 64;
const TOOL_OVERHEAD = 96;

/**
 * Provider-independent upper bound for ordinary byte-tokenized text requests.
 * Every serialized UTF-8 byte is counted as a token, with extra request,
 * message, tool, and binary framing capacity.
 */
export function estimateRequestInputTokens(params: RequestForEstimate): number {
  let binaryAllowance = 0;
  let serialized: string;
  try {
    serialized = JSON.stringify({
      prompt: params.prompt,
      tools: params.tools,
      responseFormat: params.responseFormat,
      toolChoice: params.toolChoice,
      stopSequences: params.stopSequences,
      providerOptions: params.providerOptions,
    }, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function" || typeof value === "symbol") return String(value);
      if (value instanceof ArrayBuffer) {
        binaryAllowance += value.byteLength * 2;
        return { binaryByteLength: value.byteLength };
      }
      if (ArrayBuffer.isView(value)) {
        binaryAllowance += value.byteLength * 2;
        return { binaryByteLength: value.byteLength };
      }
      return value;
    }) ?? "";
  } catch (error) {
    throw new Error("Cannot safely estimate model request token usage", { cause: error });
  }
  const estimate = REQUEST_OVERHEAD
    + params.prompt.length * MESSAGE_OVERHEAD
    + (params.tools?.length ?? 0) * TOOL_OVERHEAD
    + new TextEncoder().encode(serialized).byteLength
    + binaryAllowance;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, estimate));
}

export class SdkRunner implements AgentRunner {
  constructor(private readonly resolve: ModelResolver) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const budget = input.budget ?? new RunBudget(input.budgets);
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;
    try {
      budget.check();
      const resolved = this.resolve(input.model);
      if (typeof resolved === "string") throw new Error("ModelResolver must return an explicit provider model");
      const model = wrapLanguageModel({
        model: resolved,
        middleware: {
          transformParams: async ({ params }) => {
            budget.check();
            const estimatedInputTokens = estimateRequestInputTokens(params);
            budget.requireTokens(estimatedInputTokens + 1);
            return {
              ...params,
              maxOutputTokens: Math.min(params.maxOutputTokens ?? 8192, 8192, budget.remainingTokens - estimatedInputTokens),
              abortSignal: budget.signal,
            };
          },
          wrapGenerate: async ({ doGenerate, params }) => {
            budget.check();
            const estimatedInputTokens = estimateRequestInputTokens(params);
            const releaseReservation = budget.reserveTokens(estimatedInputTokens + (params.maxOutputTokens ?? 0));
            budget.consumeStep(0, 0);
            steps++;
            let inTok = 0;
            let outTok = 0;
            let receivedUsage = false;
            try {
              const result = await withCancellation(doGenerate(), budget.signal);
              const reportedInput = result.usage.inputTokens;
              const reportedOutput = result.usage.outputTokens;
              if (![reportedInput, reportedOutput].every(value => Number.isSafeInteger(value) && value! >= 0)) {
                budget.markUsageUnknown();
                throw new Error("Provider did not return complete token usage");
              }
              inTok = reportedInput!;
              outTok = reportedOutput!;
              releaseReservation();
              budget.recordTokens(inTok, outTok);
              receivedUsage = true;
              inputTokens += inTok;
              outputTokens += outTok;
              budget.assertActive();
              return result;
            } catch (error) {
              if (!receivedUsage) budget.markUsageUnknown();
              throw error;
            } finally {
              releaseReservation();
              emitUsage(input, budget, inTok, outTok);
            }
          },
        },
      });
      const tools: ToolSet = {};
      for (const spec of input.tools) {
        tools[spec.name] = tool({
          description: spec.description,
          inputSchema: spec.schema,
          execute: (args: unknown, options) => executeLoggedTool(input, budget, spec, args, options.toolCallId),
        });
      }
      const result = await withCancellation(generateText({
        model,
        system: input.system,
        prompt: input.prompt,
        tools,
        toolChoice: input.toolChoice,
        seed: input.seed,
        maxRetries: 0,
        abortSignal: budget.signal,
        maxOutputTokens: Math.min(8192, budget.remainingTokens),
        // A tool call made on the final allowed model step may still complete;
        // the harness can verify its effects without forcing an N+1 response.
        stopWhen: () => budget.remainingSteps === 0,
        onStepFinish: (step) => {
          for (const call of step.toolCalls) {
            if (!call.invalid) continue;
            const context = { callId: call.toolCallId, ...eventContext(input) };
            input.onEvent({ type: "tool_call", name: call.toolName, args: toolEventArgs(call.toolName, call.input), outcome: "started", ...context });
            input.onEvent({ type: "tool_error", name: call.toolName, error: call.error instanceof Error ? call.error.message : String(call.error), outcome: "failed", durationMs: 0, ...context });
          }
        },
      }), budget.signal);
      budget.assertActive();
      if (budget.usage.inputTokens + budget.usage.outputTokens > budget.limits.maxTokens) budget.check();
      return { finalText: result.text, inputTokens, outputTokens, steps };
    } catch (error) {
      if (budget.signal.aborted) throw budget.signal.reason;
      throw error;
    } finally {
      if (!input.budget) budget.dispose();
    }
  }
}
