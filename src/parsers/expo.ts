import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding, LinkPattern } from "../types.js";
import { unique } from "../util/fs.js";
import { PATH_TYPES, checkIntentFilter } from "./android.js";
import { ASSOCIATED_DOMAINS_KEY, isDict, isValidScheme, parseAssociatedDomain, suggestScheme } from "./ios.js";
import { thirdPartyScheme } from "./known.js";

export interface ExpoScan {
  /** The config file links come from: app.json or app.config.(ts|js|mjs|cjs). */
  configFile: string;
  ios: { bundleId?: string; teamId?: string; patterns: LinkPattern[] };
  android: { packageName?: string; patterns: LinkPattern[] };
  findings: Finding[];
}

type Dict = Record<string, unknown>;

const DYNAMIC_CONFIGS = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"];
const ACTION_PREFIX = "android.intent.action.";
const CATEGORY_PREFIX = "android.intent.category.";
const DATA_KEYS = new Set<string>([...PATH_TYPES, "scheme", "host", "port", "mimeType"]);

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function isExpoProject(root: string): boolean {
  if (DYNAMIC_CONFIGS.some((f) => existsSync(join(root, f)))) return true;
  try {
    const pkg = readJson(join(root, "package.json"));
    if (isDict(pkg) && [pkg.dependencies, pkg.devDependencies].some((deps) => isDict(deps) && "expo" in deps)) return true;
  } catch {
    // no package.json or not JSON
  }
  try {
    const app = readJson(join(root, "app.json"));
    return isDict(app) && isDict(app.expo);
  } catch {
    return false;
  }
}

/** Find the project's own Expo CLI, walking up for hoisted node_modules in monorepos. */
function findExpoCli(root: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const pkgFile = join(dir, "node_modules", "expo", "package.json");
    if (existsSync(pkgFile)) {
      const pkg = readJson(pkgFile);
      const bin = isDict(pkg) && isDict(pkg.bin) ? str(pkg.bin.expo) : undefined;
      const cli = join(dirname(pkgFile), bin ?? "bin/cli");
      return existsSync(cli) ? cli : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Load the Expo config. Dynamic configs are evaluated with the project's own `expo config --json`
 * rather than by running the file here, so plugins, env vars and TypeScript work as in a real build.
 */
export function loadExpoConfig(root: string): { config: Dict; file: string } | Finding {
  const dynamic = DYNAMIC_CONFIGS.find((f) => existsSync(join(root, f)));
  if (dynamic) {
    const cli = findExpoCli(root);
    if (!cli) {
      return {
        level: "error",
        message: `${dynamic} is a dynamic config, and reading it needs the project's own Expo CLI, which isn't installed.`,
        fix: "Install the project's dependencies (npm install, yarn, pnpm install or bun install), then scan again.",
        source: dynamic,
      };
    }
    try {
      const stdout = execFileSync(process.execPath, [cli, "config", "--json"], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, EXPO_NO_TELEMETRY: "1", CI: "1" },
      });
      const config: unknown = JSON.parse(stdout.slice(stdout.indexOf("{")));
      if (isDict(config)) return { config, file: dynamic };
      throw new Error("expo config did not print an object");
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").slice(-3).join(" ");
      return {
        level: "error",
        message: `\`expo config\` could not evaluate ${dynamic}${stderr ? `: ${stderr}` : "."}`,
        fix: "Run `npx expo config` in the project to see the full error.",
        source: dynamic,
      };
    }
  }

  try {
    const app = readJson(join(root, "app.json"));
    if (!isDict(app)) throw new Error("not an object");
    return { config: isDict(app.expo) ? app.expo : app, file: "app.json" };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      level: "error",
      message: missing ? "This is an Expo project, but it has no app.json or app.config file." : `app.json is not valid JSON: ${(error as Error).message}`,
      fix: missing ? "Create app.json with your app's name, slug and scheme." : "Fix the JSON syntax in app.json.",
      source: "app.json",
    };
  }
}

