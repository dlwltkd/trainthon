import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePublicGitHubUrl, readBoundedRegularFile } from "@vouch/sandbox";
import { isHiddenPath, safePath } from "../../../packages/sandbox/src/fs-tools.js";
import { RUN_ID_PATTERN } from "./registry.js";

export interface DraftPullRequest { url: string; number: number; branch: string }
export interface PullRequestOptions { runsDir: string; token?: string; fetch?: typeof fetch }
interface FileChange { path: string; deleted: boolean; bytes: Buffer | null; baseline: Buffer | null; mode: "100644" | "100755" }
interface Delivery {
  runId: string; runDir: string; repositoryUrl: string; owner: string; name: string; commit: string;
  patchHash: string; status: "TESTS_PASSED" | "PATCH_PROPOSED"; files: FileChange[]; summary: string; regressionPath?: string;
}
interface SavedDelivery {
  runId: string; repositoryUrl: string; baseCommit: string; patchHash: string; branch: string; commit: string;
  pullRequest?: DraftPullRequest;
}
type JsonObject = Record<string, unknown>;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 2_000_000;
const MAX_DELIVERY_BYTES = 8_000_000;
const pending = new Map<string, Promise<DraftPullRequest>>();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const blobHash = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as JsonObject;
}

function readBytes(root: string, path: string, max = MAX_FILE_BYTES): Buffer {
  return readBoundedRegularFile(safePath(root, path), max, path);
}

function readJson(root: string, path: string): JsonObject {
  return object(JSON.parse(readBytes(root, path).toString("utf8")), path);
}

function sourcePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 500 && !/[\s\u0000-\u001f\u007f-\u009f\\]/.test(path) &&
    !path.startsWith("/") && !path.split("/").some(part => !part || part === "." || part === "..") &&
    /\.(?:[cm]?[jt]s|[jt]sx|py)$/.test(path) && !isHiddenPath(path) &&
    !/(?:^|\/)(?:__tests__|tests?|specs?|__mocks__|fixtures?|__fixtures__|scripts?|\.github)(?:\/|$)/i.test(path) &&
    !/(?:^|[./_-])(?:test|spec|config|setup|teardown)(?:[./_-]|$)/i.test(path) &&
    !/(?:^|\/)(?:conftest|sitecustomize|usercustomize)\.py$/i.test(path);
}

