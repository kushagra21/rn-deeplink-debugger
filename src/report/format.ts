import Table from "cli-table3";
import pc from "picocolors";
import type { Check, DomainReport, Finding, LinkKind, LinkPattern, OpenReport, Platform, ScanResult } from "../types.js";

const PLATFORM_LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };
const KIND_LABEL: Record<LinkKind, string> = { scheme: "custom scheme", universal: "universal link", "app-link": "app link" };
const ICON = { error: pc.red("✖"), warning: pc.yellow("⚠"), info: pc.blue("ℹ"), pass: pc.green("✔") };

export function notImplemented(command: string): never {
  console.error(pc.yellow(`\`${command}\` is not implemented yet.`));
  process.exit(1);
}

/** A URL-like rendering of a pattern, e.g. `https://example.com/product*`. */
export function patternUrl(p: LinkPattern): string {
  if (p.kind === "universal") return `https://${p.host}/*`;
  if (!p.host) return p.kind === "scheme" ? `${p.scheme}://` : `${p.scheme}://*`;
  switch (p.pathType) {
    case undefined:
      return `${p.scheme}://${p.host}/*`;
    case "pathPrefix":
      return `${p.scheme}://${p.host}${p.path}*`;
    case "pathSuffix":
      return `${p.scheme}://${p.host}/*${p.path}`;
    default:
      return `${p.scheme}://${p.host}${p.path}`;
  }
}

function patternNotes(p: LinkPattern): string {
  const notes: string[] = [];
  if (p.thirdParty) notes.push(pc.dim(p.thirdParty));
  if (p.kind === "universal") notes.push(pc.dim("paths set by AASA"));
  if (p.kind === "app-link") notes.push(p.autoVerify ? pc.green("autoVerify") : pc.yellow("no autoVerify"));
  if (p.pathType === "pathPattern" || p.pathType === "pathAdvancedPattern") notes.push(pc.dim(p.pathType));
  if (p.note) notes.push(p.note);
  return notes.join(", ");
}

const listOr = (values: string[]) => (values.length ? values.join(", ") : pc.dim("not found"));

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => [`${ICON[f.level]} ${f.message}`, f.fix && `  ${pc.dim("Fix:")} ${f.fix}`].filter(Boolean).join("\n"))
    .join("\n\n");
}

function summary(findings: (Finding | Check)[]): string {
  const count = (level: Check["level"]) => findings.filter((f) => f.level === level).length;
  const errors = count("error");
  const warnings = count("warning");
  if (!errors && !warnings) return pc.green("✔ No problems found.");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [errors && pc.red(plural(errors, "error")), warnings && pc.yellow(plural(warnings, "warning"))].filter(Boolean).join(", ");
}

export function formatScan(result: ScanResult): string {
  const out: string[] = [];
  if (result.expo) out.push(`${pc.bold("Expo")}     config ${result.expo.configFile}`);
  if (result.ios) out.push(`${pc.bold("iOS")}      bundle ID ${listOr(result.ios.bundleIds)}  ·  team ID ${listOr(result.ios.teamIds)}`);
  if (result.android) out.push(`${pc.bold("Android")}  package ${listOr(result.android.packageNames)}`);

  if (result.patterns.length) {
    const table = new Table({
      head: ["Platform", "Type", "Link", "Notes", "Source"].map((h) => pc.bold(h)),
      style: { head: [], border: [] },
      chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
    });
    for (const p of result.patterns) {
      const url = patternUrl(p);
      table.push([PLATFORM_LABEL[p.platform], KIND_LABEL[p.kind], p.thirdParty ? pc.dim(url) : url, patternNotes(p), pc.dim(p.source)]);
    }
    out.push("", table.toString());
  }
  if (result.findings.length) out.push("", formatFindings(result.findings));
  out.push("", summary(result.findings));
  return out.join("\n");
}

function formatChecks(checks: Check[], indent: string): string[] {
  return checks.flatMap((c) => [`${indent}${ICON[c.level]} ${c.message}`, ...(c.fix ? [`${indent}  ${pc.dim("Fix:")} ${c.fix}`] : [])]);
}

export function formatVerify(reports: DomainReport[]): string {
  const out: string[] = [];
  for (const report of reports) {
    out.push(pc.bold(report.domain), ...formatChecks(report.checks, "  "));
    for (const file of report.files) {
      const title = `${PLATFORM_LABEL[file.platform]} · ${file.file}`;
      if (file.skipped) out.push(`  ${pc.dim(`${title}: skipped, ${file.skipped}`)}`);
      else out.push(`  ${pc.bold(title)}`, ...formatChecks(file.checks, "    "));
    }
    out.push("");
  }
  out.push(summary(reports.flatMap((r) => [...r.checks, ...r.files.flatMap((f) => f.checks)])));
  return out.join("\n");
}

export function formatOpen(report: OpenReport): string {
  const out = [`${pc.bold("Opening")} ${report.url}`];
  for (const device of report.devices) {
    out.push(`  ${pc.bold(`${PLATFORM_LABEL[device.platform]} · ${device.device}`)}`, ...formatChecks(device.checks, "    "));
  }
  if (report.checks.length) out.push("", ...formatChecks(report.checks, "  "));
  return out.join("\n");
}
