import pc from "picocolors";

export function notImplemented(command: string): never {
  console.error(pc.yellow(`\`${command}\` is not implemented yet.`));
  process.exit(1);
}
