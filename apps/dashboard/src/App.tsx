import { useEffect, useState } from "react";
import { ChevronLeft, Plus, Presentation, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { routeHref, useHashRoute } from "@/hooks/useHashRoute";
import { useLocalStorage } from "@/hooks/useTicker";
import { BenchView } from "./components/BenchView";
import { NewRunDialog } from "./components/NewRunDialog";
import { RunsHome } from "./components/RunsHome";
import { RunView } from "./components/RunView";
import { Button } from "./components/ui";

export function App() {
  const [route, navigate] = useHashRoute();
  const [presentation, setPresentation] = useLocalStorage<boolean>("vouch.presentation", false);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("presentation", presentation);
  }, [presentation]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "p" && !e.metaKey && !e.ctrlKey) setPresentation(!presentation);
      if (e.key === "n" && !e.metaKey && !e.ctrlKey) setDialog(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentation, setPresentation]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 sm:px-4">
        {route.name === "run" ? (
          <a href={routeHref({ name: "home" })} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-2 hover:bg-zinc-100 hover:text-ink" aria-label="back to runs">
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Runs</span>
          </a>
        ) : null}
        <a href={routeHref({ name: "home" })} className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-ink text-white">
            <ShieldCheck className="size-3.5" />
          </span>
          <span className="text-[1.05em] font-semibold tracking-tight">Vouch</span>
          <span className="secondary hidden border-l border-line pl-2 text-[0.8em] text-ink-3 lg:inline">Security agent workspace</span>
        </a>
        <nav className="ml-2 hidden items-center gap-0.5 sm:flex">
          <NavLink active={route.name === "home" || route.name === "run"} href={routeHref({ name: "home" })}>
            Runs
          </NavLink>
          <NavLink active={route.name === "bench"} href={routeHref({ name: "bench" })}>
            Evidence
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant={presentation ? "primary" : "ghost"} onClick={() => setPresentation(!presentation)} title="Presentation mode (p)">
            <Presentation className="size-3.5" />
            <span className="hidden sm:inline">Present</span>
          </Button>
          <Button size="sm" variant="default" onClick={() => setDialog(true)} title="New run (n)">
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">New run</span>
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {route.name === "home" && (
          <div className="h-full overflow-y-auto">
            <RunsHome onNewRun={() => setDialog(true)} />
          </div>
        )}
        {route.name === "bench" && (
          <div className="h-full overflow-y-auto">
            <BenchView />
          </div>
        )}
        {route.name === "run" && <RunView key={route.runId} runId={route.runId} />}
      </main>

      <NewRunDialog
        open={dialog}
        onClose={() => setDialog(false)}
        onStarted={(runId) => {
          setDialog(false);
          navigate({ name: "run", runId });
        }}
      />
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a href={href} className={cn("rounded-md px-2.5 py-1 text-[0.95em] font-medium transition-colors", active ? "bg-zinc-100 text-ink" : "text-ink-3 hover:text-ink")}>
      {children}
    </a>
  );
}
