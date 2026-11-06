// WOTS+ chain work of a message, in Quip's exact format (spec, Cryptography: the normative reference is
// contracts/lib/hashsigs-solidity/contracts/WOTSPlus.sol): n = 32, w = 16, 64 message digits and 3 checksum
// digits. Verifying chain i runs 15 - digit_i hash steps, so the verifier's work is a pure function of the
// message, and the signer can compute it before anything is signed.
// Written with Claude Code (AI) for Vicky.
import { hexToBytes, type Hex } from "viem";

export const WOTS = { w: 16, messageDigits: 64, checksumDigits: 3, chains: 67, bestSteps: 45, worstSteps: 990 } as const;

/** The 67 chain digits: WOTSPlus.computeMessageHashChainIndexes. */
export function wotsDigits(msg: Hex): number[] {
  const bytes = hexToBytes(msg);
  if (bytes.length !== 32) throw new Error(`a WOTS+ message is 32 bytes, got ${bytes.length}`);
  const digits: number[] = [];
  for (const b of bytes) digits.push(b >> 4, b & 0x0f); // toBaseW: high nibble first
  let csum = 0;
  for (const d of digits) csum += 15 - d; // checksum(): sum of (w - 1 - digit) over the message digits
  const shifted = csum << 4; // shifted left 4 bits, then written as two big-endian bytes
  const hi = (shifted >> 8) & 0xff;
  const lo = shifted & 0xff;
  digits.push(hi >> 4, hi & 0x0f, lo >> 4); // the first 3 base-16 digits of those two bytes
  return digits;
}

/** Hash steps the verifier runs: sum over the 67 chains of 15 - digit (45 at best, 990 at worst). */
export function wotsVerifySteps(msg: Hex): number {
  return wotsDigits(msg).reduce((sum, d) => sum + (15 - d), 0);
}
