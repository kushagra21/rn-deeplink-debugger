import { isDict } from "../parsers/ios.js";
import type { Check } from "../types.js";
import { describeFailure, formatSize, servedChecks, type FetchedFile } from "./fetch.js";

/** One path rule from `components` (iOS 13+) or the older `paths` array. */
export interface AasaRule {
  path?: string;
  query?: string | Record<string, string>;
  fragment?: string;
  exclude: boolean;
  caseSensitive: boolean;
  percentEncoded: boolean;
}

export interface AasaApp {
  appId: string;
  rules: AasaRule[];
}

export interface UrlParts {
  path: string;
  query: string;
  fragment: string;
}

/** A path the app is expected to open, and why. */
export interface ExpectedPath {
  /** Concrete path to test, e.g. `/product/example`. */
  sample: string;
  /** Rule to suggest adding, e.g. `/product*`. */
  suggest: string;
  reason: string;
}

export interface AasaExpectations {
  appIds: string[];
  bundleIds: string[];
  paths: ExpectedPath[];
}

export const AASA_MAX_BYTES = 128 * 1024;
const APP_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;
const EXAMPLE = '{ "applinks": { "details": [{ "appIDs": ["ABCDE12345.com.example.app"], "components": [{ "/": "/*" }] }] } }';

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

function componentRule(component: unknown): AasaRule | undefined {
  if (!isDict(component)) return undefined;
  const query = component["?"];
  return {
    path: str(component["/"]),
    query:
      typeof query === "string"
        ? query
        : isDict(query)
          ? Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === "string"))
          : undefined,
    fragment: str(component["#"]),
    exclude: component.exclude === true,
    caseSensitive: component.caseSensitive !== false,
    percentEncoded: component.percentEncoded !== false,
  };
}

function pathRule(path: string): AasaRule {
  const exclude = path.startsWith("NOT ");
  return { path: exclude ? path.slice(4) : path, exclude, caseSensitive: true, percentEncoded: true };
}

/** Read the apps and their rules from an AASA file, reporting structural problems. */
export function readAasaApps(json: unknown): { apps: AasaApp[]; problems: Check[] } {
  const problem = (message: string, fix = `Use this shape: ${EXAMPLE}`) => ({ apps: [], problems: [{ level: "error" as const, message, fix }] });
  if (!isDict(json)) return problem("The file is not a JSON object.");
  if (!isDict(json.applinks)) return problem('The file has no "applinks" section, so iOS won\'t open any links from this domain.');
  const details = json.applinks.details;
  if (!Array.isArray(details)) return problem('"applinks.details" is missing or not an array.');

  const apps: AasaApp[] = [];
  const problems: Check[] = [];
  for (const entry of details) {
    if (!isDict(entry)) continue;
    const ids = Array.isArray(entry.appIDs) ? entry.appIDs.filter((id): id is string => typeof id === "string") : str(entry.appID) ? [entry.appID as string] : [];
    if (ids.length === 0) {
      problems.push({ level: "error", message: 'An entry in applinks.details has no "appIDs" (or "appID"), so it applies to no app.', fix: `Use this shape: ${EXAMPLE}` });
      continue;
    }
    const rules = Array.isArray(entry.components)
      ? entry.components.flatMap((c) => componentRule(c) ?? [])
      : Array.isArray(entry.paths)
        ? entry.paths.flatMap((p) => (typeof p === "string" ? [pathRule(p)] : []))
        : [];
    for (const appId of ids) {
      if (!APP_ID_RE.test(appId)) {
        problems.push({
          level: "error",
          message: `"${appId}" is not a valid app ID.`,
          fix: "It must be <team ID>.<bundle ID>, e.g. ABCDE12345.com.example.app, where the team ID is the 10-character ID from developer.apple.com → Membership.",
        });
      }
      apps.push({ appId, rules });
    }
  }
  return { apps, problems };
}

