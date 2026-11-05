import { describe, expect, it } from "vitest";
import { applyArgWords, splitCreation, uintWord } from "../src/creation";
import type { Hex } from "../src/types";

const ARGS = `0x${"00".repeat(31)}05${"00".repeat(31)}07` as Hex; // two words: 5, 7

describe("splitCreation", () => {
  it("splits init code from constructor arguments", () => {
    const { initCode, args } = splitCreation({
      input: `0x6080604052${ARGS.slice(2)}` as Hex,
      constructorArgs: ARGS,
    });
    expect(initCode).toBe("0x6080604052");
    expect(args).toBe(ARGS);
  });

  it("handles contracts without constructor arguments", () => {
    const { initCode, args } = splitCreation({ input: "0x6080", constructorArgs: "0x" });
    expect(initCode).toBe("0x6080");
    expect(args).toBe("0x");
  });

  it("throws when the arguments are not a suffix of the input", () => {
    expect(() => splitCreation({ input: "0x6080", constructorArgs: "0xff" })).toThrow(/suffix/);
  });
});

describe("uintWord", () => {
  it("encodes big-endian into 32 bytes", () => {
    expect(uintWord(10n ** 15n)).toBe(
      "0x00000000000000000000000000000000000000000000000000038d7ea4c68000"
    );
  });
  it("rejects negative values", () => {
    expect(() => uintWord(-1n)).toThrow();
  });
});

describe("applyArgWords", () => {
  it("returns the arguments unchanged when there are no overrides", () => {
    expect(applyArgWords(ARGS, undefined)).toBe(ARGS);
  });

  it("replaces the word at the given index", () => {
    const result = applyArgWords(ARGS, { 1: uintWord(9n) });
    expect(result).toBe(`0x${"00".repeat(31)}05${"00".repeat(31)}09`);
  });

  it("rejects an index outside the arguments", () => {
    expect(() => applyArgWords(ARGS, { 2: uintWord(1n) })).toThrow(/outside/);
  });

  it.each(["abc", "-1", "1.5"])("rejects the argWords key %j", (key) => {
    const words = { [key]: uintWord(1n) } as unknown as Record<number, Hex>;
    expect(() => applyArgWords(ARGS, words)).toThrow(`argWords key "${key}" must be a non-negative integer`);
  });

  it("rejects a value that is not a 32-byte word", () => {
    expect(() => applyArgWords(ARGS, { 0: "0x01" })).toThrow(/32-byte/);
  });
});
