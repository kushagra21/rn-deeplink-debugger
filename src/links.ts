import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLinkUrl } from "./match.js";
import { isDict } from "./parsers/ios.js";
import type { LinkPattern, Platform, ScanResult } from "./types.js";

export const LINKS_FILE = ".deeplinks.json";

/** A test URL shared through the committable .deeplinks.json file. */
export interface SavedLink {
  url: string;
  name?: string;
  /** Only use this link on one platform. */
  platform?: Platform;
}

export const linksPath = (root: string) => join(root, LINKS_FILE);

/**
 * Read the project's saved links. Returns null when there is no file. Accepts
 * `{ "links": [...] }` or a bare array; each entry is a URL string or `{ url, name?, platform? }`.
 */
export function readLinks(root: string): SavedLink[] | { error: string } | null {
  const file = linksPath(root);
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: `${LINKS_FILE} is not valid JSON: ${(error as Error).message}` };
  }
  const entries = Array.isArray(json) ? json : isDict(json) && Array.isArray(json.links) ? json.links : undefined;
  if (!entries) return { error: `${LINKS_FILE} must look like { "links": [{ "name": "Home", "url": "myapp://home" }] }.` };

  const links: SavedLink[] = [];
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    const n = index + 1;
    if (typeof entry === "string") entry = { url: entry };
    if (!isDict(entry) || typeof entry.url !== "string") {
      problems.push(`entry ${n} has no "url"`);
      return;
    }
    if (!parseLinkUrl(entry.url)) problems.push(`entry ${n}: "${entry.url}" isn't a full URL with a scheme`);
    if (entry.platform !== undefined && entry.platform !== "ios" && entry.platform !== "android") {
      problems.push(`entry ${n}: "platform" must be "ios" or "android"`);
    }
    links.push({
      url: entry.url,
      name: typeof entry.name === "string" ? entry.name : undefined,
      platform: entry.platform as Platform | undefined,
    });
  });
  return problems.length ? { error: `${LINKS_FILE} has problems: ${problems.join("; ")}.` } : links;
}

/** Write the links, keeping any other top-level keys already in the file. */
export function writeLinks(root: string, links: SavedLink[]): void {
  const file = linksPath(root);
  let existing: Record<string, unknown> = {};
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isDict(json)) existing = json;
  } catch {
    // new file, or a bare array that becomes { "links": [...] }
  }
  const entries = links.map(({ name, url, platform }) => ({ ...(name && { name }), url, ...(platform && { platform }) }));
  writeFileSync(file, `${JSON.stringify({ ...existing, links: entries }, null, 2)}\n`);
}

/** Find a saved link by its number in the list (1-based), URL or name. */
export function findLink(links: SavedLink[], target: string): number {
  const n = Number(target);
  if (Number.isInteger(n) && n >= 1 && n <= links.length) return n - 1;
  const byUrl = links.findIndex((l) => l.url === target);
  return byUrl >= 0 ? byUrl : links.findIndex((l) => l.name?.toLowerCase() === target.toLowerCase());
}

function samplePath(p: LinkPattern): string {
  if (!p.path) return p.kind === "scheme" ? "" : "/";
  switch (p.pathType) {
    case "path":
      return p.path;
    case "pathPrefix":
      return p.path.endsWith("/") ? `${p.path}example` : `${p.path}/example`;
    case "pathSuffix":
      return `/example${p.path}`;
    default:
      return "/";
  }
}

/** One example URL per link pattern the app declares, for `links init`. */
export function suggestLinks(scan: ScanResult): SavedLink[] {
  const links = new Map<string, SavedLink>();
  const own = scan.patterns.filter((p) => !p.thirdParty);
  for (const p of own.filter((p) => p.kind !== "universal")) {
    const host = p.host?.replace(/^\*\./, "www.");
    const url = `${p.scheme}://${host ?? ""}${host ? samplePath(p) : ""}`;
    const name = p.kind === "scheme" ? `${p.scheme}:// scheme` : `App Link ${host}${p.path ?? ""}`;
    if (!links.has(url)) links.set(url, { name, url });
  }
  // Universal link hosts without an Android sample get the site root.
  for (const p of own.filter((p) => p.kind === "universal")) {
    const host = p.host!.replace(/^\*\./, "www.");
    if ([...links.keys()].some((url) => parseLinkUrl(url)?.host === host)) continue;
    links.set(`https://${host}/`, { name: `Universal link ${host}`, url: `https://${host}/` });
  }
  return [...links.values()];
}