function wildcard(pattern: string, value: string, caseSensitive: boolean): boolean {
  const source = [...pattern].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`, caseSensitive ? "s" : "is").test(value);
}

export function urlParts(url: string): UrlParts {
  const parsed = new URL(url, "https://placeholder.invalid");
  return { path: parsed.pathname, query: parsed.search.slice(1), fragment: parsed.hash.slice(1) };
}

export function ruleMatches(rule: AasaRule, url: UrlParts): boolean {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const value = (part: string) => (rule.percentEncoded ? part : decode(part));
  const cs = rule.caseSensitive;
  if (rule.path !== undefined && !wildcard(rule.path, value(url.path), cs)) return false;
  if (rule.fragment !== undefined && !wildcard(rule.fragment, value(url.fragment), cs)) return false;
  if (typeof rule.query === "string") return wildcard(rule.query, value(url.query), cs);
  if (rule.query) {
    const params = new URLSearchParams(url.query);
    for (const [key, pattern] of Object.entries(rule.query)) {
      const param = params.get(key);
      if (param === null || !wildcard(pattern, param, cs)) return false;
    }
  }
  return true;
}

/** iOS uses the first rule that matches; an `exclude` rule means the URL stays in the browser. */
export function firstMatchingRule(rules: AasaRule[], url: UrlParts): AasaRule | undefined {
  return rules.find((rule) => ruleMatches(rule, url));
}

export function describeRule(rule: AasaRule): string {
  const parts = [rule.path !== undefined && `"/": "${rule.path}"`, rule.query !== undefined && `"?": ${JSON.stringify(rule.query)}`, rule.fragment !== undefined && `"#": "${rule.fragment}"`];
  return `{ ${parts.filter(Boolean).join(", ")}${rule.exclude ? ", exclude" : ""} }`;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (isDict(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export function checkAasa(files: { wellKnown: FetchedFile; root: FetchedFile; cdn?: FetchedFile }, expected: AasaExpectations): Check[] {
  const checks: Check[] = [];

  // iOS fetches /.well-known/ first and falls back to the root.
  let file = files.wellKnown;
  const wellKnown = servedChecks(files.wellKnown, "iOS");
  if (wellKnown.usable) checks.push(...wellKnown.checks);
  else {
    const root = servedChecks(files.root, "iOS");
    if (!root.usable) return [...wellKnown.checks, { level: "info", message: `Also not served at ${files.root.url} (${describeFailure(files.root)}).` }];
    file = files.root;
    checks.push(
      {
        level: "info",
        message: `Not served at /.well-known/apple-app-site-association (${describeFailure(files.wellKnown)}), but found at the domain root. This works, but Apple recommends /.well-known/.`,
      },
      ...root.checks,
    );
  }
  if ((file.size ?? 0) > AASA_MAX_BYTES) {
    checks.push({
      level: "error",
      message: `The file is ${formatSize(file.size ?? 0)}, and iOS ignores files over 128 KB (uncompressed).`,
      fix: "Shorten it with wildcards, and remove entries for apps you no longer ship.",
    });
  }

  // Devices read the file from Apple's CDN, not from your server.
  const cdn = files.cdn;
  const cdnFix =
    "Wait for Apple's CDN to refresh. While developing, add ?mode=developer to the associated domain (applinks:example.com?mode=developer) and turn on Associated Domains Development under Settings → Developer, so the device fetches from your server.";
  if (cdn?.networkError) checks.push({ level: "info", message: `Couldn't reach Apple's CDN to compare: ${cdn.networkError}.` });
  else if (cdn?.status === 404) {
    checks.push({
      level: "warning",
      message: "Apple's CDN has no copy of this file. Devices get the file from the CDN, so universal links won't work until it picks the file up.",
      fix: cdnFix,
    });
  } else if (cdn?.status === 200 && cdn.json !== undefined) {
    if (stable(cdn.json) === stable(file.json)) checks.push({ level: "pass", message: "Apple's CDN has the same version as your server" });
    else {
      checks.push({
        level: "warning",
        message: "Apple's CDN has a different (likely older) version than your server, so devices use the old rules until it refreshes, which can take a day or more.",
        fix: cdnFix,
      });
    }
  } else if (cdn) checks.push({ level: "info", message: `Apple's CDN answered ${describeFailure(cdn)}, so its copy couldn't be compared.` });

  const { apps, problems } = readAasaApps(file.json);
  checks.push(...problems);
  if (apps.length === 0) return checks;
  const listed = apps.map((a) => a.appId).join(", ");

  let targets: AasaApp[];
  if (expected.appIds.length) {
    targets = apps.filter((a) => expected.appIds.includes(a.appId));
    if (targets.length === 0) {
      const sameBundle = apps.filter((a) => expected.bundleIds.includes(a.appId.slice(11)));
      checks.push(
        sameBundle.length
          ? {
              level: "error",
              message: `The file lists ${sameBundle.map((a) => a.appId).join(", ")}, but your app is ${expected.appIds.join(" / ")}, so the team ID doesn't match.`,
              fix: `Use the team ID from your Xcode project: "${expected.appIds[0]}".`,
            }
          : {
              level: "error",
              message: `The file doesn't list your app (${expected.appIds.join(" / ")}). It lists: ${listed}.`,
              fix: `Add an entry to applinks.details with "appIDs": ["${expected.appIds[0]}"] and the paths that should open the app.`,
            },
      );
      return checks;
    }
    checks.push({ level: "pass", message: `Lists your app ${targets.map((a) => a.appId).join(", ")}` });
  } else if (expected.bundleIds.length) {
    targets = apps.filter((a) => expected.bundleIds.includes(a.appId.slice(11)));
    if (targets.length === 0) {
      checks.push({
        level: "error",
        message: `The file doesn't list your bundle ID (${expected.bundleIds.join(", ")}). It lists: ${listed}.`,
        fix: `Add an entry to applinks.details with "appIDs": ["<team ID>.${expected.bundleIds[0]}"].`,
      });
      return checks;
    }
    checks.push({ level: "pass", message: `Lists ${targets.map((a) => a.appId).join(", ")} (team ID not checked: the project has none; pass --team-id)` });
  } else {
    targets = apps;
    checks.push({ level: "info", message: `Lists ${listed}. Run this in your project, or pass --team-id and --bundle-id, to check it's your app.` });
  }

  for (const app of targets) {
    if (app.rules.length === 0) {
      checks.push({
        level: "error",
        message: `The entry for ${app.appId} has no "components" or "paths", so no URL opens the app.`,
        fix: 'Add "components": [{ "/": "/*" }] to open every path, or list the paths that should open the app.',
      });
    } else if (app.rules.every((r) => r.exclude)) {
      checks.push({
        level: "error",
        message: `Every rule for ${app.appId} excludes paths, so no URL opens the app.`,
        fix: 'Add a rule that includes paths after the exclusions, e.g. { "/": "/*" }.',
      });
    }
  }

  for (const { sample, suggest, reason } of expected.paths) {
    // Apps with the same outcome share one line, so files listing many app IDs stay readable.
    const outcomes = new Map<string, { rule?: AasaRule; appIds: string[] }>();
    for (const app of targets) {
      if (app.rules.length === 0) continue;
      const rule = firstMatchingRule(app.rules, urlParts(sample));
      const key = rule ? `${rule.exclude}:${describeRule(rule)}` : "none";
      const outcome = outcomes.get(key) ?? { rule, appIds: [] };
      outcome.appIds.push(app.appId);
      outcomes.set(key, outcome);
    }
    for (const { rule, appIds } of outcomes.values()) {
      const apps = appIds.length === targets.length && targets.length > 1 ? "every listed app" : appIds.join(", ");
      if (rule && !rule.exclude) {
        checks.push({ level: "pass", message: `${sample} opens the app (${describeRule(rule)})` });
        continue;
      }
      checks.push({
        level: "error",
        message: rule ? `${sample} is excluded for ${apps} by ${describeRule(rule)}, but ${reason}.` : `${sample} doesn't match any rule for ${apps}, but ${reason}.`,
        fix: rule
          ? "Move the exclusion below a rule that includes this path, or narrow it. iOS uses the first rule that matches."
          : `Add { "/": "${suggest}" } to "components" (or "${suggest}" to "paths") for ${appIds.length > 1 ? "those apps" : appIds[0]}.`,
      });
    }
  }
  return checks;
}
