import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { AndroidPathType, Finding, LinkPattern } from "../types.js";
import { unique, walk } from "../util/fs.js";
import { thirdPartyScheme } from "./known.js";

export interface AndroidScan {
  packageNames: string[];
  patterns: LinkPattern[];
  findings: Finding[];
}

/** One VIEW intent filter, read from AndroidManifest.xml or from Expo's android.intentFilters. */
export interface IntentFilter {
  /** Where the filter lives, e.g. `.MainActivity` or `android.intentFilters[0]`. */
  name: string;
  source: string;
  categories: string[];
  schemes: string[];
  hosts: string[];
  paths: { type: AndroidPathType; value: string }[];
  autoVerify: boolean;
}

/** Fix suggestions are written in the syntax of the file the filter came from. */
export type FilterSyntax = { kind: "manifest" } | { kind: "expo"; file: string };

type XmlNode = Record<string, unknown>;

export const PATH_TYPES: AndroidPathType[] = ["path", "pathPrefix", "pathPattern", "pathAdvancedPattern", "pathSuffix"];
const BROWSABLE = "android.intent.category.BROWSABLE";
const DEFAULT = "android.intent.category.DEFAULT";
const ARRAY_TAGS = new Set(["activity", "activity-alias", "intent-filter", "action", "category", "data"]);
const VIEW = "android.intent.action.VIEW";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ARRAY_TAGS.has(name),
});

const nodes = (value: unknown): XmlNode[] =>
  Array.isArray(value) ? value.filter((v): v is XmlNode => typeof v === "object" && v !== null) : [];

const attr = (node: XmlNode, name: string): string | undefined => {
  const value = node[`@android:${name}`];
  return typeof value === "string" ? value : undefined;
};

const isWeb = (scheme: string) => scheme === "http" || scheme === "https";

/** Check one VIEW intent filter and expand it into link patterns. */
export function checkIntentFilter(filter: IntentFilter, syntax: FilterSyntax): { patterns: LinkPattern[]; findings: Finding[] } {
  const { name, source, categories, schemes, hosts, autoVerify } = filter;
  // Android merges all <data> elements of a filter, so repeated paths are one rule.
  const paths = [...new Map(filter.paths.map((p) => [`${p.type}:${p.value}`, p])).values()];
  const expo = syntax.kind === "expo" ? syntax.file : undefined;
  const findings: Finding[] = [];
  const add = (level: Finding["level"], message: string, fix?: string) => findings.push({ level, message, fix, source });
  const attrLabel = (key: string, value: string) => (expo ? `"${key}": "${value}"` : `android:${key}="${value}"`);
  const addCategoryFix = (category: string) =>
    expo
      ? `Add "${category}" to the filter's "category" list in ${expo}.`
      : `Add <category android:name="android.intent.category.${category}" /> to the filter.`;
  const addHostFix = expo ? `Add a "host" to the filter's "data" in ${expo}.` : 'Add <data android:host="..." /> to the filter.';

  if (schemes.length === 0) {
    add(
      "warning",
      `An intent filter in ${name} has the VIEW action but no scheme, so it never matches a link.`,
      expo ? `Add a "data" entry with a "scheme" to the filter in ${expo}.` : 'Add <data android:scheme="..." /> to the filter.',
    );
    return { patterns: [], findings };
  }

  const webSchemes = schemes.filter(isWeb);
  const label = schemes.map((s) => `${s}://`).join(", ");

  if (!categories.includes(BROWSABLE)) {
    add("warning", `The ${label} intent filter in ${name} is missing the BROWSABLE category, so links tapped in a browser won't open the app.`, addCategoryFix("BROWSABLE"));
  }
  if (!categories.includes(DEFAULT)) {
    add("warning", `The ${label} intent filter in ${name} is missing the DEFAULT category, so Android won't match it for ordinary link taps.`, addCategoryFix("DEFAULT"));
  }
  if (webSchemes.length && hosts.length === 0) {
    add(
      "error",
      `An http(s) intent filter in ${name} has no host, so it claims every web URL and can't be verified as an App Link.`,
      expo
        ? `Add { "scheme": "https", "host": "example.com" } to the filter's "data" in ${expo} for each domain you own.`
        : 'Add <data android:host="example.com" /> for each domain you own.',
    );
  } else if (webSchemes.length && !autoVerify) {
    add(
      "warning",
      `The App Link filter for ${hosts.join(", ")} in ${name} doesn't set autoVerify, so Android won't verify it. Links open in the browser (Android 12+) or show an app chooser.`,
      expo ? `Set "autoVerify": true on the filter in ${expo}.` : 'Add android:autoVerify="true" to the <intent-filter> tag.',
    );
  }
  if (autoVerify && webSchemes.length === 0) {
    add("info", `autoVerify only applies to http/https links, so it has no effect on the ${label} filter in ${name}.`);
  }
  for (const value of [...schemes, ...hosts]) {
    if (value === value.toLowerCase() || value.includes("${")) continue;
    add(
      "warning",
      `"${value}" in ${name} has uppercase letters. Android matches intent filters case-sensitively, but links are usually lowercase, so they may not match.`,
      `Use "${value.toLowerCase()}" in ${expo ?? "the manifest"} and in your links.`,
    );
  }
  for (const { type, value } of paths) {
    const neverMatches = type === "path" || type === "pathPrefix" ? !value.startsWith("/") : type !== "pathSuffix" && /^[A-Za-z0-9]/.test(value);
    if (neverMatches) add("warning", `${attrLabel(type, value)} in ${name} doesn't start with "/", so it never matches.`, `Change it to "/${value}".`);
  }
  if (paths.length && hosts.length === 0) {
    add("warning", `Path rules in the ${label} filter in ${name} are ignored because the filter has no host.`, addHostFix);
  }

  // Android combines every scheme, host and path in one filter.
  const patterns: LinkPattern[] = [];
  for (const scheme of schemes) {
    const kind = isWeb(scheme) ? "app-link" : "scheme";
    const base: LinkPattern = {
      platform: "android",
      kind,
      scheme,
      autoVerify: kind === "app-link" ? autoVerify : undefined,
      thirdParty: kind === "scheme" ? thirdPartyScheme(scheme) : undefined,
      source,
    };
    if (hosts.length === 0) {
      patterns.push(base);
      continue;
    }
    for (const host of hosts) {
      if (paths.length === 0) patterns.push({ ...base, host });
      for (const { type, value } of paths) patterns.push({ ...base, host, path: value, pathType: type });
    }
  }
  return { patterns, findings };
}

