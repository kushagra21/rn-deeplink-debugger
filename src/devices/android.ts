import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Check } from "../types.js";
import { DeviceToolError, ToolMissingError, lastLine, type Device, type Exec } from "./exec.js";

export interface AppLinkState {
  /** host → state, as printed by `pm get-app-links` (e.g. "verified", "1024"). */
  domains: Record<string, string>;
  /** SHA-256 fingerprints of the installed build's signing certificate. */
  signatures: string[];
}

const RESOLVERS = ["com.android.internal.app.ResolverActivity", "com.android.intentresolver"];

/** adb from ANDROID_HOME / ANDROID_SDK_ROOT, the default SDK locations, then PATH. */
export function findAdb(env = process.env, home = homedir()): string {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const sdks = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(home, "Library", "Android", "sdk"),
    join(home, "Android", "Sdk"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android", "Sdk"),
  ];
  return sdks.map((sdk) => sdk && join(sdk, "platform-tools", exe)).find((path): path is string => !!path && existsSync(path)) ?? "adb";
}

async function adb(run: Exec, adbPath: string, args: string[]) {
  try {
    return await run(adbPath, args);
  } catch (error) {
    if (error instanceof ToolMissingError) {
      throw new DeviceToolError("adb isn't installed. Install Android Studio (or the SDK Platform-Tools), or set ANDROID_HOME to your SDK.");
    }
    throw error;
  }
}

/** Single-quote a value for the device shell, since `adb shell` joins arguments into one command line. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export async function listAndroidDevices(run: Exec, adbPath: string): Promise<{ devices: Device[]; unusable: string[] }> {
  const result = await adb(run, adbPath, ["devices", "-l"]);
  if (result.exitCode !== 0) throw new DeviceToolError(`adb failed: ${lastLine(result.stderr)}`);
  const devices: Device[] = [];
  const unusable: string[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, id, state, props] = m as unknown as [string, string, string, string];
    if (state !== "device") {
      const why = state === "unauthorized" ? "accept the USB debugging prompt on the device" : `it is ${state}`;
      unusable.push(`${id} can't be used: ${why}.`);
      continue;
    }
    const model = /\bmodel:(\S+)/.exec(props)?.[1]?.replaceAll("_", " ");
    devices.push({ platform: "android", id, name: model ?? id, detail: id.startsWith("emulator-") ? "emulator" : "device" });
  }
  return { devices, unusable };
}

/** Parse `adb shell pm get-app-links <package>` (Android 12+). */
export function parseAppLinks(output: string): AppLinkState {
  const signatures = (/Signatures:\s*\[([^\]]*)\]/.exec(output)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const domains: Record<string, string> = {};
  const section = output.split(/Domain verification state:/)[1] ?? "";
  for (const line of section.split("\n")) {
    const m = /^\s+([\w.*-]+):\s*(\S+)\s*$/.exec(line);
    if (m) domains[m[1]!] = m[2]!;
    else if (line.trim() && !/^\s/.test(line)) break;
  }
  return { domains, signatures };
}

