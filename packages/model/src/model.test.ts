import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { APICallError } from "ai";
import { z } from "zod";
import type { EventInput } from "@vouch/protocol";
import { BudgetExceededError, RunBudget, RunCancelledError } from "./budget.js";
import { estimateRequestInputTokens, SdkRunner } from "./sdk-runner.js";
import { ScriptedRunner } from "./scripted.js";
import {
  GATEWAYS,
  ROUTEWAY_GLM_FLASH_UNCENSORED,
  canonicalizeModelSpec,
  createCompatibleRunner,
  createRunnerForSpec,
  probeModel,
  requireRunnerForSpec,
  resolveRunnerFromEnv,
  validateModelSpec,
} from "./providers.js";
import { estimateCost } from "./pricing.js";
import type { AgentRunInput, AgentRunner } from "./types.js";

const limits = { maxTokens: 20_000, maxSteps: 4, maxWallMs: 10_000 };
const allocated: RunBudget[] = [];
function budget(overrides: Partial<typeof limits> = {}, signal?: AbortSignal) {
  const value = new RunBudget({ ...limits, ...overrides }, signal);
  allocated.push(value);
  return value;
}
function input(shared = budget()): AgentRunInput & { events: EventInput[] } {
  const events: EventInput[] = [];
  return { system: "Review a supplied test.", prompt: "Read the fixture.", tools: [], budgets: shared.limits, budget: shared, model: "test-model", role: "blue", stage: "PATCH", seed: 7, events, onEvent: (event) => events.push(event) };
}
type ModelReply = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;
function reply(content: ModelReply["content"] = [{ type: "text", text: "Done" }], tokens = 10): ModelReply {
  return { content, finishReason: content.some((part) => part.type === "tool-call") ? "tool-calls" : "stop", usage: { inputTokens: tokens, outputTokens: 2, totalTokens: tokens + 2 }, warnings: [] };
}
function toolReply(name = "read_file", callId = "read-1") {
  return reply([{ type: "tool-call", toolCallId: callId, toolName: name, input: JSON.stringify({ path: "src/example.ts" }) }]);
}
function fileTool(execute = async (_args: unknown): Promise<unknown> => "fixture") {
  return { name: "read_file", description: "Read fixture text", schema: z.object({ path: z.string() }), execute };
}

afterEach(() => {
  for (const item of allocated.splice(0)) item.dispose();
  vi.useRealTimers();
});

