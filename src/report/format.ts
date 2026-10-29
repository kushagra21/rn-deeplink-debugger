import Table from "cli-table3";
import pc from "picocolors";
import type { Check, DomainReport, Finding, LinkKind, LinkPattern, OpenReport, Platform, ScanResult, TestReport } from "../types.js";

const PLATFORM_LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };
const KIND_LABEL: Record<LinkKind, string> = { scheme: "custom scheme", universal: "universal link", "app-link": "app link" };
const ICON = { error: pc.red("✖"), warning: pc.yellow("⚠"), info: pc.blue("ℹ"), pass: pc.green("✔") };

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

/** Text with one colour. Table cells are lists of parts so they can wrap without colours bleeding. */
type Part = { text: string; color?: (text: string) => string };
type Cell = string | Part[];

function patternNotes(p: LinkPattern): Part[] {
  const notes: Part[] = [];
  if (p.thirdParty) notes.push({ text: p.thirdParty, color: pc.dim });
  if (p.kind === "universal") notes.push({ text: "paths set by AASA", color: pc.dim });
  if (p.kind === "app-link") notes.push(p.autoVerify ? { text: "autoVerify", color: pc.green } : { text: "no autoVerify", color: pc.yellow });
  if (p.blockedBy) notes.push({ text: "unreachable from links", color: pc.red });
  if (p.pathType === "pathPattern" || p.pathType === "pathAdvancedPattern") notes.push({ text: p.pathType, color: pc.dim });
  if (p.note) notes.push({ text: p.note });
  return notes.map((note, i) => (i < notes.length - 1 ? { ...note, text: `${note.text},` } : note));
}

const listOr = (values: string[]) => (values.length ? values.join(", ") : pc.dim("not found"));

const visibleLength = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Columns to fit output to: the terminal's width, or $COLUMNS when output is piped. Undefined means don't wrap. */
export function terminalWidth(): number | undefined {
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  const columns = Number(process.env.COLUMNS);
  return columns > 0 ? columns : undefined;
}

/** Word-wrap text to `width` columns. Words longer than a line, such as URLs, stay whole. */
export function wrap(text: string, width: number | undefined): string[] {
  if (!width || width < 20) return text.split("\n");
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && visibleLength(line) + 1 + visibleLength(word) > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** An icon and wrapped message, then an indented "Fix:" line, wrapped under itself. */
function formatItem(level: Check["level"], message: string, fix: string | undefined, indent: string): string[] {
  const width = terminalWidth();
  const available = width && width - indent.length - 2;
  const [first = "", ...rest] = wrap(message, available);
  const lines = [`${indent}${ICON[level]} ${first}`, ...rest.map((line) => `${indent}  ${line}`)];
  if (fix) {
    const [fixFirst = "", ...fixRest] = wrap(fix, available && available - 5);
    lines.push(`${indent}  ${pc.dim("Fix:")} ${fixFirst}`, ...fixRest.map((line) => `${indent}       ${line}`));
  }
  return lines;
}

/**
 * Lay a cell out in lines of at most `width` columns ("\n" forces a break). Each word is coloured
 * on its own, so a colour never runs into the table border, and words too long for a line, such
 * as paths, are split rather than cut off.
 */
function cellLines(cell: Cell, width: number | undefined): string[] {
  const parts = typeof cell === "string" ? [{ text: cell }] : cell;
  const lines: string[] = [];
  let line = "";
  let length = 0;
  const flush = () => {
    lines.push(line);
    line = "";
    length = 0;
  };
  for (const { text, color = (s: string) => s } of parts) {
    text.split("\n").forEach((paragraph, index) => {
      if (index > 0) flush();
      for (let word of paragraph.split(" ").filter(Boolean)) {
        while (word) {
          const room = width ? width - length - (length ? 1 : 0) : Infinity;
          if (word.length <= room) {
            line += `${length ? " " : ""}${color(word)}`;
            length += (length ? 1 : 0) + word.length;
            word = "";
          } else if (length) flush();
          else {
            line += color(word.slice(0, width));
            word = word.slice(width);
            flush();
          }
        }
      }
    });
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * A compact table that fits the terminal: when it is too wide, the `shrink` columns (most
 * expendable first) get narrower and wrap.
 */
function fittedTable(head: string[], rows: Cell[][], shrink: number[]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => Math.max(...cellLines(r[i] ?? "", undefined).map(visibleLength)))) + 2);
  const width = terminalWidth();
  let excess = width ? widths.reduce((a, b) => a + b, 0) + widths.length + 1 - width : 0;
  for (const column of shrink) {
    if (excess <= 0) break;
    const cut = Math.min(excess, Math.max(0, widths[column]! - 14));
    widths[column]! -= cut;
    excess -= cut;
  }
  const table = new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
    colWidths: widths,
  });
  table.push(...rows.map((row) => row.map((cell, i) => cellLines(cell, widths[i]! - 2).join("\n"))));
  return table.toString();
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => formatItem(f.level, f.message, f.fix, "").join("\n")).join("\n\n");
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
    // The platform column already says where a file lives, so drop the obvious folders.
    const source = (path: string) => path.replace(/^android\/app\/src\/main\//, "").replace(/^ios\//, "");
    const rows = result.patterns.map((p): Cell[] => [
      PLATFORM_LABEL[p.platform],
      KIND_LABEL[p.kind],
      [{ text: patternUrl(p), color: p.thirdParty ? pc.dim : undefined }],
      patternNotes(p),
      [{ text: source(p.source), color: pc.dim }],
    ]);
    out.push("", fittedTable(["Platform", "Type", "Link", "Notes", "Source"], rows, [3, 4, 2]));
  }
  if (result.findings.length) out.push("", formatFindings(result.findings));
  out.push("", summary(result.findings));
  return out.join("\n");
}

