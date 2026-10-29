import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScan } from "../src/commands/scan.js";
import { normalizeDomain, runVerify, type VerifyOptions } from "../src/commands/verify.js";
import type { AndroidSigning } from "../src/verify/signing.js";
import type { Check, DomainReport, ScanResult } from "../src/types.js";
import { firstMatchingRule, readAasaApps, urlParts } from "../src/verify/aasa.js";
import { HANDLE_ALL_URLS, normalizeFingerprint } from "../src/verify/assetlinks.js";
import type { FetchLike } from "../src/verify/fetch.js";

const ROOT = join(import.meta.dirname, "..", "fixtures", "bare-rn");
const APP_ID = "ABCDE12345.com.example.bareapp";
const PACKAGE = "com.example.bareapp";
const RELEASE_FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":");
const DEBUG_FP = Array.from({ length: 32 }, () => "AA").join(":");

type Route = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | { networkError: string };

const aasa = (components: unknown[], appIDs = [APP_ID]) => ({ applinks: { details: [{ appIDs, components }] } });
const GOOD_AASA = aasa([{ "/": "/admin/*", exclude: true }, { "/": "/product/*" }]);
const assetlinks = (overrides: { package?: string; relation?: string[]; fingerprints?: string[] } = {}) => [
  {
    relation: overrides.relation ?? [HANDLE_ALL_URLS],
    target: { namespace: "android_app", package_name: overrides.package ?? PACKAGE, sha256_cert_fingerprints: overrides.fingerprints ?? [RELEASE_FP, DEBUG_FP] },
  },
];

/** Routes for a domain whose files are all correct; override any of them per test. */
function site(domain: string, overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`https://${domain}/.well-known/apple-app-site-association`]: { body: GOOD_AASA },
    [`https://app-site-association.cdn-apple.com/a/v1/${domain}`]: { body: GOOD_AASA },
    [`https://${domain}/.well-known/assetlinks.json`]: { body: assetlinks() },
    ...overrides,
  };
}

function fakeFetch(routes: Record<string, Route>): FetchLike {
  return async (url) => {
    const route = routes[url];
    if (!route) return new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    if ("networkError" in route) throw Object.assign(new TypeError("fetch failed"), { cause: { code: route.networkError } });
    const body = route.text ?? (route.body !== undefined ? JSON.stringify(route.body) : null);
    return new Response(body, { status: route.status ?? 200, headers: { "content-type": "application/json", ...route.headers } });
  };
}

const debugOnly: AndroidSigning = { keys: [{ name: "debug", keystore: "android/app/debug.keystore", result: { fingerprint: DEBUG_FP } }], notes: [] };

async function verify(
  domains: string[],
  routes: Record<string, Route>,
  options: Partial<VerifyOptions> = {},
  scan?: ScanResult | null,
  signing: AndroidSigning | null = debugOnly,
) {
  const result = await runVerify(domains, { cwd: ROOT, sha256: [RELEASE_FP], ...options }, {
    fetch: fakeFetch(routes),
    signing: () => signing,
    ...(scan !== undefined && { scan: () => scan }),
  });
  if ("error" in result) throw new Error(result.error);
  return result;
}

const fileChecks = (report: DomainReport[], platform: "ios" | "android"): Check[] => report[0]!.files.find((f) => f.platform === platform)!.checks;
const at = (checks: Check[], level: Check["level"]) => checks.filter((c) => c.level === level).map((c) => c.message);
const problems = (checks: Check[]) => checks.filter((c) => c.level === "error" || c.level === "warning");

describe("verify: healthy domains", () => {
  it("passes every check for each domain the project uses", async () => {
    const report = await verify([], { ...site("example.com"), ...site("www.example.com") });
    expect(report.map((r) => r.domain)).toEqual(["example.com", "www.example.com"]);
    for (const domain of report) {
      expect(domain.checks).toEqual([]);
      for (const file of domain.files) expect(problems(file.checks)).toEqual([]);
    }
    expect(at(fileChecks(report, "ios"), "pass")).toEqual([
      `Served at https://example.com/.well-known/apple-app-site-association (200, application/json, ${JSON.stringify(GOOD_AASA).length} B)`,
      "Apple's CDN has the same version as your server",
      `Lists your app ${APP_ID}`,
      '/product/example opens the app ({ "/": "/product/*" })',
    ]);
    expect(at(fileChecks(report, "android"), "pass")).toEqual([
      expect.stringContaining("Served at https://example.com/.well-known/assetlinks.json"),
      `Lists ${PACKAGE} with the handle_all_urls relation`,
      expect.stringContaining("Includes fingerprint 10:11:12:13"),
      "Includes your debug keystore's fingerprint, so builds signed with it verify",
    ]);
  });
});

