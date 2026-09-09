import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Script } from "@vouch/model";

function collectFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

/**
 * Builds a deterministic script that writes a task's known-good solution files
 * into the worktree. Used only for wiring smoke-tests when no API key is set;
 * the solution is never given to a real agent and never used for scoring.
 */
export function buildSolutionScript(solutionDir: string): Script {
  const files = collectFiles(solutionDir);
  return async (tools) => {
    for (const rel of files) {
      const content = readFileSync(join(solutionDir, rel), "utf8");
      await tools["write_file"]!({ path: rel, content });
    }
    if (tools["run_tests"]) await tools["run_tests"]({});
    return "applied scripted solution (dev wiring smoke-test)";
  };
}
