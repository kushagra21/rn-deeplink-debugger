import { describe, expect, it } from "vitest";
import { runOpen, type OpenDeps, type OpenOptions } from "../src/commands/open.js";
import { parseAppLinks, shellQuote } from "../src/devices/android.js";
import { ToolMissingError, type Exec, type ExecResult } from "../src/devices/exec.js";
import { runtimeLabel } from "../src/devices/ios.js";
import type { Check, OpenReport, ScanResult } from "../src/types.js";

const PACKAGE = "com.example.shop";
const SIGNATURE = Array.from({ length: 32 }, () => "AB").join(":");

const simulators = (...devices: { udid: string; name: string }[]) =>
  JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": devices.map((d) => ({ ...d, state: "Booted", isAvailable: true })),
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [],
    },
  });

const adbDevices = (...lines: string[]) => ["List of devices attached", ...lines, ""].join("\n");
const PIXEL = "emulator-5554          device product:sdk_gphone64_arm64 model:Pixel_8 device:emu64a transport_id:1";

const appLinks = (state: string) => `  ${PACKAGE}:
    ID: 6f2a1f2e-0000-4000-8000-000000000000
    Signatures: [${SIGNATURE}]
    Domain verification state:
      shop.example.com: ${state}
`;

const started = (activity: string) => `Starting: Intent { act=android.intent.action.VIEW }
Status: ok
LaunchState: COLD
Activity: ${activity}
TotalTime: 812
WaitTime: 815
Complete
`;

type Handler = (args: string[]) => Partial<ExecResult> | "missing";

/** A fake command runner: the first handler whose key is contained in the command line answers. */
function fakeExec(handlers: Record<string, Handler | Partial<ExecResult> | "missing">, calls: string[][] = []): Exec {
  return async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push([file, ...args]);
    for (const [key, handler] of Object.entries(handlers)) {
      if (!line.includes(key)) continue;
      const result = typeof handler === "function" ? handler(args) : handler;
      if (result === "missing") throw new ToolMissingError(file);
      return { stdout: "", stderr: "", exitCode: 0, ...result };
    }
    throw new Error(`unexpected command: ${line}`);
  };
}

const scan = { android: { packageNames: [PACKAGE] } } as ScanResult;

async function open(url: string, handlers: Parameters<typeof fakeExec>[0], options: Partial<OpenOptions> = {}, deps: OpenDeps = {}, calls?: string[][]) {
  const result = await runOpen(url, { cwd: "/project", ...options }, {
    exec: fakeExec(handlers, calls),
    hostPlatform: "darwin",
    adbPath: "adb",
    scan: () => scan,
    pick: async () => null,
    reverifyDelayMs: 0,
    ...deps,
  });
  return result;
}

const report = (result: OpenReport | { error: string }) => {
  if ("error" in result) throw new Error(result.error);
  return result;
};
const messages = (checks: Check[], level: Check["level"]) => checks.filter((c) => c.level === level).map((c) => c.message);

describe("open on both platforms", () => {
  it("opens a custom scheme on the booted simulator and emulator", async () => {
    const calls: string[][] = [];
    const result = report(
      await open(
        "shop://product/42",
        {
          "simctl list": { stdout: simulators({ udid: "SIM-1", name: "iPhone 16 Pro" }) },
          "simctl openurl": {},
          "devices -l": { stdout: adbDevices(PIXEL) },
          "am start": { stdout: started(`${PACKAGE}/.MainActivity`) },
        },
        {},
        {},
        calls,
      ),
    );
    expect(result.devices.map((d) => [d.platform, d.device, messages(d.checks, "pass")])).toEqual([
      ["ios", "iPhone 16 Pro (iOS 18.2)", ["Opened shop://product/42"]],
      ["android", "Pixel 8 (emulator)", [`Opened in ${PACKAGE}/.MainActivity (cold start, 812 ms)`]],
    ]);
    expect(calls).toContainEqual(["xcrun", "simctl", "openurl", "SIM-1", "shop://product/42"]);
    expect(calls.find((c) => c.includes("am"))).toEqual([
      "adb", "-s", "emulator-5554", "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
      "-c", "android.intent.category.BROWSABLE", "-d", "'shop://product/42'",
    ]);
  });

  it("skips a platform whose tooling is missing, with a note", async () => {
    const result = report(
      await open("shop://home", {
        "simctl list": { stdout: simulators({ udid: "SIM-1", name: "iPhone 16" }) },
        "simctl openurl": {},
        "devices -l": "missing",
      }),
    );
    expect(result.devices.map((d) => d.platform)).toEqual(["ios"]);
    expect(messages(result.checks, "info")).toEqual([expect.stringContaining("Android skipped: adb isn't installed")]);
  });

  it("fails with boot hints when nothing is running", async () => {
    const result = await open("shop://home", { "simctl list": { stdout: simulators() }, "devices -l": { stdout: adbDevices() } });
    expect(result).toEqual({ error: expect.stringMatching(/iOS: nothing is running\. Start one with `open -a Simulator`[\s\S]*emulator -avd/) });
  });

  it("explains iOS simulators need a Mac", async () => {
    const result = await open("shop://home", {}, { platform: "ios" }, { hostPlatform: "linux" });
    expect(result).toEqual({ error: expect.stringContaining("iOS simulators need macOS with Xcode") });
  });

  it("rejects a URL without a scheme", async () => {
    expect(await open("example.com/x", {})).toEqual({ error: expect.stringContaining("Include the scheme, e.g. myapp://home or https://example.com/x") });
  });
});

