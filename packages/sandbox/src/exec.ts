import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra entries prepended to PATH (e.g. the monorepo's node_modules/.bin). */
  extraPath?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

function withEnv(extraPath?: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = env ?? process.env;
  return { ...base, ...(extraPath ? { PATH: `${extraPath}:${base.PATH ?? ""}` } : {}) };
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: -1, stdout: "", stderr: "cancelled", timedOut: false, cancelled: true });
      return;
    }
    const child = spawn(cmd, args, { cwd: opts.cwd, env: withEnv(opts.extraPath, opts.env), detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const limit = opts.maxOutputBytes ?? 1_000_000;
    const tail = (old: string, chunk: Buffer) => (old + chunk.toString()).slice(-limit);
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
    };
    const abort = () => { cancelled = true; kill(); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => {
      stdout = tail(stdout, d);
    });
    child.stderr.on("data", (d) => {
      stderr = tail(stderr, d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      kill();
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, cancelled });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), timedOut, cancelled });
    });
  });
}

/** Run a shell command string via `sh -c`. */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return runCommand("sh", ["-c", command], opts);
}