export function parseAndroid(root: string): AndroidScan | null {
  const files = walk(join(root, "android"));
  if (files.length === 0) return null;

  const rel = (file: string) => relative(root, file);
  const patterns: LinkPattern[] = [];
  const findings: Finding[] = [];
  const packageNames = new Set<string>();
  const manifestPackages = new Set<string>();

  // Package name from the app module's Gradle file.
  const suffixes: { suffix: string; source: string }[] = [];
  for (const file of files.filter((f) => /^build\.gradle(\.kts)?$/.test(basename(f)))) {
    const gradle = readFileSync(file, "utf8");
    if (!gradle.includes("com.android.application")) continue;
    for (const m of gradle.matchAll(/\bapplicationId\s*=?\s*["']([^"']+)["']/g)) packageNames.add(m[1]!);
    for (const m of gradle.matchAll(/\bapplicationIdSuffix\s*=?\s*["']([^"']+)["']/g)) suffixes.push({ suffix: m[1]!, source: rel(file) });
  }

  const unresolved = new Set<string>();
  const resolvePlaceholders = (value: string, source: string) => {
    const appId = [...packageNames][0];
    const resolved = appId ? value.replaceAll("${applicationId}", appId) : value;
    for (const [placeholder] of resolved.matchAll(/\$\{[^}]+\}/g)) {
      if (unresolved.has(placeholder)) continue;
      unresolved.add(placeholder);
      findings.push({
        level: "info",
        message: `${source} uses the manifest placeholder ${placeholder}, which is set at build time, so it is shown unresolved.`,
        fix: "Check manifestPlaceholders in android/app/build.gradle.",
        source,
      });
    }
    return resolved;
  };

  const manifests = files.filter((f) => /[\\/]src[\\/][^\\/]+[\\/]AndroidManifest\.xml$/.test(f));
  for (const file of manifests) {
    const text = readFileSync(file, "utf8");
    const valid = XMLValidator.validate(text);
    if (valid !== true) {
      findings.push({
        level: "error",
        message: `${rel(file)} is not valid XML (line ${valid.err.line}: ${valid.err.msg}).`,
        fix: "Fix the XML syntax; the app will not build until it is valid.",
        source: rel(file),
      });
      continue;
    }
    const manifest = (xml.parse(text) as XmlNode).manifest as XmlNode | undefined;
    if (typeof manifest?.["@package"] === "string") manifestPackages.add(manifest["@package"]);
    const application = typeof manifest?.application === "object" ? (manifest.application as XmlNode) : undefined;
    const components = [...nodes(application?.activity), ...nodes(application?.["activity-alias"])];

    for (const component of components) {
      const name = attr(component, "name") ?? "(unnamed activity)";
      const source = `${rel(file)} → ${name}`;
      let reportedExported = false;

      for (const filter of nodes(component["intent-filter"])) {
        if (!nodes(filter.action).some((n) => attr(n, "name") === VIEW)) continue;
        const data = nodes(filter.data);
        const result = checkIntentFilter(
          {
            name,
            source,
            categories: nodes(filter.category).flatMap((n) => attr(n, "name") ?? []),
            schemes: unique(data.flatMap((d) => attr(d, "scheme") ?? []).map((s) => resolvePlaceholders(s, source))),
            hosts: unique(
              data.flatMap((d) => {
                const host = attr(d, "host");
                const port = attr(d, "port");
                return host ? [resolvePlaceholders(port ? `${host}:${port}` : host, source)] : [];
              }),
            ),
            paths: data.flatMap((d) =>
              PATH_TYPES.flatMap((type) => {
                const value = attr(d, type);
                return value ? [{ type, value: resolvePlaceholders(value, source) }] : [];
              }),
            ),
            autoVerify: attr(filter, "autoVerify") === "true",
          },
          { kind: "manifest" },
        );
        patterns.push(...result.patterns);
        findings.push(...result.findings);

        if (attr(component, "exported") === "false" && result.patterns.length && !reportedExported) {
          reportedExported = true;
          findings.push({
            level: "error",
            message: `${name} has android:exported="false", so links from browsers and other apps can't open it.`,
            fix: `Set android:exported="true" on ${name} in ${rel(file)}.`,
            source,
          });
        }
      }
    }
  }

  if (packageNames.size === 0) for (const pkg of manifestPackages) packageNames.add(pkg);
  for (const p of patterns) if (p.kind === "scheme" && packageNames.has(p.scheme)) p.thirdParty ??= "Package name";
  const basePackage = [...packageNames][0] ?? "<package>";
  for (const { suffix, source } of suffixes) {
    findings.push({
      level: "info",
      message: `${source} adds "${suffix}" to the package name for some builds (${basePackage}${suffix}).`,
      fix: "App Links in those builds only verify if assetlinks.json also lists that package name.",
      source,
    });
  }

  return { packageNames: [...packageNames], patterns, findings };
}
