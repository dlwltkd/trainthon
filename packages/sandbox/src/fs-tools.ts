import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const IGNORED = new Set(["node_modules", ".git", ".worktrees", "dist"]);
const MAX_READ_BYTES = 100_000;

/** Resolve `p` inside `dir`, rejecting paths that escape the worktree. */
function safe(dir: string, p: string): string {
  const abs = resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || rel.includes(`..${"/"}`)) {
    throw new Error(`path escapes worktree: ${p}`);
  }
  return abs;
}

export function readFileTool(dir: string, p: string): string {
  const content = readFileSync(safe(dir, p), "utf8");
  return content.length > MAX_READ_BYTES
    ? content.slice(0, MAX_READ_BYTES) + "\n... [truncated]"
    : content;
}

export function writeFileTool(dir: string, p: string, content: string): void {
  const abs = safe(dir, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function listDirTool(dir: string, p = "."): string[] {
  const root = safe(dir, p);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const abs = join(current, entry.name);
      const rel = relative(dir, abs);
      if (entry.isDirectory()) {
        out.push(rel + "/");
        walk(abs);
      } else {
        out.push(rel);
      }
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else out.push(relative(dir, root));
  return out.sort();
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export function grepTool(dir: string, pattern: string): GrepHit[] {
  const re = new RegExp(pattern);
  const hits: GrepHit[] = [];
  for (const rel of listDirTool(dir)) {
    if (rel.endsWith("/")) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        hits.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
        if (hits.length >= 200) return hits;
      }
    }
  }
  return hits;
}