describe("verify: serving problems", () => {
  it("reports redirects, which iOS and Android don't follow", async () => {
    const report = await verify(["example.com"], site("example.com", {
      "https://example.com/.well-known/apple-app-site-association": { status: 301, headers: { location: "https://www.example.com/.well-known/apple-app-site-association" } },
      "https://example.com/.well-known/assetlinks.json": { status: 302, headers: { location: "https://www.example.com/.well-known/assetlinks.json" } },
    }));
    expect(at(fileChecks(report, "ios"), "error")).toEqual([expect.stringContaining("redirects (301) to https://www.example.com/")]);
    expect(at(fileChecks(report, "ios"), "info")).toEqual([expect.stringContaining("Also not served at https://example.com/apple-app-site-association (HTTP 404)")]);
    expect(at(fileChecks(report, "android"), "error")).toEqual([expect.stringContaining("Android doesn't follow redirects")]);
  });

  it("recognises a single-page app fallback serving HTML", async () => {
    const report = await verify(["example.com"], site("example.com", {
      "https://example.com/.well-known/apple-app-site-association": { text: "<!doctype html><html></html>", headers: { "content-type": "text/html; charset=utf-8" } },
    }));
    expect(at(fileChecks(report, "ios"), "error")).toEqual([expect.stringContaining("returns an HTML page instead of the file")]);
  });

  it("accepts the root location with a note", async () => {
    const report = await verify(["example.com"], site("example.com", {
      "https://example.com/.well-known/apple-app-site-association": { status: 404 },
      "https://example.com/apple-app-site-association": { body: GOOD_AASA },
    }));
    const checks = fileChecks(report, "ios");
    expect(problems(checks)).toEqual([]);
    expect(at(checks, "info")).toEqual([expect.stringContaining("found at the domain root")]);
  });

  it("checks Content-Type and size", async () => {
    const big = aasa([{ "/": "/product/*", comment: "x".repeat(130 * 1024) }]);
    const report = await verify(["example.com"], site("example.com", {
      "https://example.com/.well-known/apple-app-site-association": { body: big, headers: { "content-type": "text/plain" } },
      "https://app-site-association.cdn-apple.com/a/v1/example.com": { body: big },
      "https://example.com/.well-known/assetlinks.json": { body: assetlinks(), headers: { "content-type": "application/octet-stream" } },
    }));
    expect(at(fileChecks(report, "ios"), "warning")).toEqual([expect.stringContaining('served as "text/plain"')]);
    expect(at(fileChecks(report, "ios"), "error")).toEqual([expect.stringContaining("iOS ignores files over 128 KB")]);
    expect(at(fileChecks(report, "android"), "error")).toEqual([expect.stringContaining('served as "application/octet-stream"')]);
  });

  it("explains network errors", async () => {
    const report = await verify(["example.com"], {
      "https://example.com/.well-known/apple-app-site-association": { networkError: "CERT_HAS_EXPIRED" },
      "https://example.com/apple-app-site-association": { networkError: "CERT_HAS_EXPIRED" },
      "https://example.com/.well-known/assetlinks.json": { networkError: "ENOTFOUND" },
    }, { cdn: false });
    expect(at(fileChecks(report, "ios"), "error")).toEqual([expect.stringContaining("its TLS certificate has expired")]);
    expect(at(fileChecks(report, "android"), "error")).toEqual([expect.stringContaining("the domain name doesn't resolve")]);
  });
});

