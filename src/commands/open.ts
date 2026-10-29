import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { findAdb, listAndroidDevices, openOnAndroid, reverifyAppLinks } from "../devices/android.js";
import { DeviceToolError, exec, type Device, type Exec } from "../devices/exec.js";
import { listBootedSimulators, openOnSimulator } from "../devices/ios.js";
import { LINKS_FILE, readLinks, type SavedLink } from "../links.js";
import { formatOpen } from "../report/format.js";
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
  /** --all: milliseconds to wait between links. */
  delay?: number;
  /** --all: wait for Enter between links. */
  step?: boolean;
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
  sleep?: (ms: number) => Promise<void>;
  /** --step: wait until the user wants the next link. */
  waitForNext?: () => Promise<void>;
}

export interface OpenAllReport {
  file: string;
  /** Notes not tied to one link, e.g. a platform that was skipped. */
  checks: Check[];
  links: { link: SavedLink; report: OpenReport }[];
}

const PLATFORM_NAME: Record<Platform, string> = { ios: "iOS", android: "Android" };

const BOOT_HINT: Record<Platform, string> = {
  ios: "Start one with `open -a Simulator`, or `xcrun simctl boot \"iPhone 16\"`.",
  android: "Start an emulator with `emulator -avd <name>` (list them with `emulator -list-avds`), or connect a device with USB debugging on.",
};

export const deviceLabel = (device: Device) => `${device.name}${device.detail ? ` (${device.detail})` : ""}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

async function enterInTerminal(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(pc.dim("Press Enter for the next link… "));
  } finally {
    rl.close();
  }
}

interface Context {
  run: Exec;
  adbPath: string;
  appPackage?: string;
  options: OpenOptions;
  deps: OpenDeps;
}

function context(options: OpenOptions, deps: OpenDeps): Context {
  const scan = (deps.scan ?? runScan)(resolve(options.cwd));
  return {
    run: deps.exec ?? exec,
    adbPath: deps.adbPath ?? findAdb(),
    appPackage: options.package ?? scan?.android?.packageNames[0],
    options,
    deps,
  };
}

/** Find the running devices to use: one per wanted platform, or the one --device names. */
async function selectDevices(wanted: Platform[], ctx: Context): Promise<{ devices: Device[]; checks: Check[] } | { error: string }> {
  const { run, adbPath, options, deps } = ctx;
  const pick = deps.pick ?? pickInTerminal;
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

  const devices: Device[] = [];
  if (options.device) {
    const query = options.device.toLowerCase();
    const matches = candidates.filter((d) => d.id.toLowerCase() === query || d.name.toLowerCase().includes(query));
    if (matches.length === 0) {
      const running = candidates.map((d) => `${deviceLabel(d)} [${d.id}]`).join(", ") || "none";
      return { error: `No running device matches "${options.device}". Running: ${running}.` };
    }
    devices.push(...matches.filter((d, i) => matches.findIndex((m) => m.platform === d.platform) === i));
  } else {
    for (const platform of wanted) {
      const running = candidates.filter((d) => d.platform === platform);
      if (running.length === 0) {
        if (!problems.some((p) => p.startsWith(PLATFORM_NAME[platform]))) {
          problems.push(`${PLATFORM_NAME[platform]}: nothing is running. ${BOOT_HINT[platform]}`);
          checks.push({ level: "info", message: `No ${PLATFORM_NAME[platform]} ${platform === "ios" ? "simulator" : "device or emulator"} is running. ${BOOT_HINT[platform]}` });
        }
        continue;
      }
      if (running.length === 1) {
        devices.push(running[0]!);
        continue;
      }
      const index = await pick(platform, running);
      if (index === null) {
        return {
          error: `Several ${PLATFORM_NAME[platform]} devices are running: ${running.map((d) => `${deviceLabel(d)} [${d.id}]`).join(", ")}. Pick one with --device <id or name>.`,
        };
      }
      devices.push(running[index]!);
    }
  }
  if (devices.length === 0) return { error: `Nothing to open the link on.\n  ${problems.join("\n  ")}` };
  return { devices, checks };
}

async function openOnDevices(url: string, devices: Device[], ctx: Context, reverify: boolean): Promise<DeviceReport[]> {
  const { run, adbPath, appPackage, options, deps } = ctx;
  const isWeb = /^https?:/i.test(url);
  const reports: DeviceReport[] = [];
  for (const device of devices) {
    const checks: Check[] = [];
    if (device.platform === "ios") checks.push(...(await openOnSimulator(run, device, url)));
    else {
      if (!appPackage && isWeb) {
        checks.push({ level: "info", message: "Pass --package (or run this in your project) to check which app handled the link and its App Link verification." });
      }
      if (reverify && appPackage) checks.push(...(await reverifyAppLinks(run, adbPath, device, appPackage, { delayMs: deps.reverifyDelayMs ?? 1000 })));
      checks.push(...(await openOnAndroid(run, adbPath, device, url, { appPackage, direct: options.direct })));
    }
    reports.push({ platform: device.platform, device: deviceLabel(device), checks });
  }
  return reports;
}

const wantedPlatforms = (option: OpenOptions["platform"]): Platform[] => (!option || option === "both" ? ["ios", "android"] : [option]);

const notAUrl = (url: string) => `"${url}" isn't a full URL. Include the scheme, e.g. myapp://home or https://${url}`;

