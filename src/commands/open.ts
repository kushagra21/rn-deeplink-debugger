import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { findAdb, listAndroidDevices, openOnAndroid, reverifyAppLinks } from "../devices/android.js";
import { DeviceToolError, exec, type Device, type Exec } from "../devices/exec.js";
import { listBootedSimulators, openOnSimulator } from "../devices/ios.js";
import { formatOpen, notImplemented } from "../report/format.js";
import type { Check, DeviceReport, OpenReport, Platform, ScanResult } from "../types.js";
import { runScan } from "./scan.js";

export interface OpenOptions {
  cwd: string;
  platform?: "ios" | "android" | "both";
  device?: string;
  package?: string;
  direct?: boolean;
  reverify?: boolean;
  all?: boolean;
  json?: boolean;
}

export interface OpenDeps {
  exec?: Exec;
  hostPlatform?: NodeJS.Platform;
  adbPath?: string;
  scan?: (root: string) => ScanResult | null;
  /** Ask the user to pick a device; returns the index, or null when there's no terminal to ask in. */
  pick?: (platform: Platform, devices: Device[]) => Promise<number | null>;
  reverifyDelayMs?: number;
}

const PLATFORM_NAME: Record<Platform, string> = { ios: "iOS", android: "Android" };

const BOOT_HINT: Record<Platform, string> = {
  ios: "Start one with `open -a Simulator`, or `xcrun simctl boot \"iPhone 16\"`.",
  android: "Start an emulator with `emulator -avd <name>` (list them with `emulator -list-avds`), or connect a device with USB debugging on.",
};

export const deviceLabel = (device: Device) => `${device.name}${device.detail ? ` (${device.detail})` : ""}`;

async function pickInTerminal(platform: Platform, devices: Device[]): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  console.log(`Several ${PLATFORM_NAME[platform]} devices are running:`);
  devices.forEach((d, i) => console.log(`  ${i + 1}) ${deviceLabel(d)}  ${pc.dim(d.id)}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = Number((await rl.question(`Open on which one? [1-${devices.length}] `)).trim());
      if (Number.isInteger(answer) && answer >= 1 && answer <= devices.length) return answer - 1;
    }
  } finally {
    rl.close();
  }
}

export async function runOpen(url: string, options: OpenOptions, deps: OpenDeps = {}): Promise<OpenReport | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `"${url}" isn't a full URL. Include the scheme, e.g. myapp://home or https://${url}` };
  }
  const run = deps.exec ?? exec;
  const adbPath = deps.adbPath ?? findAdb();
  const pick = deps.pick ?? pickInTerminal;
  const platformOption = options.platform ?? "both";
  const wanted: Platform[] = platformOption === "both" ? ["ios", "android"] : [platformOption];
  const scan = (deps.scan ?? runScan)(resolve(options.cwd));
  const appPackage = options.package ?? scan?.android?.packageNames[0];

  // Find running devices on each platform. A platform that wasn't asked for explicitly is skipped quietly.
  const checks: Check[] = [];
  const candidates: Device[] = [];
  const problems: string[] = [];
  for (const platform of wanted) {
    try {
      if (platform === "ios") candidates.push(...(await listBootedSimulators(run, deps.hostPlatform)));
      else {
        const { devices, unusable } = await listAndroidDevices(run, adbPath);
        candidates.push(...devices);
        for (const message of unusable) checks.push({ level: "warning", message });
      }
    } catch (error) {
      if (!(error instanceof DeviceToolError)) throw error;
      problems.push(`${PLATFORM_NAME[platform]}: ${error.message}`);
      checks.push({ level: "info", message: `${PLATFORM_NAME[platform]} skipped: ${error.message}` });
    }
  }

  let chosen: Device[];
  if (options.device) {
    const query = options.device.toLowerCase();
    const matches = candidates.filter((d) => d.id.toLowerCase() === query || d.name.toLowerCase().includes(query));
    if (matches.length === 0) {
      const running = candidates.map((d) => `${deviceLabel(d)} [${d.id}]`).join(", ") || "none";
      return { error: `No running device matches "${options.device}". Running: ${running}.` };
    }
    chosen = matches.filter((d, i) => matches.findIndex((m) => m.platform === d.platform) === i);
  } else {
    chosen = [];
    for (const platform of wanted) {
      const devices = candidates.filter((d) => d.platform === platform);
      if (devices.length === 0) {
        if (!problems.some((p) => p.startsWith(PLATFORM_NAME[platform]))) {
          problems.push(`${PLATFORM_NAME[platform]}: nothing is running. ${BOOT_HINT[platform]}`);
          checks.push({ level: "info", message: `No ${PLATFORM_NAME[platform]} ${platform === "ios" ? "simulator" : "device or emulator"} is running. ${BOOT_HINT[platform]}` });
        }
        continue;
      }
      if (devices.length === 1) {
        chosen.push(devices[0]!);
        continue;
      }
      const index = await pick(platform, devices);
      if (index === null) {
        return {
          error: `Several ${PLATFORM_NAME[platform]} devices are running: ${devices.map((d) => `${deviceLabel(d)} [${d.id}]`).join(", ")}. Pick one with --device <id or name>.`,
        };
      }
      chosen.push(devices[index]!);
    }
  }
  if (chosen.length === 0) return { error: `Nothing to open the link on.\n  ${problems.join("\n  ")}` };

  const reports: DeviceReport[] = [];
  for (const device of chosen) {
    const deviceChecks: Check[] = [];
    if (device.platform === "ios") deviceChecks.push(...(await openOnSimulator(run, device, url)));
    else {
      if (!appPackage && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
        deviceChecks.push({ level: "info", message: "Pass --package (or run this in your project) to check which app handled the link and its App Link verification." });
      }
      if (options.reverify && appPackage) {
        deviceChecks.push(...(await reverifyAppLinks(run, adbPath, device, appPackage, { delayMs: deps.reverifyDelayMs ?? 1000 })));
      }
      deviceChecks.push(...(await openOnAndroid(run, adbPath, device, url, { appPackage, direct: options.direct })));
    }
    reports.push({ platform: device.platform, device: deviceLabel(device), checks: deviceChecks });
  }
  return { url, checks, devices: reports };
}

export async function openCommand(url: string | undefined, options: OpenOptions): Promise<void> {
  if (options.all) notImplemented("open --all");
  if (!url) {
    console.error(`${pc.red("✖")} Pass a URL to open, e.g. rn-deeplink open myapp://home`);
    process.exitCode = 1;
    return;
  }
  const result = await runOpen(url, options);
  if ("error" in result) {
    console.error(`${pc.red("✖")} ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatOpen(result));
  if (result.devices.some((d) => d.checks.some((c) => c.level === "error"))) process.exitCode = 1;
}
