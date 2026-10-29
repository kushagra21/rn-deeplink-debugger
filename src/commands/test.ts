import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { explainUrl, parseLinkUrl, type LinkUrl } from "../match.js";
import { formatTest, patternUrl } from "../report/format.js";
import type { Check, LinkPattern, Platform, ScanResult, TestReport } from "../types.js";
import { unique } from "../util/fs.js";
import { describeRule, firstMatchingRule, readAasaApps, urlParts } from "../verify/aasa.js";
import { describeFailure, fetchFile, type FetchLike } from "../verify/fetch.js";
import { runScan } from "./scan.js";

export interface TestOptions {
  cwd: string;
  /** Fetch apple-app-site-association to check iOS paths. */
  online?: boolean;
  /** Local apple-app-site-association file to check iOS paths against. */
  aasa?: string;
  json?: boolean;
}

export interface TestDeps {
  scan?: (root: string) => ScanResult | null;
  fetch?: FetchLike;
}

const PLATFORM_NAME: Record<Platform, string> = { ios: "iOS", android: "Android" };
const KIND_NAME = { scheme: "custom scheme", universal: "universal link", "app-link": "App Link" };
const MAX_CLOSEST = 3;

const describe = (p: LinkPattern) => `${KIND_NAME[p.kind]} ${patternUrl(p)}`;

function noMatch(platform: Platform, url: LinkUrl, patterns: LinkPattern[], closest: ReturnType<typeof explainUrl>["closest"]): Check {
  const isWeb = /^https?$/i.test(url.scheme);
  const outcome = isWeb ? `so ${platform === "ios" ? "Safari" : "the browser"} opens it instead of the app` : "so the link does nothing";
  const stage = closest[0]?.miss.stage ?? "scheme";
  const near = closest.slice(0, MAX_CLOSEST).map(({ pattern, miss }) => `${describe(pattern)} (${pattern.source}): ${miss.reason}`);
  const handled = unique(patterns.filter((p) => !p.thirdParty).map(patternUrl));

  const fix =
    closest[0]?.miss.fix ??
    (stage === "path"
      ? `Add a path rule that covers ${url.path} to that intent filter (or "data" in android.intentFilters), or change the link.`
      : stage === "host" || isWeb
        ? platform === "ios"
          ? `Add "applinks:${url.host}" to your associated domains (the .entitlements file, or ios.associatedDomains in app.json).`
          : `Add an App Link intent filter for ${url.host}: <data android:scheme="https" android:host="${url.host}" /> (or android.intentFilters in app.json).`
        : platform === "ios"
          ? `Register "${url.scheme}" in CFBundleURLSchemes (or "scheme" in app.json).`
          : `Add an intent filter with <data android:scheme="${url.scheme}" /> (or "scheme" in app.json).`);

  return {
    level: "error",
    message: [
      `Nothing in the ${PLATFORM_NAME[platform]} config matches this URL, ${outcome}.`,
      near.length ? `Closest: ${near.join("; ")}.` : handled.length ? `It handles: ${handled.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    fix,
  };
}

async function aasaChecks(url: LinkUrl, scan: ScanResult, options: TestOptions, deps: TestDeps): Promise<Check[]> {
  if (!options.online && !options.aasa) {
    return [
      {
        level: "info",
        message: "Which paths open the app is set by apple-app-site-association on the server.",
        fix: "Pass --online to check this URL against the live file, or --aasa <file> for a local copy.",
      },
    ];
  }

  let json: unknown;
  let label: string;
  if (options.aasa) {
    label = options.aasa;
    try {
      json = JSON.parse(readFileSync(resolve(options.cwd, options.aasa), "utf8"));
    } catch (error) {
      return [{ level: "error", message: `Couldn't read ${options.aasa}: ${(error as Error).message}` }];
    }
  } else {
    const base = `https://${url.host}${url.port ? `:${url.port}` : ""}`;
    let file = await fetchFile(`${base}/.well-known/apple-app-site-association`, deps.fetch);
    if (file.json === undefined) file = await fetchFile(`${base}/apple-app-site-association`, deps.fetch);
    if (file.json === undefined) {
      return [
        {
          level: "error",
          message: `Couldn't get apple-app-site-association from ${url.host} (${describeFailure(file)}), so iOS won't open this link in the app.`,
          fix: `Run rn-deeplink verify ${url.host} for details.`,
        },
      ];
    }
    json = file.json;
    label = file.url;
  }

  const { apps } = readAasaApps(json);
  const bundleIds = scan.ios?.bundleIds ?? [];
  const appIds = (scan.ios?.teamIds ?? []).flatMap((team) => bundleIds.map((bundle) => `${team}.${bundle}`));
  const ours = apps.filter((a) => (appIds.length ? appIds.includes(a.appId) : bundleIds.includes(a.appId.slice(11))));
  if (ours.length === 0) {
    return [
      {
        level: "error",
        message: `${label} doesn't list your app (${(appIds.length ? appIds : bundleIds).join(", ") || "unknown app ID"}).`,
        fix: `Run rn-deeplink verify ${url.host} for details.`,
      },
    ];
  }
  return ours.map((app): Check => {
    const rule = firstMatchingRule(app.rules, urlParts(url.raw));
    if (rule && !rule.exclude) return { level: "pass", message: `apple-app-site-association opens this path for ${app.appId} (${describeRule(rule)})` };
    return {
      level: "error",
      message: rule
        ? `apple-app-site-association excludes this path for ${app.appId} (${describeRule(rule)}), so Safari opens it.`
        : `No rule in apple-app-site-association for ${app.appId} matches ${urlParts(url.raw).path}, so Safari opens it.`,
      fix: rule ? "Move the exclusion below a rule that includes this path, or narrow it." : `Add { "/": "${url.path}" } (or a wildcard such as "/${url.path.split("/")[1] ?? ""}/*") to its components.`,
    };
  });
}