export async function runOpen(url: string, options: OpenOptions, deps: OpenDeps = {}): Promise<OpenReport | { error: string }> {
  try {
    new URL(url);
  } catch {
    return { error: notAUrl(url) };
  }
  const ctx = context(options, deps);
  const selected = await selectDevices(wantedPlatforms(options.platform), ctx);
  if ("error" in selected) return selected;
  return { url, checks: selected.checks, devices: await openOnDevices(url, selected.devices, ctx, !!options.reverify) };
}

/** Open every saved link in turn on the same devices. `onLink` sees each result as it happens. */
export async function runOpenAll(
  options: OpenOptions,
  deps: OpenDeps = {},
  onLink?: (index: number, total: number, link: SavedLink, report: OpenReport) => void,
): Promise<OpenAllReport | { error: string }> {
  const root = resolve(options.cwd);
  const links = readLinks(root);
  if (links === null) return { error: `No ${LINKS_FILE} in ${root}. Create one with rn-deeplink links init, or add links with rn-deeplink links add <url>.` };
  if ("error" in links) return links;
  if (links.length === 0) return { error: `${LINKS_FILE} has no links. Add one with rn-deeplink links add <url>.` };

  // Only look for devices on platforms some link uses.
  const wanted = wantedPlatforms(options.platform).filter((p) => links.some((l) => !l.platform || l.platform === p));
  if (wanted.length === 0) return { error: `No saved link is for ${options.platform}.` };
  const ctx = context(options, deps);
  const selected = await selectDevices(wanted, ctx);
  if ("error" in selected) return selected;

  const results: OpenAllReport["links"] = [];
  for (const [index, link] of links.entries()) {
    const devices = selected.devices.filter((d) => !link.platform || d.platform === link.platform);
    // readLinks has already checked every URL parses.
    const checks: Check[] = [];
    if (devices.length === 0) checks.push({ level: "info", message: `Skipped: it's ${PLATFORM_NAME[link.platform!]}-only, and no ${PLATFORM_NAME[link.platform!]} device is in use.` });
    const report: OpenReport = { url: link.url, checks, devices: checks.length ? [] : await openOnDevices(link.url, devices, ctx, !!options.reverify && index === 0) };
    results.push({ link, report });
    onLink?.(index, links.length, link, report);
    if (index < links.length - 1) {
      if (options.step) await (deps.waitForNext ?? enterInTerminal)();
      else await (deps.sleep ?? sleep)(options.delay ?? 2000);
    }
  }
  return { file: LINKS_FILE, checks: selected.checks, links: results };
}

const hasError = (report: OpenReport) => [...report.checks, ...report.devices.flatMap((d) => d.checks)].some((c) => c.level === "error");

export async function openCommand(url: string | undefined, options: OpenOptions): Promise<void> {
  if (options.all) {
    if (url) console.error(pc.yellow(`Ignoring ${url}: --all opens the links saved in ${LINKS_FILE}.`));
    if (options.step && !process.stdin.isTTY) options.step = false;
    const result = await runOpenAll(options, {}, (index, total, link, report) => {
      if (options.json) return;
      const title = `${pc.dim(`[${index + 1}/${total}]`)} ${link.name ? `${pc.bold(link.name)} ` : ""}`;
      console.log(`${index ? "\n" : ""}${title}${formatOpen(report).replace(/^\S+ /, "")}`);
    });
    if ("error" in result) return fail(result.error);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      const failed = result.links.filter((l) => hasError(l.report)).length;
      const notes = result.checks.map((c) => `${pc.blue("ℹ")} ${c.message}`);
      console.log(["", ...notes, failed ? pc.red(`${failed} of ${result.links.length} links had problems.`) : pc.green(`✔ Opened all ${result.links.length} links.`)].join("\n"));
    }
    if (result.links.some((l) => hasError(l.report))) process.exitCode = 1;
    return;
  }

  if (!url) return fail(`Pass a URL to open (e.g. rn-deeplink open myapp://home), or --all to open the links in ${LINKS_FILE}.`);
  const result = await runOpen(url, options);
  if ("error" in result) return fail(result.error);
  console.log(options.json ? JSON.stringify(result, null, 2) : formatOpen(result));
  if (hasError(result)) process.exitCode = 1;
}

function fail(message: string): void {
  console.error(`${pc.red("✖")} ${message}`);
  process.exitCode = 1;
}
