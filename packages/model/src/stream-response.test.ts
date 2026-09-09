import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";
import type { EventInput } from "@vouch/protocol";
import { RunBudget, RunCancelledError } from "./budget.js";
import { SdkRunner } from "./sdk-runner.js";
import type { AgentRunInput } from "./types.js";

type StreamReply = Awaited<ReturnType<MockLanguageModelV2["doStream"]>>;
type StreamPart = StreamReply["stream"] extends ReadableStream<infer T> ? T : never;
const allocated: RunBudget[] = [];
const finish = (reason: "stop" | "tool-calls" | "length" = "stop"): StreamPart => ({ type: "finish", finishReason: reason, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
const call: StreamPart = { type: "tool-call", toolCallId: "read-1", toolName: "read_fixture", input: '{"path":"src/add.ts"}' };
const textParts: StreamPart[] = [{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "42" }, { type: "text-end", id: "text" }, finish()];
function stream(parts: StreamPart[]): StreamReply {
  return { stream: new ReadableStream({ start(controller) { for (const part of [{ type: "stream-start", warnings: [] } as StreamPart, ...parts]) controller.enqueue(part); controller.close(); } }) };
}
function input(signal?: AbortSignal) {
  const budget = new RunBudget({ maxTokens: 200_000, maxSteps: 8, maxWallMs: 20_000 }, signal);
  allocated.push(budget);
  const events: EventInput[] = [];
  const execute = vi.fn(async () => ({ left: 13, right: 29 }));
  const run: AgentRunInput = { system: "Inspect an arithmetic fixture.", prompt: "Read the fixture and give the sum.", model: "test-model", role: "red", stage: "REVIEW", budget, budgets: budget.limits, requestPolicy: { transport: "stream", maxRetries: 1, timeoutMs: 2_000 }, tools: [{ name: "read_fixture", description: "Read supplied fixture", schema: z.object({ path: z.string() }), execute }], onEvent: event => events.push(event) };
  return { run, events, execute, budget };
}
afterEach(() => { for (const budget of allocated.splice(0)) budget.dispose(); vi.useRealTimers(); });

describe("streamed model turns", () => {
  it("buffers fragmented tools, preserves typed tool results and provider metadata, and publishes only execution metadata", async () => {
    const f = input();
    const model = new MockLanguageModelV2({ doStream: [stream([
      { type: "response-metadata", id: "provider-response" },
      { type: "reasoning-start", id: "r", providerMetadata: { mock: { signature: "internal-signature" } } },
      { type: "reasoning-delta", id: "r", delta: "private provider reasoning" },
      { type: "reasoning-end", id: "r" },
      { type: "tool-input-start", id: "read-1", toolName: "read_fixture" },
      { type: "tool-input-delta", id: "read-1", delta: '{"path":' },
      { type: "tool-input-delta", id: "read-1", delta: '"src/add.ts"}' },
      { type: "tool-input-end", id: "read-1" }, call, finish("tool-calls"),
    ]), stream(textParts)] });
    const result = await new SdkRunner(() => model).run(f.run);
    expect(result).toMatchObject({ finalText: "42", steps: 2, inputTokens: 20, outputTokens: 10 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(0);
    const history = model.doStreamCalls[1]!.prompt;
    expect(history.find(message => message.role === "assistant")).toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ type: "tool-call", toolCallId: "read-1", toolName: "read_fixture", input: { path: "src/add.ts" } })]) });
    expect(JSON.stringify(history)).toContain("internal-signature");
    const telemetry = JSON.stringify(f.events);
    expect(telemetry).not.toContain("private provider reasoning");
    expect(telemetry).not.toContain("internal-signature");
    expect(f.events).toContainEqual(expect.objectContaining({ type: "model_request", phase: "tool_input", toolName: "read_fixture", firstChunkMs: expect.any(Number) }));
    const committed = f.events.findIndex(event => event.type === "model_request" && event.phase === "completed");
    expect(f.events.findIndex(event => event.type === "tool_call")).toBeGreaterThan(committed);
    expect(f.budget.usageKnown).toBe(true);
  });

  it("discards tools from a failed stream, then retries the same turn without duplicating tool execution", async () => {
    vi.useFakeTimers();
    const f = input();
    const model = new MockLanguageModelV2({ doStream: [
      stream([call, { type: "error", error: { code: "bad_gateway", message: "do not log secret response" } }]),
      stream([call, finish("tool-calls")]), stream(textParts),
    ] });
    const result = new SdkRunner(() => model).run(f.run);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ finalText: "42", steps: 3 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls[1]!.prompt).toEqual(model.doStreamCalls[0]!.prompt);
    expect(f.events.filter(event => event.type === "model_msg").map(event => event.outcome)).toEqual(["failed", "completed", "completed"]);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "model_request", phase: "retry_wait", retryAt: expect.any(Number) }));
    expect(JSON.stringify(f.events)).not.toContain("secret response");
    expect(f.budget.usageKnown).toBe(false);
  });

  it.each(["missing", "length"])("never executes tools from an incomplete response: %s", async reason => {
    vi.useFakeTimers();
    const f = input();
    const model = new MockLanguageModelV2({ doStream: stream(reason === "missing" ? [call] : [call, finish("length")]) });
    const assertion = expect(new SdkRunner(() => model).run(f.run)).rejects.toThrow(reason === "missing" ? "valid completion marker" : "incomplete");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(f.execute).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(reason === "missing" ? 2 : 1);
  });

  it("cancels an open stream before any buffered tools execute", async () => {
    const controller = new AbortController();
    const f = input(controller.signal);
    const cancel = vi.fn();
    const model = new MockLanguageModelV2({ doStream: { stream: new ReadableStream({ start(stream) { stream.enqueue(call); }, cancel }) } });
    f.run.onEvent = event => { f.events.push(event); if (event.type === "model_request" && event.phase === "receiving") controller.abort(); };
    await expect(new SdkRunner(() => model).run(f.run)).rejects.toThrow(RunCancelledError);
    expect(cancel).toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("keeps a slow active stream alive and stops an idle stream", async () => {
    vi.useFakeTimers();
    const f = input();
    f.run.requestPolicy = { transport: "stream", maxRetries: 0, timeoutMs: 30 };
    const model = new MockLanguageModelV2({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-start", id: "t" });
      for (const delay of [20, 40, 60]) setTimeout(() => controller.enqueue({ type: "text-delta", id: "t", delta: "." }), delay);
      setTimeout(() => { controller.enqueue({ type: "text-end", id: "t" }); controller.enqueue(finish()); controller.close(); }, 80);
    } }) }) });
    const completed = new SdkRunner(() => model).run(f.run);
    await vi.advanceTimersByTimeAsync(80);
    await expect(completed).resolves.toMatchObject({ finalText: "..." });
    const stalled = input();
    stalled.run.requestPolicy = f.run.requestPolicy;
    const cancel = vi.fn();
    const hung = new MockLanguageModelV2({ doStream: { stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-start", id: "t" }); }, cancel }) } });
    const failure = expect(new SdkRunner(() => hung).run(stalled.run)).rejects.toThrow("without stream activity");
    await vi.advanceTimersByTimeAsync(30);
    await failure;
    expect(cancel).toHaveBeenCalled();
  });
});
