import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isHiddenPath, safePath } from "./fs-tools.js";
import { runCommand } from "./exec.js";
import type { DiffResult } from "./worktree.js";

const gitExec = promisify(execFile);
const MAX_FILE_BYTES = 2_000_000;
const MAX_REPOSITORY_BYTES = 30_000_000;
const MAX_FILES = 3000;
const records = new WeakMap<LocalWorkspace, Map<string, Buffer>>();
const recordModes = new WeakMap<LocalWorkspace, Map<string, number>>();
export const localProcessEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function readBoundedRegularFile(path: string, maxBytes: number, label = "file"): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

function configuredSupportFiles(original: Map<string, Buffer>): Set<string> {
  const protectedFiles = new Set<string>();
  const queue = [...original.keys()].filter(path => /(?:^|\/)(?:vitest|vite)[^/]*config\.[cm]?[jt]s$/.test(path));
  for (const path of queue) {
    if (protectedFiles.has(path)) continue;
    protectedFiles.add(path);
    const text = original.get(path)?.toString("utf8") ?? "";
    for (const match of text.matchAll(/["'`]((?:\.\.?\/)[^"'`\n]+)["'`]/g)) {
      const target = relative("/", resolve("/", dirname(path), match[1]!));
      for (const candidate of [target, ...[".ts", ".js", ".mts", ".mjs", "/index.ts", "/index.js"].map(ext => target + ext)]) {
        if (original.has(candidate) && !protectedFiles.has(candidate)) queue.push(candidate);
      }
    }
  }
  return protectedFiles;
}

export interface LocalWorkspace {
  dir: string;
  baselineDir: string;
  verificationDir: string;
  commit: string;
  regressionPath: string;
  regressionHash: string;
  files: string[];
  protectedPaths: string[];
  cleanup(): void;
}
export interface PrepareLocalWorkspaceOptions {
  repoPath: string;
  ref?: string;
  regressionPath: string;
  workspacesDir: string;
  signal?: AbortSignal;
}

function validateRelative(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\0\r\n]/.test(path) || path.split("/").some(p => p === ".." || p === "." || !p)) throw new Error(`invalid repository-relative path: ${path}`);
}

function isSourcePath(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)
    && !/\s/.test(path)
    && !/(?:^|\/)(?:__tests__|tests?|specs?|__mocks__|fixtures?|__fixtures__|scripts?|\.github)(?:\/|$)/i.test(path)
    && !/(?:^|[./_-])(?:test|spec|config|setup|teardown)(?:[./_-]|$)/i.test(path)
    && !isHiddenPath(path);
}

export function isLocalSourcePath(workspace: LocalWorkspace, path: string): boolean {
  try { validateRelative(path); safePath(workspace.dir, path); } catch { return false; }
  return path !== workspace.regressionPath && !workspace.protectedPaths.includes(path) && isSourcePath(path);
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`unsupported workspace entry: ${path}`);
    if (path === "node_modules" && entry.isDirectory() && readdirSync(join(dir, path)).length === 0) continue;
    if (entry.isDirectory()) out.push(...walk(dir, path));
    else out.push(path);
  }
  return out.sort();
}

async function git(repoPath: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const { stdout } = await gitExec("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repoPath, env: localProcessEnv(), encoding: "buffer", maxBuffer: MAX_REPOSITORY_BYTES, timeout: 30_000, signal });
  return stdout;
}

export async function prepareLocalWorkspace(opts: PrepareLocalWorkspaceOptions): Promise<LocalWorkspace> {
  validateRelative(opts.regressionPath);
  if (isHiddenPath(opts.regressionPath)) throw new Error("regression cannot be a hidden or credential file");
  const repoPath = realpathSync(resolve(opts.repoPath));
  const gitRoot = (await git(repoPath, ["rev-parse", "--show-toplevel"], opts.signal)).toString().trim();
  if (realpathSync(gitRoot) !== repoPath) throw new Error("--repo must identify the Git repository root");
  const commit = (await git(repoPath, ["rev-parse", "--verify", "--end-of-options", `${opts.ref ?? "HEAD"}^{commit}`], opts.signal)).toString().trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git did not resolve a commit");
  const tree = (await git(repoPath, ["ls-tree", "-rlz", "--full-tree", commit], opts.signal)).toString();
  const original = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  let bytes = 0;
  for (const entry of tree.split("\0").filter(Boolean)) {
    opts.signal?.throwIfAborted();
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("unsupported Git tree entry");
    const [, mode, type, oid, size, path] = match as unknown as [string, string, string, string, string, string];
    validateRelative(path);
    if (isHiddenPath(path)) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`symlinks and submodules are unsupported: ${path}`);
    if (Number(size) > MAX_FILE_BYTES) throw new Error(`file exceeds 2 MB snapshot limit: ${path}`);
    bytes += Number(size);
    if (bytes > MAX_REPOSITORY_BYTES || original.size >= MAX_FILES) throw new Error("repository exceeds MVP snapshot limits (30 MB / 3000 files)");
    original.set(path, await git(repoPath, ["cat-file", "blob", oid], opts.signal));
    modes.set(path, mode === "100755" ? 0o755 : 0o644);
  }
  const supplied = safePath(repoPath, opts.regressionPath);
  if (!existsSync(supplied)) throw new Error("supplied regression must be an existing regular file");
  const regression = readBoundedRegularFile(supplied, MAX_FILE_BYTES, "regression");
  original.set(opts.regressionPath, regression);
  modes.set(opts.regressionPath, 0o644);
  mkdirSync(resolve(opts.workspacesDir), { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(resolve(opts.workspacesDir), "local-"));
  const supportFiles = configuredSupportFiles(original);
  const workspace: LocalWorkspace = {
    dir: join(root, "candidate"), baselineDir: join(root, "baseline"), verificationDir: join(root, "verification"),
    commit, regressionPath: opts.regressionPath, regressionHash: hash(regression), files: [...original.keys()].sort(),
    protectedPaths: [...original.keys()].filter(path => path === opts.regressionPath || !isSourcePath(path) || supportFiles.has(path)).sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  try {
    for (const [path, content] of original) {
      const target = join(workspace.baselineDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      chmodSync(target, modes.get(path) ?? 0o644);
    }
    cpSync(workspace.baselineDir, workspace.dir, { recursive: true });
    records.set(workspace, original);
    recordModes.set(workspace, modes);
    return workspace;
  } catch (error) { workspace.cleanup(); throw error; }
}

export function writeLocalSource(workspace: LocalWorkspace, path: string, content: string): void {
  if (!isLocalSourcePath(workspace, path)) throw new Error(`only application source files may be edited: ${path}`);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("source file exceeds 2 MB limit");
  const target = safePath(workspace.dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function changes(workspace: LocalWorkspace): Map<string, Buffer | null> {
  const original = records.get(workspace);
  const modes = recordModes.get(workspace);
  if (!original) throw new Error("unknown local workspace");
  const current = walk(workspace.dir);
  const all = new Set([...original.keys(), ...current]);
  const changed = new Map<string, Buffer | null>();
  for (const path of all) {
    const abs = safePath(workspace.dir, path);
    const data = existsSync(abs) ? readFileSync(abs) : null;
    if (data && data.length > MAX_FILE_BYTES) throw new Error(`source file exceeds limit: ${path}`);
    const prior = original.get(path);
    const expectedMode = modes?.get(path) ?? 0o644;
    if (data && Boolean(statSync(abs).mode & 0o111) !== Boolean(expectedMode & 0o111)) {
      throw new Error(`file mode changed: ${path}`);
    }
    if (prior && data && prior.equals(data)) continue;
    if (!isLocalSourcePath(workspace, path)) throw new Error(`protected file changed: ${path}`);
    changed.set(path, data);
  }
  return changed;
}

export async function createVerificationWorkspace(workspace: LocalWorkspace): Promise<string> {
  const changed = changes(workspace);
  rmSync(workspace.verificationDir, { recursive: true, force: true });
  mkdirSync(workspace.verificationDir, { recursive: true });
  for (const [path, bytes] of records.get(workspace)!) {
    const target = join(workspace.verificationDir, path);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
    chmodSync(target, recordModes.get(workspace)?.get(path) ?? 0o644);
  }
  for (const [path, bytes] of changed) {
    const target = join(workspace.verificationDir, path);
    if (bytes === null) rmSync(target);
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
  }
  return workspace.verificationDir;
}

export async function captureLocalChanges(workspace: LocalWorkspace): Promise<DiffResult> {
  const changed = changes(workspace);
  if (!changed.size) return { patch: "", changedFiles: [], lineCount: 0 };
  const root = dirname(workspace.dir);
  const diffRoot = mkdtempSync(join(root, "diff-"));
  const before = join(diffRoot, "before");
  const after = join(diffRoot, "after");
  mkdirSync(before);
  mkdirSync(after);
  const original = records.get(workspace)!;
  const changedFiles = [...changed.keys()].sort();
  try {
    for (const path of changedFiles) {
      const prior = original.get(path);
      const current = changed.get(path);
      if (prior !== undefined) {
        const target = join(before, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, prior);
        chmodSync(target, recordModes.get(workspace)?.get(path) ?? 0o644);
      }
      if (current !== null && current !== undefined) {
        const target = join(after, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, current);
        chmodSync(target, recordModes.get(workspace)?.get(path) ?? 0o644);
      }
    }
    const result = await runCommand("git", ["diff", "--no-index", "--no-renames", "--no-ext-diff", "--text", "--", "before", "after"], {
      cwd: diffRoot,
      timeoutMs: 10_000,
      env: { ...localProcessEnv(), GIT_CEILING_DIRECTORIES: diffRoot },
      maxOutputBytes: 70_000_000,
    });
    if (result.exitCode !== 1 || result.timedOut || result.cancelled) throw new Error(`could not capture source patch: ${result.stderr}`);
    const patch = result.stdout.split("\n").map(line => {
      if (!/^(?:diff --git |--- |\+\+\+ )/.test(line)) return line;
      return line
        .replaceAll("a/before/", "a/")
        .replaceAll("a/after/", "a/")
        .replaceAll("b/before/", "b/")
        .replaceAll("b/after/", "b/");
    }).join("\n");
    const lineCount = patch.split("\n").filter(line => (/^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line))).length;
    return { patch, changedFiles, lineCount };
  } finally {
    rmSync(diffRoot, { recursive: true, force: true });
  }
}

export async function applyLocalPatch(workspace: LocalWorkspace, patchPath: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  opts.signal?.throwIfAborted();
  const patch = readBoundedRegularFile(resolve(patchPath), MAX_REPOSITORY_BYTES, "patch").toString("utf8");
  if (/^(?:old mode|new mode|rename |copy |GIT binary patch|Binary files)/m.test(patch)) throw new Error("patch mode changes, renames, copies and binary patches are unsupported");
  if (/^(?:new file mode|deleted file mode) (?!100644$)/m.test(patch)) throw new Error("patch contains unsupported file mode");
  let paths = 0;
  for (const line of patch.split("\n")) {
    if (/^diff --git /.test(line)) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || match[1] !== match[2] || !isLocalSourcePath(workspace, match[1]!)) throw new Error("patch targets an unsupported or protected path");
      paths++;
    }
    if (/^(?:---|\+\+\+) /.test(line)) {
      const value = line.slice(4);
      if (value !== "/dev/null" && (!/^[ab]\//.test(value) || !isLocalSourcePath(workspace, value.slice(2)))) throw new Error("patch targets an unsupported or protected path");
    }
  }
  if (!paths) throw new Error("patch contains no source changes");
  const env = { ...localProcessEnv(), GIT_CEILING_DIRECTORIES: dirname(workspace.dir) };
  for (const extra of [["--check"], []]) {
    opts.signal?.throwIfAborted();
    const result = await runCommand("git", ["apply", "--whitespace=nowarn", ...extra, resolve(patchPath)], { cwd: workspace.dir, timeoutMs: 10_000, env, signal: opts.signal });
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) throw new Error(`patch cannot be applied: ${result.stderr}`);
  }
  changes(workspace);
}
