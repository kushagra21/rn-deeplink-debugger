import { createRequire } from "node:module";
import { Command } from "commander";
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
    .action(() => notImplemented("scan"));

  program
    .command("verify")
    .description("Check apple-app-site-association and assetlinks.json for a domain")
    .argument("<domain>", "domain to check, e.g. example.com")
    .option("--json", "print machine-readable JSON")
    .action(() => notImplemented("verify"));

  program
    .command("open")
    .description("Open a URL on a booted simulator, emulator or device")
    .argument("[url]", "URL to open")
    .option("-p, --platform <platform>", "ios | android | both", "both")
    .option("--all", "open every saved link from .deeplinks.json")
    .action(() => notImplemented("open"));

  program
    .command("test")
    .description("Explain which link patterns a URL matches on each platform")
    .argument("<url>", "URL to test")
    .option("--json", "print machine-readable JSON")
    .action(() => notImplemented("test"));

  return program;
}

// Only parse argv when run as a binary, so tests can import buildProgram.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("rn-deeplink")) {
  await buildProgram().parseAsync(process.argv);
}
