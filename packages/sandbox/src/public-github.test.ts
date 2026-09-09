import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePublicGitHubRepository, parsePublicGitHubUrl, type GitHubGitInvoker } from "./public-github.js";
import type { ExecOptions, ExecResult } from "./exec.js";

const roots: string[] = [];
const commit = "a".repeat(40);
const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, cancelled: false });
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(overrides: { tree?: string; onCommand?: (args: string[], options: ExecOptions) => ExecResult | void } = {}) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "vouch-github-test-"));
  roots.push(workspacesDir);
  const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = [];
  const invoke: GitHubGitInvoker = async (command, args, options) => {
    calls.push({ command, args, options });
    const overridden = overrides.onCommand?.(args, options);
    if (overridden) return overridden;
    if (args.includes("rev-parse")) return ok(commit + "\n");
    if (args.includes("ls-tree")) return ok(overrides.tree ?? `100644 blob ${commit} 30\tapp.py\0`);
    if (args.includes("checkout")) {
      writeFileSync(join(options.cwd, "app.py"), "def add(a, b): return a + b\n");
      mkdirSync(join(options.cwd, "tests"));
      writeFileSync(join(options.cwd, "tests", "test_add.py"), "assert 2 + 1 == 3\n");
    }
    return ok();
  };
  return { workspacesDir, calls, invoke, options: { url: "https://github.com/example/calculator", workspacesDir, invoke } };
}

describe("public GitHub URL validation", () => {
  it("normalizes optional .git and trailing slash while retaining repository identity", () => {
    for (const suffix of ["", "/", ".git", ".git/"]) {
      expect(parsePublicGitHubUrl(`https://github.com/Example/calculator${suffix}`)).toEqual({ url: "https://github.com/Example/calculator", owner: "Example", name: "calculator" });
    }
    expect(parsePublicGitHubUrl("https://github.com/example/.github").name).toBe(".github");
  });

  it.each([
    "/tmp/repository", "git@github.com:owner/repo.git", "http://github.com/owner/repo", "https://example.com/owner/repo",
    "https://github.com.example.com/owner/repo", "https://github.com:443/owner/repo", "https://user:password@github.com/owner/repo",
    "https://github.com/owner/repo?ref=main", "https://github.com/owner/repo#readme", "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/%72epo", "https://github.com/owner/../repo", " https://github.com/owner/repo", "https://github.com/owner/repo\n",
  ])("rejects noncanonical or unsupported repository location %s", value => {
    expect(() => parsePublicGitHubUrl(value)).toThrow();
  });
});

describe("public GitHub acquisition", () => {
  it.each([undefined, "main", "release/1.0", "v1.0.0", "refs/tags/v1.0.0", commit])("fetches only the selected revision %s in a private credential-free checkout", async ref => {
    vi.stubEnv("GITHUB_TOKEN", "never-forward-this");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("HTTPS_PROXY", "never-forward-proxy");
    const f = fixture();
    const acquired = await acquirePublicGitHubRepository({ ...f.options, ref });
    expect(acquired).toMatchObject({ name: "example/calculator", url: f.options.url, commit });
    expect(statSync(dirname(acquired.repoPath)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(acquired.repoPath, "tests/test_add.py"), "utf8")).toContain("assert 2 + 1");
    const fetch = f.calls.find(call => call.args.includes("fetch"))!;
    expect(fetch.args.slice(fetch.args.indexOf("fetch"))).toEqual(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--", "https://github.com/example/calculator.git", ref ?? "HEAD"]);
    for (const call of f.calls) {
      expect(call.command).toBe("git");
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(90_000);
      expect(call.options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "https", GIT_LFS_SKIP_SMUDGE: "1" });
      expect(call.options.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(call.options.env).not.toHaveProperty("GIT_CONFIG_COUNT");
      expect(call.options.env).not.toHaveProperty("HTTPS_PROXY");
      expect(call.options.env?.HOME).toBe(join(dirname(acquired.repoPath), "empty-home"));
      expect(call.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "credential.helper=", "http.followRedirects=false", "http.sslVerify=true", "filter.lfs.process=", "transfer.bundleURI=false", "promisor.acceptFromServer=none"]));
    }
    acquired.cleanup();
    acquired.cleanup();
    expect(readdirSync(f.workspacesDir)).toEqual([]);
  });

  it.each(["-main", "main:other", "HEAD~1", "refs/pull/1/head", "foo..bar", "foo.lock", "branch name", ""])("rejects unsupported ref %s before creating a checkout", async ref => {
    const f = fixture();
    await expect(acquirePublicGitHubRepository({ ...f.options, ref })).rejects.toThrow("GitHub ref");
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(f.workspacesDir)).toEqual([]);
  });

  it("cleans failed or timed-out fetches and does not attempt checkout", async () => {
    for (const fetchResult of [
      { ...ok(), exitCode: 128, stderr: "repository unavailable" },
      { ...ok(), timedOut: true },
    ]) {
      const f = fixture({ onCommand: args => args.includes("fetch") ? fetchResult : undefined });
      await expect(acquirePublicGitHubRepository(f.options)).rejects.toThrow(/unavailable|timed out/);
      expect(f.calls.some(call => call.args.includes("checkout"))).toBe(false);
      expect(readdirSync(f.workspacesDir)).toEqual([]);
    }
  });

  it("honors cancellation before and during acquisition", async () => {
    const controller = new AbortController();
    const f = fixture({ onCommand: args => { if (args.includes("fetch")) controller.abort(new Error("cancelled by observer")); } });
    await expect(acquirePublicGitHubRepository({ ...f.options, signal: controller.signal })).rejects.toThrow("cancelled by observer");
    expect(f.calls.some(call => call.args.includes("checkout"))).toBe(false);
    expect(readdirSync(f.workspacesDir)).toEqual([]);
    const calls = f.calls.length;
    await expect(acquirePublicGitHubRepository({ ...f.options, signal: controller.signal })).rejects.toThrow("cancelled by observer");
    expect(f.calls).toHaveLength(calls);
  });

  it("rejects a different commit and oversized checkout metadata before materializing files", async () => {
    const mismatched = fixture();
    await expect(acquirePublicGitHubRepository({ ...mismatched.options, ref: "b".repeat(40) })).rejects.toThrow("different commit");
    const huge = fixture({ tree: `100644 blob ${commit} 64000001\tfixture.bin\0` });
    await expect(acquirePublicGitHubRepository(huge.options)).rejects.toThrow("64 MB");
    for (const f of [mismatched, huge]) {
      expect(f.calls.some(call => call.args.includes("checkout"))).toBe(false);
      expect(readdirSync(f.workspacesDir)).toEqual([]);
    }
  });

  it("limits acquired disk usage independently of the later source snapshot", async () => {
    const f = fixture({ onCommand: (args, options) => {
      if (args.includes("fetch")) {
        const path = join(options.cwd, "download.pack");
        writeFileSync(path, "");
        truncateSync(path, 128_000_001);
      }
    } });
    await expect(acquirePublicGitHubRepository(f.options)).rejects.toThrow("128 MB");
    expect(f.calls.some(call => call.args.includes("checkout"))).toBe(false);
    expect(readdirSync(f.workspacesDir)).toEqual([]);
  });
});
