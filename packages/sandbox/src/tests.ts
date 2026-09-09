import { runShell } from "./exec.js";

export interface TestOutcome {
  passed: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number;
  cancelled?: boolean;
}

/**
 * Runs a test command inside the worktree. `passed` is true only on a clean
 * exit within the timeout. Output is tail-truncated for logging.
 */
export async function runTestCommand(
  dir: string,
  command: string,
  opts: { timeoutMs: number; extraPath?: string; signal?: AbortSignal },
): Promise<TestOutcome> {
  const res = await runShell(command, {
    cwd: dir,
    timeoutMs: opts.timeoutMs,
    extraPath: opts.extraPath,
    signal: opts.signal,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    passed: res.exitCode === 0 && !res.timedOut && !res.cancelled,
    output: combined.length > 8000 ? combined.slice(-8000) : combined,
    timedOut: res.timedOut,
    exitCode: res.exitCode,
    cancelled: res.cancelled,
  };
}
