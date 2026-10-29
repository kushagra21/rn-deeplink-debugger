import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../src/commands/scan.js";
import { parseExpoConfig } from "../src/parsers/expo.js";
import { patternUrl } from "../src/report/format.js";
import type { ScanResult } from "../src/types.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

const scan = (root: string): ScanResult => {
  const result = runScan(root);
  if (!result) throw new Error(`${root} was not recognised as a project`);
  return result;
};

const links = (result: ScanResult) => result.patterns.map((p) => `${p.platform} ${p.kind} ${patternUrl(p)}`);
const messages = (result: ScanResult, level: string) => result.findings.filter((f) => f.level === level).map((f) => f.message);

describe("scan: Expo managed project", () => {
  const result = scan(fixture("expo-managed"));

  it("reads IDs from app.json", () => {
    expect(result.expo).toEqual({ configFile: "app.json" });
    expect(result.ios).toEqual({ bundleIds: ["com.example.shop"], teamIds: ["TEAM123456"] });
    expect(result.android).toEqual({ packageNames: ["com.example.shop"] });
  });

  it("lists the links prebuild will generate, including the bundle ID scheme", () => {
    expect(links(result)).toEqual([
      "ios scheme shop://",
      "ios scheme com.example.shop://",
      "ios universal https://shop.example.com/*",
      "android scheme shop://",
      "android app-link https://shop.example.com/p*",
    ]);
    expect(result.patterns.find((p) => p.scheme === "com.example.shop")?.thirdParty).toBe("Bundle ID");
  });

  it("reports no problems", () => {
    expect(result.findings).toEqual([]);
  });
});

describe("scan: Expo managed project with common mistakes", () => {
  const result = scan(fixture("expo-managed-broken"));

  it("reports errors", () => {
    expect(messages(result, "error")).toEqual([
      expect.stringContaining('Scheme "shop://" in app.json is not valid'),
      expect.stringContaining('"shop.example.com" in ios.associatedDomains (app.json) is invalid: it is missing a service prefix'),
      expect.stringContaining('becomes "android.intent.action.android.intent.action.VIEW"'),
      expect.stringContaining('uses the category "android.intent.category.DEFAULT"'),
    ]);
  });

  it("reports warnings with fixes in app.json syntax", () => {
    const warnings = result.findings.filter((f) => f.level === "warning");
    expect(warnings.map((f) => f.message)).toEqual([
      expect.stringContaining('"pathprefix" in android.intentFilters[1].data'),
      expect.stringContaining("missing the DEFAULT category"),
      expect.stringContaining("doesn't set autoVerify"),
      expect.stringContaining("shop.example.com has an App Link intent filter on Android but is not an associated domain on iOS"),
    ]);
    expect(warnings.map((f) => f.fix)).toEqual([
      'Did you mean "pathPrefix"? Keys are case-sensitive.',
      'Add "DEFAULT" to the filter\'s "category" list in app.json.',
      'Set "autoVerify": true on the filter in app.json.',
      'Add "applinks:shop.example.com" to ios.associatedDomains in app.json.',
    ]);
  });

  it("skips the filter whose action never matches", () => {
    expect(result.patterns.some((p) => p.host === "old.example.com")).toBe(false);
  });
});

describe("scan: Expo dynamic config", () => {
  it("evaluates app.config.js with the project's Expo CLI", () => {
    const result = scan(fixture("expo-dynamic"));
    expect(result.expo).toEqual({ configFile: "app.config.js" });
    expect(links(result)).toContain("android app-link https://dynamic.example.com/*");
    expect(result.findings).toEqual([]);
  });

  it("explains that dependencies are needed when the Expo CLI is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
    try {
      cpSync(join(fixture("expo-dynamic"), "app.config.js"), join(root, "app.config.js"));
      const result = scan(root);
      expect(result.patterns).toEqual([]);
      expect(result.findings).toEqual([
        expect.objectContaining({ level: "error", message: expect.stringContaining("needs the project's own Expo CLI") }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scan: Expo project with stale native folders", () => {
  const result = scan(fixture("expo-prebuild"));

  it("reports the native folders as the source of truth", () => {
    expect(result.patterns.every((p) => p.source.startsWith("ios/") || p.source.startsWith("android/"))).toBe(true);
    expect(result.android).toEqual({ packageNames: ["com.example.bareapp"] });
  });

  it("flags config the native folders are missing", () => {
    expect(messages(result, "warning")).toEqual([
      expect.stringContaining("app.json sets up https://new.example.com/* for iOS, but ios/ doesn't have it"),
      expect.stringContaining("app.json sets up https://new.example.com/product* for Android, but android/ doesn't have it"),
      expect.stringContaining('sets android.package to "com.example.renamed", but android/ uses "com.example.bareapp"'),
    ]);
  });
});

describe("parseExpoConfig", () => {
  it("merges platform schemes and reads associated domains from entitlements", () => {
    const scan = parseExpoConfig(
      {
        scheme: "app",
        ios: {
          scheme: ["app-ios"],
          entitlements: { "com.apple.developer.associated-domains": ["applinks:example.com"] },
          infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ["fb123"] }] },
        },
        android: { scheme: "app-android" },
      },
      "app.config.ts",
    );
    expect(scan.ios.patterns.map((p) => [p.scheme, p.host, p.thirdParty])).toEqual([
      ["app", undefined, undefined],
      ["app-ios", undefined, undefined],
      ["fb123", undefined, "Facebook SDK"],
      ["https", "example.com", undefined],
    ]);
    expect(scan.android.patterns.map((p) => p.scheme)).toEqual(["app", "app-android"]);
  });

  it("lets ios.associatedDomains replace the entitlements value, as prebuild does", () => {
    const scan = parseExpoConfig(
      {
        ios: {
          associatedDomains: ["applinks:new.example.com"],
          entitlements: { "com.apple.developer.associated-domains": ["applinks:old.example.com"] },
        },
      },
      "app.json",
    );
    expect(scan.ios.patterns.map((p) => p.host)).toEqual(["new.example.com"]);
  });
});
