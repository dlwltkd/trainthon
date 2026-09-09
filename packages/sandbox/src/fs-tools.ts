import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const IGNORED = new Set(["node_modules", "dist", "credentials.json", "secrets.json"]);
const MAX_READ_BYTES = 100_000;

export function isHiddenPath(p: string): boolean {
  return p.split(/[\\/]/).some(part => {
    const lower = part.toLowerCase();
    return Boolean(part && part !== ".") && (
      lower.startsWith(".") || IGNORED.has(lower) ||
      /\.(?:pem|key|p12|pfx)$/i.test(part) || /^id_(?:rsa|ed25519|ecdsa)/i.test(part)
    );
  });
}

/** Resolve `p` inside `dir`, rejecting paths that escape the worktree. */
export function safePath(dir: string, p: string): string {
  if (p.includes("\0") || isAbsolute(p) || p.includes("\\") || isHiddenPath(p)) throw new Error(`path is not accessible: ${p}`);
  const abs = resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes worktree: ${p}`);
  }
  let current = resolve(dir);
  const realRoot = realpathSync(current);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) || (() => { try { return lstatSync(current).isSymbolicLink(); } catch { return false; } })()) {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink is not accessible: ${p}`);
      const realRel = relative(realRoot, realpathSync(current));
      if (realRel === ".." || realRel.startsWith(`..${sep}`)) throw new Error(`path escapes worktree: ${p}`);
    }
  }
  return abs;
}

export function readFileTool(dir: string, p: string): string {
  const content = readFileSync(safePath(dir, p), "utf8");
  return content.length > MAX_READ_BYTES
    ? content.slice(0, MAX_READ_BYTES) + "\n... [truncated]"
    : content;
}

export function writeFileTool(dir: string, p: string, content: string): void {
  const abs = safePath(dir, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function listDirTool(dir: string, p = "."): string[] {
  const root = safePath(dir, p);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (isHiddenPath(entry.name) || entry.isSymbolicLink()) continue;
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
      content = readFileTool(dir, rel);
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
