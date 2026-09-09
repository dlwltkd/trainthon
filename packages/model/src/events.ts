import { createHash } from "node:crypto";
import type { AgentRunInput, AgentTool } from "./types.js";
import { RunBudget, withCancellation } from "./budget.js";

const MAX_TOOL_RESULT_LOG = 8000;
const MAX_TOOL_ARGS_LOG = 8000;

function short(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 160) : undefined;
}

function actionSummary(name: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = short(input.path);
  switch (name) {
    case "read_file": return path ? `Reading ${path}` : "Reading a repository file";
    case "list_dir": return path ? `Listing ${path}` : "Listing repository files";
    case "grep": return short(input.pattern) ? `Searching for ${JSON.stringify(short(input.pattern))}` : "Searching repository text";
    case "write_file": return path ? `Updating ${path}` : "Updating an application source file";
    case "run_regression":
    case "run_repro": return "Running the supplied security regression";
    case "run_functional_tests":
    case "run_tests": return "Running functional tests";
    case "apply_supplied_patch": return "Applying the supplied source patch";
    default: return `Running ${name}`;
  }
}

export function toolEventArgs(name: string, args: unknown): unknown {
  let safe = args;
  if (name === "write_file" && args && typeof args === "object") {
    const input = args as Record<string, unknown>;
    if (typeof input.content === "string") {
      safe = {
        ...input,
        content: `[omitted ${Buffer.byteLength(input.content)} bytes]`,
        contentSha256: createHash("sha256").update(input.content).digest("hex"),
      };
    }
  }
  const serialized = JSON.stringify(safe) ?? "null";
  return serialized.length <= MAX_TOOL_ARGS_LOG
    ? safe
    : { truncated: true, preview: serialized.slice(0, MAX_TOOL_ARGS_LOG) };
}

export function eventContext(input: AgentRunInput) {
  return { agentRole: input.role ?? "solo", stage: input.stage ?? "PATCH" } as const;
}

export function emitUsage(input: AgentRunInput, budget: RunBudget, inputTokens: number, outputTokens: number): void {
  input.onEvent({ type: "model_msg", role: "assistant", tokensIn: inputTokens, tokensOut: outputTokens, ...eventContext(input) });
  const usage = budget.usage;
  input.onEvent({ type: "budget_update", tokens: usage.inputTokens + usage.outputTokens, steps: usage.steps, elapsedMs: budget.elapsedMs, ...eventContext(input) });
}

export async function executeLoggedTool(
  input: AgentRunInput,
  budget: RunBudget,
  tool: AgentTool,
  args: unknown,
  callId: string,
): Promise<unknown> {
  budget.assertActive();
  const startedAt = performance.now();
  const context = { callId, ...eventContext(input) };
  input.onEvent({ type: "action_summary", summary: actionSummary(tool.name, args), ...context });
  input.onEvent({ type: "tool_call", name: tool.name, args: toolEventArgs(tool.name, args), outcome: "started", ...context });
  try {
    const result = await withCancellation(Promise.resolve().then(() => {
      budget.assertActive();
      return tool.execute(args);
    }), budget.signal);
    budget.assertActive();
    const serialized = typeof result === "string" ? result : JSON.stringify(result) ?? "null";
    const truncated = serialized.length > MAX_TOOL_RESULT_LOG;
    input.onEvent({
      type: "tool_result", name: tool.name,
      result: truncated ? serialized.slice(0, MAX_TOOL_RESULT_LOG) : result ?? null,
      truncated, outcome: "succeeded", durationMs: Math.floor(performance.now() - startedAt), ...context,
    });
    return result;
  } catch (error) {
    input.onEvent({ type: "tool_error", name: tool.name, error: error instanceof Error ? error.message : String(error), outcome: "failed", durationMs: Math.floor(performance.now() - startedAt), ...context });
    throw error;
  }
}
