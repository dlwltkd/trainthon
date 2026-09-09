import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { AgentRole, RunStatus } from "@vouch/protocol";
import { cn } from "@/lib/cn";
import { statusLabel, roleLabel, statusTone } from "@/lib/derive";

export type Tone = "pass" | "fail" | "info" | "warn" | "neutral" | "running" | "red" | "blue";

const TONE_CHIP: Record<Tone, string> = {
  pass: "bg-pass-soft text-pass border-pass/20",
  fail: "bg-fail-soft text-fail border-fail/20",
  info: "bg-info-soft text-info border-info/20",
  warn: "bg-warn-soft text-warn border-warn/20",
  neutral: "bg-zinc-100 text-ink-2 border-line",
  running: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-role/10 text-red-role border-red-role/20",
  blue: "bg-blue-role/10 text-blue-role border-blue-role/20",
};

export function Chip({ tone = "neutral", className, children, dot, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[0.8em] font-medium leading-none whitespace-nowrap",
        TONE_CHIP[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span className={cn("relative inline-block size-1.5 rounded-full bg-current", tone === "running" && "pulse-dot")} />}
      {children}
    </span>
  );
}

export function StatusChip({ status, reason, className }: { status: RunStatus; reason?: string; className?: string }) {
  return (
    <Chip tone={statusTone(status)} dot className={cn("uppercase tracking-wide", className)}>
      {statusLabel(status, reason)}
    </Chip>
  );
}

export function RoleChip({ role, className, size = "sm" }: { role: AgentRole | undefined; className?: string; size?: "sm" | "md" }) {
  const tone: Tone = role === "red" ? "red" : role === "blue" ? "blue" : "neutral";
  return (
    <Chip tone={tone} className={cn(size === "md" && "px-2 py-1 text-[0.85em]", className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {roleLabel(role)}
    </Chip>
  );
}

export function Button({
  variant = "default",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info",
        size === "sm" ? "h-7 px-2.5 text-[0.85em]" : "h-8.5 px-3.5",
        variant === "default" && "border-line-2 bg-panel text-ink hover:bg-zinc-50",
        variant === "primary" && "border-ink bg-ink text-white hover:bg-zinc-800",
        variant === "ghost" && "border-transparent bg-transparent text-ink-2 hover:bg-zinc-100 hover:text-ink",
        variant === "danger" && "border-fail/30 bg-fail-soft text-fail hover:bg-fail/15",
        className,
      )}
      {...rest}
    />
  );
}

export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-xl border border-line bg-panel", className)} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, aside, className }: { title: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line px-3", className)}>
      <div className="flex min-w-0 items-center gap-2 text-[0.85em] font-semibold uppercase tracking-wider text-ink-3">{title}</div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-2 bg-zinc-50 px-1 font-mono text-[0.75em] text-ink-2">{children}</kbd>;
}

export function Mono({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("font-mono text-[0.92em]", className)} {...rest}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)} aria-label="loading" />
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-sm text-[0.9em] text-ink-3">{hint}</div>}
      {action}
    </div>
  );
}

export function Meter({ value, max, tone = "info", className }: { value: number; max: number; tone?: Tone; className?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const color = tone === "fail" ? "bg-fail" : tone === "warn" ? "bg-warn" : tone === "pass" ? "bg-pass" : "bg-info";
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-zinc-200/80", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ id: T; label: ReactNode; badge?: ReactNode }>;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex h-8 items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5", className)} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[0.9em] font-medium transition-colors",
            value === item.id ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {item.label}
          {item.badge !== undefined && item.badge !== null && (
            <span className="rounded-full bg-zinc-200/80 px-1.5 text-[0.8em] tabular-nums text-ink-2">{item.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
