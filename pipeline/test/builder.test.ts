import { describe, expect, test } from "bun:test";
import { buildFrameTx, expiryFrame, keyedNonce, nonceKeyFor, nonceManagerSlot, prefixBudget, splitNonceKey } from "../src/builder.ts";
import { EXPIRY_VERIFIER } from "../src/config.ts";
import { SIG_SCHEME, type SignatureEntry } from "../src/codec/FrameTx.ts";
import type { Address } from "viem";

const ME: Address = "0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d";
const BOB: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
const fees = { maxFeePerGas: 2_000_000_001n, maxPriorityFeePerGas: 2_000_000_000n };
const ecdsa: SignatureEntry = { scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: "0x" };
const hashEntry: SignatureEntry = { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" };

describe("nonce keys", () => {
  test("key = (epoch << 32) | leaf, as the devnet showed: 0x100000005", () => {
    expect(nonceKeyFor(1, 5)).toBe(0x1_0000_0005n);
    expect(splitNonceKey(0x1_0000_0005n)).toEqual({ epoch: 1, leaf: 5 });
  });
  test("epoch 0, leaf 0 is refused: key 0 is the legacy nonce", () => {
    expect(() => nonceKeyFor(0, 0)).toThrow("legacy nonce");
    expect(nonceKeyFor(1, 0)).toBe(1n << 32n);
  });
  test("leaf and epoch must fit in 32 bits", () => {
    expect(() => nonceKeyFor(0, 2 ** 32)).toThrow();
    expect(() => nonceKeyFor(-1, 1)).toThrow();
  });
  test("keyed transactions run at sequence 0", () => {
    expect(keyedNonce(2, 7)).toEqual({ keys: [(2n << 32n) | 7n], seq: 0n });
  });
  test("nonce manager slot matches the one read on the devnet for (our EOA, key 1)", () => {
    expect(nonceManagerSlot(ME, 1n)).toBe("0x51e7c35edefbc77deee71aa576d542cb93237e8dea9aa852c6299c08d9e45b9a");
  });
});

describe("frames", () => {
  test("expiry data is the 8-byte big-endian deadline (spec example)", () => {
    const f = expiryFrame(0x690c2a5e);
    expect(f.data).toBe("0x00000000690c2a5e");
    expect(f.target).toBe(EXPIRY_VERIFIER);
    expect(f.limits.execution).toBe(5_000n);
  });
  test("order: expiry, self_verify, then one SENDER frame per call", () => {
    const tx = buildFrameTx({ chainId: 1337n, sender: ME, nonce: keyedNonce(2, 1), verifyGas: 50_000n, calls: [{ to: BOB, value: 1n }, { to: BOB, value: 2n }], deadline: 1_800_000_000, fees, signatures: [ecdsa] });
    expect(tx.frames.map((f) => [f.mode, f.flags, f.target])).toEqual([[1, 0, EXPIRY_VERIFIER], [1, 3, null], [2, 0, BOB], [2, 0, BOB]]);
  });
  test("no expiry frame when the deadline is null", () => {
    const tx = buildFrameTx({ chainId: 1337n, sender: ME, nonce: keyedNonce(2, 1), verifyGas: 50_000n, calls: [{ to: BOB }], deadline: null, fees, signatures: [ecdsa] });
    expect(tx.frames.map((f) => f.mode)).toEqual([1, 2]);
  });
});

describe("prefix budget (flat 100k on the devnet)", () => {
  const base = { chainId: 1337n, sender: ME, nonce: keyedNonce(2, 1), calls: [{ to: BOB }], deadline: 1_800_000_000, fees };
  test("spec layout fits: expiry 5,000 + verify 90,000 + ARBITRARY 100 + ECDSA 2,800 = 97,900", () => {
    const tx = buildFrameTx({ ...base, verifyGas: 90_000n, signatures: [ecdsa, hashEntry] });
    expect(prefixBudget(tx)).toBe(97_900n);
  });
  test("over the cap is refused before signing: the devnet would say 'exceeds MAX_VERIFY_GAS'", () => {
    expect(() => buildFrameTx({ ...base, verifyGas: 95_000n, signatures: [ecdsa, hashEntry] })).toThrow("above the 100000 cap");
  });
});
