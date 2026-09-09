import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./exec.js";

export interface Worktree {
  /** Absolute path to the isolated working copy. */
  dir: string;
  cleanup: () => void;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  /** Path (relative to repoRoot) of the target code to copy. */
  sourcePath: string;
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const GIT_IDENTITY = [
  "-c",
  "user.email=vouch@local",
  "-c",
  "user.name=vouch",
];

async function runGit(dir: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const result = await runCommand("git", args, { cwd: dir, timeoutMs: opts.timeoutMs ?? 20_000, signal: opts.signal });
  if (result.cancelled) throw opts.signal?.reason ?? new Error("Git command cancelled");
  if (result.timedOut) throw new Error(`Git command timed out: git ${args[0] ?? ""}`);
  if (result.exitCode !== 0) throw new Error(`Git command failed: git ${args[0] ?? ""}: ${result.stderr.slice(-2000)}`);
  return result.stdout;
}

/**
 * Copies the target code into `.worktrees/<runId>` and takes a baseline git
 * commit so edits can be diffed. Living under the repo root lets Node resolve
 * tooling (vitest, tsx) from the monorepo without a per-run install.
 */
export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<Worktree> {
  const base = resolve(opts.repoRoot, ".worktrees");
  mkdirSync(base, { recursive: true });
  const dir = join(base, opts.runId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const src = resolve(opts.repoRoot, opts.sourcePath);
  if (!existsSync(src)) {
    throw new Error(`worktree source not found: ${src}`);
  }
  cpSync(src, dir, { recursive: true });

  await runGit(dir, ["init", "-q"], opts);
  await runGit(dir, ["add", "-A"], opts);
  await runGit(dir, [...GIT_IDENTITY, "commit", "-q", "-m", "baseline"], opts);

  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Revert all agent edits back to the baseline commit (tracked + untracked). */
export async function resetWorktree(dir: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  await runGit(dir, ["checkout", "--", "."], opts);
  await runGit(dir, ["clean", "-fd"], opts);
}

export interface DiffResult {
  patch: string;
  changedFiles: string[];
  lineCount: number;
}

/** Captures the agent's edits (including new files) relative to the baseline. */
export async function getDiff(dir: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DiffResult> {
  await runGit(dir, ["add", "-A"], opts);
  const patch = await runGit(dir, ["diff", "--cached"], opts);
  const names = await runGit(dir, ["diff", "--cached", "--name-only"], opts);
  const numstat = await runGit(dir, ["diff", "--cached", "--numstat"], opts);
  const changedFiles = names
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let lineCount = 0;
  for (const line of numstat.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const added = parseInt(parts[0]!, 10);
      const deleted = parseInt(parts[1]!, 10);
      if (!Number.isNaN(added)) lineCount += added;
      if (!Number.isNaN(deleted)) lineCount += deleted;
    }
  }
  return { patch, changedFiles, lineCount };
}
