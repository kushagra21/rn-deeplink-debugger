#!/usr/bin/env node
// Records the README demo GIFs from real runs of the built CLI on the fixture projects.
// Each command is "typed", its real output is captured with colours, and the session is written
// as an asciicast and converted to a GIF with agg (brew install agg).
//
// Usage: npm run demos

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COLS = 110;
const MAX_ROWS = 44;

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "cli.js");
const out = join(repo, "docs", "media");

const demos = [
  {
    name: "scan",
    fixture: "bare-rn-broken",
    commands: [["scan"]],
  },
  {
    name: "test",
    fixture: "bare-rn",
    commands: [
      ["test", "https://example.com/product/42"],
      ["test", "https://example.com/item/42"],
    ],
  },
  {
    name: "routes",
    fixture: "react-navigation-app",
    commands: [["routes"], ["test", "bareapp://product/42"]],
  },
  {
    name: "links",
    fixture: "bare-rn",
    commands: [["links", "init"], ["links", "add", "https://example.com/item/42", "--name", "Old item page"], ["test", "--all"]],
  },
];

const quote = (arg) => (/^[\w./:@-]+$/.test(arg) ? arg : `"${arg}"`);

function record({ name, fixture, commands }) {
  const work = mkdtempSync(join(tmpdir(), "rn-deeplink-demo-"));
  const project = join(work, "my-app");
  cpSync(join(repo, "fixtures", fixture), project, { recursive: true });

  const events = [];
  let time = 0.4;
  let lines = 0;
  const emit = (text, delay) => {
    time += delay;
    events.push([Number(time.toFixed(3)), "o", text]);
  };

  for (const args of commands) {
    emit("\x1b[32m~/my-app\x1b[0m $ ", 0.3);
    for (const ch of `npx rn-deeplink ${args.map(quote).join(" ")}`) emit(ch, 0.035 + Math.random() * 0.04);
    emit("\r\n", 0.35);
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1", COLUMNS: String(COLS) },
    });
    // Print a block (a table, a finding) at a time: easier to follow, and far fewer GIF frames.
    const output = `${result.stdout}${result.stderr}`.replace(/\n$/, "");
    for (const block of output.split(/\n(?=\n)/)) {
      const blockLines = block.split("\n");
      emit(`${blockLines.join("\r\n")}\r\n`, 0.25);
      lines += blockLines.length;
      // Give viewers time to read a table before the rest scrolls it away.
      if (blockLines.some((line) => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("└"))) time += 2.5;
    }
    emit("\r\n", 0.1);
    lines += 2;
    time += 2.2;
  }
  emit("", 1.5);

  const cols = COLS;
  const rows = Math.min(MAX_ROWS, lines + 2);
  const cast = join(work, `${name}.cast`);
  writeFileSync(cast, [JSON.stringify({ version: 2, width: cols, height: rows }), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
  const gif = join(out, `${name}.gif`);
  execFileSync("agg", ["--theme", "github-dark", "--font-size", "14", "--line-height", "1.3", "--idle-time-limit", "3", "--last-frame-duration", "4", cast, gif], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  // DEMO_CAST_DIR keeps the asciicasts, e.g. to inspect or re-render them.
  if (process.env.DEMO_CAST_DIR) cpSync(cast, join(process.env.DEMO_CAST_DIR, `${name}.cast`));
  rmSync(work, { recursive: true, force: true });
  console.log(`${gif} (${cols}×${rows})`);
}

mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
for (const demo of demos) if (only.length === 0 || only.includes(demo.name)) record(demo);
