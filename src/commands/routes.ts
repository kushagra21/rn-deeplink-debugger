import { resolve } from "node:path";
import pc from "picocolors";
import { readLinks, type SavedLink } from "../links.js";
import { matchPattern, parseLinkUrl, type LinkUrl } from "../match.js";
import { formatRoutes, patternUrl } from "../report/format.js";
import { matchRoute, navigationPath, readRoutes, samplePath, type Route, type RouterInfo } from "../routes/index.js";
import type { Check, Finding, LinkPattern, Platform, ScanResult } from "../types.js";
import { unique } from "../util/fs.js";
import { runScan } from "./scan.js";

export interface RoutesOptions {
  cwd: string;
  json?: boolean;
}

export interface RoutesDeps {
  scan?: (root: string) => ScanResult | null;
  routes?: (root: string) => RouterInfo | null;
}

export interface RouteCoverage {
  path: string;
  /** Expo Router: the route file. React Navigation: the screen chain. */
  screen: string;
  /** Links that reach the route on each platform, e.g. `shop://` or `https://example.com`. */
  ios: string[];
  android: string[];
}

export interface RoutesReport {
  router: RouterInfo["router"];
  source: string;
  routes: RouteCoverage[];
  findings: Finding[];
}

export const ROUTER_NAME: Record<RouterInfo["router"], string> = { "expo-router": "Expo Router", "react-navigation": "React Navigation" };

const NO_ROUTER =
  "No Expo Router or React Navigation found. rn-deeplink reads routes from Expo Router's app/ folder or React Navigation's linking config, and needs expo-router or @react-navigation/native in package.json.";

const isCatchAll = (route: Route) => route.segments.length > 0 && route.segments.every((s) => s.kind === "rest");

export const screenLabel = (info: RouterInfo, route: Route) => (info.router === "expo-router" ? route.source : route.screen);

/** What happens when no route matches, in each router. */
function fallback(info: RouterInfo): string {
  if (info.router === "react-navigation") return "React Navigation can't navigate to it, and the app opens on its initial screen";
  return info.hasNotFound ? "Expo Router shows app/+not-found" : 'Expo Router shows its default "Unmatched Route" screen';
}

/** The screen a URL opens, as checks for `test`. */
export function screenChecks(info: RouterInfo, url: LinkUrl): Check[] {
  if (info.routes.length === 0) return info.notes.slice(0, 1).map((message) => ({ level: "info", message }));
  const path = navigationPath(url);
  const match = matchRoute(info.routes, path, new URL(url.raw).search.slice(1));
  if (!match) {
    return [
      {
        level: "warning",
        message: `No ${ROUTER_NAME[info.router]} route matches ${path}, so ${fallback(info)}.`,
        fix:
          info.router === "expo-router"
            ? `Add a route file for it under ${info.source} (for example ${info.source}${path.slice(1) || "index"}.tsx), or change the link.`
            : `Add a screen with this path to linking.config.screens in ${info.source}, or change the link.`,
      },
    ];
  }
  const label = screenLabel(info, match.route);
  const params = Object.keys(match.params).length ? ` with ${JSON.stringify(match.params)}` : "";
  if (isCatchAll(match.route)) {
    return [{ level: "warning", message: `Only the catch-all route ${match.route.path} matches ${path}, so it opens ${label}${params}.` }];
  }
  const missing = info.unknownScreens.find((s) => s.name === match.route.screen.split(" > ").at(-1));
  if (missing) {
    return [{ level: "error", message: `It matches ${match.route.path} for "${missing.name}", but no navigator has a screen called "${missing.name}".` }];
  }
  return [{ level: "pass", message: `Opens ${label}${params}` }];
}

/** A concrete path a link pattern opens, for checking it against the routes. */
function patternSample(p: LinkPattern): string | undefined {
  const path = p.pathType === "path" ? p.path : p.pathType === "pathPrefix" ? (p.path!.endsWith("/") ? `${p.path}example` : `${p.path}/example`) : p.path ? undefined : "";
  if (path === undefined) return undefined;
  // Custom schemes put the first path segment in the host: bareapp://settings is /settings.
  if (p.kind === "scheme") return p.host && !p.host.includes("*") ? `/${p.host}${path}` : undefined;
  return p.host && path ? path : undefined;
}

function urlFor(p: LinkPattern, route: Route): string {
  const sample = samplePath(route);
  if (p.kind === "scheme") return `${p.scheme}://${sample.slice(1)}`;
  return `https://${(p.host ?? "").replace(/^\*\./, "www.")}${sample}`;
}

/** Which links reach a route on a platform. iOS universal links are only checked by host; their paths live in the AASA. */
function reachedBy(route: Route, patterns: LinkPattern[], platform: Platform): string[] {
  return unique(
    patterns
      .filter((p) => p.platform === platform && !p.thirdParty && !p.blockedBy)
      .flatMap((p) => {
        const url = parseLinkUrl(urlFor(p, route));
        if (!url || matchPattern(p, url)) return [];
        return [p.kind === "scheme" ? `${p.scheme}://` : `https://${p.host}${p.kind === "universal" ? " (AASA)" : ""}`];
      }),
  );
}

