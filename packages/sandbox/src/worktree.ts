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
}

const GIT_IDENTITY = [
  "-c",
  "user.email=vouch@local",
  "-c",
  "user.name=vouch",
];

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

  const t = 20_000;
  await runCommand("git", ["init", "-q"], { cwd: dir, timeoutMs: t });
  await runCommand("git", ["add", "-A"], { cwd: dir, timeoutMs: t });
  await runCommand("git", [...GIT_IDENTITY, "commit", "-q", "-m", "baseline"], {
    cwd: dir,
    timeoutMs: t,
  });

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
export async function resetWorktree(dir: string): Promise<void> {
  const t = 20_000;
  await runCommand("git", ["checkout", "--", "."], { cwd: dir, timeoutMs: t });
  await runCommand("git", ["clean", "-fd"], { cwd: dir, timeoutMs: t });
}

export interface DiffResult {
  patch: string;
  changedFiles: string[];
  lineCount: number;
}

/** Captures the agent's edits (including new files) relative to the baseline. */
export async function getDiff(dir: string): Promise<DiffResult> {
  const t = 20_000;
  await runCommand("git", ["add", "-A"], { cwd: dir, timeoutMs: t });
  const patchRes = await runCommand("git", ["diff", "--cached"], { cwd: dir, timeoutMs: t });
  const namesRes = await runCommand("git", ["diff", "--cached", "--name-only"], {
    cwd: dir,
    timeoutMs: t,
  });
  const numstat = await runCommand("git", ["diff", "--cached", "--numstat"], {
    cwd: dir,
    timeoutMs: t,
  });
  const changedFiles = namesRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  let lineCount = 0;
  for (const line of numstat.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const added = parseInt(parts[0]!, 10);
      const deleted = parseInt(parts[1]!, 10);
      if (!Number.isNaN(added)) lineCount += added;
      if (!Number.isNaN(deleted)) lineCount += deleted;
    }
  }
  return { patch: patchRes.stdout, changedFiles, lineCount };
}
