import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parsePlist, parseBinary, parseOpenStep } from "plist";
import type { Finding, LinkPattern } from "../types.js";
import { unique, walk } from "../util/fs.js";
import { thirdPartyScheme } from "./known.js";

export interface IosScan {
  bundleIds: string[];
  teamIds: string[];
  patterns: LinkPattern[];
  findings: Finding[];
}

export interface BuildConfig {
  name: string;
  settings: Record<string, string>;
}

export interface XcodeTarget {
  name: string;
  productType: string;
  configs: BuildConfig[];
}

type Dict = Record<string, unknown>;

const APP_PRODUCT_TYPE = "com.apple.product-type.application";
export const ASSOCIATED_DOMAINS_KEY = "com.apple.developer.associated-domains";
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const TEST_PATH_RE = /(^|[\\/])[^\\/]*Tests([\\/]|$)/;

export const isValidScheme = (scheme: string) => SCHEME_RE.test(scheme);

/** A valid spelling for an invalid scheme, e.g. `myapp` for `myapp://`. */
export const suggestScheme = (scheme: string) => scheme.replace(/:.*$/, "").replace(/[^A-Za-z0-9+.-]/g, "");

export const isDict = (value: unknown): value is Dict =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

/**
 * Read the native targets of a project.pbxproj file. Each target's build settings are merged
 * over the project-level settings of the same configuration, as Xcode does.
 */
export function parseXcodeProject(text: string): XcodeTarget[] {
  const root = parseOpenStep(text);
  if (!isDict(root) || !isDict(root.objects)) return [];
  const objects: Dict = root.objects;
  const object = (id: unknown): Dict | undefined => {
    const value = typeof id === "string" ? objects[id] : undefined;
    return isDict(value) ? value : undefined;
  };
  const configsOf = (listId: unknown): BuildConfig[] => {
    const ids = object(listId)?.buildConfigurations;
    return (Array.isArray(ids) ? ids : []).flatMap((id) => {
      const config = object(id);
      return config ? [{ name: String(config.name ?? ""), settings: stringSettings(config.buildSettings) }] : [];
    });
  };

  const projectConfigs = configsOf(object(root.rootObject)?.buildConfigurationList);
  return Object.values(objects)
    .filter(isDict)
    .filter((entry) => entry.isa === "PBXNativeTarget")
    .map((target) => {
      const name = String(target.name ?? "");
      const configs = configsOf(target.buildConfigurationList).map((config) => ({
        name: config.name,
        settings: {
          TARGET_NAME: name,
          PRODUCT_NAME: "$(TARGET_NAME)",
          ...projectConfigs.find((p) => p.name === config.name)?.settings,
          ...config.settings,
        },
      }));
      return { name, productType: String(target.productType ?? ""), configs };
    });
}

