import { useEffect, useState } from "react";
import { FileCode2, FileDiff } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { shortSha } from "@/lib/format";
import { Button, Empty, Mono, Spinner } from "./ui";

interface Loaded {
  text: string;
  revision: string;
}

export function CodeView({
  runId,
  path,
  available,
  changed,
  onShowDiff,
}: {
  runId: string;
  path: string | null;
  available: boolean;
  changed: boolean;
  onShowDiff: () => void;
}) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "error"; data?: Loaded; error?: string }>({ status: "idle" });

  useEffect(() => {
    if (!path) return;
    if (!available) {
      setState({ status: "error", error: "File contents are not available for this run. The repository path is only known for runs started from this dashboard or benchmark fixtures." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    api
      .file(runId, path)
      .then((data) => !cancelled && setState({ status: "ok", data }))
      .catch((error: Error) => !cancelled && setState({ status: "error", error: error.message }));
    return () => {
      cancelled = true;
    };
  }, [runId, path, available]);

  if (!path) return <Empty title="Select a file" hint="Pick a file from the tree or click an activity entry to open what the agent was looking at." />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[0.9em]">
        <FileCode2 className="size-4 text-ink-3" />
        <Mono className="min-w-0 flex-1 truncate">{path}</Mono>
        {state.data && <span className="secondary text-ink-3">@ {state.data.revision.length > 12 ? shortSha(state.data.revision) : state.data.revision}</span>}
        {changed && (
          <Button size="sm" variant="ghost" onClick={onShowDiff}>
            <FileDiff className="size-3.5" /> view diff
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <div className="flex items-center gap-2 p-4 text-ink-3">
            <Spinner /> loading
          </div>
        )}
        {state.status === "error" && <div className="p-4 text-[0.9em] text-ink-3">{state.error}</div>}
        {state.status === "ok" && state.data && <Source text={state.data.text} />}
      </div>
    </div>
  );
}

export function Source({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <table className={cn("code w-full border-collapse", className)}>
      <tbody>
        {lines.map((line, i) => (
          <tr key={i} className="hover:bg-zinc-50">
            <td className="w-10 select-none border-r border-line/60 px-2 text-right text-ink-3/70 tabular-nums">{i + 1}</td>
            <td className="whitespace-pre px-3">{line}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
