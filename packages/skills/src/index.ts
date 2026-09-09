import type { Task } from "@vouch/protocol";

/** System prompt for the baseline coding agent (condition B). Generic engineer. */
export function systemPromptB(): string {
  return [
    "You are a software engineer fixing a reported issue in a code repository.",
    "You have tools to read files, list the tree, search, edit files, and run the project's tests.",
    "Investigate the report, make the smallest correct change that resolves it, and keep existing behavior working.",
    "Run the tests to check your work. When the issue is resolved and tests pass, stop and briefly summarize what you changed.",
    "Do not make changes unrelated to the report.",
  ].join(" ");
}

/** Condition C, Red role: prove the vulnerability with a failing PoC test. */
export function systemPromptRed(): string {
  return [
    "You are a security researcher. Your job is to PROVE whether the reported vulnerability is real in THIS code.",
    "Write a reproduction test (a proof-of-concept) that FAILS on the current, unmodified code — a failing test demonstrates the bug exists.",
    "Call submit_repro with the test source; it saves and runs the test and tells you whether it fails now.",
    "Do not modify the application code. Only write the reproduction test.",
    "If, after investigating, the issue does NOT apply to this code (you cannot make an honest test fail), say so clearly and do not fabricate a failure.",
  ].join(" ");
}

/** Condition C, Blue role: make the reproduction pass while keeping behavior. */
export function systemPromptBlue(): string {
  return [
    "You are a security engineer. A reproduction test proves a vulnerability in this code.",
    "Fix the application code so the reproduction test passes AND the existing public tests still pass.",
    "Use run_repro and run_tests to check your work. Make the smallest correct change and do not alter the reproduction test.",
  ].join(" ");
}

export function buildRedPrompt(input: ContextInput): string {
  return [
    "## Task: reproduce the reported vulnerability",
    buildContextPrompt(input),
    "",
    "Write a failing reproduction test and submit it with submit_repro.",
  ].join("\n");
}

export function buildBluePrompt(input: ContextInput, reproPath: string): string {
  return [
    `## Task: fix the vulnerability proven by ${reproPath}`,
    buildContextPrompt(input),
    "",
    `A reproduction test at ${reproPath} currently fails. Fix the code so it passes and public tests stay green.`,
  ].join("\n");
}

const HINT_GUIDANCE: Record<number, string> = {
  0: "Only the class of issue is described; you must locate the affected code yourself.",
  1: "The general area is indicated; narrow it down to the exact code.",
  2: "The affected file is indicated.",
  3: "The affected file and function are indicated.",
};

export interface ContextInput {
  task: Task;
  fileTree: string[];
  /** [path, contents] for the public tests visible to the agent. */
  publicTestFiles: Array<[string, string]>;
}

/** Builds the user prompt: the report, hint guidance, tree, and public tests. */
export function buildContextPrompt(input: ContextInput): string {
  const { task, fileTree, publicTestFiles } = input;
  const parts: string[] = [];
  parts.push("## Security report");
  parts.push(task.report.text);
  parts.push("");
  parts.push(`Hint level ${task.report.hintLevel}: ${HINT_GUIDANCE[task.report.hintLevel] ?? ""}`);
  parts.push("");
  parts.push("## Repository files");
  parts.push(fileTree.join("\n"));
  if (publicTestFiles.length > 0) {
    parts.push("");
    parts.push("## Public tests (already present)");
    for (const [path, contents] of publicTestFiles) {
      parts.push(`### ${path}`);
      parts.push("```");
      parts.push(contents);
      parts.push("```");
    }
  }
  parts.push("");
  parts.push(
    "Use the tools to investigate and fix the issue. Run the tests with the run_tests tool before finishing.",
  );
  return parts.join("\n");
}
