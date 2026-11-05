import { describe, expect, test } from "bun:test";
import { computeSigHash } from "../src/codec/codec.ts";
import { fromWire, toWire } from "../src/rpc.ts";

// Two transactions that landed on the devnet, read back from the explorer, with the sig hash the
// chain itself returned for them (TXPARAM 0x08, logged by the probe account).
const fixture = await Bun.file(new URL("./fixtures/devnet-sighash.json", import.meta.url)).json();

describe("codec against the devnet", () => {
  for (const c of fixture.cases) {
    test(`sig hash equals TXPARAM(0x08) on chain: ${c.note}`, () => {
      expect(computeSigHash(fromWire(c.tx))).toBe(c.onChainSigHash);
    });
    test(`wire JSON round-trips: ${c.note}`, () => {
      expect(toWire(fromWire(c.tx))).toEqual(c.tx);
    });
  }
});