function stringSettings(value: unknown): Record<string, string> {
  if (!isDict(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Expand `$(VAR)` and `$(VAR:rfc1034identifier)` using other settings from the same configuration. */
export function resolveBuildSetting(value: string, settings: Record<string, string>, depth = 0): string {
  if (depth > 5) return value;
  return value.replace(/\$[({]([A-Za-z0-9_]+)(?::([a-z0-9]+))?[)}]/g, (whole, name: string, modifier?: string) => {
    const raw = settings[name];
    if (raw === undefined) return whole;
    let resolved = resolveBuildSetting(raw, settings, depth + 1);
    if (/\$[({]/.test(resolved)) return whole;
    if (modifier === "rfc1034identifier") resolved = resolved.replace(/[^A-Za-z0-9.-]/g, "-");
    return resolved;
  });
}

export type AssociatedDomain =
  | { ok: true; service: string; host: string; mode?: string }
  | { ok: false; reason: string };

/** Parse an entry such as `applinks:example.com?mode=developer`. */
export function parseAssociatedDomain(entry: string): AssociatedDomain {
  const value = entry.trim();
  if (value.includes("://")) return { ok: false, reason: "it includes a URL scheme like https://" };
  const colon = value.indexOf(":");
  if (colon <= 0) return { ok: false, reason: "it is missing a service prefix such as applinks:" };
  const service = value.slice(0, colon);
  const [host = "", query] = value.slice(colon + 1).split("?", 2);
  if (host.includes("/")) return { ok: false, reason: "it includes a path, but only the domain is allowed" };
  if (!/^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?$/.test(host)) {
    return { ok: false, reason: `"${host}" is not a valid domain` };
  }
  if (query === undefined) return { ok: true, service, host };
  const mode = /^mode=(developer|managed|developer\+managed)$/.exec(query)?.[1];
  if (!mode) return { ok: false, reason: `"?${query}" is not a known option (use ?mode=developer)` };
  return { ok: true, service, host, mode };
}

const stripSrcRoot = (path: string) => path.replace(/^\$[({](SRCROOT|PROJECT_DIR)[)}]\//, "");

export function parseIos(root: string): IosScan | null {
  const iosDir = join(root, "ios");
  const files = walk(iosDir);
  if (files.length === 0) return null;

  const rel = (file: string) => relative(root, file);
  const patterns: LinkPattern[] = [];
  const findings: Finding[] = [];
  const bundleIds = new Set<string>();
  const teamIds = new Set<string>();

  const plistCache = new Map<string, Dict | null>();
  const readPlist = (file: string): Dict | null => {
    if (!plistCache.has(file)) {
      let parsed: Dict | null = null;
      if (existsSync(file)) {
        try {
          const data = readFileSync(file);
          const value = data.subarray(0, 6).toString() === "bplist" ? parseBinary(data) : parsePlist(data.toString("utf8"));
          parsed = isDict(value) ? value : null;
        } catch {
          findings.push({
            level: "error",
            message: `${rel(file)} could not be read as a property list.`,
            fix: `Run \`plutil -lint ${rel(file)}\` to find the syntax error.`,
            source: rel(file),
          });
        }
      }
      plistCache.set(file, parsed);
    }
    return plistCache.get(file) ?? null;
  };

  const readAssociatedDomains = (file: string, report: boolean) => {
    const entries = readPlist(file)?.[ASSOCIATED_DOMAINS_KEY];
    const domains: { host: string; mode?: string }[] = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry !== "string") continue;
      const parsed = parseAssociatedDomain(entry);
      if (!parsed.ok) {
        if (report) {
          findings.push({
            level: "error",
            message: `Associated domain "${entry}" in ${rel(file)} is invalid: ${parsed.reason}.`,
            fix: "Use the form applinks:example.com (or applinks:*.example.com, applinks:example.com?mode=developer).",
            source: rel(file),
          });
        }
        continue;
      }
      if (parsed.service === "applinks") domains.push({ host: parsed.host, mode: parsed.mode });
    }
    return domains;
  };

  const universalPattern = (host: string, mode: string | undefined, source: string, note?: string): LinkPattern => ({
    platform: "ios",
    kind: "universal",
    scheme: "https",
    host,
    source,
    note: [mode && `mode=${mode}`, note].filter(Boolean).join(", ") || undefined,
  });

  // App targets and their build configurations, read from the Xcode project.
  const targets: { infoPlist: string; srcRoot: string; configs: BuildConfig[] }[] = [];
  const referencedEntitlements = new Set<string>();
  for (const pbxproj of files.filter((f) => basename(f) === "project.pbxproj")) {
    const srcRoot = dirname(dirname(pbxproj));
    let xcodeTargets: XcodeTarget[];
    try {
      xcodeTargets = parseXcodeProject(readFileSync(pbxproj, "utf8"));
    } catch {
      findings.push({
        level: "warning",
        message: `${rel(pbxproj)} could not be parsed, so bundle IDs and entitlements were guessed from files on disk.`,
        fix: "Open the project in Xcode to check it is not corrupted (e.g. by a merge conflict).",
        source: rel(pbxproj),
      });
      continue;
    }
    for (const target of xcodeTargets) {
      for (const config of target.configs) {
        const entitlements = config.settings.CODE_SIGN_ENTITLEMENTS;
        if (entitlements) referencedEntitlements.add(resolve(srcRoot, stripSrcRoot(resolveBuildSetting(entitlements, config.settings))));
      }
      if (target.productType !== APP_PRODUCT_TYPE) continue;
      const infoPlist = target.configs.map((c) => c.settings.INFOPLIST_FILE && resolveBuildSetting(c.settings.INFOPLIST_FILE, c.settings)).find(Boolean);
      targets.push({ infoPlist: infoPlist ? resolve(srcRoot, stripSrcRoot(infoPlist)) : "", srcRoot, configs: target.configs });
    }
  }
  const haveXcodeProject = targets.length > 0;

  // Without a readable Xcode project, fall back to any app Info.plist on disk.
  if (!haveXcodeProject) {
    for (const file of files) {
      if (basename(file) !== "Info.plist" || TEST_PATH_RE.test(rel(file))) continue;
      const info = readPlist(file);
      if (info && !info.NSExtension) targets.push({ infoPlist: file, srcRoot: iosDir, configs: [] });
    }
  }

  for (const target of targets) {
    const info = target.infoPlist ? readPlist(target.infoPlist) : null;
    const plistSource = target.infoPlist ? rel(target.infoPlist) : "ios";

    // Bundle and team IDs
    const ids = new Set<string>();
    for (const config of target.configs) {
      const { PRODUCT_BUNDLE_IDENTIFIER: id, DEVELOPMENT_TEAM: team } = config.settings;
      if (id) ids.add(resolveBuildSetting(id, config.settings));
      if (team && !team.includes("$")) teamIds.add(team);
    }
    if (ids.size === 0 && typeof info?.CFBundleIdentifier === "string") ids.add(info.CFBundleIdentifier);
    for (const id of ids) {
      if (!/\$[({]/.test(id)) bundleIds.add(id);
      else {
        findings.push({
          level: "info",
          message: `Bundle ID "${id}" uses a build variable that could not be resolved.`,
          fix: "Check PRODUCT_BUNDLE_IDENTIFIER in Xcode → target → Build Settings.",
          source: plistSource,
        });
      }
    }

    // Custom URL schemes
    const seenSchemes = new Set<string>();
    const urlTypes = Array.isArray(info?.CFBundleURLTypes) ? info.CFBundleURLTypes.filter(isDict) : [];
    for (const urlType of urlTypes) {
      const rawSchemes = Array.isArray(urlType.CFBundleURLSchemes) ? urlType.CFBundleURLSchemes : [];
      for (const raw of rawSchemes) {
        if (typeof raw !== "string") continue;
        const schemes = target.configs.length ? unique(target.configs.map((c) => resolveBuildSetting(raw, c.settings))) : [raw];
        for (const scheme of schemes) {
          if (seenSchemes.has(scheme)) continue;
          seenSchemes.add(scheme);
          if (/\$[({]/.test(scheme)) continue;
          if (!isValidScheme(scheme)) {
            const suggestion = suggestScheme(scheme);
            findings.push({
              level: "error",
              message: `URL scheme "${scheme}" in ${plistSource} is not valid, so iOS ignores it.`,
              fix: `List only the scheme name${suggestion ? ` ("${suggestion}")` : ""}, without "://", spaces or other punctuation.`,
              source: plistSource,
            });
            continue;
          }
          patterns.push({ platform: "ios", kind: "scheme", scheme, thirdParty: thirdPartyScheme(scheme), source: plistSource });
        }
      }
    }

    // Associated domains, per build configuration
    if (target.configs.length === 0) continue;
    const configsByFile = new Map<string, string[]>();
    const hostsByConfig = new Map<string, Set<string>>();
    for (const config of target.configs) {
      hostsByConfig.set(config.name, new Set());
      const setting = config.settings.CODE_SIGN_ENTITLEMENTS;
      if (!setting) continue;
      const file = resolve(target.srcRoot, stripSrcRoot(resolveBuildSetting(setting, config.settings)));
      configsByFile.set(file, [...(configsByFile.get(file) ?? []), config.name]);
    }
    const domainInfo = new Map<string, { mode?: string; source: string }>();
    for (const [file, configNames] of configsByFile) {
      if (!existsSync(file)) {
        findings.push({
          level: "error",
          message: `The ${configNames.join(" and ")} build points to ${rel(file)} for entitlements, but that file does not exist.`,
          fix: "Fix the Code Signing Entitlements path in Xcode → target → Build Settings, or re-add the Associated Domains capability.",
          source: rel(file),
        });
        continue;
      }
      for (const domain of readAssociatedDomains(file, true)) {
        for (const name of configNames) hostsByConfig.get(name)?.add(domain.host);
        if (!domainInfo.has(domain.host)) domainInfo.set(domain.host, { mode: domain.mode, source: rel(file) });
      }
    }
    for (const [host, { mode, source }] of domainInfo) {
      const inConfigs = target.configs.filter((c) => hostsByConfig.get(c.name)?.has(host)).map((c) => c.name);
      const note = inConfigs.length < target.configs.length ? `only in ${inConfigs.join(", ")}` : undefined;
      patterns.push(universalPattern(host, mode, source, note));
    }
    const withLinks = target.configs.filter((c) => hostsByConfig.get(c.name)?.size).map((c) => c.name);
    const withoutLinks = target.configs.filter((c) => !hostsByConfig.get(c.name)?.size).map((c) => c.name);
    if (withLinks.length && withoutLinks.length) {
      findings.push({
        level: "warning",
        message: `Universal links are set up for the ${withLinks.join(", ")} build but not ${withoutLinks.join(", ")}, so they won't open the app in ${withoutLinks.join(", ")}.`,
        fix: "In Xcode → target → Build Settings, set Code Signing Entitlements to the same .entitlements file for every configuration (or add Associated Domains under Signing & Capabilities → All).",
        source: plistSource,
      });
    }
  }

  // Entitlements files no build configuration uses.
  for (const file of files) {
    if (!file.endsWith(".entitlements") || TEST_PATH_RE.test(rel(file)) || referencedEntitlements.has(file)) continue;
    if (!haveXcodeProject) {
      for (const domain of readAssociatedDomains(file, true)) patterns.push(universalPattern(domain.host, domain.mode, rel(file)));
    } else if (readAssociatedDomains(file, false).length) {
      findings.push({
        level: "warning",
        message: `${rel(file)} lists associated domains, but no build configuration uses this file, so they are ignored.`,
        fix: "Point Code Signing Entitlements in Build Settings at this file, or move its domains into the entitlements file your app target uses.",
        source: rel(file),
      });
    }
  }

  // Expo prebuild (and some OAuth SDKs) register the bundle ID as a scheme.
  for (const p of patterns) if (p.kind === "scheme" && bundleIds.has(p.scheme)) p.thirdParty ??= "Bundle ID";

  if (teamIds.size === 0 && patterns.some((p) => p.kind === "universal")) {
    findings.push({
      level: "info",
      message: "No DEVELOPMENT_TEAM found in the Xcode project. The team ID is needed to check the appID in apple-app-site-association.",
      fix: "Pick a team in Xcode → target → Signing & Capabilities.",
    });
  }

  return { bundleIds: [...bundleIds], teamIds: [...teamIds], patterns, findings };
}
