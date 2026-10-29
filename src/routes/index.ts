import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict } from "../parsers/ios.js";
import { readExpoRouter } from "./expo-router.js";
import { readReactNavigation } from "./react-navigation.js";
import type { RouterInfo } from "./routes.js";

export * from "./routes.js";

/** The project's router: Expo Router when it depends on expo-router, else React Navigation. Null when it uses neither. */
export function readRoutes(root: string): RouterInfo | null {
  const file = join(root, "package.json");
  if (!existsSync(file)) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const deps = isDict(pkg) ? { ...(isDict(pkg.dependencies) ? pkg.dependencies : {}), ...(isDict(pkg.devDependencies) ? pkg.devDependencies : {}) } : {};
  if ("expo-router" in deps) return readExpoRouter(root);
  if ("@react-navigation/native" in deps) return readReactNavigation(root);
  return null;
}
