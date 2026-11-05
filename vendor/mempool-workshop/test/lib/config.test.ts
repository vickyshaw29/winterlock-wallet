import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, parseConfig } from "../../src/lib/config.js";

const valid = fs.readFileSync(CONFIG_FILE, "utf8");

describe("workshop.config.json5", () => {
  it("parses, converting ETH and gwei amounts to wei", () => {
    const c = parseConfig(valid);
    expect(c.chainId).toBe(1337);
    expect(c.stakeWei).toBe(12_000_000_000_000_000n);
    expect(c.minBalanceWei).toBe(100_000_000_000_000_000n);
    expect(c.maxFeePerGasWei).toBe(2_000_000_000n);
    expect(c.legacyGasPriceWei).toBe(2_000_000n);
    expect(c.transferWei).toBe(1_000_000_000n);
    expect(c.deployGasLimit).toBe(6_000_000n);
    expect(c.stateFile.endsWith("/.workshop-state.json")).toBe(true);
  });

  it("rejects a missing key, naming it", () => {
    expect(() => parseConfig(valid.replace(/^\s*chainId:.*$/m, ""))).toThrowError(/missing key "chainId"/);
  });

  it("rejects an unknown key, naming it", () => {
    expect(() => parseConfig(valid.replace("{", '{ funderKey: "0x01",'))).toThrowError(/unknown key "funderKey"/);
  });

  it("rejects values of the wrong shape, listing every problem", () => {
    const bad = valid.replace(/stakeEth:.*,/, "stakeEth: 0.012,").replace(/recipient:.*,/, 'recipient: "nope",');
    expect(() => parseConfig(bad)).toThrowError(/"recipient": expected a 0x address/);
    expect(() => parseConfig(bad)).toThrowError(/"stakeEth": expected a string/);
  });

  it("rejects text that is not JSON5", () => {
    expect(() => parseConfig("{")).toThrowError(/not valid JSON5/);
  });
});
