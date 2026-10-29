import { resolve } from "node:path";
import pc from "picocolors";
import { parseAndroid } from "../parsers/android.js";
import { parseExpo } from "../parsers/expo.js";
import { parseIos } from "../parsers/ios.js";
import { formatScan, patternUrl } from "../report/format.js";
import type { Finding, FindingLevel, LinkPattern, Platform, ScanResult } from "../types.js";

export interface ScanOptions {
  cwd: string;
  json?: boolean;
}

const LEVEL_ORDER: Record<FindingLevel, number> = { error: 0, warning: 1, info: 2 };

/**
 * Scan a project root. Returns null when it is neither a native project (ios/ or android/)
 * nor an Expo project.
 *
 * When a native folder exists it decides what the current build does, so its patterns are
 * reported and the Expo config is only compared against it. Without one (Expo managed / CNG),
 * the Expo config is the source of truth.
 */
export function runScan(root: string): ScanResult | null {
  const expo = parseExpo(root);
  const ios = parseIos(root);
  const android = parseAndroid(root);
  if (!ios && !android && !expo) return null;

  const iosPatterns = ios?.patterns ?? expo?.ios.patterns ?? [];
  const androidPatterns = android?.patterns ?? expo?.android.patterns ?? [];
  const patterns = [...iosPatterns, ...androidPatterns];
  const findings = [...(expo?.findings ?? []), ...(ios?.findings ?? []), ...(android?.findings ?? [])];

  if (expo && ios) {
    findings.push(...compareWithNative("ios", expo.configFile, expo.ios.patterns, ios.patterns));
    findings.push(...compareIds("ios", expo.configFile, expo.ios.bundleId, ios.bundleIds));
  }
  if (expo && android) {
    findings.push(...compareWithNative("android", expo.configFile, expo.android.patterns, android.patterns));
    findings.push(...compareIds("android", expo.configFile, expo.android.packageName, android.packageNames));
  }
  if ((ios || expo) && (android || expo)) {
    findings.push(...compareLinks(patterns, { ios: ios ? undefined : expo?.configFile, android: android ? undefined : expo?.configFile }));
  }
  if (patterns.length === 0 && !findings.some((f) => f.level === "error")) {
    findings.push({
      level: "info",
      message: "No deep link config found: no URL schemes, associated domains or VIEW intent filters.",
    });
  }

  const optional = (value: string | undefined) => (value ? [value] : []);
  return {
    root,
    expo: expo && { configFile: expo.configFile },
    ios: ios
      ? { bundleIds: ios.bundleIds, teamIds: ios.teamIds }
      : expo && { bundleIds: optional(expo.ios.bundleId), teamIds: optional(expo.ios.teamId) },
    android: android ? { packageNames: android.packageNames } : expo && { packageNames: optional(expo.android.packageName) },
    patterns,
    findings: findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
  };
}

const PLATFORM_NAME: Record<Platform, string> = { ios: "iOS", android: "Android" };

const prebuildFix = (platform: Platform, file: string) =>
  `Run \`npx expo prebuild\` to regenerate ${platform}/. If you maintain ${platform}/ by hand instead, make the change there, because Expo only applies ${file} when it generates the native folders.`;

/** Links the Expo config sets up that the generated native folder is missing (i.e. prebuild is stale). */
export function compareWithNative(platform: Platform, file: string, config: LinkPattern[], native: LinkPattern[]): Finding[] {
  const key = (p: LinkPattern) => [p.kind, p.scheme.toLowerCase(), p.host ?? "", p.pathType ?? "", p.path ?? ""].join("|");
  const nativeKeys = new Set(native.map(key));
  const missing = config.filter((p) => !p.thirdParty && !nativeKeys.has(key(p)));
  if (missing.length === 0) return [];
  return [
    {
      level: "warning",
      message: `${file} sets up ${missing.map(patternUrl).join(", ")} for ${PLATFORM_NAME[platform]}, but ${platform}/ doesn't have ${missing.length === 1 ? "it" : "them"}, so the current native build won't open ${missing.length === 1 ? "that link" : "those links"}.`,
      fix: prebuildFix(platform, file),
      source: file,
    },
  ];
}

