import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linksAddCommand, linksInitCommand, linksRemoveCommand } from "../src/commands/links.js";
import { runOpenAll } from "../src/commands/open.js";
import { runScan } from "../src/commands/scan.js";
import { runTestAll } from "../src/commands/test.js";
import type { ExecResult, Exec } from "../src/devices/exec.js";
import { LINKS_FILE, findLink, readLinks, suggestLinks, writeLinks } from "../src/links.js";
import { formatTestAll } from "../src/report/format.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const write = (json: unknown) => writeFileSync(join(dir, LINKS_FILE), typeof json === "string" ? json : JSON.stringify(json));
const fileJson = () => JSON.parse(readFileSync(join(dir, LINKS_FILE), "utf8"));
/** A copy of a fixture project, so tests can write .deeplinks.json into it. */
const project = (name: string) => {
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
};

describe(".deeplinks.json", () => {
  it("reads objects and plain URL strings, and returns null without a file", () => {
    expect(readLinks(dir)).toBeNull();
    write({ links: ["myapp://home", { name: "Product", url: "https://example.com/p/1", platform: "android" }] });
    expect(readLinks(dir)).toEqual([
      { url: "myapp://home", name: undefined, platform: undefined },
      { url: "https://example.com/p/1", name: "Product", platform: "android" },
    ]);
  });

  it("explains what's wrong with a bad file", () => {
    write("{ nope");
    expect(readLinks(dir)).toEqual({ error: expect.stringContaining(".deeplinks.json is not valid JSON") });
    write({ urls: [] });
    expect(readLinks(dir)).toEqual({ error: expect.stringContaining('must look like { "links": [') });
    write({ links: [{ name: "x" }, "example.com/x", { url: "a://b", platform: "web" }] });
    expect(readLinks(dir)).toEqual({
      error: '.deeplinks.json has problems: entry 1 has no "url"; entry 2: "example.com/x" isn\'t a full URL with a scheme; entry 3: "platform" must be "ios" or "android".',
    });
  });

  it("writes readable JSON and keeps other keys", () => {
    write({ $comment: "shared test links", links: [] });
    writeLinks(dir, [{ url: "myapp://home", name: "Home" }, { url: "myapp://x", platform: "ios" }]);
    expect(readFileSync(join(dir, LINKS_FILE), "utf8")).toBe(
      `${JSON.stringify({ $comment: "shared test links", links: [{ name: "Home", url: "myapp://home" }, { url: "myapp://x", platform: "ios" }] }, null, 2)}\n`,
    );
  });

  it("finds links by number, URL or name", () => {
    const links = [{ url: "a://1", name: "Home" }, { url: "a://2" }];
    expect([findLink(links, "2"), findLink(links, "a://2"), findLink(links, "home"), findLink(links, "nope")]).toEqual([1, 1, 0, -1]);
  });

  it("suggests one example link per pattern", () => {
    expect(suggestLinks(runScan(fixture("bare-rn"))!)).toEqual([
      { name: "bareapp:// scheme", url: "bareapp://" },
      { name: "App Link example.com/product", url: "https://example.com/product/example" },
      { name: "App Link www.example.com/product", url: "https://www.example.com/product/example" },
    ]);
    expect(suggestLinks(runScan(fixture("expo-managed"))!).map((l) => l.url)).toEqual(["shop://", "https://shop.example.com/p/example"]);
  });
});

describe("links commands", () => {
  it("adds, refuses duplicates and bad URLs, and removes", () => {
    linksAddCommand("myapp://home", { cwd: dir, name: "Home" });
    linksAddCommand("https://example.com/p/1", { cwd: dir, platform: "android" });
    expect(fileJson().links).toEqual([{ name: "Home", url: "myapp://home" }, { url: "https://example.com/p/1", platform: "android" }]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Commit the file"));

    linksAddCommand("myapp://home", { cwd: dir });
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("already saved"));
    linksAddCommand("example.com", { cwd: dir });
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("isn't a full URL"));
    expect(process.exitCode).toBe(1);

    linksRemoveCommand("home", { cwd: dir });
    expect(fileJson().links).toEqual([{ url: "https://example.com/p/1", platform: "android" }]);
  });

  it("creates the file from the project once, unless forced", () => {
    project("bare-rn");
    linksInitCommand({ cwd: dir });
    expect(fileJson().links).toHaveLength(3);
    linksInitCommand({ cwd: dir });
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("already exists. Pass --force"));
  });
});

