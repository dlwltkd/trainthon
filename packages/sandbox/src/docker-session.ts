import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type ExecOptions, type ExecResult } from "./exec.js";
import { localProcessEnv } from "./local-workspace.js";

export type DockerInvoker = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export class DockerSession {
  private readonly active = new Set<string>();
  constructor(private readonly invoke: DockerInvoker = runCommand) {}

  private async remove(name: string): Promise<void> {
    const result = await this.invoke("docker", ["rm", "--force", name], {
      cwd: tmpdir(), env: localProcessEnv(), timeoutMs: 5000, maxOutputBytes: 1000,
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error(`could not remove sandbox container ${name}`);
    this.active.delete(name);
  }

  async run(args: string[], opts: { signal?: AbortSignal; timeoutMs: number }, maxOutputBytes = 100_000): Promise<ExecResult> {
    const name = `vouch-${randomUUID()}`;
    this.active.add(name);
    try {
      return await this.invoke("docker", [
        "run", "--name", name, "--init", "--log-driver=local", "--log-opt", "max-size=1m",
        "--log-opt", "max-file=1", "--log-opt", "compress=false", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1g", "--cpus=2",
        "--ulimit=nofile=1024:1024", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
        "--env", "HOME=/tmp/vouch-home", "--env", "CI=1", ...args,
      ], { cwd: tmpdir(), env: localProcessEnv(), timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes });
    } finally {
      await this.remove(name);
    }
  }

  async cleanup(): Promise<void> {
    const failed: string[] = [];
    for (const name of [...this.active]) {
      try { await this.remove(name); } catch { failed.push(name); }
    }
    if (failed.length) throw new Error(`could not remove sandbox containers: ${failed.join(", ")}`);
  }
}

export function exceedsDirectoryLimit(root: string, maxBytes: number, maxEntries: number): boolean {
  const queue = [root];
  let bytes = 0;
  let entries = 0;
  while (queue.length) {
    const directory = queue.pop()!;
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (++entries > maxEntries) return true;
      const path = join(directory, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) queue.push(path);
      else {
        try { bytes += lstatSync(path).size; } catch { continue; }
        if (bytes > maxBytes) return true;
      }
    }
  }
  return false;
}