function compareIds(platform: Platform, file: string, configId: string | undefined, nativeIds: string[]): Finding[] {
  if (!configId || nativeIds.length === 0 || nativeIds.includes(configId)) return [];
  const [label, key] = platform === "ios" ? ["bundle ID", "ios.bundleIdentifier"] : ["package name", "android.package"];
  return [
    {
      level: "warning",
      message: `${file} sets ${key} to "${configId}", but ${platform}/ uses ${nativeIds.map((id) => `"${id}"`).join(", ")}. Association files must match the ${label} the app is actually built with.`,
      fix: prebuildFix(platform, file),
      source: file,
    },
  ];
}

/**
 * Flag links the app handles on one platform but not the other. `managed` names the Expo config
 * file for platforms without a native folder, so fixes point at the file to edit.
 */
export function compareLinks(patterns: LinkPattern[], managed: Partial<Record<Platform, string>> = {}): Finding[] {
  const own = patterns.filter((p) => !p.thirdParty);
  const collect = (filter: (p: LinkPattern) => boolean, key: (p: LinkPattern) => string | undefined) => {
    const values = new Map<string, string>();
    for (const p of own.filter(filter)) {
      const value = key(p);
      if (value) values.set(value.toLowerCase(), value);
    }
    return values;
  };
  const iosSchemes = collect((p) => p.platform === "ios" && p.kind === "scheme", (p) => p.scheme);
  const androidSchemes = collect((p) => p.platform === "android" && p.kind === "scheme", (p) => p.scheme);
  const iosHosts = collect((p) => p.kind === "universal", (p) => p.host);
  const androidHosts = collect((p) => p.kind === "app-link", (p) => p.host);

  const findings: Finding[] = [];
  for (const [key, scheme] of iosSchemes) {
    if (androidSchemes.has(key)) continue;
    findings.push({
      level: "warning",
      message: `Custom scheme "${scheme}://" is registered on iOS but not on Android.`,
      fix: managed.android
        ? `Add "${key}" to "scheme" (or "android.scheme") in ${managed.android}.`
        : `Add an intent filter with <data android:scheme="${key}" /> to the activity that handles links (usually MainActivity) in android/app/src/main/AndroidManifest.xml.`,
    });
  }
  for (const [key, scheme] of androidSchemes) {
    if (iosSchemes.has(key)) continue;
    findings.push({
      level: "warning",
      message: `Custom scheme "${scheme}://" is registered on Android but not on iOS.`,
      fix: managed.ios
        ? `Add "${key}" to "scheme" (or "ios.scheme") in ${managed.ios}.`
        : `Add "${key}" to CFBundleURLSchemes under CFBundleURLTypes in your app's Info.plist (Xcode → target → Info → URL Types).`,
    });
  }
  for (const [key, host] of iosHosts) {
    if (androidHosts.has(key)) continue;
    findings.push({
      level: "warning",
      message: `${host} is an associated domain on iOS but has no App Link intent filter on Android.`,
      fix: managed.android
        ? `Add a filter to android.intentFilters in ${managed.android}: { "action": "VIEW", "autoVerify": true, "category": ["BROWSABLE", "DEFAULT"], "data": [{ "scheme": "https", "host": "${host}" }] }.`
        : `Add an intent filter with android:autoVerify="true", <data android:scheme="https" /> and <data android:host="${host}" /> to AndroidManifest.xml.`,
    });
  }
  for (const [key, host] of androidHosts) {
    if (iosHosts.has(key)) continue;
    findings.push({
      level: "warning",
      message: `${host} has an App Link intent filter on Android but is not an associated domain on iOS.`,
      fix: managed.ios
        ? `Add "applinks:${host}" to ios.associatedDomains in ${managed.ios}.`
        : `Add "applinks:${host}" to com.apple.developer.associated-domains in your .entitlements file (Xcode → Signing & Capabilities → Associated Domains).`,
    });
  }
  return findings;
}

export function scanCommand(options: ScanOptions): void {
  const root = resolve(options.cwd);
  const result = runScan(root);
  if (!result) {
    console.error(
      `${pc.red("✖")} ${root} doesn't look like a React Native project (no ios/, android/, app.json or app.config).\n  Run this in your project root, or pass --cwd <dir>.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatScan(result));
  if (result.findings.some((f) => f.level === "error")) process.exitCode = 1;
}
