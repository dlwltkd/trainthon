import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { acquirePublicGitHubRepository, parsePublicGitHubUrl } from "@vouch/sandbox";

export function repositoryIdentity(input: string): { name: string; url?: string } {
  if (/^[a-z][a-z0-9+.-]*:|^git@|^github\.com\//i.test(input)) {
    const source = parsePublicGitHubUrl(input);
    return { name: `${source.owner}/${source.name}`, url: source.url };
  }
  return { name: basename(resolve(input)) };
}

export async function acquireRepository(input: string, ref: string | undefined, workspacesDir: string, signal: AbortSignal) {
  const identity = repositoryIdentity(input);
  if (identity.url) return acquirePublicGitHubRepository({ url: identity.url, ref, workspacesDir, signal });
  return { ...identity, repoPath: resolve(input), commit: undefined, cleanup() {} };
}

export function saveSourceSnapshot(baselineDir: string, artifactDir: string): void {
  // Only the already-filtered and size-bounded snapshot reaches the artifact store.
  cpSync(baselineDir, join(artifactDir, "source"), { recursive: true, errorOnExist: true, force: false });
}

export function saveDeliverySnapshot(workspace: { dir: string; baselineDir: string }, artifactDir: string, patch: string, files: string[]) {
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  if (!existsSync(join(artifactDir, "source"))) saveSourceSnapshot(workspace.baselineDir, artifactDir);
  cpSync(workspace.dir, join(artifactDir, "candidate"), { recursive: true, errorOnExist: true, force: false });
  return { patchHash: digest(patch), files: files.map(path => {
    const candidate = join(workspace.dir, path);
    const deleted = !existsSync(candidate);
    return { path, deleted, sha256: digest(readFileSync(deleted ? join(workspace.baselineDir, path) : candidate)) };
  }) };
}
