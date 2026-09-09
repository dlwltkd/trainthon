import type { RunStatus } from "@vouch/protocol";
import { githubRepositoryUrl } from "./repository-source";

export function canDeliverPatch(status: RunStatus, repositoryUrl: string | undefined, changedFiles: number): boolean {
  return (status === "PATCH_PROPOSED" || status === "TESTS_PASSED") && changedFiles > 0 && githubRepositoryUrl(repositoryUrl) !== null;
}

export function pullRequestLink(value: string, repositoryUrl: string | undefined): string | null {
  const repository = githubRepositoryUrl(repositoryUrl);
  if (!repository || !value.startsWith(`${repository}/pull/`)) return null;
  return /^[1-9]\d*$/.test(value.slice(`${repository}/pull/`.length)) ? value : null;
}
