import { describe, expect, it } from "vitest";
import { AddressMap } from "../src/address-map";
import type { Address, Hex } from "../src/types";

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");
const MAINNET_A = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const DEVNET_A = "0x1111111111111111111111111111111111111111" as Address;
// Permit2 starts with zero bytes: a vanity address.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const DEVNET_P = "0x2222222222222222222222222222222222222222" as Address;

describe("AddressMap.rewrite", () => {
  it("replaces a mapped address word and leaves other words alone", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const input = `0x${word("0x2a")}${word(MAINNET_A)}${word("0x01")}` as Hex;

    const result = map.rewrite(input);

    expect(result.data).toBe(`0x${word("0x2a")}${word(DEVNET_A)}${word("0x01")}`);
    expect(result.replaced).toBe(1);
    expect(result.unmapped).toEqual([]);
  });

  it("matches addresses case-insensitively", () => {
    const map = new AddressMap();
    map.set(MAINNET_A.toUpperCase().replace("0X", "0x") as Address, DEVNET_A);
    const result = map.rewrite(`0x${word(MAINNET_A.toLowerCase())}` as Hex);
    expect(result.data).toBe(`0x${word(DEVNET_A)}`);
  });

  it("rewrites vanity addresses that start with zero bytes", () => {
    const map = new AddressMap();
    map.set(PERMIT2, DEVNET_P);
    const result = map.rewrite(`0x${word(PERMIT2)}` as Hex);
    expect(result.data).toBe(`0x${word(DEVNET_P)}`);
    expect(result.replaced).toBe(1);
  });

  it("reports address-looking words with no mapping and leaves them unchanged", () => {
    const map = new AddressMap();
    const input = `0x${word(MAINNET_A)}` as Hex;
    const result = map.rewrite(input);
    expect(result.data).toBe(input);
    expect(result.replaced).toBe(0);
    expect(result.unmapped).toEqual([MAINNET_A.toLowerCase()]);
  });

  it("does not flag small numbers or text as addresses", () => {
    const map = new AddressMap();
    const text = Buffer.from("Tether USD").toString("hex").padEnd(64, "0");
    const input = `0x${word("0x174876e800")}${word("0x06")}${text}` as Hex;
    const result = map.rewrite(input);
    expect(result.unmapped).toEqual([]);
    expect(result.data).toBe(input);
  });

  it("rejects data that is not a whole number of words", () => {
    expect(() => new AddressMap().rewrite("0x1234" as Hex)).toThrow(/32-byte words/);
  });

  it("round-trips through toJSON and the constructor", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const copy = new AddressMap(map.toJSON());
    expect(copy.get(MAINNET_A)).toBe(DEVNET_A);
  });
});

describe("AddressMap.patch", () => {
  // Address literals as they appear in raw bytecode: 40 lower-case hex chars, no padding,
  // no leading "0x" wrapper implied by word alignment - unlike rewrite(), which only ever
  // sees 32-byte ABI words.
  const bare = (address: Address): string => address.slice(2).toLowerCase();

  it("replaces every literal occurrence with the devnet address", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0x6080${bare(MAINNET_A)}6001${bare(MAINNET_A)}6002` as Hex;

    const result = map.patch(initCode, [{ find: MAINNET_A, count: 2 }]);

    expect(result).toBe(`0x6080${bare(DEVNET_A)}6001${bare(DEVNET_A)}6002`);
  });

  it("matches literals case-insensitively and normalizes the whole output to lower case", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0x60AA${MAINNET_A.slice(2).toUpperCase()}6001` as Hex;

    const result = map.patch(initCode, [{ find: MAINNET_A, count: 1 }]);

    expect(result).toBe(`0x60aa${bare(DEVNET_A)}6001`);
  });

  it("leaves bytes outside the matched literal untouched", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0xdeadbeef${bare(MAINNET_A)}cafebabe` as Hex;

    const result = map.patch(initCode, [{ find: MAINNET_A, count: 1 }]);

    expect(result).toBe(`0xdeadbeef${bare(DEVNET_A)}cafebabe`);
  });

  it("applies several patches in one call", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    map.set(PERMIT2, DEVNET_P);
    const initCode = `0x${bare(MAINNET_A)}${bare(PERMIT2)}` as Hex;

    const result = map.patch(initCode, [
      { find: MAINNET_A, count: 1 },
      { find: PERMIT2, count: 1 },
    ]);

    expect(result).toBe(`0x${bare(DEVNET_A)}${bare(DEVNET_P)}`);
  });

  it("throws when the actual occurrence count is lower than expected", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0x${bare(MAINNET_A)}` as Hex;

    expect(() => map.patch(initCode, [{ find: MAINNET_A, count: 2 }])).toThrow(
      /expected 2 occurrences of 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 in init code, found 1/
    );
  });

  it("throws when the actual occurrence count is higher than expected", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0x${bare(MAINNET_A)}${bare(MAINNET_A)}` as Hex;

    expect(() => map.patch(initCode, [{ find: MAINNET_A, count: 1 }])).toThrow(
      /expected 1 occurrences .* found 2/
    );
  });

  it("does not mutate the init code when the count check fails", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const initCode = `0x${bare(MAINNET_A)}${bare(MAINNET_A)}` as Hex;
    try {
      map.patch(initCode, [{ find: MAINNET_A, count: 1 }]);
    } catch {
      /* expected */
    }
    // A second, correctly-counted patch call against the same map still works.
    expect(map.patch(initCode, [{ find: MAINNET_A, count: 2 }])).toBe(`0x${bare(DEVNET_A)}${bare(DEVNET_A)}`);
  });

  it("throws with no devnet mapping for the target address", () => {
    const map = new AddressMap();
    const initCode = `0x${bare(MAINNET_A)}` as Hex;

    expect(() => map.patch(initCode, [{ find: MAINNET_A, count: 1 }])).toThrow(
      /no devnet mapping for 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/
    );
  });

  it("with no patches, returns the init code unchanged (aside from case)", () => {
    const map = new AddressMap();
    expect(map.patch("0xDEADBEEF" as Hex, [])).toBe("0xdeadbeef");
  });
});
