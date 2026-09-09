import type { ZodType } from "zod";
import type { Budgets, EngineState, EventInput } from "@vouch/protocol";
import type { RunBudget } from "./budget.js";

/** A tool the agent may call. Backed by the sandbox; defined by the engine. */
export interface AgentTool<A = unknown, R = unknown> {
  name: string;
  description: string;
  schema: ZodType<A>;
  execute: (args: A) => Promise<R>;
}

export interface AgentRunInput {
  system: string;
  prompt: string;
  tools: AgentTool[];
  budgets: Budgets;
  model: string;
  budget?: RunBudget;
  role?: "solo" | "red" | "blue";
  stage?: EngineState;
  seed?: number;
  /** Emit events to the run log as the agent works. */
  onEvent: (event: EventInput) => void;
}

export interface AgentRunResult {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  steps: number;
}

/** Drives an agent to completion using a set of tools within a budget. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