describe("choosing a device", () => {
  const handlers = {
    "simctl list": { stdout: simulators({ udid: "SIM-1", name: "iPhone 16" }, { udid: "SIM-2", name: "iPad Pro" }) },
    "simctl openurl": {},
  };

  it("asks for --device when several are running and there's no terminal", async () => {
    const result = await open("shop://home", handlers, { platform: "ios" });
    expect(result).toEqual({ error: expect.stringContaining("Several iOS devices are running: iPhone 16 (iOS 18.2) [SIM-1], iPad Pro (iOS 18.2) [SIM-2]") });
  });

  it("uses the picked device", async () => {
    const result = report(await open("shop://home", handlers, { platform: "ios" }, { pick: async () => 1 }));
    expect(result.devices[0]!.device).toBe("iPad Pro (iOS 18.2)");
  });

  it("matches --device by name or id", async () => {
    expect(report(await open("shop://home", handlers, { platform: "ios", device: "ipad" })).devices[0]!.device).toBe("iPad Pro (iOS 18.2)");
    expect(report(await open("shop://home", handlers, { platform: "ios", device: "SIM-1" })).devices[0]!.device).toBe("iPhone 16 (iOS 18.2)");
    expect(await open("shop://home", handlers, { platform: "ios", device: "pixel" })).toEqual({ error: expect.stringContaining('No running device matches "pixel"') });
  });

  it("reports unauthorized Android devices", async () => {
    const result = report(
      await open("shop://home", { "devices -l": { stdout: adbDevices("R5CT1234 unauthorized usb:1-1", PIXEL) }, "am start": { stdout: started(`${PACKAGE}/.MainActivity`) } }, { platform: "android" }),
    );
    expect(messages(result.checks, "warning")).toEqual(["R5CT1234 can't be used: accept the USB debugging prompt on the device."]);
  });
});

describe("iOS results", () => {
  const ios = (openurl: Partial<ExecResult>, url = "shop://home") =>
    open(url, { "simctl list": { stdout: simulators({ udid: "SIM-1", name: "iPhone 16" }) }, "simctl openurl": openurl }, { platform: "ios" });

  it("explains when no app registers the scheme", async () => {
    const result = report(
      await ios({ exitCode: 1, stderr: 'An error was encountered processing the command (domain=NSOSStatusErrorDomain, code=-10814):\nSimulator device failed to open shop://home.' }),
    );
    expect(messages(result.devices[0]!.checks, "error")).toEqual(["No app on iPhone 16 handles shop:// URLs."]);
  });

  it("adds a hint for universal links", async () => {
    const result = report(await ios({}, "https://shop.example.com/p/1"));
    expect(result.devices[0]!.checks[1]).toMatchObject({ level: "info", fix: expect.stringContaining("applinks:shop.example.com?mode=developer") });
  });
});

