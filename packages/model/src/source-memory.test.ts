import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { SourceMemory } from "./source-memory.js";

const task: ModelMessage = { role: "user", content: "Review the pinned fixture at commit abc123." };
const exchange = (id: string, toolName: string, value: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }] },
];
function history(): ModelMessage[] {
  return [task,
    { role: "assistant", content: [{ type: "reasoning", text: "private-test-placeholder" }, { type: "tool-call", toolCallId: "read", toolName: "read_file", input: { path: "src/add.ts" } }] },
    exchange("read", "read_file", "old-source-page".repeat(1000))[1]!,
    ...exchange("recent-read", "read_file", "recent-source-page"),
    ...exchange("recent-search", "grep", "recent-source-match"),
    ...exchange("progress", "report_progress", "Recorded the latest public plan."),
  ];
}
function checkpoint(memory: SourceMemory, messages: ModelMessage[]) {
  const message = memory.messages(messages).find(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Harness context checkpoint."))!;
  expect(message.role).toBe("user");
  return JSON.parse((message.content as string).split("\n").at(-1)!);
}

describe("SourceMemory", () => {
  it("retains a public plan published by skill selection without a separate progress call", () => {
    const memory = new SourceMemory(8_000, ["initial.py"]);
    const messages = history();
    memory.record("use_skill", {}, { id: "security-contract-review", version: "1.0.0", instructions: "Review the stated contract.", progress: { summary: "Review the supplied source contract.", evidence: ["initial.py"], nextAction: "Inspect relevant exits." } });
    expect(memory.needsCheckpoint(messages)).toBe(true);
    expect(memory.compact(messages)).toBeDefined();
    expect(checkpoint(memory, messages)).toMatchObject({ activeSkill: { id: "security-contract-review" }, latestProgress: { evidence: ["initial.py"], nextAction: "Inspect relevant exits." } });
    expect(checkpoint(memory, messages).activeSkill.progress).toBeUndefined();
  });

  it("retains supplied source paths through compaction without treating unread paths as observed", () => {
    const memory = new SourceMemory(8_000, ["initial.py"]);
    const messages = history();
    messages[0] = { role: "user", content: "Complete initial.py source: def identity(value): return value" };
    memory.record("list_dir", {}, { entries: ["unread.py"] });
    memory.record("report_progress", { summary: "Continue from the supplied source.", evidence: ["initial.py"] }, {});
    expect(memory.compact(messages)).toBeDefined();
    expect(memory.messages(messages)[0]).toBe(messages[0]);
    expect(checkpoint(memory, messages).observedFiles).toEqual(["initial.py"]);
  });

  it("keeps the original task and complete latest tool exchange without old source or reasoning", () => {
    const memory = new SourceMemory(8_000);
    const messages = history();
    memory.record("read_file", { path: "src/add.ts" }, {});
    memory.record("report_progress", { summary: "Observed an arithmetic mismatch.", evidence: ["src/add.ts"], nextAction: "Check the declared contract." }, { recorded: true });
    expect(memory.needsCheckpoint(messages)).toBe(true);
    const event = memory.compact(messages)!;
    expect(event.bytesAfter).toBeLessThan(event.bytesBefore);
    const compacted = memory.messages(messages);
    expect(compacted[0]).toBe(task);
    expect(compacted.slice(-2)).toEqual(messages.slice(-2));
    expect(compacted.slice(1, 5)).toEqual(messages.slice(3, 7));
    expect(JSON.stringify(compacted)).not.toMatch(/old-source-page|private-test-placeholder/);
    expect(checkpoint(memory, messages)).toMatchObject({ observedFiles: ["src/add.ts"], latestProgress: { nextAction: "Check the declared contract." } });

    const continued = [...messages, ...exchange("reread", "read_file", "Current fixture text")];
    expect(memory.messages(continued).slice(-2)).toEqual(continued.slice(-2));
    expect(JSON.stringify(memory.messages(continued))).not.toContain("old-source-page");
    expect(memory.needsCheckpoint(continued)).toBe(false);
  });

  it("carries successful findings, independent assessments, skills and inspected edits across checkpoints", () => {
    const memory = new SourceMemory(8_000);
    const messages = history();
    memory.record("use_skill", {}, { id: "change-validation", version: "1.0.0", instructions: "Inspect the diff." });
    memory.record("grep", {}, { hits: [{ file: "src/add.ts", line: 2 }] });
    memory.record("list_dir", {}, { entries: ["unread.ts"] });
    memory.record("report_finding", { id: "blue-add", confidence: "confirmed", evidence: ["src/add.ts"] }, { recorded: true });
    memory.record("assess_finding", { findingId: "red-add", verdict: "confirmed", blueFindingId: "blue-add" }, { recorded: true });
    memory.record("edit_file", { path: "src/add.ts", newText: "new-source-content" }, { findingIds: ["blue-add"] });
    memory.record("inspect_diff", {}, { patch: "raw-patch-content", changedFiles: ["src/add.ts"], checks: { testsRun: false } });
    memory.record("report_progress", { summary: "Source change inspected; tests have not run." }, {});
    memory.compact(messages);
    expect(checkpoint(memory, messages)).toMatchObject({
      activeSkill: { id: "change-validation" }, observedFiles: ["src/add.ts"],
      findings: [{ id: "blue-add" }], assessments: [{ findingId: "red-add", verdict: "confirmed" }],
      changedFiles: { "src/add.ts": ["blue-add"] },
      inspectedDiff: { patchHash: expect.stringMatching(/^[a-f0-9]{64}$/), checks: { testsRun: false } },
    });
    expect(JSON.stringify(checkpoint(memory, messages))).not.toMatch(/unread.ts|raw-patch-content|new-source-content/);

    memory.record("report_finding", { id: "blue-add", confidence: "potential" }, {});
    memory.record("edit_file", { path: "src/add.ts" }, { findingIds: ["blue-add"] });
    const continued = [...messages, ...exchange("read-again", "read_file", "later-source-page".repeat(1000)), ...exchange("progress-again", "report_progress", "Recorded")];
    expect(memory.needsCheckpoint(continued)).toBe(true);
    memory.compact(continued);
    expect(checkpoint(memory, continued)).toMatchObject({ findings: [{ confidence: "potential" }], assessments: [] });
    expect(checkpoint(memory, continued).inspectedDiff).toBeUndefined();
  });

  it("waits for new history if the latest exchange cannot be reduced", () => {
    const memory = new SourceMemory(8_000);
    const messages = [task, ...exchange("large-progress", "report_progress", "x".repeat(10_000))];
    memory.record("report_progress", { summary: "Still reviewing." }, {});
    expect(memory.needsCheckpoint(messages)).toBe(true);
    expect(memory.compact(messages)).toBeUndefined();
    expect(memory.needsCheckpoint(messages)).toBe(false);
    expect(memory.messages(messages)).toBe(messages);
  });

  it("retains a large latest source exchange without splitting its call/result pairs", () => {
    const memory = new SourceMemory(8_000);
    memory.record("report_progress", { summary: "Continue with the latest source." }, {});
    const messages = [task,
      ...exchange("old-source", "read_file", "discard-older-source".repeat(1000)),
      ...exchange("latest-source", "read_file", "retain-latest-source".repeat(2000)),
      ...exchange("progress", "report_progress", "Recorded"),
    ];
    expect(memory.compact(messages)).toBeDefined();
    const compacted = memory.messages(messages);
    expect(JSON.stringify(compacted)).not.toContain("discard-older-source");
    expect(compacted.slice(1, 3)).toEqual(messages.slice(3, 5));
    const calls = compacted.flatMap(message => message.role === "assistant" && Array.isArray(message.content) ? message.content.filter(part => part.type === "tool-call").map(part => part.toolCallId) : []);
    const results = compacted.flatMap(message => message.role === "tool" ? message.content.filter(part => part.type === "tool-result").map(part => part.toolCallId) : []);
    expect(calls).toEqual(results);
  });
});