/** Read link config from an evaluated Expo config. */
export function parseExpoConfig(config: Dict, file: string): ExpoScan {
  const ios = isDict(config.ios) ? config.ios : {};
  const android = isDict(config.android) ? config.android : {};
  const bundleId = str(ios.bundleIdentifier);
  const packageName = str(android.package);
  const findings: Finding[] = [];
  const iosPatterns: LinkPattern[] = [];
  const androidPatterns: LinkPattern[] = [];

  // Schemes: the top-level `scheme` is merged with ios.scheme / android.scheme.
  const shared = strings(config.scheme);
  const iosSchemes = unique([...shared, ...strings(ios.scheme)]);
  const androidSchemes = unique([...shared, ...strings(android.scheme)]);
  for (const scheme of unique([...iosSchemes, ...androidSchemes])) {
    if (isValidScheme(scheme)) continue;
    const suggestion = suggestScheme(scheme);
    findings.push({
      level: "error",
      message: `Scheme "${scheme}" in ${file} is not valid, so the app won't register it.`,
      fix: `Use only the scheme name${suggestion ? ` ("${suggestion}")` : ""}, without "://", spaces or other punctuation.`,
      source: file,
    });
  }
  for (const scheme of iosSchemes.filter(isValidScheme)) {
    iosPatterns.push({ platform: "ios", kind: "scheme", scheme, thirdParty: thirdPartyScheme(scheme), source: file });
  }
  for (const scheme of androidSchemes.filter(isValidScheme)) {
    androidPatterns.push({ platform: "android", kind: "scheme", scheme, thirdParty: thirdPartyScheme(scheme), source: file });
  }
  // Prebuild also registers the bundle ID as a scheme on iOS.
  if (bundleId && !iosSchemes.includes(bundleId)) {
    iosPatterns.push({ platform: "ios", kind: "scheme", scheme: bundleId, thirdParty: "Bundle ID", source: file });
  }
  const infoPlist = isDict(ios.infoPlist) ? ios.infoPlist : {};
  const urlTypes = Array.isArray(infoPlist.CFBundleURLTypes) ? infoPlist.CFBundleURLTypes.filter(isDict) : [];
  for (const scheme of unique(urlTypes.flatMap((t) => strings(t.CFBundleURLSchemes)))) {
    if (!isValidScheme(scheme) || iosPatterns.some((p) => p.scheme === scheme)) continue;
    iosPatterns.push({ platform: "ios", kind: "scheme", scheme, thirdParty: thirdPartyScheme(scheme), source: `${file} → ios.infoPlist` });
  }

  // Associated domains: ios.associatedDomains replaces any set in ios.entitlements.
  const entitlements = isDict(ios.entitlements) ? ios.entitlements : {};
  const domainsKey = Array.isArray(ios.associatedDomains) ? "ios.associatedDomains" : "ios.entitlements";
  const domains = strings(Array.isArray(ios.associatedDomains) ? ios.associatedDomains : entitlements[ASSOCIATED_DOMAINS_KEY]);
  for (const entry of domains) {
    const parsed = parseAssociatedDomain(entry);
    if (!parsed.ok) {
      findings.push({
        level: "error",
        message: `Associated domain "${entry}" in ${domainsKey} (${file}) is invalid: ${parsed.reason}.`,
        fix: 'Use the form "applinks:example.com" (or "applinks:*.example.com", "applinks:example.com?mode=developer").',
        source: file,
      });
      continue;
    }
    if (parsed.service !== "applinks") continue;
    iosPatterns.push({
      platform: "ios",
      kind: "universal",
      scheme: "https",
      host: parsed.host,
      note: parsed.mode && `mode=${parsed.mode}`,
      source: file,
    });
  }

  // Android intent filters. Expo prefixes action and category names itself.
  const filters = Array.isArray(android.intentFilters) ? android.intentFilters : [];
  filters.forEach((filter, index) => {
    if (!isDict(filter)) return;
    const name = `android.intentFilters[${index}]`;
    const source = `${file} → ${name}`;
    const action = str(filter.action) ?? "";
    if (action.startsWith(ACTION_PREFIX)) {
      findings.push({
        level: "error",
        message: `${name} in ${file} uses "action": "${action}". Expo adds the "${ACTION_PREFIX}" prefix itself, so this becomes "${ACTION_PREFIX}${action}" and the filter never matches.`,
        fix: `Use "action": "${action.slice(ACTION_PREFIX.length)}".`,
        source,
      });
      return;
    }
    if (action !== "VIEW") return;

    const categories: string[] = [];
    for (const category of strings(filter.category)) {
      if (!category.startsWith(CATEGORY_PREFIX)) {
        categories.push(CATEGORY_PREFIX + category);
        continue;
      }
      findings.push({
        level: "error",
        message: `${name} in ${file} uses the category "${category}". Expo adds the "${CATEGORY_PREFIX}" prefix itself, so this category is wrong in the generated manifest.`,
        fix: `Use "${category.slice(CATEGORY_PREFIX.length)}".`,
        source,
      });
    }

    const data = (Array.isArray(filter.data) ? filter.data : [filter.data]).filter(isDict);
    for (const key of unique(data.flatMap((d) => Object.keys(d)))) {
      if (DATA_KEYS.has(key)) continue;
      const known = [...DATA_KEYS].find((k) => k.toLowerCase() === key.toLowerCase());
      findings.push({
        level: "warning",
        message: `"${key}" in ${name}.data is not a data attribute Android knows, so it is ignored.`,
        fix: known ? `Did you mean "${known}"? Keys are case-sensitive.` : `Use one of: ${[...DATA_KEYS].join(", ")}.`,
        source,
      });
    }

    const result = checkIntentFilter(
      {
        name,
        source,
        categories,
        schemes: unique(data.flatMap((d) => str(d.scheme) ?? [])),
        hosts: unique(
          data.flatMap((d) => {
            const host = str(d.host);
            const port = str(d.port);
            return host ? [port ? `${host}:${port}` : host] : [];
          }),
        ),
        paths: data.flatMap((d) => PATH_TYPES.flatMap((type) => (str(d[type]) ? [{ type, value: d[type] as string }] : []))),
        autoVerify: filter.autoVerify === true,
      },
      { kind: "expo", file },
    );
    androidPatterns.push(...result.patterns);
    findings.push(...result.findings);
  });

  for (const p of androidPatterns) if (p.kind === "scheme" && p.scheme === packageName) p.thirdParty ??= "Package name";

  return {
    configFile: file,
    ios: { bundleId, teamId: str(ios.appleTeamId), patterns: iosPatterns },
    android: { packageName, patterns: androidPatterns },
    findings,
  };
}

/** Scan an Expo project's config. Returns null when the project doesn't use Expo. */
export function parseExpo(root: string): ExpoScan | null {
  if (!isExpoProject(root)) return null;
  const loaded = loadExpoConfig(root);
  if ("config" in loaded) return parseExpoConfig(loaded.config, loaded.file);
  return {
    configFile: loaded.source ?? "app.json",
    ios: { patterns: [] },
    android: { patterns: [] },
    findings: [loaded],
  };
}
