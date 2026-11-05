import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("parses a command with protocol names", () => {
    expect(parseArgs(["run", "link", "usdt"])).toEqual({
      command: "run",
      names: ["link", "usdt"],
      all: false,
      force: false,
    });
  });

  it("parses --all and --force", () => {
    expect(parseArgs(["run", "--all", "--force"])).toMatchObject({ all: true, force: true });
  });

  it("accepts commands that need no protocols", () => {
    expect(parseArgs(["list"]).command).toBe("list");
    expect(parseArgs(["fund"]).command).toBe("fund");
  });

  it("requires protocols or --all for fetch, run and verify", () => {
    for (const command of ["fetch", "run", "verify"]) {
      expect(() => parseArgs([command])).toThrow(/name at least one protocol/);
    }
  });

  it("rejects --all together with names", () => {
    expect(() => parseArgs(["run", "link", "--all"])).toThrow(/either --all or protocol names/);
  });

  it("rejects --force outside run", () => {
    expect(() => parseArgs(["verify", "link", "--force"])).toThrow(/only applies to `run`/);
  });

  it("requires exactly one address for creation", () => {
    expect(parseArgs(["creation", "0xabc"]).names).toEqual(["0xabc"]);
    expect(() => parseArgs(["creation"])).toThrow(/exactly one contract address/);
  });

  it("rejects unknown commands and flags with the usage text", () => {
    expect(() => parseArgs([])).toThrow(/usage: bun run predeploy/);
    expect(() => parseArgs(["deploy"])).toThrow(/usage: bun run predeploy/);
    expect(() => parseArgs(["run", "link", "--wat"])).toThrow(/unknown flag --wat/);
  });
});
