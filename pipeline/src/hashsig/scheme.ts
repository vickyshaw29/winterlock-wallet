// WOTS+ in Quip's exact wire format (spec, Cryptography; the normative source is
// contracts/lib/hashsigs-solidity/contracts/WOTSPlus.sol) and the spec's key derivation.
// Written with Claude Code (AI) for Vicky, during the event, because the hashsig library was not published.
//
//   n = 32 (keccak256), w = 16, 64 message digits + 3 checksum digits = 67 chains, signature 67 x 32 bytes.
//   Randomization elements (Quip's prf): r_k = keccak256(0x03 ‖ publicSeed ‖ uint16(k)). A chain step at position
//   s is x = keccak256(x XOR r_s), so only r_1..r_15 are ever used (WOTSPlus.chain: elements[i + index], i >= 1).
//   Signing chain j runs steps 1..d_j from the secret; verifying runs steps d_j + 1..15 from the signature.
//   Public key hash = keccak256 of the 67 chain ends.
//
// Key derivation (spec table "Key derivation (ours)"), every quantity from one 32-byte master seed S:
//   T = keccak256(0x02 ‖ S ‖ uint32(g))          tree seed, g the generation (the account's epoch)
//   P_i = keccak256(T ‖ uint32(i))                per-leaf public seed, i = (slot << h) | leaf
//   sk_{i,j} = keccak256(0x01 ‖ S ‖ uint32(g) ‖ uint32(i) ‖ uint8(j))
import { keccak_256 } from "@noble/hashes/sha3.js";
import { wotsDigits } from "../wots.ts";
import { bytesToHex, type Hex } from "viem";

export const HASH_LEN = 32;
export const W = 16;
export const CHAINS = 67;
export const SIGNATURE_BYTES = CHAINS * HASH_LEN; // 2,144

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const keccak = (...parts: Uint8Array[]): Uint8Array => keccak_256(parts.length === 1 ? parts[0]! : concatBytes(...parts));

const checkUint = (v: number, bits: number, what: string) => {
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) throw new Error(`${what} must be a uint${bits}, got ${v}`);
};
export const u8 = (v: number) => { checkUint(v, 8, "value"); return Uint8Array.of(v); };
export const u16 = (v: number) => { checkUint(v, 16, "value"); return Uint8Array.of(v >>> 8, v & 0xff); };
export const u32 = (v: number) => { checkUint(v, 32, "value"); return Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
export function u256(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 256n) throw new Error(`value must be a uint256, got ${v}`);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
const xor32 = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = a[i]! ^ b[i]!; return o; };

// ------------------------------------------------------------------ derivation
const checkSeed = (S: Uint8Array) => { if (S.length !== 32) throw new Error(`master seed must be 32 bytes, got ${S.length}`); };
export function treeSeedOf(S: Uint8Array, generation: number): Uint8Array {
  checkSeed(S);
  return keccak(Uint8Array.of(0x02), S, u32(generation));
}
export const publicSeedOf = (treeSeed: Uint8Array, index: number): Uint8Array => keccak(treeSeed, u32(index));
export function secretOf(S: Uint8Array, generation: number, index: number, chain: number): Uint8Array {
  checkSeed(S);
  return keccak(Uint8Array.of(0x01), S, u32(generation), u32(index), u8(chain));
}

// ------------------------------------------------------------------ WOTS+ (Quip format)
/** r_0..r_15 (WOTSPlus.prf). r_0 is never used by the chain function; it is kept so r[s] is position s. */
export function randomization(publicSeed: Uint8Array): Uint8Array[] {
  return Array.from({ length: W }, (_, k) => keccak(Uint8Array.of(0x03), publicSeed, u16(k)));
}

/** WOTSPlus.chain: `steps` steps starting after position `start` (start + steps <= 15). */
export function chain(x: Uint8Array, r: Uint8Array[], start: number, steps: number): Uint8Array {
  if (start + steps > W - 1) throw new Error(`chain past the end: start ${start} + steps ${steps}`);
  let out = x;
  for (let i = 1; i <= steps; i++) out = keccak(xor32(out, r[start + i]!));
  return out;
}

const digitsOf = (msg: Uint8Array) => wotsDigits(bytesToHex(msg));

/** The 67 secrets of one leaf. */
export const leafSecrets = (S: Uint8Array, generation: number, index: number) =>
  Array.from({ length: CHAINS }, (_, j) => secretOf(S, generation, index, j));

/** Chain ends from the secrets: the public key. */
export const publicKeyOf = (secrets: Uint8Array[], r: Uint8Array[]) => secrets.map((sk) => chain(sk, r, 0, W - 1));

/** WOTSPlus public key hash: keccak256 of the 67 chain ends. */
export const publicKeyHashOf = (pk: Uint8Array[]) => keccak(concatBytes(...pk));

/** Sign: chain j runs d_j steps from its secret. */
export function wotsSign(msg: Uint8Array, secrets: Uint8Array[], r: Uint8Array[]): Uint8Array[] {
  if (msg.length !== 32) throw new Error(`message must be 32 bytes, got ${msg.length}`);
  const d = digitsOf(msg);
  return secrets.map((sk, j) => chain(sk, r, 0, d[j]!));
}

/** Verify side: complete each chain from the signature to its end (WOTSPlus.verify). */
export function wotsPublicKeyFromSignature(msg: Uint8Array, sig: Uint8Array[], r: Uint8Array[]): Uint8Array[] {
  if (sig.length !== CHAINS) throw new Error(`signature must have ${CHAINS} elements, got ${sig.length}`);
  const d = digitsOf(msg);
  return sig.map((s, j) => chain(s, r, d[j]!, W - 1 - d[j]!));
}

export const toHexBytes = (b: Uint8Array): Hex => bytesToHex(b);
