import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTest, type TestOptions } from "../src/commands/test.js";
import { androidGlob, androidPathMatches, explainUrl, matchPattern, parseLinkUrl } from "../src/match.js";
import type { Check, LinkPattern, Platform, ScanResult, TestReport } from "../src/types.js";
import type { FetchLike } from "../src/verify/fetch.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

async function test(url: string, project = "bare-rn", options: Partial<TestOptions> = {}, fetch?: FetchLike): Promise<TestReport> {
  const result = await runTest(url, { cwd: fixture(project), ...options }, { fetch });
  if ("error" in result) throw new Error(result.error);
  return result;
}

const on = (report: TestReport, platform: Platform): Check[] => report.platforms.find((p) => p.platform === platform)!.checks;
const at = (checks: Check[], level: Check["level"]) => checks.filter((c) => c.level === level).map((c) => c.message);

describe("test: URLs the app handles", () => {
  it("matches a custom scheme on both platforms", async () => {
    const report = await test("bareapp://settings");
    expect(at(on(report, "ios"), "pass")).toEqual(["Matches custom scheme bareapp:// (ios/BareApp/Info.plist)"]);
    expect(at(on(report, "android"), "pass")).toEqual(["Matches custom scheme bareapp:// (android/app/src/main/AndroidManifest.xml → .MainActivity)"]);
    expect(at(report.checks, "info")).toEqual(["Try it on a device: rn-deeplink open bareapp://settings"]);
  });

  it("matches an https link on both platforms and explains where iOS paths come from", async () => {
    const report = await test("https://example.com/product/42");
    expect(at(on(report, "ios"), "pass")).toEqual(["Matches universal link https://example.com/* (ios/BareApp/BareApp.entitlements)"]);
    expect(at(on(report, "ios"), "info")).toEqual([
      "Which paths open the app is set by apple-app-site-association on the server.",
      expect.stringContaining("Typing the URL in Safari"),
    ]);
    expect(at(on(report, "android"), "pass")).toEqual(["Matches App Link https://example.com/product* (android/app/src/main/AndroidManifest.xml → .MainActivity)"]);
  });

  it("notes SDK schemes", async () => {
    const report = await test("fb1234567890://authorize");
    expect(at(on(report, "ios"), "info")).toEqual(["fb1234567890:// is registered for Facebook SDK, so that, not your app's own navigation, expects these URLs."]);
  });

  it("works from an Expo config", async () => {
    const report = await test("https://shop.example.com/p/1", "expo-managed");
    expect(at(on(report, "android"), "pass")).toEqual(["Matches App Link https://shop.example.com/p* (app.json → android.intentFilters[0])"]);
  });
});

describe("test: URLs the app doesn't handle", () => {
  it("names the closest Android filter and the path rule that failed", async () => {
    const report = await test("https://example.com/item/42");
    const [check] = on(report, "android");
    expect(check).toMatchObject({
      level: "error",
      message: expect.stringContaining("Closest: App Link https://example.com/product* (android/app/src/main/AndroidManifest.xml → .MainActivity): the path must start with /product."),
      fix: expect.stringContaining("Add a path rule that covers /item/42"),
    });
    expect(at(on(report, "ios"), "pass")).toHaveLength(1);
  });

  it("names the hosts that are covered when the host is unknown", async () => {
    const report = await test("https://other.com/x");
    expect(on(report, "ios")[0]).toMatchObject({ message: expect.stringContaining("universal link https://example.com/* (ios/BareApp/BareApp.entitlements): it is for example.com"), fix: expect.stringContaining('"applinks:other.com"') });
    expect(on(report, "android")[0]!.fix).toContain('android:host="other.com"');
  });

  it("suggests https for an http link", async () => {
    const report = await test("http://example.com/product/1");
    for (const platform of ["ios", "android"] as const) expect(on(report, platform)[0]!.fix).toBe("Link to https://example.com/product/1 instead.");
  });

  it("lists what is handled when the scheme is unknown", async () => {
    const [check] = on(await test("other://x"), "ios");
    expect(check!.message).toBe("Nothing in the iOS config matches this URL, so the link does nothing. It handles: bareapp://, https://example.com/*, https://www.example.com/*.");
  });

  it("explains a scheme that only differs in case", async () => {
    const [check] = on(await test("onlyandroid://x", "bare-rn-broken"), "android");
    expect(check).toMatchObject({ message: expect.stringContaining('its scheme is "OnlyAndroid", and Android compares schemes case-sensitively'), fix: expect.stringContaining('"onlyandroid"') });
  });

  it("reports filters a tapped link can't reach", async () => {
    const report = await test("brokenapp://settings", "bare-rn-broken");
    expect(at(on(report, "android"), "error")).toEqual([
      expect.stringContaining("can't reach it: the filter is missing the BROWSABLE category"),
      expect.stringContaining('can\'t reach it: .SettingsActivity has android:exported="false"'),
    ]);
    expect(report.checks).toEqual([]);
  });

  it("warns about App Links without autoVerify", async () => {
    const scan: ScanResult = {
      root: "/x",
      expo: null,
      ios: null,
      android: { packageNames: ["com.example.app"] },
      patterns: [{ platform: "android", kind: "app-link", scheme: "https", host: "example.com", autoVerify: false, source: "AndroidManifest.xml → .MainActivity" }],
      findings: [],
    };
    const result = await runTest("https://example.com/product/1", { cwd: "/x" }, { scan: () => scan });
    if ("error" in result) throw new Error(result.error);
    expect(at(on(result, "android"), "warning")).toEqual([expect.stringContaining("doesn't set autoVerify, so Android 12+ opens this link in the browser")]);
  });
});

