import type { ZodType } from "zod";
import type { Budgets, EngineState, EventInput } from "@vouch/protocol";
import type { RunBudget } from "./budget.js";

/** A tool the agent may call. Backed by the sandbox; defined by the engine. */
export interface AgentTool<A = unknown, R = unknown> {
  name: string;
  description: string;
  schema: ZodType<A>;
  execute: (args: A, context?: { callId: string }) => Promise<R>;
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
  /** Per-response output allowance, within the shared run budget. Defaults to 8192. */
  maxOutputTokens?: number;
  /** Finish this role with a tool-free handoff after either investigation allowance is reached. */
  handoffAfter?: { tokens: number; steps: number };
  /** Constrain whether the provider may or must call one of the supplied tools. */
  toolChoice?: "auto" | "required" | "none";
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
