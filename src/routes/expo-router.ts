import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walk } from "../util/fs.js";
import { formatPath, type Route, type RouterInfo, type Segment } from "./routes.js";

/**
 * Routes from an Expo Router `app/` (or `src/app/`) folder. Groups like `(tabs)` don't add to the
 * path, `index` is the folder's own path, `[id]` is a parameter and `[...slug]` a catch-all.
 * Layouts, `+not-found`, `+html` and `+api` routes aren't screens.
 */
export function readExpoRouter(root: string): RouterInfo {
  const appDir = ["src/app", "app"].map((d) => join(root, d)).find(existsSync);
  const info: RouterInfo = { router: "expo-router", source: "app/", routes: [], unlinkedScreens: [], unknownScreens: [], notes: [] };
  if (!appDir) {
    info.notes.push("The project uses expo-router but has no app/ or src/app/ folder, so it has no routes.");
    return info;
  }
  info.source = `${relative(root, appDir).split(sep).join("/")}/`;

  const seen = new Set<string>();
  // Platform files (about.ios.tsx) come after the shared file, which is reported as the route's source.
  const platformFile = (file: string) => (/\.(ios|android|web|native)\.[jt]sx?$/.test(file) ? 1 : 0);
  const files = walk(appDir, 12).sort((a, b) => platformFile(a) - platformFile(b) || a.localeCompare(b));
  for (const file of files) {
    const relativePath = relative(appDir, file).split(sep);
    const fileName = relativePath.pop()!;
    if (!/\.(tsx?|jsx?)$/.test(fileName) || fileName.endsWith(".d.ts")) continue;
    const name = fileName.replace(/\.(tsx?|jsx?)$/, "").replace(/\.(ios|android|web|native)$/, "");
    if (name === "+not-found") info.hasNotFound = true;
    if (name.startsWith("_") || name.startsWith("+") || name.endsWith("+api")) continue;
    if (relativePath.some((dir) => dir.startsWith("_"))) continue;

    const parts = [...relativePath, name].filter((part) => part !== "index" && !/^\(.*\)$/.test(part));
    const segments = parts.map((part): Segment => {
      const rest = /^\[\.\.\.(.+)\]$/.exec(part);
      if (rest) return { kind: "rest", name: rest[1]!, minOne: true };
      const param = /^\[(.+)\]$/.exec(part);
      return param ? { kind: "param", name: param[1]! } : { kind: "static", value: part };
    });
    const path = formatPath(segments);
    if (seen.has(path)) continue;
    seen.add(path);
    const route: Route = {
      path,
      segments,
      screen: `/${parts.join("/")}`,
      source: relative(root, file).split(sep).join("/"),
    };
    info.routes.push(route);
  }
  return info;
}
