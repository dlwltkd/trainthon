import type { StartRequest } from "./api";

export type RepositorySourceKind = "github" | "local";

export function githubRepositoryUrl(value: string | undefined): string | null {
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9._-]{1,100})\/?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const name = match[2]!.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") return null;
  return `https://github.com/${match[1]}/${name}`;
}

export function githubCommitUrl(repository: string | undefined, commit: string | undefined): string | null {
  const origin = githubRepositoryUrl(repository);
  return origin && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit ?? "") ? `${origin}/tree/${commit}` : null;
}

export function repositoryInputError(source: RepositorySourceKind, value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (source === "github" && !githubRepositoryUrl(value)) return "Enter a public GitHub repository URL: https://github.com/owner/repo";
  if (source === "local" && /^https?:\/\//i.test(value.trim())) return "Choose Public GitHub to use a repository URL.";
  return undefined;
}

export interface RepositoryFormValues {
  workflow: "review" | "repair" | "remediate";
  prompt: string;
  source: RepositorySourceKind;
  repoPath: string;
  regressionPath: string;
  reportText: string;
  ref: string;
  mode: "live" | "scripted";
  patchPath: string;
  review: boolean;
}

export function repositoryStartRequest(values: RepositoryFormValues): Extract<StartRequest, { kind: "repository" }> {
  const error = repositoryInputError(values.source, values.repoPath);
  if (error) throw new Error(error);
  if (!values.repoPath.trim()) throw new Error("A repository is required.");
  if (values.workflow !== "repair" && !values.prompt.trim()) throw new Error("Describe the source review task in the prompt.");
  if (values.workflow === "repair" && !values.regressionPath.trim()) throw new Error("An existing regression test is required for repository repair.");
  if (values.workflow === "repair" && values.mode === "scripted" && !values.patchPath.trim()) throw new Error("Select the supplied patch for scripted mode.");
  return {
    kind: "repository",
    workflow: values.workflow,
    repoPath: values.source === "github" ? githubRepositoryUrl(values.repoPath)! : values.repoPath.trim(),
    ...(values.workflow === "repair" ? { regressionPath: values.regressionPath.trim() } : {}),
    ...(values.prompt.trim() ? { prompt: values.prompt.trim() } : {}),
    ...(values.reportText.trim() ? { reportText: values.reportText.trim() } : {}),
    ref: values.ref.trim() || "HEAD",
    mode: values.workflow !== "repair" ? "live" : values.mode,
    ...(values.workflow === "repair" && values.mode === "scripted" ? { patchPath: values.patchPath.trim() } : {}),
    ...(values.workflow === "repair" ? { review: values.review } : {}),
  };
}
