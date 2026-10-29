import { resolve } from "node:path";
import pc from "picocolors";
import { formatVerify, patternUrl } from "../report/format.js";
import type { Check, DomainReport, FileReport, ScanResult } from "../types.js";
import { unique } from "../util/fs.js";
import { checkAasa, type ExpectedPath } from "../verify/aasa.js";
import { checkAssetlinks } from "../verify/assetlinks.js";
import { fetchFile, type FetchLike } from "../verify/fetch.js";
import { debugKeystoreFingerprint, type DebugKeystore } from "../verify/signing.js";
import { runScan } from "./scan.js";

export interface VerifyOptions {
  cwd: string;
  json?: boolean;
  teamId?: string;
  bundleId?: string[];
  package?: string[];
  sha256?: string[];
  path?: string[];
  platform?: "ios" | "android" | "both";
  cdn?: boolean;
}

export interface VerifyDeps {
  fetch?: FetchLike;
  scan?: (root: string) => ScanResult | null;
  debugKeystore?: (root: string) => DebugKeystore | null;
}

/** `https://Example.com/path` or `example.com/path` → `example.com`. */
export function normalizeDomain(input: string): string {
  const value = input.includes("://") ? new URL(input).host : input.split("/")[0]!;
  return value.toLowerCase();
}

/** A concrete path for a pattern Android opens, to test against the AASA rules. */
function expectedFromAndroid(scan: ScanResult | null, domain: string): ExpectedPath[] {
  return (scan?.patterns ?? []).flatMap((p) => {
    if (p.kind !== "app-link" || p.host !== domain || !p.path) return [];
    if (p.pathType === "path") return [{ sample: p.path, suggest: p.path, reason: `Android opens ${patternUrl(p)}` }];
    if (p.pathType !== "pathPrefix") return [];
    const sample = p.path.endsWith("/") ? `${p.path}example` : `${p.path}/example`;
    return [{ sample, suggest: `${p.path}*`, reason: `Android opens ${patternUrl(p)}` }];
  });
}

export async function runVerify(domainArgs: string[], options: VerifyOptions, deps: VerifyDeps = {}): Promise<DomainReport[] | { error: string }> {
  const root = resolve(options.cwd);
  const scan = (deps.scan ?? runScan)(root);
  const platform = options.platform ?? "both";
  const doFetch = (url: string) => fetchFile(url, deps.fetch);

  const iosHosts = new Set(scan?.patterns.filter((p) => p.kind === "universal").map((p) => p.host!) ?? []);
  const androidHosts = new Set(scan?.patterns.filter((p) => p.kind === "app-link" && p.host).map((p) => p.host!) ?? []);
  const domains = unique(domainArgs.length ? domainArgs.map(normalizeDomain) : [...iosHosts, ...androidHosts]);
  if (domains.length === 0) {
    return {
      error: scan
        ? "The project has no associated domains or App Link hosts. Pass a domain: rn-deeplink verify example.com"
        : "Pass a domain (rn-deeplink verify example.com), or run this in your project to verify its domains.",
    };
  }

  const teamIds = options.teamId ? [options.teamId] : (scan?.ios?.teamIds ?? []);
  const bundleIds = options.bundleId ?? scan?.ios?.bundleIds ?? [];
  const appIds = teamIds.flatMap((team) => bundleIds.map((bundle) => `${team}.${bundle}`));
  const packageNames = options.package ?? scan?.android?.packageNames ?? [];
  const debugKeystore = platform !== "ios" && scan?.android ? (deps.debugKeystore ?? debugKeystoreFingerprint)(root) : null;

  return Promise.all(
    domains.map(async (domain): Promise<DomainReport> => {
      const checks: Check[] = [];
      if (domain.includes("*")) {
        checks.push({ level: "info", message: `${domain} is a wildcard, so there's no single file to fetch. Pass a specific host, e.g. rn-deeplink verify ${domain.replace("*.", "www.")}` });
        return { domain, checks, files: [] };
      }

      // Without a project, check both files. With one, check the platforms that claim the domain.
      const inIos = iosHosts.has(domain);
      const inAndroid = androidHosts.has(domain);
      if (scan && !inIos && !inAndroid) {
        checks.push({
          level: "warning",
          message: `${domain} isn't an associated domain or App Link host in this project, so the app never asks for these files.`,
          fix: "Add the domain to the app (run rn-deeplink scan to see the domains it has).",
        });
      }
      const checkIos = platform === "ios" || (platform === "both" && (!scan || inIos || !inAndroid));
      const checkAndroid = platform === "android" || (platform === "both" && (!scan || inAndroid || !inIos));
      const files: FileReport[] = [];

      if (checkIos) {
        const base = `https://${domain}`;
        const [wellKnown, rootFile, cdn] = await Promise.all([
          doFetch(`${base}/.well-known/apple-app-site-association`),
          doFetch(`${base}/apple-app-site-association`),
          options.cdn === false ? undefined : doFetch(`https://app-site-association.cdn-apple.com/a/v1/${domain}`),
        ]);
        const paths = [
          ...expectedFromAndroid(scan, domain),
          ...(options.path ?? []).map((path) => ({ sample: path, suggest: path, reason: "it was passed with --path" })),
        ];
        files.push({
          platform: "ios",
          file: "apple-app-site-association",
          checks: checkAasa({ wellKnown, root: rootFile, cdn }, { appIds, bundleIds, paths: [...new Map(paths.map((p) => [p.sample, p])).values()] }),
        });
      } else if (platform === "both") {
        files.push({ platform: "ios", file: "apple-app-site-association", skipped: "the iOS app has no associated domain for it", checks: [] });
      }

      if (checkAndroid) {
        const file = await doFetch(`https://${domain}/.well-known/assetlinks.json`);
        files.push({
          platform: "android",
          file: "assetlinks.json",
          checks: checkAssetlinks(file, { packageNames, fingerprints: options.sha256 ?? [], debugKeystore }),
        });
      } else if (platform === "both") {
        files.push({ platform: "android", file: "assetlinks.json", skipped: "the Android app has no App Link filter for it", checks: [] });
      }
      return { domain, checks, files };
    }),
  );
}

export async function verifyCommand(domains: string[], options: VerifyOptions): Promise<void> {
  const result = await runVerify(domains, options);
  if ("error" in result) {
    console.error(`${pc.red("✖")} ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatVerify(result));
  const allChecks = result.flatMap((d) => [...d.checks, ...d.files.flatMap((f) => f.checks)]);
  if (allChecks.some((c) => c.level === "error")) process.exitCode = 1;
}
