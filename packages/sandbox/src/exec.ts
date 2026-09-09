import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra entries prepended to PATH (e.g. the monorepo's node_modules/.bin). */
  extraPath?: string;
}

function withEnv(extraPath?: string): NodeJS.ProcessEnv {
  if (!extraPath) return { ...process.env };
  return { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ""}` };
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: withEnv(opts.extraPath) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

/** Run a shell command string via `sh -c`. */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return runCommand("sh", ["-c", command], opts);
}
