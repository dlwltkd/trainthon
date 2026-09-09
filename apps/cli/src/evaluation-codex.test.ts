import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexSource } from "./evaluation-codex.js";

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => processMock);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Codex source-only adapter", () => {
  it("accepts startup warning items, records usage, and discards private reasoning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-codex-adapter-"));
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
    processMock.spawn.mockReturnValue(child);
    vi.stubEnv("ROUTEWAY_API_KEY", "test-secret-not-for-child");
    child.stdin.once("finish", () => {
      child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "error", message: "startup warning" } }) + "\n");
      child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning must not be retained" } }) + "\n");
      child.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }) + "\n");
      writeFileSync(join(dir, "answer.json"), "42");
      child.emit("close", 0);
    });
    try {
      const result = await runCodexSource({ dir, prompt: "arithmetic", source: "answer=42", model: "gpt-5.6-sol", maxWallMs: 10_000, signal: new AbortController().signal });
      expect(result).toEqual({ text: "42", usage: { inputTokens: 12, outputTokens: 3 } });
      expect(readFileSync(join(dir, "events.jsonl"), "utf8")).not.toContain("private reasoning");
      const [, args, options] = processMock.spawn.mock.calls.at(-1)!;
      expect(args).toContain('web_search="disabled"');
      expect(args).toContain("shell_tool");
      expect(options.env.ROUTEWAY_API_KEY).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed if native output indicates unexpected execution capabilities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-codex-capabilities-"));
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345678 });
    processMock.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    child.stdin.once("finish", () => {
      child.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution" } }) + "\n");
      child.emit("close", 130);
    });
    try {
      await expect(runCodexSource({ dir, prompt: "arithmetic", source: "answer=42", model: "gpt-5.6-sol", maxWallMs: 10_000, signal: new AbortController().signal })).rejects.toThrow("unexpected tool activity");
      expect(kill).toHaveBeenCalledWith(-12345678, "SIGINT");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
