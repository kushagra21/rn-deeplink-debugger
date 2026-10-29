import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { parseAndroid } from "../parsers/android.js";
import { parseIos } from "../parsers/ios.js";
import { formatScan } from "../report/format.js";
import type { Finding, FindingLevel, LinkPattern, ScanResult } from "../types.js";

export interface ScanOptions {
  cwd: string;
  json?: boolean;
}

const LEVEL_ORDER: Record<FindingLevel, number> = { error: 0, warning: 1, info: 2 };

/** Scan a project root. Returns null when it has neither an ios/ nor an android/ folder. */
export function runScan(root: string): ScanResult | null {
  const ios = parseIos(root);
  const android = parseAndroid(root);
  if (!ios && !android) return null;

  const patterns = [...(ios?.patterns ?? []), ...(android?.patterns ?? [])];
  const findings = [...(ios?.findings ?? []), ...(android?.findings ?? [])];
  if (ios && android) findings.push(...compareLinks(patterns));
  if (patterns.length === 0) {
    findings.push({
      level: "info",
      message: "No deep link config found: no URL schemes, associated domains or VIEW intent filters.",
    });
  }

  return {
    root,
    ios: ios && { bundleIds: ios.bundleIds, teamIds: ios.teamIds },
    android: android && { packageNames: android.packageNames },
    patterns,
    findings: findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
  };
}

/** Flag links the app handles on one platform but not the other. */
export function compareLinks(patterns: LinkPattern[]): Finding[] {
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
      fix: `Add an intent filter with <data android:scheme="${key}" /> to the activity that handles links (usually MainActivity) in android/app/src/main/AndroidManifest.xml.`,
    });
  }
  for (const [key, scheme] of androidSchemes) {
    if (iosSchemes.has(key)) continue;
    findings.push({
      level: "warning",
      message: `Custom scheme "${scheme}://" is registered on Android but not on iOS.`,
      fix: `Add "${key}" to CFBundleURLSchemes under CFBundleURLTypes in your app's Info.plist (Xcode → target → Info → URL Types).`,
    });
  }
  for (const [key, host] of iosHosts) {
    if (androidHosts.has(key)) continue;
    findings.push({
      level: "warning",
      message: `${host} is an associated domain on iOS but has no App Link intent filter on Android.`,
      fix: `Add an intent filter with android:autoVerify="true", <data android:scheme="https" /> and <data android:host="${host}" /> to AndroidManifest.xml.`,
    });
  }
  for (const [key, host] of androidHosts) {
    if (iosHosts.has(key)) continue;
    findings.push({
      level: "warning",
      message: `${host} has an App Link intent filter on Android but is not an associated domain on iOS.`,
      fix: `Add "applinks:${host}" to com.apple.developer.associated-domains in your .entitlements file (Xcode → Signing & Capabilities → Associated Domains).`,
    });
  }
  return findings;
}

function looksLikeExpo(root: string): boolean {
  for (const file of ["app.json", "package.json"]) {
    const path = join(root, file);
    if (existsSync(path) && /"expo"\s*:/.test(readFileSync(path, "utf8"))) return true;
  }
  return existsSync(join(root, "app.config.js")) || existsSync(join(root, "app.config.ts"));
}

export function scanCommand(options: ScanOptions): void {
  const root = resolve(options.cwd);
  const result = runScan(root);
  if (!result) {
    const hint = looksLikeExpo(root)
      ? "This looks like an Expo project without native folders. Reading app.json / app.config is coming soon; for now, run `npx expo prebuild` and scan again."
      : "Run this in a React Native project root, or pass --cwd <dir>.";
    console.error(`${pc.red("✖")} No ios/ or android/ folder found in ${root}.\n  ${hint}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatScan(result));
  if (result.findings.some((f) => f.level === "error")) process.exitCode = 1;
}
