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