describe("verify: apple-app-site-association contents", () => {
  const iosChecks = async (file: unknown, cdn: Route = { body: file }) =>
    fileChecks(
      await verify(["example.com"], site("example.com", {
        "https://example.com/.well-known/apple-app-site-association": { body: file },
        "https://app-site-association.cdn-apple.com/a/v1/example.com": cdn,
      })),
      "ios",
    );

  it("spots a team ID mismatch", async () => {
    const checks = await iosChecks(aasa([{ "/": "*" }], ["ZZZZZ99999.com.example.bareapp"]));
    expect(at(checks, "error")).toEqual([expect.stringContaining("so the team ID doesn't match")]);
  });

  it("rejects malformed app IDs and a missing applinks section", async () => {
    expect(at(await iosChecks(aasa([{ "/": "*" }], ["com.example.bareapp"])), "error")).toEqual([
      expect.stringContaining('"com.example.bareapp" is not a valid app ID'),
      expect.stringContaining("doesn't list your app"),
    ]);
    expect(at(await iosChecks({ webcredentials: { apps: [APP_ID] } }), "error")).toEqual([expect.stringContaining('no "applinks" section')]);
  });

  it("checks the paths Android opens are covered on iOS", async () => {
    expect(at(await iosChecks(aasa([{ "/": "/shop/*" }])), "error")).toEqual([
      `/product/example doesn't match any rule for ${APP_ID}, but Android opens https://example.com/product*.`,
    ]);
    expect(at(await iosChecks(aasa([{ "/": "/product/*", exclude: true }, { "/": "*" }])), "error")).toEqual([
      expect.stringContaining('/product/example is excluded for ABCDE12345.com.example.bareapp by { "/": "/product/*", exclude }'),
    ]);
  });

  it("reads the legacy paths format", async () => {
    const legacy = { applinks: { apps: [], details: [{ appID: APP_ID, paths: ["NOT /product/secret", "/product/*"] }] } };
    expect(problems(await iosChecks(legacy))).toEqual([]);
  });

  it("compares with Apple's CDN copy", async () => {
    expect(at(await iosChecks(GOOD_AASA, { body: aasa([{ "/": "/old/*" }]) }), "warning")).toEqual([expect.stringContaining("Apple's CDN has a different")]);
    expect(at(await iosChecks(GOOD_AASA, { status: 404 }), "warning")).toEqual([expect.stringContaining("Apple's CDN has no copy")]);
  });
});

describe("verify: assetlinks.json contents", () => {
  const androidChecks = async (file: unknown, options: Partial<VerifyOptions> = {}) =>
    fileChecks(await verify(["example.com"], site("example.com", { "https://example.com/.well-known/assetlinks.json": { body: file } }), options), "android");

  it("spots a missing package, relation or fingerprint", async () => {
    expect(at(await androidChecks(assetlinks({ package: "com.example.other" })), "error")).toEqual([
      expect.stringContaining("doesn't list your package (com.example.bareapp). It lists: com.example.other"),
    ]);
    expect(at(await androidChecks(assetlinks({ relation: ["delegate_permission/common.get_login_creds"] })), "error")).toEqual([
      expect.stringContaining(`doesn't include the "${HANDLE_ALL_URLS}" relation`),
    ]);
    const checks = await androidChecks(assetlinks({ fingerprints: [DEBUG_FP] }));
    expect(at(checks, "error")).toEqual([expect.stringContaining(`doesn't include the fingerprint ${RELEASE_FP}`)]);
  });

  it("recognises SHA-1 and badly formatted fingerprints", async () => {
    const sha1 = Array.from({ length: 20 }, () => "AB").join(":");
    const lower = RELEASE_FP.toLowerCase().replaceAll(":", "");
    const checks = await androidChecks(assetlinks({ fingerprints: [sha1, lower] }));
    expect(at(checks, "error")).toEqual([expect.stringContaining("is a SHA-1 fingerprint")]);
    expect(at(checks, "warning")).toEqual([expect.stringContaining("isn't in the standard format")]);
    expect(at(checks, "pass")).toContainEqual(expect.stringContaining("Includes fingerprint"));
  });

  it("notes when the debug key or release key aren't checked", async () => {
    const checks = await androidChecks(assetlinks({ fingerprints: [RELEASE_FP] }), { sha256: [] });
    expect(at(checks, "info")).toEqual([
      expect.stringContaining("won't verify in debug builds"),
      "Fingerprints weren't checked against your release or Play App Signing key.",
    ]);
  });
});

