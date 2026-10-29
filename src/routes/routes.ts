import type { LinkUrl } from "../match.js";

export type Segment = { kind: "static"; value: string } | { kind: "param"; name: string; optional?: boolean } | { kind: "rest"; name: string; minOne: boolean };

/** A path the app's navigation handles, and the screen it opens. */
export interface Route {
  /** Path pattern, e.g. `/product/:id` or `/blog/*slug`. */
  path: string;
  segments: Segment[];
  /** Expo Router: the file route, e.g. `/product/[id]`. React Navigation: the screen chain, e.g. `HomeTabs > Feed`. */
  screen: string;
  /** File it was read from, relative to the project root. */
  source: string;
}

export interface RouterInfo {
  router: "expo-router" | "react-navigation";
  /** Where the routes come from, e.g. `app/` or `src/navigation/linking.ts`. */
  source: string;
  routes: Route[];
  /** React Navigation: screens navigators declare that the linking config doesn't map. */
  unlinkedScreens: string[];
  /** React Navigation: linking config entries for screens no navigator declares. */
  unknownScreens: { name: string; path?: string; source: string }[];
  /** Expo Router: whether app/+not-found exists. */
  hasNotFound?: boolean;
  /** What couldn't be read, in plain words. */
  notes: string[];
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string | string[]>;
}

export function formatPath(segments: Segment[]): string {
  return `/${segments
    .map((s) => (s.kind === "static" ? s.value : s.kind === "param" ? `:${s.name}${s.optional ? "?" : ""}` : s.name === "*" ? "*" : `*${s.name}`))
    .join("/")}`;
}

/** React Navigation path syntax: `user/:id`, `user/:id?`, `*`. Regex constraints like `:id(\\d+)` are ignored. */
export function parseReactNavigationPath(path: string): Segment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((part): Segment => {
      if (part === "*") return { kind: "rest", name: "*", minOne: false };
      const param = /^:([^?(]+)(\(.*\))?(\?)?$/.exec(part);
      if (param) return { kind: "param", name: param[1]!, optional: !!param[3] };
      return { kind: "static", value: part };
    });
}

/**
 * The path navigation sees for a URL. Web links use the URL path. For custom schemes the "host" is
 * the first path segment, so `myapp://product/42` is `/product/42`, as React Navigation and Expo
 * Router read it.
 */
export function navigationPath(url: LinkUrl): string {
  const web = /^https?$/i.test(url.scheme);
  const path = web ? url.path : `/${url.host}${url.path === "/" ? "" : url.path}`;
  return path.replace(/\/+$/, "") || "/";
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function matchSegments(segments: Segment[], parts: string[], params: Record<string, string | string[]>): boolean {
  const [segment, ...rest] = segments;
  if (!segment) return parts.length === 0;
  if (segment.kind === "rest") {
    if (segment.minOne && parts.length === 0) return false;
    params[segment.name] = parts.map(decode);
    return true;
  }
  if (segment.kind === "param") {
    if (parts.length && matchSegments(rest, parts.slice(1), params)) {
      params[segment.name] = decode(parts[0]!);
      return true;
    }
    return !!segment.optional && matchSegments(rest, parts, params);
  }
  return parts[0] === segment.value && matchSegments(rest, parts.slice(1), params);
}

/** Static segments beat parameters, which beat catch-alls, as both routers rank them. */
function specificity(route: Route): number[] {
  const count = (kind: Segment["kind"]) => route.segments.filter((s) => s.kind === kind).length;
  return [count("rest") ? 0 : 1, count("static"), count("param"), route.segments.length];
}

const compare = (a: number[], b: number[]) => a.reduce((result, value, i) => result || value - b[i]!, 0);

/** The route a path opens, with its params (query parameters included), or null when none matches. */
export function matchRoute(routes: Route[], path: string, query = ""): RouteMatch | null {
  const parts = path.split("/").filter(Boolean);
  let best: RouteMatch | null = null;
  for (const route of routes) {
    const params: Record<string, string | string[]> = {};
    if (!matchSegments(route.segments, parts, params)) continue;
    if (!best || compare(specificity(route), specificity(best.route)) > 0) best = { route, params };
  }
  if (best && query) for (const [key, value] of new URLSearchParams(query)) best.params[key] ??= value;
  return best;
}

/** A concrete path that reaches a route, with "example" for each parameter. */
export function samplePath(route: Route): string {
  return `/${route.segments
    .flatMap((s) => (s.kind === "static" ? [s.value] : s.kind === "param" && s.optional ? [] : ["example"]))
    .join("/")}`;
}