describe("Android results", () => {
  const android = (handlers: Parameters<typeof fakeExec>[0], url = "https://shop.example.com/p/1", options: Partial<OpenOptions> = {}, calls?: string[][]) =>
    open(url, { "devices -l": { stdout: adbDevices(PIXEL) }, ...handlers }, { platform: "android", ...options }, {}, calls);
  const checks = async (...args: Parameters<typeof android>) => report(await android(...args)).devices[0]!.checks;

  it("passes when the app opens a verified App Link", async () => {
    const result = await checks({ "am start": { stdout: started(`${PACKAGE}/.MainActivity`) }, "get-app-links": { stdout: appLinks("verified") } });
    expect(messages(result, "pass")).toEqual([`Opened in ${PACKAGE}/.MainActivity (cold start, 812 ms)`, "App Link for shop.example.com is verified"]);
  });

  it("explains a link that opened in the browser because verification failed", async () => {
    const result = await checks({ "am start": { stdout: started("com.android.chrome/com.google.android.apps.chrome.IntentDispatcher") }, "get-app-links": { stdout: appLinks("1024") } });
    expect(messages(result, "error")).toEqual([
      `Opened in com.android.chrome instead of ${PACKAGE}.`,
      "App Link for shop.example.com is verification failed (Android couldn't confirm assetlinks.json).",
    ]);
    expect(result.at(-1)!.fix).toContain(`This build is signed with ${SIGNATURE}, so assetlinks.json must list that fingerprint.`);
  });

  it("recognises the app chooser", async () => {
    const result = await checks({ "am start": { stdout: started("android/com.android.internal.app.ResolverActivity") }, "get-app-links": { stdout: appLinks("none") } });
    expect(messages(result, "error")).toEqual(["Android showed an app chooser instead of opening one app."]);
    expect(messages(result, "warning")).toEqual(["App Link for shop.example.com is not verified yet; verification may still be running."]);
  });

  it("reports intents nothing handles", async () => {
    const result = await checks({ "am start": { stdout: "Starting: Intent { }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW }" } }, "shop://home");
    expect(messages(result, "error")).toEqual(["Nothing on Pixel 8 handles shop://home."]);
  });

  it("notes an app that was already in front", async () => {
    const result = await checks(
      { "am start": { stdout: "Warning: Activity not started, intent has been delivered to currently running top-most instance.\nStatus: ok\nLaunchState: UNKNOWN (0)\nActivity: com.example.shop/.MainActivity" } },
      "shop://home",
    );
    expect(messages(result, "pass")).toEqual(["Delivered to the app that was already in front (com.example.shop/.MainActivity)"]);
  });

  it("sends the intent straight to the app with --direct", async () => {
    const calls: string[][] = [];
    await android({ "am start": { stdout: started(`${PACKAGE}/.MainActivity`) } }, "https://shop.example.com/a?b=1&c='x'", { direct: true }, calls);
    const am = calls.find((c) => c.includes("am"))!;
    expect(am.slice(-2)).toEqual([`'https://shop.example.com/a?b=1&c='\\''x'\\'''`, PACKAGE]);
    expect(calls.some((c) => c.includes("get-app-links"))).toBe(false);
  });

  it("re-runs verification with --reverify", async () => {
    const calls: string[][] = [];
    let polls = 0;
    const result = await checks(
      {
        "verify-app-links": {},
        "get-app-links": () => ({ stdout: appLinks(++polls < 3 ? "none" : "verified") }),
        "am start": { stdout: started(`${PACKAGE}/.MainActivity`) },
      },
      undefined,
      { reverify: true },
      calls,
    );
    expect(calls.find((c) => c.includes("verify-app-links"))).toEqual(["adb", "-s", "emulator-5554", "shell", "pm", "verify-app-links", "--re-verify", PACKAGE]);
    expect(messages(result, "info")).toEqual([`Re-ran App Link verification for ${PACKAGE}`]);
    expect(messages(result, "pass")).toContain("App Link for shop.example.com is verified");
  });

  it("explains get-app-links needs Android 12", async () => {
    const result = await checks({ "am start": { stdout: started(`${PACKAGE}/.MainActivity`) }, "get-app-links": { stdout: "Unknown command: get-app-links", exitCode: 255 } });
    expect(messages(result, "info")).toEqual(["Couldn't read App Link verification state: pm get-app-links needs Android 12 or newer."]);
  });
});

describe("helpers", () => {
  it("labels simulator runtimes", () => {
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-18-2")).toBe("iOS 18.2");
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.watchOS-11-0")).toBe("watchOS 11.0");
  });

  it("parses pm get-app-links output", () => {
    expect(parseAppLinks(`${appLinks("verified")}    User 0:\n      Verification link handling allowed: true\n`)).toEqual({
      domains: { "shop.example.com": "verified" },
      signatures: [SIGNATURE],
    });
  });

  it("quotes URLs for the device shell", () => {
    expect(shellQuote("https://x.com/?a=1&b=2")).toBe("'https://x.com/?a=1&b=2'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