describe("verify: signing keys and project settings", () => {
  const UPLOAD_FP = Array.from({ length: 32 }, () => "CC").join(":");
  const PLAY_FP = Array.from({ length: 32 }, () => "DD").join(":");
  const withUpload: AndroidSigning = {
    keys: [...debugOnly.keys, { name: "release", keystore: "android/app/my-upload-key.keystore", result: { fingerprint: UPLOAD_FP } }],
    releaseConfig: "release",
    notes: [],
  };
  const android = async (listed: string[], options: Partial<VerifyOptions>, signing: AndroidSigning | null, cwd = ROOT) =>
    fileChecks(
      await verify(["example.com"], site("example.com", { "https://example.com/.well-known/assetlinks.json": { body: assetlinks({ fingerprints: listed }) } }), { cwd, ...options }, undefined, signing),
      "android",
    );

  it("passes when the release keystore's fingerprint is listed", async () => {
    const checks = await android([UPLOAD_FP], { sha256: [] }, withUpload);
    expect(at(checks, "pass")).toContain("Includes your release keystore (android/app/my-upload-key.keystore)'s fingerprint, so builds signed with it verify");
  });

  it("warns about an unlisted upload key until the Play App Signing key is known", async () => {
    const unknown = await android([PLAY_FP], { sha256: [] }, withUpload);
    expect(at(unknown, "warning")).toEqual([expect.stringContaining("If you use Play App Signing that's expected")]);
    const known = await android([PLAY_FP], { sha256: [PLAY_FP] }, withUpload);
    expect(at(known, "warning")).toEqual([]);
    expect(at(known, "info")).toContainEqual(expect.stringContaining("That's fine if this is your Play upload key"));
  });

  it("warns when release builds are signed with the debug keystore", async () => {
    const checks = await android([RELEASE_FP], {}, { ...debugOnly, releaseConfig: "debug" });
    expect(at(checks, "warning")).toEqual([expect.stringContaining("Release builds are signed with the debug keystore")]);
  });

  it("passes on keystores it couldn't read", async () => {
    const checks = await android([RELEASE_FP], {}, { keys: [{ name: "release", keystore: "k", result: { error: "the keystore password is wrong" } }], notes: ["The release signing config reads its keystore from somewhere rn-deeplink can't see (for example a CI secret)."] });
    expect(at(checks, "info")).toEqual([
      "Couldn't read the release keystore (k): the keystore password is wrong.",
      expect.stringContaining("can't see (for example a CI secret)"),
    ]);
  });

  describe("with .deeplinks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const project = (json: unknown) => {
      cpSync(ROOT, dir, { recursive: true });
      writeFileSync(join(dir, ".deeplinks.json"), JSON.stringify(json));
      return dir;
    };

    it("checks the fingerprints saved under android.sha256", async () => {
      const cwd = project({ links: [], android: { sha256: [PLAY_FP] } });
      const checks = await android([RELEASE_FP], { sha256: [] }, debugOnly, cwd);
      expect(at(checks, "error")).toEqual([expect.stringContaining(`doesn't include the fingerprint ${PLAY_FP}`)]);
    });

    it("checks saved https links against the AASA rules", async () => {
      const cwd = project({ links: [{ name: "Old item", url: "https://example.com/item/9" }, { url: "https://example.com/product/9?ref=mail" }, { url: "https://example.com/admin/x", platform: "android" }] });
      const report = await verify(["example.com"], site("example.com"), { cwd });
      const ios = fileChecks(report, "ios");
      expect(at(ios, "error")).toEqual([`/item/9 doesn't match any rule for ${APP_ID}, but it's saved in .deeplinks.json as "Old item".`]);
      expect(at(ios, "pass")).toContain('/product/9?ref=mail opens the app ({ "/": "/product/*" })');
    });

    it("uses ios.teamId when the Xcode project has no team", async () => {
      const cwd = project({ links: [], ios: { teamId: "ABCDE12345" } });
      const scan = { ...runScan(ROOT)!, ios: { bundleIds: ["com.example.bareapp"], teamIds: [] } };
      const report = await verify(["example.com"], site("example.com"), { cwd }, scan);
      expect(at(fileChecks(report, "ios"), "pass")).toContain(`Lists your app ${APP_ID}`);
    });

    it("explains invalid settings", async () => {
      const cwd = project({ links: [], android: { sha256: "AB" }, ios: { teamId: "nope" } });
      expect(await runVerify(["example.com"], { cwd }, { fetch: fakeFetch({}), signing: () => null })).toEqual({
        error: '.deeplinks.json has problems: "android.sha256" must be a list of fingerprints; "ios.teamId" must be a 10-character Apple team ID.',
      });
    });
  });
});

