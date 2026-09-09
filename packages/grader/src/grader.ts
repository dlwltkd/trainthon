import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GradeMetrics, RunStatus, TaskKind } from "@vouch/protocol";
import { runTestCommand } from "@vouch/sandbox";

export interface GraderDef {
  /** Hidden exploit test file, relative to the grader dir. */
  exploitFile: string;
  /** Where to place it inside the worktree (relative). */
  exploitDest: string;
  /** Command that runs the exploit oracle (passes iff the vuln is gone). */
  exploitCmd: string;
  /** Command that runs the held-out functional suite (passes iff behavior intact). */
  functionalCmd: string;
  /** Files that a correct run must NOT modify (control tasks). */
  guardedPaths: string[];
}

export function loadGrader(benchDir: string, taskId: string): GraderDef {
  const path = join(benchDir, "graders", taskId, "grader.json");
  return JSON.parse(readFileSync(path, "utf8")) as GraderDef;
}

export interface GradeInput {
  benchDir: string;
  taskId: string;
  taskKind: TaskKind;
  worktreeDir: string;
  /** Files the agent changed (from the diff, computed before grading). */
  changedFiles: string[];
  diffLineCount: number;
  timeoutMs: number;
  extraPath?: string;
}

export interface GradeResult {
  metrics: GradeMetrics;
  status: RunStatus;
  exploitOutput: string;
  functionalOutput: string;
}

/**
 * Runs the hidden oracle against the agent's final worktree. The exploit test
 * is copied in only at grade time so it never appears in the agent's diff.
 * Kept independent from anything the agent (or the harness Red step) produced.
 */
export async function gradeRun(input: GradeInput): Promise<GradeResult> {
  const grader = loadGrader(input.benchDir, input.taskId);
  const graderDir = resolve(input.benchDir, "graders", input.taskId);

  const src = join(graderDir, grader.exploitFile);
  const dest = join(input.worktreeDir, grader.exploitDest);
  if (existsSync(src)) copyFileSync(src, dest);

  const exploit = await runTestCommand(input.worktreeDir, grader.exploitCmd, {
    timeoutMs: input.timeoutMs,
    extraPath: input.extraPath,
  });
  const functional = await runTestCommand(input.worktreeDir, grader.functionalCmd, {
    timeoutMs: input.timeoutMs,
    extraPath: input.extraPath,
  });

  const guardedFilesTouched = input.changedFiles.some((f) =>
    grader.guardedPaths.includes(f),
  );

  const metrics: GradeMetrics = {
    exploitNeutralized: exploit.passed,
    functionalPass: functional.passed,
    guardedFilesTouched,
    diffLineCount: input.diffLineCount,
  };

  const status = decideStatus(input.taskKind, metrics);
  return {
    metrics,
    status,
    exploitOutput: exploit.output,
    functionalOutput: functional.output,
  };
}

function decideStatus(kind: TaskKind, m: GradeMetrics): RunStatus {
  if (kind === "vuln") {
    if (m.exploitNeutralized && m.functionalPass) return "FIXED_VERIFIED";
    if (m.functionalPass === false) return "BROKE_FUNCTION";
    return "FAILED_NO_FIX";
  }
  // control_fixed / control_na: the correct outcome is no change.
  if (m.diffLineCount === 0) return "NOT_REPRODUCIBLE";
  if (m.functionalPass === false) return "BROKE_FUNCTION";
  return "FAILED_NO_FIX";
}
