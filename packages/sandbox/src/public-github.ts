import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand, type ExecOptions, type ExecResult } from "./exec.js";
import { exceedsDirectoryLimit } from "./docker-session.js";

export interface PublicGitHubRepository { url: string; owner: string; name: string }
export interface AcquiredPublicGitHubRepository {
  repoPath: string;
  url: string;
  name: string;
  commit: string;
  cleanup(): void;
}
export type GitHubGitInvoker = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;
export interface AcquirePublicGitHubOptions {
  url: string;
  ref?: string;
  workspacesDir: string;
  signal?: AbortSignal;
  /** Host-side test seam; never populated from browser input. */
  invoke?: GitHubGitInvoker;
}

const MAX_ACQUISITION_MS = 120_000;
const MAX_ACQUISITION_BYTES = 128_000_000;
const MAX_ACQUISITION_ENTRIES = 12_000;
const MAX_CHECKOUT_BYTES = 64_000_000;
const MAX_CHECKOUT_FILES = 6_000;
const MAX_TREE_OUTPUT = 2_000_000;

export function parsePublicGitHubUrl(value: string): PublicGitHubRepository {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(value);
  if (!match) throw new Error("use a public GitHub repository URL: https://github.com/owner/repository");
  const owner = match[1]!;
  const name = match[2]!.replace(/\.git$/, "");
  if (!name || name === "." || name === ".." || name.endsWith(".git")) {
    throw new Error("invalid GitHub repository name");
  }
  return { url: `https://github.com/${owner}/${name}`, owner, name };
}

function selectedRef(value = "HEAD"): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.includes("..") || value.endsWith(".") || value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) ||
      (value.startsWith("refs/") && !/^refs\/(?:heads|tags)\/.+/.test(value))) {
    throw new Error("GitHub ref must be HEAD, a branch, a tag, or a full commit hash");
  }
  return value;
}

const GIT_CONFIG = [
  "core.hooksPath=/dev/null", "core.fsmonitor=false", "core.attributesFile=/dev/null", "core.symlinks=false",
  "credential.helper=", "credential.interactive=false", "http.extraHeader=", "http.cookieFile=", "http.saveCookies=false",
  "http.followRedirects=false", "http.sslVerify=true", "http.proxy=", "http.emptyAuth=false", "http.maxRetries=0",
  "protocol.allow=never", "protocol.https.allow=always", "submodule.recurse=false", "fetch.recurseSubmodules=false",
  "fetch.fsckObjects=true", "transfer.fsckObjects=true", "transfer.bundleURI=false", "promisor.acceptFromServer=none",
  "filter.lfs.process=", "filter.lfs.smudge=", "filter.lfs.clean=", "filter.lfs.required=false",
  "gc.auto=0", "maintenance.auto=false", "fetch.unpackLimit=1", "pack.threads=1", "index.threads=1",
].flatMap(value => ["-c", value]);

/** Fetch one public revision without loading user credentials or executing repository code. */
export async function acquirePublicGitHubRepository(options: AcquirePublicGitHubOptions): Promise<AcquiredPublicGitHubRepository> {
  const repository = parsePublicGitHubUrl(options.url);
  const ref = selectedRef(options.ref);
  options.signal?.throwIfAborted();
  const parent = resolve(options.workspacesDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(realpathSync(parent), "github-"));
  chmodSync(root, 0o700);
  const repoPath = join(root, "repository");
  const credentialDir = join(root, "empty-home");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(repoPath, { mode: 0o700 });
    mkdirSync(credentialDir, { mode: 0o700 });
  } catch (error) { cleanup(); throw error; }
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = Date.now() + MAX_ACQUISITION_MS;
  const timeout = setTimeout(() => controller.abort(new Error("GitHub acquisition exceeded the 120 second time limit")), MAX_ACQUISITION_MS);
  const checkSize = () => {
    if (exceedsDirectoryLimit(root, MAX_ACQUISITION_BYTES, MAX_ACQUISITION_ENTRIES)) {
      controller.abort(new Error("GitHub acquisition exceeds the 128 MB / 12000 entry download limit"));
    }
  };
  const monitor = setInterval(checkSize, 200);
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
    // This isolated child environment also prevents libcurl from finding the user's .netrc.
    HOME: credentialDir, XDG_CONFIG_HOME: credentialDir,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1", GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "https", GIT_CEILING_DIRECTORIES: root,
  };
  const invoke = options.invoke ?? runCommand;
  const git = async (args: string[], maxOutputBytes = 8_000): Promise<string> => {
    controller.signal.throwIfAborted();
    const result = await invoke("git", [...GIT_CONFIG, ...args], {
      cwd: repoPath, env, signal: controller.signal,
      timeoutMs: Math.max(1, Math.min(90_000, deadline - Date.now())), maxOutputBytes,
    });
    checkSize();
    controller.signal.throwIfAborted();
    if (result.cancelled) throw new Error("GitHub acquisition was cancelled");
    if (result.timedOut) throw new Error("GitHub acquisition command timed out");
    if (result.exitCode !== 0) {
      const detail = result.stderr.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 500);
      throw new Error(`GitHub ${args[0]} failed${detail ? `: ${detail}` : ""}; only publicly accessible repositories and refs are supported`);
    }
    if (Buffer.byteLength(result.stdout) >= maxOutputBytes) throw new Error("GitHub command output exceeds the acquisition limit");
    return result.stdout;
  };

  try {
    if (options.signal?.aborted) onAbort();
    await git(["init", "--quiet", "--template="]);
    await git(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--", `${repository.url}.git`, ref]);
    const commit = (await git(["rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"])).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("GitHub did not resolve the requested revision to a commit");
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) && commit !== ref.toLowerCase()) throw new Error("GitHub returned a different commit than requested");
    const tree = await git(["ls-tree", "-rlz", "--full-tree", commit], MAX_TREE_OUTPUT);
    let bytes = 0;
    let files = 0;
    for (const entry of tree.split("\0").filter(Boolean)) {
      const match = /^\d+ \w+ [a-f0-9]+\s+(-|\d+)\t/.exec(entry);
      if (!match) throw new Error("GitHub returned an unsupported tree entry");
      bytes += match[1] === "-" ? 0 : Number(match[1]);
      if (++files > MAX_CHECKOUT_FILES || bytes > MAX_CHECKOUT_BYTES) throw new Error("GitHub checkout exceeds the 64 MB / 6000 file acquisition limit");
    }
    await git(["checkout", "--quiet", "--detach", "--force", commit, "--"]);
    const checked = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (checked !== commit) throw new Error("GitHub checkout does not match the selected commit");
    return { repoPath, url: repository.url, name: `${repository.owner}/${repository.name}`, commit, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
