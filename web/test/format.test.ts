// format.js: amounts at a glance (six significant decimals) and exact (titles), typed amounts, gas, short hashes,
// nonce keys as lanes, times.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import {
  formatAgo, formatClock, formatGas, formatOffset, formatWei, formatWeiExact, isAddress, nonceKeyParts, parseEth, shortHex, toBigInt, weiToEthInput,
} from "../public/format.js";

describe("formatWei and formatWeiExact", () => {
  test("exact, never rounded (titles): wei below 1 gwei, ETH above with trailing zeros trimmed", () => {
    expect(formatWeiExact("0")).toBe("0 ETH");
    expect(formatWeiExact("1")).toBe("1 wei");
    expect(formatWeiExact("999999999")).toBe("999,999,999 wei");
    expect(formatWeiExact("1000000000")).toBe("0.000000001 ETH");
    expect(formatWeiExact("10000000000000000")).toBe("0.01 ETH");
    expect(formatWeiExact(1234n * 10n ** 18n + 1n)).toBe("1,234.000000000000000001 ETH");
    expect(formatWeiExact(-(10n ** 18n))).toBe("-1 ETH");
    expect(formatWeiExact("2968364197253086")).toBe("0.002968364197253086 ETH");
  });

  test("at a glance: at most six significant decimals, rounded half up; a tranche never shows 18 decimals", () => {
    expect(formatWei("2968364197253086")).toBe("0.00296836 ETH"); // a tranche the balance limits: 0.002968364197253086
    expect(formatWei("2000000000001000")).toBe("0.002 ETH"); // the set-aside line of one ticket
    expect(formatWei("2968365000000000")).toBe("0.00296837 ETH"); // half up
    expect(formatWei("1234567891")).toBe("0.00000000123457 ETH"); // six significant digits after the zeros
    expect(formatWei(1234n * 10n ** 18n + 567891234n * 10n ** 9n)).toBe("1,234.567891 ETH"); // six decimals from 1 ETH up
    expect(formatWei(10n ** 18n + 1n)).toBe("1 ETH");
    expect(formatWei(10n ** 18n - 1n)).toBe("1 ETH");
    expect(formatWei(-(2968364197253086n))).toBe("-0.00296836 ETH");
    for (let wei = 10n ** 9n; wei < 10n ** 22n; wei = wei * 7n + 12_345n) {
      const decimals = (formatWei(wei).split(" ")[0]!.split(".")[1] ?? "").replace(/^0+/, "");
      expect([wei, decimals.length <= 6]).toEqual([wei, true]);
    }
    // unchanged where they were short already
    expect([formatWei("0"), formatWei("1"), formatWei("999999999"), formatWei("1000000000"), formatWei("10000000000000000"), formatWei("1500000000000000000"), formatWei("0x2386f26fc10000")])
      .toEqual(["0 ETH", "1 wei", "999,999,999 wei", "0.000000001 ETH", "0.01 ETH", "1.5 ETH", "0.01 ETH"]);
  });

  test("anything that is not an amount is a dash, never NaN", () => {
    for (const v of [null, undefined, "", "1.5", "abc", 1.5, {}]) expect([formatWei(v), formatWeiExact(v)]).toEqual(["—", "—"]);
  });
});

describe("parseEth and weiToEthInput", () => {
  test("plain amounts of at most 18 decimals", () => {
    expect(parseEth("0.01")).toBe(10n ** 16n);
    expect(parseEth(" .5 ")).toBe(5n * 10n ** 17n);
    expect(parseEth("2")).toBe(2n * 10n ** 18n);
    expect(parseEth("2.")).toBe(2n * 10n ** 18n);
    expect(parseEth("0.000000000000000001")).toBe(1n);
  });

  test("refuses what a person could mistype", () => {
    for (const t of ["", ".", "-1", "1e18", "1,5", "0x10", "0.0000000000000000001", "1.2.3", "ten"]) expect(parseEth(t)).toBeNull();
  });

  test("round trip through the input field form", () => {
    for (const wei of [0n, 1n, 10n ** 16n, 123456789n * 10n ** 9n, 7n * 10n ** 18n]) expect(parseEth(weiToEthInput(wei))).toBe(wei);
    expect(weiToEthInput("10000000000000000")).toBe("0.01");
  });
});

describe("the rest", () => {
  test("gas, hashes, addresses", () => {
    expect(formatGas("60000")).toBe("60,000");
    expect(formatGas("0xea60")).toBe("60,000");
    expect(formatGas(null)).toBe("—");
    expect(shortHex("0x5544596212F91984C986A919C8026DF0576816f9")).toBe("0x5544…16f9");
    expect(shortHex("0x1")).toBe("0x1");
    expect(shortHex(null)).toBe("—");
    expect(isAddress("0x5544596212F91984C986A919C8026DF0576816f9")).toBe(true);
    expect(isAddress("0x5544")).toBe(false);
    expect(toBigInt("12")).toBe(12n);
    expect(toBigInt(2 ** 60)).toBeNull(); // not a safe integer
  });

  test("a lane is a nonce key: (epoch << 32) | leaf", () => {
    expect(nonceKeyParts("0x1")).toEqual({ epoch: 0, leaf: 1 });
    expect(nonceKeyParts("0x10000000c")).toEqual({ epoch: 1, leaf: 12 });
    expect(nonceKeyParts(null)).toBeNull();
  });

  test("times", () => {
    expect([formatAgo(4.4), formatAgo(61), formatAgo(7300)]).toEqual(["4 s ago", "1 min ago", "2 h ago"]);
    expect([formatOffset(400), formatOffset(12_400), formatOffset(125_000)]).toEqual(["+0.4 s", "+12 s", "+2 min 5 s"]);
    expect(formatClock("2026-11-06T09:03:05.000Z")).toMatch(/^\d\d:\d\d:05$/);
    expect(formatClock(1_762_419_785)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(formatClock("not a time")).toBe("—");
  });
});