export async function getAppLinkState(run: Exec, adbPath: string, device: Device, pkg: string): Promise<AppLinkState | { error: string }> {
  const result = await adb(run, adbPath, ["-s", device.id, "shell", "pm", "get-app-links", pkg]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (/Unknown command|Unknown option/i.test(output)) return { error: "pm get-app-links needs Android 12 or newer" };
  if (result.exitCode !== 0 || !result.stdout.trim()) return { error: `${pkg} isn't installed on ${device.name}` };
  return parseAppLinks(result.stdout);
}

const STATE_MEANING: Record<string, string> = {
  verified: "verified",
  approved: "approved by the user in settings",
  migrated: "verified on an older Android version",
  restored: "restored from a backup",
  system_configured: "set by the device configuration",
  none: "not verified yet; verification may still be running",
  denied: "turned off by the user in the app's settings",
  legacy_failure: "verification failed",
  "1024": "verification failed (Android couldn't confirm assetlinks.json)",
};

const isVerified = (state: string) => ["verified", "approved", "migrated", "restored", "system_configured"].includes(state);

/** Ask Android to re-run App Link verification, then wait until no domain is still pending. */
export async function reverifyAppLinks(
  run: Exec,
  adbPath: string,
  device: Device,
  pkg: string,
  { attempts = 15, delayMs = 1000 } = {},
): Promise<Check[]> {
  const result = await adb(run, adbPath, ["-s", device.id, "shell", "pm", "verify-app-links", "--re-verify", pkg]);
  if (result.exitCode !== 0 || /Unknown|Error|Exception/i.test(result.stdout + result.stderr)) {
    return [{ level: "warning", message: `Couldn't re-run App Link verification: ${lastLine(result.stderr || result.stdout) || "pm verify-app-links failed"}.` }];
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const state = await getAppLinkState(run, adbPath, device, pkg);
    if ("error" in state || !Object.values(state.domains).includes("none")) break;
  }
  return [{ level: "info", message: `Re-ran App Link verification for ${pkg}` }];
}

export interface AndroidOpenOptions {
  /** The app's package, used to tell whether the app or something else handled the link. */
  appPackage?: string;
  /** Send the intent straight to appPackage, skipping verification and the chooser. */
  direct?: boolean;
}

export async function openOnAndroid(run: Exec, adbPath: string, device: Device, url: string, options: AndroidOpenOptions = {}): Promise<Check[]> {
  const { appPackage, direct } = options;
  // BROWSABLE makes the intent look like a link tapped in a browser, so filters missing it fail here too.
  const args = ["-s", device.id, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-c", "android.intent.category.BROWSABLE", "-d", shellQuote(url)];
  if (direct && appPackage) args.push(appPackage);
  const result = await adb(run, adbPath, args);
  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = new URL(url);
  const isWeb = parsed.protocol === "http:" || parsed.protocol === "https:";

  if (/unable to resolve Intent|Activity not started, unable/i.test(output)) {
    return [
      {
        level: "error",
        message: `Nothing on ${device.name} handles ${url}${direct && appPackage ? ` in ${appPackage}` : ""}.`,
        fix: "Check the app is installed and has a matching intent filter with the BROWSABLE and DEFAULT categories (rn-deeplink scan).",
      },
    ];
  }
  if (result.exitCode !== 0 && !/Status: ok/.test(output)) {
    return [{ level: "error", message: `adb couldn't open the URL: ${lastLine(result.stderr || result.stdout)}` }];
  }

  const checks: Check[] = [];
  const component = /^Activity: (\S+)/m.exec(output)?.[1];
  const handledBy = component?.split("/")[0];
  const launch = /^LaunchState: (\w+)/m.exec(output)?.[1]?.toLowerCase();
  const time = /^TotalTime: (\d+)/m.exec(output)?.[1];
  const timing = launch && launch !== "unknown" ? ` (${launch} start${time ? `, ${time} ms` : ""})` : "";

  if (/intent has been delivered to currently running top-most instance/.test(output)) {
    checks.push({ level: "pass", message: `Delivered to the app that was already in front${component ? ` (${component})` : ""}` });
  } else if (component && RESOLVERS.some((r) => component.includes(r))) {
    checks.push({
      level: isWeb ? "error" : "warning",
      message: "Android showed an app chooser instead of opening one app.",
      fix: isWeb
        ? "The App Link isn't verified for this domain. See the verification state below."
        : "More than one installed app registers this scheme. Use a scheme unique to your app.",
    });
  } else if (appPackage && handledBy && handledBy !== appPackage) {
    checks.push({
      level: "error",
      message: `Opened in ${handledBy} instead of ${appPackage}.`,
      fix: isWeb ? "The App Link isn't verified for this domain. See the verification state below." : "Another app registers this scheme. Use a scheme unique to your app.",
    });
  } else {
    checks.push({ level: "pass", message: `Opened in ${component ?? "the app"}${timing}` });
  }

  if (isWeb && appPackage && !direct) checks.push(...(await appLinkChecks(run, adbPath, device, appPackage, parsed.hostname)));
  return checks;
}

async function appLinkChecks(run: Exec, adbPath: string, device: Device, pkg: string, host: string): Promise<Check[]> {
  const state = await getAppLinkState(run, adbPath, device, pkg);
  if ("error" in state) return [{ level: "info", message: `Couldn't read App Link verification state: ${state.error}.` }];
  const value = state.domains[host];
  if (value === undefined) {
    return [
      {
        level: "warning",
        message: `The installed ${pkg} doesn't declare ${host} as an App Link host.`,
        fix: 'Add an intent filter for this host with android:autoVerify="true", rebuild and reinstall.',
      },
    ];
  }
  if (isVerified(value)) return [{ level: "pass", message: `App Link for ${host} is ${STATE_MEANING[value] ?? value}` }];
  const signature = state.signatures[0];
  return [
    {
      level: value === "none" ? "warning" : "error",
      message: `App Link for ${host} is ${STATE_MEANING[value] ?? `in state "${value}"`}.`,
      fix: [
        `Run rn-deeplink verify ${host}.`,
        signature && `This build is signed with ${signature}, so assetlinks.json must list that fingerprint.`,
        "Then run this again with --reverify.",
      ]
        .filter(Boolean)
        .join(" "),
    },
  ];
}
