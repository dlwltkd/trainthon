import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { pullRequestLink } from "@/lib/pull-request";

export function useDraftDelivery(runId: string, repositoryUrl: string | undefined, eligible: boolean) {
  const [connection, setConnection] = useState<"loading" | "configured" | "missing" | "error">("loading");
  const [status, setStatus] = useState<"idle" | "creating" | "created">("idle");
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);

  useEffect(() => {
    if (!eligible) return;
    let disposed = false;
    setConnection("loading");
    api.health().then((health) => {
      if (!disposed) setConnection(health.github?.configured ? "configured" : "missing");
    }).catch(() => { if (!disposed) setConnection("error"); });
    return () => { disposed = true; };
  }, [eligible, refresh]);

  const create = useCallback(async () => {
    if (!eligible || connection !== "configured" || status === "created" || pending.current) return;
    pending.current = true;
    setStatus("creating");
    setError(undefined);
    try {
      const result = await api.pullRequest(runId);
      const link = pullRequestLink(result.url, repositoryUrl);
      setStatus("created");
      if (link) setUrl(link);
      else setError("The draft was created, but its returned GitHub link could not be validated. Check the repository’s pull requests.");
    } catch (cause) {
      setStatus("idle");
      setError(cause instanceof Error ? cause.message : "Could not create the draft PR.");
    } finally { pending.current = false; }
  }, [eligible, connection, status, runId, repositoryUrl]);

  return { connection, status, url, error, create, refresh: () => setRefresh((value) => value + 1) };
}
