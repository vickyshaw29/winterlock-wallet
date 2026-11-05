import { describe, expect, test } from "bun:test";
import { concat, hexToBigInt, recoverAddress, size, slice, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildFrameTx, keyedNonce } from "../src/builder.ts";
import { computeSigHash } from "../src/codec/codec.ts";
import { hashEntryLength, placeholders, signFrameTx, type HashSigner, type SignatureSlot } from "../src/signer.ts";

const KEY: Hex = `0x${"11".repeat(32)}`; // test-only key
const owner = privateKeyToAccount(KEY);
const BOB = "0x5544596212F91984C986A919C8026DF0576816f9";

/** Stand-in for the hashsig CLI: right length, deterministic bytes. */
const fakeHashSigner = (height: number, wrongLength = false): HashSigner => ({
  height,
  async sign({ leaf }) {
    const body = new Uint8Array(hashEntryLength(height) - 2 + (wrongLength ? 1 : 0)).fill(leaf % 256);
    return concat(["0x0100", toHex(body)]);
  },
});

const hybrid = (signer: HashSigner, leaf: number): SignatureSlot[] => [
  { kind: "ecdsa", privateKey: KEY, signer: owner.address },
  { kind: "hash", signer, leaf },
];
const unsigned = (slots: SignatureSlot[]) =>
  buildFrameTx({
    chainId: 1337n, sender: "0x13075a0f56d6a793eba4493d866e6502052abe87", nonce: keyedNonce(1, 7), verifyGas: 90_000n,
    calls: [{ to: BOB, value: 1n }], deadline: 1_800_000_000,
    fees: { maxFeePerGas: 2_000_000_001n, maxPriorityFeePerGas: 2_000_000_000n }, signatures: placeholders(slots),
  });

describe("two-pass signing", () => {
  test("entry sizes from the spec: 2,594 bytes at h = 10, 2,914 at h = 20", () => {
    expect(hashEntryLength(10)).toBe(2_594);
    expect(hashEntryLength(20)).toBe(2_914);
  });

  test("placeholders have the final lengths", () => {
    const [e, h] = placeholders(hybrid(fakeHashSigner(10), 7));
    expect([size(e!.signature), size(h!.signature)]).toEqual([65, 2_594]);
  });

  test("filling the entries keeps the sig hash; the ECDSA entry recovers to the owner and is low-s", async () => {
    const slots = hybrid(fakeHashSigner(10), 7);
    const draft = unsigned(slots);
    const { tx, sigHash } = await signFrameTx(draft, slots);
    expect(sigHash).toBe(computeSigHash(draft));
    expect(computeSigHash(tx)).toBe(sigHash);

    const sig = tx.signatures[0]!.signature as Hex;
    const yParity = Number(hexToBigInt(slice(sig, 0, 1)));
    const r = slice(sig, 1, 33), s = slice(sig, 33, 65);
    expect(await recoverAddress({ hash: sigHash, signature: { r, s, yParity } })).toBe(owner.address);
    expect(hexToBigInt(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    expect(size(tx.signatures[1]!.signature as Hex)).toBe(2_594);
  });

  test("the hash signer is asked for this transaction's sig hash and leaf", async () => {
    let asked: { leaf: number; msg: Hex; chainId: bigint } | undefined;
    const spy: HashSigner = { height: 10, async sign(req) { asked = req; return fakeHashSigner(10).sign(req); } };
    const slots = hybrid(spy, 9);
    const { sigHash } = await signFrameTx(unsigned(slots), slots);
    expect(asked).toEqual({ leaf: 9, msg: sigHash, chainId: 1337n });
  });

  test("a hash-based entry of the wrong length is refused", async () => {
    const slots = hybrid(fakeHashSigner(10, true), 7);
    await expect(signFrameTx(unsigned(slots), slots)).rejects.toThrow("expected 2594");
  });
});
