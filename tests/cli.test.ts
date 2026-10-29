import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli", () => {
  it("registers the MVP commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(["scan", "verify", "open", "test"]);
  });
});
