import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "bench" }
  | { name: "join"; id?: string }
  | { name: "present" }
  | { name: "run"; runId: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const join = /^\/join(?:\/([^/?]+))?\/?$/.exec(path);
  if (join) return { name: "join", ...(join[1] ? { id: join[1] } : {}) };
  if (path === "/present") return { name: "present" };
  const run = /^\/runs\/([^/?]+)/.exec(path);
  if (run) {
    try { return { name: "run", runId: decodeURIComponent(run[1]!) }; }
    catch { return { name: "home" }; }
  }
  if (path.startsWith("/bench")) return { name: "bench" };
  return { name: "home" };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "bench":
      return "#/bench";
    case "join":
      return route.id ? `#/join/${encodeURIComponent(route.id)}` : "#/join";
    case "present":
      return "#/present";
    case "run":
      return `#/runs/${encodeURIComponent(route.runId)}`;
  }
}

export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    window.location.hash = routeHref(next);
  }, []);
  return [route, navigate];
}
