import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../src/commands/scan.js";
import { patternUrl } from "../src/report/format.js";
import type { ScanResult } from "../src/types.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

const scan = (name: string): ScanResult => {
  const result = runScan(fixture(name));
  if (!result) throw new Error(`fixture ${name} was not recognised as a project`);
  return result;
};

const links = (result: ScanResult) => result.patterns.map((p) => `${p.platform} ${p.kind} ${patternUrl(p)}`);
const messages = (result: ScanResult, level: string) => result.findings.filter((f) => f.level === level).map((f) => f.message);

describe("scan: bare RN project", () => {
  const result = scan("bare-rn");

  it("reads bundle ID, team ID and package name", () => {
    expect(result.ios).toEqual({ bundleIds: ["com.example.bareapp"], teamIds: ["ABCDE12345"] });
    expect(result.android).toEqual({ packageNames: ["com.example.bareapp"] });
  });

  it("lists every link pattern on both platforms", () => {
    expect(links(result)).toEqual([
      "ios scheme bareapp://",
      "ios scheme fb1234567890://",
      "ios universal https://example.com/*",
      "ios universal https://www.example.com/*",
      "android scheme bareapp://",
      "android app-link https://example.com/product*",
      "android app-link https://www.example.com/product*",
      "android scheme fb1234567890://",
    ]);
  });

  it("marks SDK schemes as third-party and App Links as verified", () => {
    expect(result.patterns.filter((p) => p.thirdParty).map((p) => p.thirdParty)).toEqual(["Facebook SDK", "Facebook SDK"]);
    expect(result.patterns.filter((p) => p.kind === "app-link").every((p) => p.autoVerify)).toBe(true);
  });

  it("reports no problems", () => {
    expect(result.findings).toEqual([]);
  });
});

describe("scan: bare RN project with common mistakes", () => {
  const result = scan("bare-rn-broken");

  it("resolves the bundle ID from build variables", () => {
    expect(result.ios?.bundleIds).toEqual(["org.reactjs.native.example.Broken-App"]);
    expect(result.ios?.teamIds).toEqual([]);
  });

  it("reports errors", () => {
    const errors = messages(result, "error");
    expect(errors).toHaveLength(4);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('URL scheme "brokenapp://"'),
        expect.stringContaining('"applinks:https://example.com"'),
        expect.stringContaining("has no android:host"),
        expect.stringContaining('.SettingsActivity has android:exported="false"'),
      ]),
    );
  });

  it("reports warnings", () => {
    const warnings = messages(result, "warning");
    expect(warnings).toHaveLength(9);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("set up for the Debug build but not Release"),
        expect.stringContaining("Old.entitlements lists associated domains, but no build configuration uses this file"),
        expect.stringContaining("missing the BROWSABLE category"),
        expect.stringContaining('no android:autoVerify="true"'),
        expect.stringContaining('android:pathPrefix="product"'),
        expect.stringContaining('"OnlyAndroid" in .MainActivity has uppercase letters'),
        expect.stringContaining('"onlyios://" is registered on iOS but not on Android'),
        expect.stringContaining('"OnlyAndroid://" is registered on Android but not on iOS'),
        expect.stringContaining("ios-only.example.com is an associated domain on iOS"),
      ]),
    );
  });

  it("reports info about the missing team and package suffix", () => {
    expect(messages(result, "info")).toEqual([
      expect.stringContaining("No DEVELOPMENT_TEAM"),
      expect.stringContaining("com.example.broken.debug"),
    ]);
  });

  it("notes universal links that only exist in some build configurations", () => {
    const universal = result.patterns.filter((p) => p.kind === "universal");
    expect(universal.map((p) => [p.host, p.note])).toEqual([
      ["example.com", "only in Debug"],
      ["ios-only.example.com", "only in Debug"],
    ]);
  });

  it("puts errors first", () => {
    const levels = result.findings.map((f) => f.level);
    expect(levels).toEqual([...levels].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b)));
  });
});

describe("scan: not a project", () => {
  it("returns null without ios/ or android/", () => {
    expect(runScan(mkdtempSync(join(tmpdir(), "rn-deeplink-")))).toBeNull();
  });
});
