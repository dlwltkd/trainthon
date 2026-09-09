import { runShell } from "./exec.js";

export interface TestOutcome {
  passed: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number;
}

/**
 * Runs a test command inside the worktree. `passed` is true only on a clean
 * exit within the timeout. Output is tail-truncated for logging.
 */
export async function runTestCommand(
  dir: string,
  command: string,
  opts: { timeoutMs: number; extraPath?: string },
): Promise<TestOutcome> {
  const res = await runShell(command, {
    cwd: dir,
    timeoutMs: opts.timeoutMs,
    extraPath: opts.extraPath,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    passed: res.exitCode === 0 && !res.timedOut,
    output: combined.length > 8000 ? combined.slice(-8000) : combined,
    timedOut: res.timedOut,
    exitCode: res.exitCode,
  };
}