function loadDelivery(value: unknown, runsDir: string): Delivery {
  const input = object(value, "run record");
  if (typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId)) throw new Error("invalid run ID");
  const runDir = safePath(runsDir, input.runId);
  const record = readJson(runDir, "record.json");
  if (record.runId !== input.runId || record.provisional === true) throw new Error("the run has no final delivery record");
  if (record.reviewStatus === "partial") throw new Error("draft delivery requires a complete Red review");
  if (record.status !== "TESTS_PASSED" && record.status !== "PATCH_PROPOSED") throw new Error("draft delivery requires TESTS_PASSED or PATCH_PROPOSED");
  const repo = object(record.repository, "repository metadata");
  if (typeof repo.url !== "string" || typeof repo.commit !== "string" || !SHA.test(repo.commit)) throw new Error("delivery requires a public GitHub URL and full recorded commit");
  const repository = parsePublicGitHubUrl(repo.url);
  if (repository.url !== repo.url) throw new Error("the recorded GitHub URL must be canonical");
  if (record.status === "TESTS_PASSED") {
    const verification = object(record.verification, "test verification");
    if (verification.scope !== "repository_tests" || verification.regressionPassed !== true || verification.functionalPassed !== true ||
        verification.regressionManifestMatched !== true || verification.functionalManifestMatched !== true) {
      throw new Error("the successful run is missing its existing-test verification evidence");
    }
  }
  const metadata = object(record.delivery, "delivery metadata");
  if (typeof metadata.patchHash !== "string" || !HASH.test(metadata.patchHash)) throw new Error("delivery patch hash is missing");
  const patch = readBytes(runDir, "patch.diff");
  if (!patch.toString("utf8").trim() || digest(patch) !== metadata.patchHash) throw new Error("the recorded source patch is empty or changed");
  const changed = object(record.changes, "source changes").files;
  if (!Array.isArray(changed) || changed.length === 0 || changed.length > 100 || !changed.every(sourcePath) || new Set(changed).size !== changed.length) {
    throw new Error("delivery requires 1–100 distinct application source files; tests, config and hidden paths are excluded");
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== changed.length) throw new Error("delivery file inventory does not match the patch");
  const source = safePath(runDir, "source");
  const candidate = safePath(runDir, "candidate");
  if (!statSync(source).isDirectory() || !statSync(candidate).isDirectory()) throw new Error("delivery snapshots are missing");
  const seen = new Set<string>();
  let total = 0;
  const files = metadata.files.map(value => {
    const file = object(value, "delivery file");
    if (!sourcePath(file.path) || !changed.includes(file.path) || seen.has(file.path) || typeof file.deleted !== "boolean" || typeof file.sha256 !== "string" || !HASH.test(file.sha256)) {
      throw new Error("invalid delivery file metadata");
    }
    seen.add(file.path);
    const originalPath = safePath(source, file.path);
    const candidatePath = safePath(candidate, file.path);
    const baseline = existsSync(originalPath) ? readBytes(source, file.path) : null;
    const bytes = existsSync(candidatePath) ? readBytes(candidate, file.path) : null;
    if (file.deleted ? !baseline || bytes !== null : bytes === null) throw new Error("candidate files do not match their recorded deletion state");
    const expected = file.deleted ? baseline! : bytes!;
    if (digest(expected) !== file.sha256) throw new Error(`delivery content changed: ${file.path}`);
    if (bytes && baseline?.equals(bytes)) throw new Error(`delivery contains an unchanged source file: ${file.path}`);
    total += (bytes?.length ?? 0) + (baseline?.length ?? 0);
    if (total > MAX_DELIVERY_BYTES) throw new Error("delivery source snapshots exceed the 8 MB limit");
    const mode = baseline && (statSync(originalPath).mode & 0o111) ? "100755" as const : "100644" as const;
    if (bytes && Boolean(statSync(candidatePath).mode & 0o111) !== (mode === "100755")) throw new Error(`delivery changes executable mode: ${file.path}`);
    return { path: file.path, deleted: file.deleted, baseline, bytes, mode };
  });
  const summary = [record.summary, record.reason].find(value => typeof value === "string" && value.trim());
  return {
    runId: input.runId, runDir, repositoryUrl: repository.url, owner: repository.owner, name: repository.name,
    commit: repo.commit, patchHash: metadata.patchHash, status: record.status, files,
    summary: typeof summary === "string" ? summary.trim().slice(0, 1_200) : "Source changes proposed from the recorded repository review. Inspect the diff before approval.",
    regressionPath: typeof repo.regressionPath === "string" ? repo.regressionPath : undefined,
  };
}

function branchFor(delivery: Delivery): string { return `vouch/${delivery.runId}`; }

function savedDelivery(delivery: Delivery): SavedDelivery | null {
  if (!existsSync(safePath(delivery.runDir, "pull-request.json"))) return null;
  const saved = readJson(delivery.runDir, "pull-request.json");
  if (saved.runId !== delivery.runId || saved.repositoryUrl !== delivery.repositoryUrl || saved.baseCommit !== delivery.commit ||
      saved.patchHash !== delivery.patchHash || saved.branch !== branchFor(delivery) || typeof saved.commit !== "string" || !SHA.test(saved.commit)) {
    throw new Error("existing pull-request delivery metadata does not match this run");
  }
  return {
    runId: delivery.runId, repositoryUrl: delivery.repositoryUrl, baseCommit: delivery.commit,
    patchHash: delivery.patchHash, branch: branchFor(delivery), commit: saved.commit,
    ...(saved.pullRequest ? { pullRequest: validatePullRequest(saved.pullRequest, delivery) } : {}),
  };
}

