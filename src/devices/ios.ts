import type { Check } from "../types.js";
import { DeviceToolError, ToolMissingError, lastLine, type Device, type Exec } from "./exec.js";

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` → `iOS 18.2` */
export function runtimeLabel(runtime: string): string {
  const name = runtime.replace(/^.*SimRuntime\./, "");
  const m = /^(\w+?)-(\d+)-(\d+)$/.exec(name);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : name;
}

async function simctl(run: Exec, args: string[]) {
  try {
    return await run("xcrun", ["simctl", ...args]);
  } catch (error) {
    if (error instanceof ToolMissingError) throw new DeviceToolError("xcrun isn't available. Install Xcode from the App Store.");
    throw error;
  }
}

export async function listBootedSimulators(run: Exec, hostPlatform: NodeJS.Platform = process.platform): Promise<Device[]> {
  if (hostPlatform !== "darwin") throw new DeviceToolError("iOS simulators need macOS with Xcode.");
  const result = await simctl(run, ["list", "devices", "booted", "--json"]);
  if (result.exitCode !== 0) {
    const missing = /unable to find utility "simctl"|xcode-select/i.test(result.stderr);
    throw new DeviceToolError(
      missing
        ? "simctl isn't available, usually because the command line tools point at CommandLineTools instead of Xcode. Run: sudo xcode-select -s /Applications/Xcode.app"
        : `simctl failed: ${lastLine(result.stderr)}`,
    );
  }
  const json = JSON.parse(result.stdout) as { devices?: Record<string, { udid: string; name: string; state: string }[]> };
  return Object.entries(json.devices ?? {}).flatMap(([runtime, devices]) =>
    devices.filter((d) => d.state === "Booted").map((d) => ({ platform: "ios" as const, id: d.udid, name: d.name, detail: runtimeLabel(runtime) })),
  );
}

export async function openOnSimulator(run: Exec, device: Device, url: string): Promise<Check[]> {
  const result = await simctl(run, ["openurl", device.id, url]);
  const scheme = new URL(url).protocol.slice(0, -1);
  if (result.exitCode === 0) {
    const checks: Check[] = [{ level: "pass", message: `Opened ${url}` }];
    if (scheme === "http" || scheme === "https") {
      checks.push({
        level: "info",
        message: "If Safari opened instead of your app, iOS hasn't associated the app with this domain.",
        fix: `Run rn-deeplink verify ${new URL(url).host}. While developing, use applinks:${new URL(url).host}?mode=developer so the simulator reads the file from your server instead of Apple's CDN.`,
      });
    }
    return checks;
  }
  // -10814 is kLSApplicationNotFoundErr: no installed app registers this scheme.
  if (/-10814|LSApplicationWorkspaceErrorDomain/.test(result.stderr)) {
    return [
      {
        level: "error",
        message: `No app on ${device.name} handles ${scheme}:// URLs.`,
        fix: "Install a build that registers the scheme (rebuild after changing Info.plist or app.json), and check the scheme with rn-deeplink scan.",
      },
    ];
  }
  return [{ level: "error", message: `simctl couldn't open the URL: ${lastLine(result.stderr)}` }];
}
