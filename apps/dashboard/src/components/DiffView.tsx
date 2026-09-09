import { useEffect, useRef, useState } from "react";
import { FileDiff, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DiffFile } from "@/lib/diff";
import { diffStats } from "@/lib/diff";
import { Chip, Empty } from "./ui";

export function DiffView({ files, focusPath, emptyHint }: { files: DiffFile[]; focusPath: string | null; emptyHint: string }) {
  const [showGenerated, setShowGenerated] = useState(false);
  const generated = files.filter((f) => f.generated);
  const shown = files.filter((f) => showGenerated || !f.generated);
  const stats = diffStats(shown);
  const refs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!focusPath) return;
    refs.current.get(focusPath)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusPath, files]);

  if (files.length === 0) {
    return <Empty title="No changes yet" hint={emptyHint} />;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.9em] text-ink-2">
        <FileDiff className="size-4 text-ink-3" />
        <span>
          {stats.files} file{stats.files === 1 ? "" : "s"} changed
        </span>
        <span className="font-mono text-pass">+{stats.additions}</span>
        <span className="font-mono text-fail">−{stats.deletions}</span>
        {generated.length > 0 && (
          <button onClick={() => setShowGenerated((v) => !v)} className="ml-auto inline-flex items-center gap-1 text-[0.9em] text-ink-3 hover:text-ink">
            <EyeOff className="size-3.5" />
            {showGenerated ? "hide" : "show"} {generated.length} generated
          </button>
        )}
      </div>
      {shown.map((file) => (
        <div
          key={file.path}
          ref={(el) => {
            if (el) refs.current.set(file.path, el);
            else refs.current.delete(file.path);
          }}
          className={cn("overflow-hidden rounded-lg border", focusPath === file.path ? "border-info/50 ring-2 ring-info/15" : "border-line")}
        >
          <div className="flex items-center gap-2 border-b border-line bg-canvas/70 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.92em] text-ink">{file.path}</span>
            {file.status !== "modified" && <Chip tone={file.status === "deleted" ? "fail" : "pass"}>{file.status}</Chip>}
            <span className="font-mono text-[0.85em] tabular-nums text-pass">+{file.additions}</span>
            <span className="font-mono text-[0.85em] tabular-nums text-fail">−{file.deletions}</span>
          </div>
          <div className="code overflow-x-auto">
            <table className="w-full border-collapse">
              <tbody>
                {file.hunks.map((hunk, hi) => (
                  <HunkRows key={hi} hunk={hunk} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function HunkRows({ hunk }: { hunk: DiffFile["hunks"][number] }) {
  return (
    <>
      <tr className="bg-info-soft/60 text-info/80">
        <td colSpan={3} className="px-3 py-0.5 font-mono text-[0.85em]">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, li) => (
        <tr
          key={li}
          className={cn(
            line.kind === "add" && "bg-diff-add",
            line.kind === "del" && "bg-diff-del",
            line.kind === "meta" && "text-ink-3",
          )}
        >
          <td className="w-10 select-none border-r border-line/60 px-1.5 text-right text-ink-3/70 tabular-nums">{line.oldNo ?? ""}</td>
          <td className="w-10 select-none border-r border-line/60 px-1.5 text-right text-ink-3/70 tabular-nums">{line.newNo ?? ""}</td>
          <td className="whitespace-pre px-3">
            <span className={cn("mr-2 inline-block w-2 select-none", line.kind === "add" && "text-pass", line.kind === "del" && "text-fail")}>
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            {line.text}
          </td>
        </tr>
      ))}
    </>
  );
}