describe("test --all", () => {
  it("tests every saved link and summarises them", async () => {
    project("bare-rn");
    writeLinks(dir, [
      { name: "Home", url: "bareapp://home" },
      { name: "Product", url: "https://example.com/product/1" },
      { name: "Old item", url: "https://example.com/item/1" },
      { name: "iOS only", url: "https://example.com/item/2", platform: "ios" },
    ]);
    const result = await runTestAll({ cwd: dir });
    if ("error" in result) throw new Error(result.error);
    const status = result.links.map(({ link, report }) => [link.name, report.platforms.map((p) => `${p.platform}:${p.checks.some((c) => c.level === "error") ? "✖" : "✔"}`).join(" ")]);
    expect(status).toEqual([
      ["Home", "ios:✔ android:✔"],
      ["Product", "ios:✔ android:✔"],
      ["Old item", "ios:✔ android:✖"],
      ["iOS only", "ios:✔"],
    ]);
    const text = formatTestAll(result);
    expect(text).toContain("1 of 4 links won't open the app everywhere they should.");
    expect(text).toContain("Old item: ");
    expect(text).not.toContain("Product: ");
  });

  it("explains a missing file", async () => {
    expect(await runTestAll({ cwd: dir })).toEqual({ error: expect.stringContaining("No .deeplinks.json") });
  });
});

describe("open --all", () => {
  const simulators = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "SIM-1", name: "iPhone 16", state: "Booted" }] } });
  const fakeExec = (calls: string[]): Exec => async (file, args): Promise<ExecResult> => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    if (line.includes("simctl list")) return { stdout: simulators, stderr: "", exitCode: 0 };
    if (line.includes("devices -l")) return { stdout: "List of devices attached\nemulator-5554 device model:Pixel_8\n", stderr: "", exitCode: 0 };
    if (line.includes("am start")) return { stdout: "Status: ok\nActivity: com.example.bareapp/.MainActivity\n", stderr: "", exitCode: 0 };
    if (line.includes("get-app-links")) return { stdout: "  com.example.bareapp:\n    Domain verification state:\n      example.com: verified\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  it("opens each link in turn on the same devices, honouring platform-only links", async () => {
    writeLinks(dir, [{ url: "bareapp://home" }, { url: "https://example.com/product/1", platform: "android" }, { url: "bareapp://cart", platform: "ios" }]);
    const calls: string[] = [];
    const waits: number[] = [];
    const seen: string[] = [];
    const result = await runOpenAll(
      { cwd: dir, delay: 500 },
      { exec: fakeExec(calls), hostPlatform: "darwin", adbPath: "adb", scan: () => runScan(fixture("bare-rn")), sleep: async (ms) => void waits.push(ms) },
      (index, total, link) => seen.push(`${index + 1}/${total} ${link.url}`),
    );
    if ("error" in result) throw new Error(result.error);
    expect(seen).toEqual(["1/3 bareapp://home", "2/3 https://example.com/product/1", "3/3 bareapp://cart"]);
    expect(result.links.map(({ report }) => report.devices.map((d) => d.platform))).toEqual([["ios", "android"], ["android"], ["ios"]]);
    expect(calls.filter((c) => c.includes("simctl list") || c.includes("devices -l"))).toHaveLength(2);
    expect(waits).toEqual([500, 500]);
  });

  it("only looks for devices on platforms the links use, and can wait for Enter", async () => {
    writeLinks(dir, [{ url: "bareapp://a", platform: "ios" }, { url: "bareapp://b", platform: "ios" }]);
    const calls: string[] = [];
    let presses = 0;
    const result = await runOpenAll(
      { cwd: dir, step: true },
      { exec: fakeExec(calls), hostPlatform: "darwin", scan: () => null, waitForNext: async () => void presses++ },
    );
    expect("error" in result).toBe(false);
    expect(calls.some((c) => c.includes("devices -l"))).toBe(false);
    expect(presses).toBe(1);
  });
});
