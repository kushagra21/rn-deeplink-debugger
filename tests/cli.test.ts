import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli", () => {
  it("registers the MVP commands", () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toEqual(["scan", "verify", "open", "test", "links"]);
    expect(program.commands.find((c) => c.name() === "links")!.commands.map((c) => c.name())).toEqual(["list", "add", "remove", "init"]);
  });
});
