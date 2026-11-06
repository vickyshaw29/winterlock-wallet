import { describe, expect, test } from "bun:test";
import { toHex, type Hex } from "viem";
import { WOTS, wotsDigits, wotsVerifySteps } from "../src/wots.ts";

// The fixture's digits were checked against Quip's WOTSPlus.sol by account/test/WotsDigitsOracle.t.sol.
const fixture = await Bun.file(new URL("./fixtures/wots-digits.json", import.meta.url)).json();
const fill = (byte: number): Hex => toHex(new Uint8Array(32).fill(byte));

describe("WOTS+ chain work (Quip format)", () => {
  test("worst message: all-zero digits need 15 steps each, 990 in all (spec: 990 worst)", () => {
    const d = wotsDigits(fill(0x00));
    expect(d.length).toBe(67);
    expect(d.slice(0, 64).every((x) => x === 0)).toBe(true);
    expect(d.slice(64)).toEqual([3, 12, 0]); // checksum 64 x 15 = 960 = 0x3c0
    expect(wotsVerifySteps(fill(0x00))).toBe(WOTS.worstSteps);
  });

  test("best message: all-0xf digits need no steps; only the checksum chains run, 45 in all (spec: 45 best)", () => {
    expect(wotsDigits(fill(0xff)).slice(64)).toEqual([0, 0, 0]);
    expect(wotsVerifySteps(fill(0xff))).toBe(WOTS.bestSteps);
  });

  test("high nibble first", () => {
    const msg = `0x1f${"00".repeat(31)}` as Hex;
    expect(wotsDigits(msg).slice(0, 2)).toEqual([1, 15]);
  });

  test("agrees with the Quip-checked fixture on every case", () => {
    for (const c of fixture.cases) {
      expect(wotsDigits(c.msg)).toEqual(c.digits);
      expect(wotsVerifySteps(c.msg)).toBe(c.steps);
    }
  });

  test("random messages average about 506 steps (spec)", () => {
    const random = fixture.cases.slice(7).map((c: { steps: number }) => c.steps);
    const mean = random.reduce((a: number, b: number) => a + b, 0) / random.length;
    expect(mean).toBeGreaterThan(480);
    expect(mean).toBeLessThan(530);
  });

  test("refuses a message that is not 32 bytes", () => {
    expect(() => wotsDigits("0x00")).toThrow("32 bytes");
  });
});
