import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAssociatedDomain, parseXcodeProject, resolveBuildSetting } from "../src/parsers/ios.js";

describe("parseAssociatedDomain", () => {
  it.each([
    ["applinks:example.com", { ok: true, service: "applinks", host: "example.com" }],
    ["applinks:*.example.com", { ok: true, service: "applinks", host: "*.example.com" }],
    ["applinks:example.com:8443", { ok: true, service: "applinks", host: "example.com:8443" }],
    ["applinks:example.com?mode=developer", { ok: true, service: "applinks", host: "example.com", mode: "developer" }],
    ["webcredentials:example.com", { ok: true, service: "webcredentials", host: "example.com" }],
  ])("accepts %s", (entry, expected) => {
    expect(parseAssociatedDomain(entry)).toEqual(expected);
  });

  it.each([
    ["applinks:https://example.com", "URL scheme"],
    ["example.com", "service prefix"],
    ["applinks:example.com/path", "path"],
    ["applinks:example", "not a valid domain"],
    ["applinks:example.com?mode=dev", "not a known option"],
  ])("rejects %s", (entry, reason) => {
    const result = parseAssociatedDomain(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("resolveBuildSetting", () => {
  it("expands variables recursively and applies rfc1034identifier", () => {
    const settings = { PRODUCT_NAME: "$(TARGET_NAME)", TARGET_NAME: "My App" };
    expect(resolveBuildSetting("org.example.$(PRODUCT_NAME:rfc1034identifier)", settings)).toBe("org.example.My-App");
    expect(resolveBuildSetting("${PRODUCT_NAME}", settings)).toBe("My App");
  });

  it("leaves unknown variables untouched", () => {
    expect(resolveBuildSetting("com.example.$(SUFFIX)", {})).toBe("com.example.$(SUFFIX)");
  });
});

describe("parseXcodeProject", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "fixtures", "bare-rn", "ios", "BareApp.xcodeproj", "project.pbxproj"), "utf8");
  const targets = parseXcodeProject(text);

  it("finds native targets and their product types", () => {
    expect(targets.map((t) => [t.name, t.productType])).toEqual([
      ["BareAppTests", "com.apple.product-type.bundle.unit-test"],
      ["BareApp", "com.apple.product-type.application"],
    ]);
  });

  it("merges project-level settings into target configurations", () => {
    const app = targets.find((t) => t.name === "BareApp")!;
    expect(app.configs.map((c) => c.name)).toEqual(["Debug", "Release"]);
    expect(app.configs[0]!.settings).toMatchObject({
      DEVELOPMENT_TEAM: "ABCDE12345",
      CODE_SIGN_ENTITLEMENTS: "BareApp/BareApp.entitlements",
      PRODUCT_BUNDLE_IDENTIFIER: "com.example.bareapp",
      TARGET_NAME: "BareApp",
    });
  });
});