describe("RunBudget", () => {
  it("shares usage and preserves an in-flight token overrun", () => {
    const shared = budget({ maxTokens: 100 });
    shared.consumeStep(90, 20);
    expect(shared.usage).toEqual({ inputTokens: 90, outputTokens: 20, steps: 1 });
    expect(shared.remainingTokens).toBe(0);
    expect(() => shared.check()).toThrow(BudgetExceededError);
    expect(shared.signal.reason.reason).toBe("tokens");
  });

  it("lets the final allowed step finish but rejects a subsequent step", () => {
    const shared = budget({ maxSteps: 1 });
    shared.consumeStep(2, 3);
    expect(() => shared.assertActive()).not.toThrow();
    expect(() => shared.check()).toThrow("steps budget exhausted");
  });

  it("enforces an immutable copy of caller-supplied limits", () => {
    const supplied = { ...limits, maxTokens: 50 };
    const shared = new RunBudget(supplied);
    allocated.push(shared);
    supplied.maxTokens = 5_000;
    expect(shared.limits.maxTokens).toBe(50);
    expect(Object.isFrozen(shared.limits)).toBe(true);
    shared.consumeStep(40, 10);
    expect(() => shared.check()).toThrow("tokens budget exhausted");
  });

  it("propagates external cancellation and the wall deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancelled = budget({}, controller.signal);
    controller.abort();
    expect(() => cancelled.check()).toThrow(RunCancelledError);
    const timed = budget({ maxWallMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(() => timed.assertActive()).toThrow("wall budget exhausted");
  });
});

describe("SdkRunner", () => {
  it("caps each request, correlates tool events, and accounts across roles", async () => {
    const model = new MockLanguageModelV2({ doGenerate: [toolReply(), reply()] });
    const run = input();
    run.tools = [fileTool()];
    const result = await new SdkRunner(() => model).run(run);
    expect(result).toMatchObject({ finalText: "Done", inputTokens: 20, outputTokens: 4, steps: 2 });
    for (const [index, call] of model.doGenerateCalls.entries()) {
      const priorUsage = index === 0 ? 0 : 12;
      expect(estimateRequestInputTokens(call) + call.maxOutputTokens!).toBeLessThanOrEqual(limits.maxTokens - priorUsage);
      expect(call.maxOutputTokens).toBeLessThanOrEqual(8192);
    }
    expect(model.doGenerateCalls[0]?.seed).toBe(7);
    expect(model.doGenerateCalls[0]?.abortSignal).toBe(run.budget!.signal);
    const call = run.events.find((event) => event.type === "tool_call");
    const output = run.events.find((event) => event.type === "tool_result");
    expect(call).toMatchObject({ callId: "read-1", agentRole: "blue", stage: "PATCH", outcome: "started" });
    expect(output).toMatchObject({ callId: "read-1", outcome: "succeeded", result: "fixture", durationMs: expect.any(Number) });
    expect(run.events).toContainEqual(expect.objectContaining({ type: "action_summary", callId: "read-1", summary: "Reading src/example.ts" }));
    await new ScriptedRunner(async () => "reviewed").run({ ...run, role: "red" });
    expect(run.budget!.usage).toEqual({ inputTokens: 20, outputTokens: 4, steps: 3 });
  });

  it("passes an explicit tool choice to the provider", async () => {
    const model = new MockLanguageModelV2({ doGenerate: reply() });
    const run = input();
    run.tools = [fileTool()];
    run.toolChoice = "required";
    await new SdkRunner(() => model).run(run);
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: "required" });
  });

  it("retains provider usage when a tool fails and emits its error", async () => {
    const model = new MockLanguageModelV2({ doGenerate: [toolReply(), reply()] });
    const run = input();
    run.tools = [fileTool(async () => { throw new Error("file unavailable"); })];
    await new SdkRunner(() => model).run(run);
    expect(run.budget!.usage).toEqual({ inputTokens: 20, outputTokens: 4, steps: 2 });
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_error", callId: "read-1", outcome: "failed", error: "file unavailable" }));
  });

  it("keeps a tool result from the final allowed step without an N+1 request", async () => {
    const model = new MockLanguageModelV2({ doGenerate: toolReply() });
    const run = input(budget({ maxSteps: 1 }));
    run.tools = [fileTool()];
    const result = await new SdkRunner(() => model).run(run);
    expect(result.steps).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(run.budget!.usage).toEqual({ inputTokens: 10, outputTokens: 2, steps: 1 });
    expect(run.events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("rejects oversized request context before invoking the provider", async () => {
    const model = new MockLanguageModelV2({ doGenerate: reply() });
    const run = input(budget({ maxTokens: 1_000 }));
    run.prompt = "x".repeat(2_000);
    await expect(new SdkRunner(() => model).run(run)).rejects.toThrow("tokens budget exhausted");
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(run.budget!.usage).toEqual({ inputTokens: 0, outputTokens: 0, steps: 0 });
  });

  it("blocks a second provider call when tool output makes the request too large", async () => {
    const model = new MockLanguageModelV2({ doGenerate: [toolReply(), reply()] });
    const run = input(budget({ maxTokens: 2_500 }));
    run.tools = [fileTool(async () => "x".repeat(3_000))];
    await expect(new SdkRunner(() => model).run(run)).rejects.toThrow("tokens budget exhausted");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(run.budget!.usage).toEqual({ inputTokens: 10, outputTokens: 2, steps: 1 });
  });

  it("reserves context capacity when setting the provider output limit", async () => {
    const model = new MockLanguageModelV2({ doGenerate: reply() });
    const run = input(budget({ maxTokens: 2_000 }));
    run.prompt = "x".repeat(500);
    await new SdkRunner(() => model).run(run);
    const call = model.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(2_000 - estimateRequestInputTokens(call));
    expect(call.maxOutputTokens).toBeGreaterThan(0);
  });

  it("records token overruns without issuing a second request", async () => {
    const model = new MockLanguageModelV2({ doGenerate: reply(undefined, 20_100) });
    const run = input();
    await expect(new SdkRunner(() => model).run(run)).rejects.toThrow("tokens budget exhausted");
    expect(run.budget!.usage.inputTokens).toBe(20_100);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("counts failed requests and never retries a provider error", async () => {
    const model = new MockLanguageModelV2({ doGenerate: async () => { throw new APICallError({ message: "provider unavailable", url: "https://provider.example/v1", requestBodyValues: {}, statusCode: 503, isRetryable: true }); } });
    const run = input();
    await expect(new SdkRunner(() => model).run(run)).rejects.toThrow("provider unavailable");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(run.budget!.usage).toEqual({ inputTokens: 0, outputTokens: 0, steps: 1 });
  });

  it("records rejected tool arguments even when execution never starts", async () => {
    const model = new MockLanguageModelV2({ doGenerate: [reply([{ type: "tool-call", toolCallId: "invalid-1", toolName: "read_file", input: JSON.stringify({ path: 42 }) }]), reply()] });
    const run = input();
    const execute = vi.fn(async () => "fixture");
    run.tools = [fileTool(execute)];
    await new SdkRunner(() => model).run(run);
    expect(execute).not.toHaveBeenCalled();
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_error", callId: "invalid-1", outcome: "failed" }));
  });

  it("cancels an in-flight provider request", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV2({ doGenerate: async () => {
      controller.abort();
      return new Promise<never>(() => {});
    } });
    const run = input(budget({}, controller.signal));
    await expect(new SdkRunner(() => model).run(run)).rejects.toThrow(RunCancelledError);
    expect(run.budget!.usage.steps).toBe(1);
  });
});

describe("ScriptedRunner", () => {
  it("shares the step budget between roles", async () => {
    const run = input(budget({ maxSteps: 1 }));
    const runner = new ScriptedRunner(async () => "done");
    await runner.run(run);
    await expect(runner.run({ ...run, role: "red" })).rejects.toThrow("steps budget exhausted");
  });

  it("does not invoke tools after cancellation", async () => {
    const controller = new AbortController();
    const run = input(budget({}, controller.signal));
    const execute = vi.fn(async () => "fixture");
    run.tools = [fileTool(execute)];
    const runner = new ScriptedRunner(async (tools) => {
      controller.abort();
      await tools.read_file!({ path: "src/example.ts" });
      return "done";
    });
    await expect(runner.run(run)).rejects.toThrow(RunCancelledError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("terminates a hung script at the wall deadline", async () => {
    vi.useFakeTimers();
    const run = input(budget({ maxWallMs: 20 }));
    const result = new ScriptedRunner(async () => new Promise<never>(() => {})).run(run);
    const assertion = expect(result).rejects.toThrow("wall budget exhausted");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });
});

describe("explicit provider configuration", () => {
  it("canonicalizes provider defaults and Routeway URLs", () => {
    expect(canonicalizeModelSpec({ provider: "anthropic", model: "claude-example" })).toEqual({
      provider: "anthropic", model: "claude-example", apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(canonicalizeModelSpec({
      provider: "compatible", model: ROUTEWAY_GLM_FLASH_UNCENSORED, baseURL: `${GATEWAYS.routeway}/`,
    })).toEqual({
      provider: "compatible", model: ROUTEWAY_GLM_FLASH_UNCENSORED,
      baseURL: GATEWAYS.routeway, apiKeyEnv: "ROUTEWAY_API_KEY",
    });
  });

  it("does not send Routeway credentials to an unrelated compatible endpoint by default", () => {
    expect(() => canonicalizeModelSpec({
      provider: "compatible", model: "custom", baseURL: "https://provider.example/v1",
    })).toThrow("requires an explicit apiKeyEnv");
    expect(canonicalizeModelSpec({
      provider: "compatible", model: "custom", baseURL: "https://provider.example/v1/", apiKeyEnv: "CUSTOM_KEY",
    })).toEqual({
      provider: "compatible", model: "custom", baseURL: "https://provider.example/v1", apiKeyEnv: "CUSTOM_KEY",
    });
    expect(() => canonicalizeModelSpec({ provider: "openai", model: "gpt-example", apiKeyEnv: "" })).toThrow("environment variable");
  });

  it("does not fall back to another provider with a key", () => {
    expect(resolveRunnerFromEnv({ preferred: "anthropic", model: "claude-example", env: { OPENAI_API_KEY: "fixture" } })).toBeNull();
    expect(resolveRunnerFromEnv({ model: "gpt-example", env: { ANTHROPIC_API_KEY: "fixture" } })).toBeNull();
  });

  it("requires credentials and a matching provider", () => {
    expect(() => requireRunnerForSpec({ provider: "compatible", model: "configured-model" }, {})).toThrow("requires ROUTEWAY_API_KEY");
    expect(() => resolveRunnerFromEnv({ preferred: "openai", model: "claude-example", env: { OPENAI_API_KEY: "fixture" } })).toThrow("does not match");
    expect(() => resolveRunnerFromEnv({ model: "custom-model", env: {} })).toThrow("explicit provider");
  });

  it("validates gateway configuration without contacting the provider", () => {
    expect(() => validateModelSpec({ provider: "compatible", model: "example", baseURL: "not a URL" })).toThrow("absolute URL");
    expect(() => validateModelSpec({ provider: "compatible", model: "example", baseURL: "http://example.com/v1" })).toThrow("HTTPS");
    expect(createRunnerForSpec({ provider: "compatible", model: "example", baseURL: "http://127.0.0.1:1234/v1", apiKeyEnv: "FIXTURE_KEY" }, { FIXTURE_KEY: "fixture" })).toBeInstanceOf(SdkRunner);
  });

  it("keeps unconfigured model cost unavailable", () => {
    expect(estimateCost(1000, 500)).toBeNull();
    expect(estimateCost(1_000_000, 1_000_000, { inputPerMTok: 2, outputPerMTok: 4 })).toBe(6);
  });
});

describe("live provider probe", () => {
  it("performs one Routeway-compatible required tool call without exposing the key", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock: NonNullable<Parameters<typeof createCompatibleRunner>[0]["fetch"]> = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      const nonce = JSON.stringify(body).match(/[a-f0-9]{32}/)?.[0];
      if (!nonce) throw new Error("probe nonce missing from request");
      return new Response(JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion",
        created: 1,
        model: ROUTEWAY_GLM_FLASH_UNCENSORED,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-probe",
              type: "function",
              function: { name: "connection_probe", arguments: JSON.stringify({ nonce }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const runner = createCompatibleRunner({
      apiKey: "  routeway-test-secret  ",
      baseURL: `${GATEWAYS.routeway}/`,
      name: "routeway",
      fetch: fetchMock,
    });

    const result = await probeModel({
      provider: "compatible",
      model: ROUTEWAY_GLM_FLASH_UNCENSORED,
    }, { runner });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${GATEWAYS.routeway}/chat/completions`);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer routeway-test-secret");
    expect(requests[0]?.body).toMatchObject({
      model: ROUTEWAY_GLM_FLASH_UNCENSORED,
      tool_choice: "required",
      max_completion_tokens: expect.any(Number),
      tools: [{ type: "function", function: { name: "connection_probe" } }],
    });
    expect(requests[0]?.body).not.toHaveProperty("seed");
    expect(requests[0]?.body).not.toHaveProperty("max_tokens");
    expect(result).toMatchObject({
      provider: "compatible",
      model: ROUTEWAY_GLM_FLASH_UNCENSORED,
      apiKeyEnv: "ROUTEWAY_API_KEY",
      baseURL: GATEWAYS.routeway,
      inputTokens: 17,
      outputTokens: 5,
      steps: 1,
      toolCalls: 1,
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain("routeway-test-secret");
  });

  it("fails when a runner does not perform the required probe call", async () => {
    const runner: AgentRunner = {
      run: async () => ({ finalText: "skipped", inputTokens: 1, outputTokens: 1, steps: 1 }),
    };
    await expect(probeModel({ provider: "openai", model: "gpt-example" }, { runner }))
      .rejects.toThrow("exactly one required");
  });
});
