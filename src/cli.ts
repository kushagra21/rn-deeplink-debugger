import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { openCommand } from "./commands/open.js";
import { scanCommand } from "./commands/scan.js";
import { verifyCommand } from "./commands/verify.js";
import { notImplemented } from "./report/format.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("rn-deeplink")
    .description("Debug deep links and universal/app links in React Native apps.")
    .version(version);

  program
    .command("scan")
    .description("Read the project's iOS, Android and Expo link config (works offline)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .option("--json", "print machine-readable JSON")
    .action(scanCommand);

  program
    .command("verify")
    .description("Check apple-app-site-association and assetlinks.json for your domains")
    .argument("[domains...]", "domains to check (default: every domain the project uses)")
    .option("-C, --cwd <dir>", "project root, used to find the expected app IDs", process.cwd())
    .option("-p, --platform <platform>", "ios | android | both", "both")
    .option("--team-id <id>", "Apple team ID (default: from the Xcode project)")
    .option("--bundle-id <ids...>", "iOS bundle IDs (default: from the project)")
    .option("--package <names...>", "Android package names (default: from the project)")
    .option("--sha256 <fingerprints...>", "signing certificate fingerprints assetlinks.json must include")
    .option("--path <paths...>", "paths that should open the app, checked against the AASA rules")
    .option("--no-cdn", "don't compare with Apple's CDN copy")
    .option("--json", "print machine-readable JSON")
    .action(verifyCommand);

  program
    .command("open")
    .description("Open a URL on a booted iOS simulator and/or Android emulator or device")
    .argument("[url]", "URL to open, e.g. myapp://product/42 or https://example.com/product/42")
    .option("-C, --cwd <dir>", "project root, used to find the Android package", process.cwd())
    .option("-p, --platform <platform>", "ios | android | both", "both")
    .option("-d, --device <id or name>", "device to use when several are running")
    .option("--package <name>", "Android package to check against (default: from the project)")
    .option("--direct", "Android: send the intent straight to the app, skipping verification and the app chooser")
    .option("--reverify", "Android: re-run App Link verification before opening")
    .option("--all", "open every saved link from .deeplinks.json")
    .option("--json", "print machine-readable JSON")
    .action(openCommand);

  program
    .command("test")
    .description("Explain which link patterns a URL matches on each platform")
    .argument("<url>", "URL to test")
    .option("--json", "print machine-readable JSON")
    .action(() => notImplemented("test"));

  return program;
}

// Only parse argv when run as a binary (including through an npm .bin symlink), so tests can import buildProgram.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  await buildProgram().parseAsync(process.argv);
}
