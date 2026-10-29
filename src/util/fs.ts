import { readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED_DIRS = new Set(["node_modules", "Pods", "build", "DerivedData", ".gradle", ".cxx", ".git"]);

/** List files under `dir` recursively, skipping dependency and build output folders. */
export function walk(dir: string, maxDepth = 6): string[] {
  const files: string[] = [];
  const visit = (current: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && depth < maxDepth) visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(dir, 0);
  return files;
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
