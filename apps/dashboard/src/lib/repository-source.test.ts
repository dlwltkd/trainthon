import { describe, expect, it } from "vitest";
import { githubCommitUrl, githubRepositoryUrl, repositoryInputError, repositoryStartRequest, type RepositoryFormValues } from "./repository-source";

const form: RepositoryFormValues = { workflow: "review", prompt: "Review authorization boundaries.", source: "github", repoPath: "https://github.com/example/repository", regressionPath: "", reportText: "", ref: "HEAD", mode: "live", patchPath: "", review: true };

describe("repository sources and workflow requests", () => {
  it("starts a prompt-based public review without a report or regression", () => {
    const request = repositoryStartRequest(form);
    expect(request).toMatchObject({ kind: "repository", workflow: "review", repoPath: form.repoPath, prompt: form.prompt, mode: "live" });
    expect(request).not.toHaveProperty("reportText");
    expect(request).not.toHaveProperty("regressionPath");
    expect(request).not.toHaveProperty("review");
  });

  it("starts a remediation from a prompt without adding test or delivery operations", () => {
    const request = repositoryStartRequest({ ...form, workflow: "remediate", mode: "scripted", patchPath: "/tmp/old.diff" });
    expect(request).toMatchObject({ workflow: "remediate", prompt: form.prompt, mode: "live" });
    expect(request).not.toHaveProperty("regressionPath");
    expect(request).not.toHaveProperty("patchPath");
    expect(request).not.toHaveProperty("pullRequest");
    expect(() => repositoryStartRequest({ ...form, workflow: "remediate", prompt: " " })).toThrow("prompt");
  });

  it("keeps a source review read-only when switching from a scripted repair", () => {
    const request = repositoryStartRequest({ ...form, mode: "scripted", patchPath: "/tmp/old.diff", regressionPath: "tests/old.test.ts" });
    expect(request.mode).toBe("live");
    expect(request).not.toHaveProperty("patchPath");
    expect(request).not.toHaveProperty("regressionPath");
  });

  it("requires a review prompt and only requires a regression for repair", () => {
    expect(() => repositoryStartRequest({ ...form, prompt: " " })).toThrow("prompt");
    expect(() => repositoryStartRequest({ ...form, workflow: "repair" })).toThrow("regression test");
    expect(repositoryStartRequest({ ...form, workflow: "repair", prompt: "", regressionPath: " tests/security.test.ts " })).toMatchObject({ workflow: "repair", regressionPath: "tests/security.test.ts" });
  });

  it("keeps reports optional for repairs and includes supplementary context when present", () => {
    const repair = { ...form, workflow: "repair" as const, regressionPath: "tests/security.test.ts", reportText: " " };
    expect(repositoryStartRequest(repair)).not.toHaveProperty("reportText");
    expect(repositoryStartRequest({ ...form, reportText: " Relevant context. " }).reportText).toBe("Relevant context.");
  });

  it("accepts a local source without turning it into a URL", () => {
    expect(repositoryStartRequest({ ...form, source: "local", repoPath: " /tmp/my repository " }).repoPath).toBe("/tmp/my repository");
    expect(repositoryInputError("local", form.repoPath)).toContain("Public GitHub");
  });

  it("normalizes public GitHub repository URLs and preserves the exact commit link", () => {
    expect(githubRepositoryUrl(" https://github.com/example/repository.git/ ")).toBe(form.repoPath);
    expect(githubCommitUrl(form.repoPath, "a".repeat(40))).toBe(`${form.repoPath}/tree/${"a".repeat(40)}`);
    expect(githubCommitUrl(form.repoPath, "HEAD")).toBeNull();
    expect(githubCommitUrl(form.repoPath, "a123456")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "http://github.com/example/repository",
    "https://github.com.attacker.test/example/repository",
    "https://github.com@attacker.test/example/repository",
    "https://github.com:443/example/repository",
    "https://github.com/example/repository?token=hidden",
    "https://github.com/example/repository/tree/main",
    "https://github.com/example/..",
  ])("does not link or submit a noncanonical repository source: %s", (url) => {
    expect(githubRepositoryUrl(url)).toBeNull();
    expect(githubCommitUrl(url, "a".repeat(40))).toBeNull();
    expect(() => repositoryStartRequest({ ...form, repoPath: url })).toThrow("public GitHub");
  });
});
