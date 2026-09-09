import { useEffect, useState } from "react";

/** Re-render on an interval while `enabled`, for live elapsed timers. */
export function useTicker(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

export function useLocalStorage<T extends string | boolean>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    if (typeof fallback === "boolean") return (raw === "true") as T;
    return raw as T;
  });
  const update = (next: T) => {
    setValue(next);
    window.localStorage.setItem(key, String(next));
  };
  return [value, update];
}
