import type { AndroidPathType, LinkPattern } from "./types.js";

export interface LinkUrl {
  raw: string;
  /** Scheme as typed (URL parsing would lowercase it, but Android compares it case-sensitively). */
  scheme: string;
  host: string;
  port: string;
  /** Decoded path, as Android matches it. */
  path: string;
}

/** Why a pattern doesn't match, at the first part of the URL that differs. */
export interface Miss {
  stage: "scheme" | "host" | "path";
  reason: string;
  /** The scheme only differs in case, or is http vs https on a matching host. */
  near?: boolean;
  /** Fix for a near miss. */
  fix?: string;
}

const isWeb = (scheme: string) => scheme === "http" || scheme === "https";

export function parseLinkUrl(input: string): LinkUrl | null {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(input)?.[1];
  if (!scheme) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the encoded path
  }
  return { raw: input, scheme, host: url.hostname, port: url.port, path };
}

const escapeRegex = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Android's PatternMatcher simple glob: "." is any character, "x*" is zero or more x, "\" escapes. */
export function androidGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    let unit: string;
    if (ch === "\\" && i + 1 < pattern.length) unit = escapeRegex(pattern[++i]!);
    else unit = ch === "." ? "." : escapeRegex(ch);
    if (pattern[i + 1] === "*") {
      unit += "*";
      i++;
    }
    source += unit;
  }
  return new RegExp(`^${source}$`, "s");
}

export function androidPathMatches(type: AndroidPathType, rule: string, path: string): boolean {
  switch (type) {
    case "path":
      return path === rule;
    case "pathPrefix":
      return path.startsWith(rule);
    case "pathSuffix":
      return path.endsWith(rule);
    case "pathPattern":
      return androidGlob(rule).test(path);
    case "pathAdvancedPattern":
      try {
        return new RegExp(`^(?:${rule})$`, "s").test(path);
      } catch {
        return false;
      }
  }
}

const PATH_RULE: Record<AndroidPathType, string> = {
  path: "be exactly",
  pathPrefix: "start with",
  pathSuffix: "end with",
  pathPattern: "match the pattern",
  pathAdvancedPattern: "match the pattern",
};

/**
 * Host match with an optional `:port`. `*.example.com` matches subdomains only. iOS needs the
 * port to match exactly; Android ignores the port when the filter doesn't set one.
 */
function hostMatches(pattern: string, url: LinkUrl, strictPort: boolean): boolean {
  const [, host = "", port] = /^(.*?)(?::(\d+))?$/.exec(pattern) ?? [];
  if (port !== undefined ? port !== url.port : strictPort && url.port !== "") return false;
  const actual = url.host.toLowerCase();
  const wanted = host.toLowerCase();
  return wanted.startsWith("*") ? actual.endsWith(wanted.slice(1)) : actual === wanted;
}

/** Whether a URL reaches a pattern, or the reason it doesn't. */
export function matchPattern(p: LinkPattern, url: LinkUrl): Miss | null {
  const scheme = url.scheme.toLowerCase();
  const asHttps = `https://${url.raw.replace(/^[^:]+:\/\//, "")}`;
  if (p.platform === "ios") {
    if (p.kind === "scheme") return scheme === p.scheme.toLowerCase() ? null : { stage: "scheme", reason: `it handles ${p.scheme}:// URLs` };
    if (scheme !== "https") {
      return scheme === "http" && hostMatches(p.host ?? "", url, true)
        ? { stage: "scheme", reason: "universal links only work with https", near: true, fix: `Link to ${asHttps} instead.` }
        : { stage: "scheme", reason: "it handles https URLs" };
    }
    return hostMatches(p.host ?? "", url, true) ? null : { stage: "host", reason: `it is for ${p.host}` };
  }

  if (p.scheme !== url.scheme) {
    if (p.scheme.toLowerCase() === scheme) {
      return {
        stage: "scheme",
        reason: `its scheme is "${p.scheme}", and Android compares schemes case-sensitively`,
        near: true,
        fix: `Change the filter's scheme to "${scheme}". Browsers and most apps send schemes in lowercase.`,
      };
    }
    if (isWeb(scheme) && isWeb(p.scheme) && (!p.host || hostMatches(p.host, url, false))) {
      return {
        stage: "scheme",
        reason: `it only handles ${p.scheme}:// URLs`,
        near: true,
        fix: p.scheme === "https" ? `Link to ${asHttps} instead.` : `Add <data android:scheme="${scheme}" /> to that filter.`,
      };
    }
    return { stage: "scheme", reason: `it handles ${p.scheme}:// URLs` };
  }
  if (p.host && !hostMatches(p.host, url, false)) return { stage: "host", reason: `it is for ${p.host}` };
  if (p.host && p.path && p.pathType && !androidPathMatches(p.pathType, p.path, url.path)) {
    return { stage: "path", reason: `the path must ${PATH_RULE[p.pathType]} ${p.path}` };
  }
  return null;
}

const STAGE_RANK = { scheme: 0, host: 1, path: 2 };

/** Patterns the URL matches, and otherwise the patterns that came closest. */
export function explainUrl(url: LinkUrl, patterns: LinkPattern[]): { matched: LinkPattern[]; closest: { pattern: LinkPattern; miss: Miss }[] } {
  const matched: LinkPattern[] = [];
  const misses: { pattern: LinkPattern; miss: Miss }[] = [];
  for (const pattern of patterns) {
    const miss = matchPattern(pattern, url);
    if (miss) misses.push({ pattern, miss });
    else matched.push(pattern);
  }
  // A scheme that only differs in case, or http vs https, is a near miss worth naming.
  const rank = ({ miss }: { miss: Miss }) => (miss.near ? 0.5 : STAGE_RANK[miss.stage]);
  const best = Math.max(-1, ...misses.map(rank));
  return { matched, closest: best > 0 ? misses.filter((m) => rank(m) === best) : [] };
}
