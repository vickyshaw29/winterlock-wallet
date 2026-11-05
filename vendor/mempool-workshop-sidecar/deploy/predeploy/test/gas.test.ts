import { describe, expect, it } from "vitest";
import { planGas, planGasPrice } from "../src/gas";

describe("planGas", () => {
  it("adds the margin", () => {
    expect(planGas(1_000_000n, 60_000_000n, 20n)).toBe(1_200_000n);
  });

  it("caps at the block gas limit when only the margin overshoots", () => {
    expect(planGas(55_000_000n, 60_000_000n, 20n)).toBe(60_000_000n);
  });

  it("throws when the estimate itself exceeds the block gas limit", () => {
    expect(() => planGas(61_000_000n, 60_000_000n, 20n)).toThrow(/exceeds the block gas limit/);
  });
});

describe("planGasPrice", () => {
  it("multiplies the node price", () => {
    expect(planGasPrice(1_000_007n, 2n, 500_000_000_000n)).toBe(2_000_014n);
  });

  it("caps at the ceiling when the multiplied node price would exceed it", () => {
    // Guards against a reactive/self-poisoning eth_gasPrice oracle (observed live on the ethrex
    // devnet: repeated bulk transactions paying 2x its own quoted price fed back into that same
    // quote, driving it from ~2 gwei to over 33,000 gwei within one deployment run, even though
    // the chain's real EIP-1559 base fee stayed at 7 wei the whole time). Without a ceiling nothing
    // stops that feedback loop from compounding without bound.
    expect(planGasPrice(1_000_000_000_000n, 2n, 500_000_000_000n)).toBe(500_000_000_000n);
  });
});
