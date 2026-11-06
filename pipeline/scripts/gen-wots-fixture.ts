// Writes test/fixtures/wots-digits.json: messages with the digits and chain steps our wots.ts computes.
// account/test/WotsDigitsOracle.t.sol checks every case against Quip's WOTSPlus.sol (the normative format).
// Written with Claude Code (AI) for Vicky.
//   bun scripts/gen-wots-fixture.ts
import { keccak256, toHex, type Hex } from "viem";
import { wotsDigits, wotsVerifySteps } from "../src/wots.ts";

const fill = (byte: number): Hex => toHex(new Uint8Array(32).fill(byte));
const messages: Hex[] = [
  fill(0x00), fill(0xff), fill(0x0f), fill(0xf0), fill(0x5a), fill(0x11), fill(0xee),
  ...Array.from({ length: 64 }, (_, i) => keccak256(toHex(`winterlock wots fixture ${i}`))),
];
const cases = messages.map((msg) => ({ msg, digits: wotsDigits(msg), steps: wotsVerifySteps(msg) }));
await Bun.write(`${import.meta.dir}/../test/fixtures/wots-digits.json`, JSON.stringify({ source: "pipeline/src/wots.ts", cases }, null, 1) + "\n");
console.log(`${cases.length} cases, steps from ${Math.min(...cases.map((c) => c.steps))} to ${Math.max(...cases.map((c) => c.steps))}`);