describe("test: iOS paths from apple-app-site-association", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
  const aasaFile = join(dir, "aasa.json");
  const aasa = {
    applinks: { details: [{ appIDs: ["ABCDE12345.com.example.bareapp"], components: [{ "/": "/product/secret", exclude: true }, { "/": "/product/*" }] }] },
  };
  writeFileSync(aasaFile, JSON.stringify(aasa));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("checks the path against a local file", async () => {
    expect(at(on(await test("https://example.com/product/42", "bare-rn", { aasa: aasaFile }), "ios"), "pass")).toContain(
      'apple-app-site-association opens this path for ABCDE12345.com.example.bareapp ({ "/": "/product/*" })',
    );
    expect(at(on(await test("https://example.com/product/secret", "bare-rn", { aasa: aasaFile }), "ios"), "error")).toEqual([
      expect.stringContaining("excludes this path for ABCDE12345.com.example.bareapp"),
    ]);
    expect(at(on(await test("https://example.com/about", "bare-rn", { aasa: aasaFile }), "ios"), "error")).toEqual([
      "No rule in apple-app-site-association for ABCDE12345.com.example.bareapp matches /about, so Safari opens it.",
    ]);
  });

  it("fetches the live file with --online", async () => {
    const requested: string[] = [];
    const fetch: FetchLike = async (url) => {
      requested.push(url);
      return url.includes(".well-known") ? new Response(JSON.stringify(aasa), { headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 });
    };
    const report = await test("https://example.com/product/1", "bare-rn", { online: true }, fetch);
    expect(requested).toEqual(["https://example.com/.well-known/apple-app-site-association"]);
    expect(at(on(report, "ios"), "pass")).toContain('apple-app-site-association opens this path for ABCDE12345.com.example.bareapp ({ "/": "/product/*" })');
  });

  it("reports a file it can't fetch", async () => {
    const fetch: FetchLike = async () => new Response("nope", { status: 404 });
    const report = await test("https://example.com/product/1", "bare-rn", { online: true }, fetch);
    expect(at(on(report, "ios"), "error")).toEqual(["Couldn't get apple-app-site-association from example.com (HTTP 404), so iOS won't open this link in the app."]);
  });
});

describe("test: input", () => {
  it("rejects a URL without a scheme and a folder that isn't a project", async () => {
    expect(await runTest("example.com/x", { cwd: fixture("bare-rn") })).toEqual({ error: expect.stringContaining("https://example.com/x") });
    expect(await runTest("myapp://x", { cwd: mkdtempSync(join(tmpdir(), "rn-deeplink-")) })).toEqual({ error: expect.stringContaining("No React Native project here") });
  });
});

describe("matching rules", () => {
  const android = (p: Partial<LinkPattern>): LinkPattern => ({ platform: "android", kind: "app-link", scheme: "https", source: "x", ...p });
  const ios = (p: Partial<LinkPattern>): LinkPattern => ({ platform: "ios", kind: "universal", scheme: "https", source: "x", ...p });
  const matches = (p: LinkPattern, url: string) => matchPattern(p, parseLinkUrl(url)!) === null;

  it("follows Android's simple glob for pathPattern", () => {
    expect(androidGlob("/product/.*").test("/product/42")).toBe(true);
    expect(androidGlob("/a*b").test("/aaab")).toBe(true);
    expect(androidGlob("/a*b").test("/b")).toBe(true);
    expect(androidGlob("/x\\.json").test("/x.json")).toBe(true);
    expect(androidGlob("/x\\.json").test("/xajson")).toBe(false);
    expect(androidPathMatches("pathAdvancedPattern", "/item/[0-9]+", "/item/42")).toBe(true);
    expect(androidPathMatches("pathSuffix", ".pdf", "/docs/a.pdf")).toBe(true);
  });

  it("matches Android hosts case-insensitively and wildcards to subdomains only", () => {
    expect(matches(android({ host: "Example.com" }), "https://example.com/x")).toBe(true);
    expect(matches(android({ host: "*.example.com" }), "https://shop.example.com/x")).toBe(true);
    expect(matches(android({ host: "*.example.com" }), "https://example.com/x")).toBe(false);
    expect(matches(android({ host: "example.com:8443" }), "https://example.com:8443/x")).toBe(true);
    expect(matches(android({ host: "example.com" }), "https://example.com:8443/x")).toBe(true);
  });

  it("decodes the path for Android", () => {
    expect(matches(android({ host: "example.com", path: "/café", pathType: "path" }), "https://example.com/caf%C3%A9")).toBe(true);
  });

  it("needs https and an exact port for universal links", () => {
    expect(matches(ios({ host: "example.com" }), "https://EXAMPLE.com/x")).toBe(true);
    expect(matches(ios({ host: "example.com" }), "https://example.com:8443/x")).toBe(false);
    expect(matches(ios({ host: "example.com:8443" }), "https://example.com:8443/x")).toBe(true);
  });

  it("ranks the closest misses", () => {
    const patterns = [android({ host: "example.com", path: "/p", pathType: "pathPrefix" }), android({ host: "other.com" }), android({ kind: "scheme", scheme: "app" })];
    const { matched, closest } = explainUrl(parseLinkUrl("https://example.com/q")!, patterns);
    expect(matched).toEqual([]);
    expect(closest.map((c) => [c.pattern.host, c.miss.stage])).toEqual([["example.com", "path"]]);
  });
});
