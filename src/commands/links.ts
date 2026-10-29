import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { LINKS_FILE, findLink, linksPath, readLinks, suggestLinks, writeLinks, type SavedLink } from "../links.js";
import { parseLinkUrl } from "../match.js";
import type { Platform } from "../types.js";
import { runScan } from "./scan.js";

interface LinksOptions {
  cwd: string;
}

const fail = (message: string) => {
  console.error(`${pc.red("✖")} ${message}`);
  process.exitCode = 1;
};

/** Saved links, or an error already printed. A missing file is an empty list. */
function load(root: string): SavedLink[] | undefined {
  const links = readLinks(root);
  if (links && "error" in links) {
    fail(links.error);
    return undefined;
  }
  return links ?? [];
}

export function formatLinks(links: SavedLink[]): string {
  if (links.length === 0) return `No saved links. Add one with ${pc.bold("rn-deeplink links add <url>")}, or run ${pc.bold("rn-deeplink links init")}.`;
  const width = Math.max(...links.map((l) => (l.name ?? "").length));
  return [
    `${pc.bold(LINKS_FILE)} (${links.length} link${links.length === 1 ? "" : "s"})`,
    ...links.map((l, i) => `  ${pc.dim(`${i + 1}.`)} ${(l.name ?? "").padEnd(width)}  ${l.url}${l.platform ? pc.dim(`  ${l.platform} only`) : ""}`),
  ].join("\n");
}

export function linksListCommand(options: LinksOptions & { json?: boolean }): void {
  const links = load(resolve(options.cwd));
  if (links) console.log(options.json ? JSON.stringify(links, null, 2) : formatLinks(links));
}

export function linksAddCommand(url: string, options: LinksOptions & { name?: string; platform?: string }): void {
  const root = resolve(options.cwd);
  if (!parseLinkUrl(url)) return fail(`"${url}" isn't a full URL. Include the scheme, e.g. myapp://home or https://${url}`);
  if (options.platform && options.platform !== "ios" && options.platform !== "android") return fail('--platform must be "ios" or "android".');
  const links = load(root);
  if (!links) return;
  if (links.some((l) => l.url === url)) return fail(`${url} is already saved.`);
  const created = !existsSync(linksPath(root));
  writeLinks(root, [...links, { url, name: options.name, platform: options.platform as Platform | undefined }]);
  console.log(`${pc.green("✔")} Added ${url} to ${LINKS_FILE}${created ? ". Commit the file so your team shares the same test links." : "."}`);
}

export function linksRemoveCommand(target: string, options: LinksOptions): void {
  const root = resolve(options.cwd);
  const links = load(root);
  if (!links) return;
  const index = findLink(links, target);
  if (index < 0) return fail(`No saved link matches "${target}". Use its number, URL or name from rn-deeplink links list.`);
  const [removed] = links.splice(index, 1);
  writeLinks(root, links);
  console.log(`${pc.green("✔")} Removed ${removed!.url} from ${LINKS_FILE}.`);
}

export function linksInitCommand(options: LinksOptions & { force?: boolean }): void {
  const root = resolve(options.cwd);
  if (existsSync(linksPath(root)) && !options.force) return fail(`${LINKS_FILE} already exists. Pass --force to replace it.`);
  const scan = runScan(root);
  if (!scan) return fail("No React Native project here. Run this in your project root, or pass --cwd <dir>.");
  const links = suggestLinks(scan);
  if (links.length === 0) return fail("The project has no deep links to suggest. Add links with rn-deeplink links add <url>.");
  writeLinks(root, links);
  console.log(
    [
      `${pc.green("✔")} Created ${LINKS_FILE} with one example link per pattern the app declares:`,
      formatLinks(links),
      "",
      `Replace the examples with real URLs from your app, then run ${pc.bold("rn-deeplink test --all")} or ${pc.bold("rn-deeplink open --all")}.`,
    ].join("\n"),
  );
}