function saveDelivery(delivery: Delivery, saved: SavedDelivery): void {
  const temp = safePath(delivery.runDir, `pull-request.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(saved, null, 2), { flag: "wx", mode: 0o600 });
  renameSync(temp, safePath(delivery.runDir, "pull-request.json"));
}

function validatePullRequest(value: unknown, delivery: Delivery): DraftPullRequest {
  const result = object(value, "pull request response");
  if (!Number.isSafeInteger(result.number) || (result.number as number) <= 0 || result.url !== `${delivery.repositoryUrl}/pull/${result.number}` || result.branch !== branchFor(delivery)) {
    throw new Error("GitHub returned an unexpected pull request identity");
  }
  return { url: result.url as string, number: result.number as number, branch: result.branch as string };
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new Error("GitHub response exceeds the delivery limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("GitHub returned invalid JSON"); }
}

async function deliver(delivery: Delivery, options: PullRequestOptions): Promise<DraftPullRequest> {
  let saved = savedDelivery(delivery);
  if (saved?.pullRequest) return saved.pullRequest;
  const token = options.token !== undefined ? options.token.trim()
    : process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN with Contents and Pull requests write access to this repository before creating a draft PR");
  if (/\s|[\u0000-\u001f\u007f-\u009f]/.test(token)) throw new Error("the GitHub token contains invalid characters");
  const transport = options.fetch ?? globalThis.fetch;
  const deadline = Date.now() + 120_000;
  const prefix = `/repos/${encodeURIComponent(delivery.owner)}/${encodeURIComponent(delivery.name)}`;
  const api = async (path: string, body?: unknown, allow404 = false): Promise<unknown> => {
    if (Date.now() >= deadline) throw new Error("GitHub draft delivery exceeded its time limit; retry to resume the recorded branch");
    let response: Response;
    try {
      response = await transport(`https://api.github.com${prefix}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("GitHub request failed or timed out; retry to resume draft delivery"); }
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new Error(`GitHub denied access (HTTP ${response.status}); the token needs repository Contents and Pull requests write permissions`);
      throw new Error(`GitHub draft delivery failed (HTTP ${response.status}); retry after checking repository and branch access`);
    }
    return responseJson(response);
  };
  const repo = object(await api(""), "GitHub repository");
  const permissions = repo.permissions ? object(repo.permissions, "GitHub repository permissions") : {};
  if (repo.private !== false || typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== `${delivery.owner}/${delivery.name}`.toLowerCase()) throw new Error("GitHub repository identity or public visibility changed");
  if (permissions.push !== true || repo.archived === true || repo.disabled === true) throw new Error("This MVP creates draft PRs only in repositories where the token has push access; fork delivery is not supported");
  if (typeof repo.default_branch !== "string" || !repo.default_branch || repo.default_branch.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(repo.default_branch)) throw new Error("GitHub default branch is unavailable");
  const base = repo.default_branch;
  const branch = branchFor(delivery);
  if (branch === base || branch.endsWith(".") || branch.endsWith(".lock") || branch.includes("..")) throw new Error("the run ID cannot form a unique delivery branch");
  const baseUnchanged = async () => {
    const ref = object(await api(`/git/ref/heads/${encodeURIComponent(base)}`), "default branch ref");
    if (object(ref.object, "default branch commit").sha !== delivery.commit) throw new Error("The default branch moved since this run; run the review again before creating a draft PR");
  };
  await baseUnchanged();
  const baseCommit = object(await api(`/git/commits/${delivery.commit}`), "base Git commit");
  const baseTree = object(baseCommit.tree, "base Git tree").sha;
  if (baseCommit.sha !== delivery.commit || typeof baseTree !== "string" || !SHA.test(baseTree)) throw new Error("GitHub did not return the recorded base commit");
  const tree = object(await api(`/git/trees/${baseTree}?recursive=1`), "base tree inventory");
  if (tree.truncated === true || !Array.isArray(tree.tree)) throw new Error("GitHub tree is too large to verify for draft delivery");
  const originals = new Map(tree.tree.map(value => { const entry = object(value, "tree entry"); return [entry.path, entry] as const; }));
  for (const file of delivery.files) {
    const original = originals.get(file.path);
    if (file.baseline) {
      if (!original || original.type !== "blob" || original.mode !== file.mode || original.sha !== blobHash(file.baseline)) throw new Error(`source baseline does not match the recorded GitHub commit: ${file.path}`);
    } else if (original) throw new Error(`new source path already exists in the recorded commit: ${file.path}`);
  }
  const marker = `<!-- vouch-run:${delivery.runId} patch:${delivery.patchHash} -->`;
  const matching = await api(`/pulls?state=all&head=${encodeURIComponent(`${delivery.owner}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=100`);
  if (!Array.isArray(matching)) throw new Error("GitHub returned an invalid pull request list");
  const existing = matching.find(value => {
    const pr = object(value, "pull request");
    return typeof pr.body === "string" && pr.body.includes(marker) && (!saved || object(pr.head, "pull request head").sha === saved.commit);
  });
  if (existing) {
    const pr = object(existing, "existing pull request");
    const result = validatePullRequest({ url: pr.html_url, number: pr.number, branch }, delivery);
    const commit = object(pr.head, "existing pull request head").sha;
    if (typeof commit !== "string" || !SHA.test(commit)) throw new Error("existing draft commit is invalid");
    saveDelivery(delivery, { runId: delivery.runId, repositoryUrl: delivery.repositoryUrl, baseCommit: delivery.commit, patchHash: delivery.patchHash, branch, commit, pullRequest: result });
    return result;
  }
  const existingRef = await api(`/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
  if (existingRef && (!saved || object(object(existingRef, "delivery branch").object, "delivery branch commit").sha !== saved.commit)) throw new Error("The delivery branch already exists with different content; it will not be overwritten");
  if (!saved) {
    const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
    for (const file of delivery.files) {
      let sha: string | null = null;
      if (file.bytes) {
        const blob = object(await api("/git/blobs", { content: file.bytes.toString("base64"), encoding: "base64" }), "created blob");
        if (blob.sha !== blobHash(file.bytes)) throw new Error("GitHub created a blob that does not match the reviewed source");
        sha = blob.sha as string;
      }
      entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
    }
    const nextTree = object(await api("/git/trees", { base_tree: baseTree, tree: entries }), "created tree");
    if (typeof nextTree.sha !== "string" || !SHA.test(nextTree.sha)) throw new Error("GitHub returned an invalid new tree");
    const commit = object(await api("/git/commits", { message: `fix: proposed source changes from Vouch ${delivery.runId}`, tree: nextTree.sha, parents: [delivery.commit] }), "created commit");
    if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) throw new Error("GitHub returned an invalid new commit");
    saved = { runId: delivery.runId, repositoryUrl: delivery.repositoryUrl, baseCommit: delivery.commit, patchHash: delivery.patchHash, branch, commit: commit.sha };
    saveDelivery(delivery, saved);
  }
  await baseUnchanged();
  if (!existingRef) await api("/git/refs", { ref: `refs/heads/${branch}`, sha: saved.commit });
  await baseUnchanged();
  const validation = delivery.status === "TESTS_PASSED"
    ? `The supplied regression${delivery.regressionPath ? ` (${delivery.regressionPath})` : ""} and existing functional suite passed in a fresh workspace with matching test inventories. This covers repository tests; it is not independent security verification.`
    : "UNTESTED DRAFT: this is a proposed source patch. No regression or functional tests were executed for this review. Inspect and validate the change before approving or merging.";
  const body = [
    delivery.summary, "", "Changed application source:", ...delivery.files.map(file => `- ${file.deleted ? "Delete" : file.baseline ? "Update" : "Add"} ${file.path}`),
    "", "Validation", validation, "", `Based on commit ${delivery.commit}.`, `Run: ${delivery.runId}.`, "", marker,
  ].join("\n");
  const pr = object(await api("/pulls", { title: `fix: ${delivery.status === "PATCH_PROPOSED" ? "proposed" : "validated"} source changes from Vouch`, head: branch, base, body, draft: true, maintainer_can_modify: true }), "created draft pull request");
  if (pr.draft !== true) throw new Error("GitHub did not confirm draft status; inspect the delivery branch before retrying");
  const result = validatePullRequest({ url: pr.html_url, number: pr.number, branch }, delivery);
  saveDelivery(delivery, { ...saved, pullRequest: result });
  return result;
}

export async function createDraftPullRequest(record: unknown, options: PullRequestOptions): Promise<DraftPullRequest> {
  const delivery = loadDelivery(record, options.runsDir);
  const inFlight = pending.get(delivery.runDir);
  if (inFlight) return inFlight;
  const operation = deliver(delivery, options);
  pending.set(delivery.runDir, operation);
  try { return await operation; }
  finally { pending.delete(delivery.runDir); }
}