describe("verify: which domains and files", () => {
  const scan: ScanResult = {
    root: ROOT,
    expo: null,
    ios: { bundleIds: ["com.example.bareapp"], teamIds: ["ABCDE12345"] },
    android: { packageNames: [PACKAGE] },
    patterns: [{ platform: "ios", kind: "universal", scheme: "https", host: "ios.example.com", source: "x" }],
    findings: [],
  };

  it("skips the platform that doesn't use the domain", async () => {
    const report = await verify(["ios.example.com"], site("ios.example.com"), {}, scan);
    expect(report[0]!.files.map((f) => [f.platform, f.skipped])).toEqual([
      ["ios", undefined],
      ["android", "the Android app has no App Link filter for it"],
    ]);
  });

  it("warns about a domain the project doesn't use and checks both files", async () => {
    const report = await verify(["other.example.com"], site("other.example.com"), {}, scan);
    expect(at(report[0]!.checks, "warning")).toEqual([expect.stringContaining("isn't an associated domain or App Link host")]);
    expect(report[0]!.files.every((f) => !f.skipped)).toBe(true);
  });

  it("explains wildcard domains and needs a domain outside a project", async () => {
    const report = await verify(["*.example.com"], {}, {}, scan);
    expect(at(report[0]!.checks, "info")).toEqual([expect.stringContaining("rn-deeplink verify www.example.com")]);
    const result = await runVerify([], { cwd: ROOT }, { scan: () => null });
    expect(result).toEqual({ error: expect.stringContaining("Pass a domain") });
  });

  it("normalises domain arguments", () => {
    expect(normalizeDomain("https://Example.com/path?x=1")).toBe("example.com");
    expect(normalizeDomain("example.com/.well-known/assetlinks.json")).toBe("example.com");
  });
});

describe("AASA rule matching", () => {
  const rules = (components: unknown[]) => readAasaApps(aasa(components)).apps[0]!.rules;
  const opens = (components: unknown[], url: string) => {
    const rule = firstMatchingRule(rules(components), urlParts(url));
    return !!rule && !rule.exclude;
  };

  it("supports * and ? wildcards", () => {
    expect(opens([{ "/": "/product/*" }], "/product/42")).toBe(true);
    expect(opens([{ "/": "/product/*" }], "/product")).toBe(false);
    expect(opens([{ "/": "/p/???" }], "/p/abc")).toBe(true);
    expect(opens([{ "/": "/p/???" }], "/p/abcd")).toBe(false);
  });

  it("uses the first matching rule, so order matters", () => {
    expect(opens([{ "/": "/product/*", exclude: true }, { "/": "*" }], "/product/1")).toBe(false);
    expect(opens([{ "/": "*" }, { "/": "/product/*", exclude: true }], "/product/1")).toBe(true);
  });

  it("matches query items, fragments and case-insensitive rules", () => {
    expect(opens([{ "/": "/s", "?": { q: "*" } }], "/s?q=shoes")).toBe(true);
    expect(opens([{ "/": "/s", "?": { q: "*" } }], "/s")).toBe(false);
    expect(opens([{ "/": "/help", "#": "faq-*" }], "/help#faq-1")).toBe(true);
    expect(opens([{ "/": "/About", caseSensitive: false }], "/about")).toBe(true);
    expect(opens([{ "/": "/café", percentEncoded: false }], "/caf%C3%A9")).toBe(true);
  });
});

describe("normalizeFingerprint", () => {
  it("formats SHA-256 values as uppercase colon-separated pairs", () => {
    expect(normalizeFingerprint(RELEASE_FP.toLowerCase().replaceAll(":", ""))).toBe(RELEASE_FP);
  });
});