function formatChecks(checks: Check[], indent: string): string[] {
  return checks.flatMap((c) => formatItem(c.level, c.message, c.fix, indent));
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

export function formatTest(report: TestReport): string {
  const out = [`${pc.bold("Testing")} ${report.url}`];
  for (const { platform, checks } of report.platforms) out.push(`  ${pc.bold(PLATFORM_LABEL[platform])}`, ...formatChecks(checks, "    "));
  if (report.checks.length) out.push("", ...formatChecks(report.checks, "  "));
  return out.join("\n");
}

const worst = (checks: Check[]): Check["level"] =>
  checks.some((c) => c.level === "error") ? "error" : checks.some((c) => c.level === "warning") ? "warning" : "pass";

/** A table with one row per saved link, then the details of links with problems. */
export function formatTestAll(result: { file: string; links: { link: { url: string; name?: string }; report: TestReport }[] }): string {
  const platforms = (["ios", "android"] as const).filter((p) => result.links.some((l) => l.report.platforms.some((r) => r.platform === p)));
  const rows = result.links.map(({ link, report }, i): Cell[] => {
    const cells = platforms.map((platform): Cell => {
      const checks = report.platforms.find((r) => r.platform === platform)?.checks;
      return checks ? ICON[worst(checks)] : [{ text: "–", color: pc.dim }];
    });
    const name: Part[] = link.name ? [{ text: `${link.name}\n` }, { text: link.url, color: pc.dim }] : [{ text: link.url }];
    return [[{ text: String(i + 1), color: pc.dim }], name, ...cells];
  });
  const table = fittedTable(["#", "Link", ...platforms.map((p) => PLATFORM_LABEL[p])], rows, [1]);

  const problems = result.links.filter(({ report }) => report.platforms.some((p) => worst(p.checks) !== "pass"));
  const details = problems.map(({ link, report }) => {
    const relevant = { ...report, checks: [], platforms: report.platforms.filter((p) => worst(p.checks) !== "pass") };
    return `${link.name ? `${pc.bold(link.name)}: ` : ""}${formatTest(relevant)}`;
  });
  const failed = result.links.filter(({ report }) => report.platforms.some((p) => worst(p.checks) === "error")).length;
  const summary = failed
    ? pc.red(`${failed} of ${result.links.length} links won't open the app everywhere they should.`)
    : pc.green(`✔ All ${result.links.length} links open the app.`);
  return [`${pc.bold(result.file)}`, table, ...(details.length ? ["", details.join("\n\n")] : []), "", summary].join("\n");
}