async function platformChecks(platform: Platform, url: LinkUrl, scan: ScanResult, options: TestOptions, deps: TestDeps): Promise<Check[]> {
  const patterns = scan.patterns.filter((p) => p.platform === platform);
  const { matched, closest } = explainUrl(url, patterns);
  if (matched.length === 0) return [noMatch(platform, url, patterns, closest)];

  const checks: Check[] = [];
  for (const p of matched) {
    if (p.blockedBy) {
      checks.push({
        level: "error",
        message: `Matches ${describe(p)} (${p.source}), but a tapped link can't reach it: ${p.blockedBy.join("; ")}.`,
        fix: "Fix the intent filter; rn-deeplink scan shows how.",
      });
      continue;
    }
    checks.push({ level: "pass", message: `Matches ${describe(p)} (${p.source})` });
    if (p.thirdParty) {
      checks.push({ level: "info", message: `${p.scheme}:// is registered for ${p.thirdParty}, so that, not your app's own navigation, expects these URLs.` });
    }
    if (p.kind === "app-link" && !p.autoVerify) {
      checks.push({
        level: "warning",
        message: "That filter doesn't set autoVerify, so Android 12+ opens this link in the browser, and older versions show an app chooser.",
        fix: 'Add android:autoVerify="true" to the intent filter (or "autoVerify": true in app.json).',
      });
    }
  }
  if (matched.some((p) => p.kind === "universal")) {
    checks.push(...(await aasaChecks(url, scan, options, deps)));
    checks.push({
      level: "info",
      message: "Universal links open the app when tapped in another app or on another site. Typing the URL in Safari, or following a link on the same domain, stays in Safari.",
    });
  }
  return checks;
}

export async function runTest(input: string, options: TestOptions, deps: TestDeps = {}): Promise<TestReport | { error: string }> {
  const url = parseLinkUrl(input);
  if (!url) return { error: `"${input}" isn't a full URL. Include the scheme, e.g. myapp://home or https://${input}` };
  const scan = (deps.scan ?? runScan)(resolve(options.cwd));
  if (!scan) return { error: "No React Native project here. Run this in your project root, or pass --cwd <dir>." };

  const platforms: TestReport["platforms"] = [];
  for (const platform of ["ios", "android"] as const) {
    if (scan[platform]) platforms.push({ platform, checks: await platformChecks(platform, url, scan, options, deps) });
  }
  const checks: Check[] = [];
  if (platforms.length && platforms.every((p) => !p.checks.some((c) => c.level === "error"))) {
    checks.push({ level: "info", message: `Try it on a device: rn-deeplink open ${input}` });
  }
  return { url: input, checks, platforms };
}

export async function testCommand(url: string, options: TestOptions): Promise<void> {
  const result = await runTest(url, options);
  if ("error" in result) {
    console.error(`${pc.red("✖")} ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatTest(result));
  if (result.platforms.some((p) => p.checks.some((c) => c.level === "error"))) process.exitCode = 1;
}
