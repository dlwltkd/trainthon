import { ExternalLink, GitPullRequestDraft } from "lucide-react";
import type { useDraftDelivery } from "@/hooks/useDraftDelivery";
import { Button, Chip, Panel, Spinner } from "./ui";

export function DraftPullRequest({ delivery, repositoryUrl, tested }: { delivery: ReturnType<typeof useDraftDelivery>; repositoryUrl: string; tested: boolean }) {
  return <Panel className="space-y-3 p-4">
    <div className="flex flex-wrap items-center gap-2"><GitPullRequestDraft className="size-4 text-ink-2" /><h3 className="font-semibold">Deliver this patch</h3><Chip tone={tested ? "info" : "warn"}>{tested ? "Repository tests passed" : "Untested source patch"}</Chip></div>
    <p className="text-[0.9em] leading-relaxed text-ink-2">{tested ? "The recorded repository tests passed. Review the diff above before delivery." : "Tests were not run. Review the source findings and diff above before delivery."} Creating a draft PR writes a branch and draft pull request to <span className="font-mono">{repositoryUrl.replace("https://github.com/", "")}</span>.</p>
    {delivery.connection === "missing" && <p className="text-[0.85em] text-ink-3">GitHub delivery is not connected. Configure a token with push access on the server. This workflow opens the PR in the original repository.</p>}
    {delivery.connection === "error" && <p className="text-[0.85em] text-fail">Could not check the GitHub connection.</p>}
    {delivery.error && <p className="whitespace-pre-wrap text-[0.87em] text-fail" role="alert">{delivery.error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {delivery.url ? <a href={delivery.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[0.9em] font-medium text-white">Open draft PR <ExternalLink className="size-3.5" /></a> : <Button variant="primary" onClick={() => void delivery.create()} disabled={delivery.connection !== "configured" || delivery.status !== "idle"}>{delivery.status === "creating" || delivery.connection === "loading" ? <Spinner className="size-3.5" /> : <GitPullRequestDraft className="size-3.5" />}{delivery.status === "creating" ? "Creating draft…" : delivery.status === "created" ? "Draft created" : "Create draft PR"}</Button>}
      {delivery.connection === "missing" || delivery.connection === "error" ? <Button variant="ghost" onClick={delivery.refresh}>Recheck connection</Button> : null}
    </div>
  </Panel>;
}
