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
    if (tools["run_repro"]) await tools["run_repro"]({});
    if (tools["run_tests"]) await tools["run_tests"]({});
    return "applied scripted solution (dev wiring smoke-test)";
  };
}

/**
 * Scripted Red: submit a task's dev reproduction test. Whether it "reproduces"
 * is decided by the harness from the test actually failing on the target code,
 * so the same script yields reproduced=true on a vulnerable fixture and
 * reproduced=false on an already-fixed control.
 */
export function buildReproScript(reproFile: string): Script {
  return async (tools) => {
    const content = readFileSync(reproFile, "utf8");
    const r = (await tools["submit_repro"]!({ content })) as { failsNow: boolean };
    return r.failsNow
      ? "reproduction fails on current code: vulnerability confirmed"
      : "reproduction passes on current code: could not reproduce";
  };
}