export function analyzeRoutes(scan: ScanResult, info: RouterInfo, links: SavedLink[]): RoutesReport {
  const findings: Finding[] = info.notes.map((message) => ({ level: "info", message }));

  for (const screen of info.unknownScreens) {
    findings.push({
      level: "warning",
      message: `The linking config maps "${screen.name}"${screen.path !== undefined ? ` to /${screen.path}` : ""}, but no navigator has a screen called "${screen.name}", so links to it go nowhere.`,
      fix: `Rename the entry in ${screen.source} to an existing screen, or remove it.`,
      source: screen.source,
    });
  }
  if (info.unlinkedScreens.length) {
    findings.push({
      level: "info",
      message: `${info.unlinkedScreens.length} screen${info.unlinkedScreens.length === 1 ? " has" : "s have"} no deep link path, so links can't open ${info.unlinkedScreens.length === 1 ? "it" : "them"} directly: ${info.unlinkedScreens.join(", ")}.`,
      fix: `If they should be linkable, add them to linking.config.screens in ${info.source}.`,
    });
  }

  if (info.routes.length) {
    // Links that open the app but land on no route.
    const candidates: { label: string; path: string; query: string }[] = [];
    for (const link of links) {
      const url = parseLinkUrl(link.url);
      const opensApp = url && scan.patterns.some((p) => !p.thirdParty && (!link.platform || p.platform === link.platform) && !matchPattern(p, url));
      if (url && opensApp) candidates.push({ label: `Saved link ${link.name ? `"${link.name}" ` : ""}(${link.url})`, path: navigationPath(url), query: new URL(link.url).search.slice(1) });
    }
    for (const p of scan.patterns.filter((p) => p.platform === "android" && !p.thirdParty)) {
      const path = patternSample(p);
      if (path) candidates.push({ label: `The Android filter for ${patternUrl(p)} (${p.source})`, path, query: "" });
    }
    const seen = new Set<string>();
    for (const { label, path, query } of candidates) {
      if (seen.has(label)) continue;
      seen.add(label);
      const match = matchRoute(info.routes, path, query);
      if (match && !isCatchAll(match.route)) continue;
      findings.push({
        level: "warning",
        message: match
          ? `${label} opens the app, but only the catch-all route ${match.route.path} matches ${path}, so it lands on ${screenLabel(info, match.route)}.`
          : `${label} opens the app, but no route matches ${path}, so ${fallback(info)}.`,
        fix: label.startsWith("Saved link") ? "Fix the link, or add a route for it." : "Add a route for this path, or narrow the filter to paths the app handles.",
      });
    }
  }

  const routes = info.routes.map((route) => ({
    path: route.path,
    screen: screenLabel(info, route),
    ios: reachedBy(route, scan.patterns, "ios"),
    android: reachedBy(route, scan.patterns, "android"),
  }));

  // Routes https links can't reach on Android, when the app has App Links at all.
  if (scan.patterns.some((p) => p.kind === "app-link" && !p.thirdParty)) {
    const missing = new Set(info.unknownScreens.map((s) => s.name));
    const unreached = routes.filter((r, i) => {
      const route = info.routes[i]!;
      return !isCatchAll(route) && !missing.has(route.screen.split(" > ").at(-1)!) && !r.android.some((l) => l.startsWith("https://"));
    });
    if (unreached.length) {
      findings.push({
        level: "info",
        message: `No Android App Link covers ${unreached.length === 1 ? "this route" : `these ${unreached.length} routes`}, so https links to ${unreached.length === 1 ? "it" : "them"} open in the browser on Android: ${unreached.map((r) => r.path).join(", ")}.`,
        fix: "If they should open the app from the web, add their paths to an App Link intent filter (or android.intentFilters in app.json).",
      });
    }
  }

  return { router: info.router, source: info.source, routes, findings };
}

export function runRoutes(options: RoutesOptions, deps: RoutesDeps = {}): RoutesReport | { error: string } {
  const root = resolve(options.cwd);
  const info = (deps.routes ?? readRoutes)(root);
  if (!info) return { error: NO_ROUTER };
  const scan = (deps.scan ?? runScan)(root);
  if (!scan) return { error: "No React Native project here. Run this in your project root, or pass --cwd <dir>." };
  const links = readLinks(root);
  if (links && "error" in links) return links;
  return analyzeRoutes(scan, info, links ?? []);
}

export function routesCommand(options: RoutesOptions): void {
  const result = runRoutes(options);
  if ("error" in result) {
    console.error(`${pc.red("✖")} ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatRoutes(result));
  if (result.findings.some((f) => f.level === "error")) process.exitCode = 1;
}
