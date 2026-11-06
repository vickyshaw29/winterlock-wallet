// Two-pass signing (spec, "Two-pass signing"): placeholders of the final lengths, then the sig hash,
// then each entry. Every entry has an empty msg, so the sig hash skips signature bytes and filling
// the entries cannot change it.
import { sign } from "viem/accounts";
import { concat, hexToBigInt, size, toHex, type Address, type Hex } from "viem";
import { computeSigHash } from "./codec/codec.ts";
import { SIG_SCHEME, type FrameTransaction, type SignatureEntry } from "./codec/FrameTx.ts";

export const ECDSA_ENTRY_LENGTH = 65; // y-parity ‖ r ‖ s
/** Hash-based entry: version (1) ‖ chain slot (1) ‖ WOTS+ signature (2,144) ‖ path 32 × (h + 4). */
export const hashEntryLength = (height: number) => 2 + 2_144 + 32 * (height + 4);

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Produces the hash-based signature entry for one leaf over one 32-byte message. It names the tree it signs
 * from (tree seed, generation, height), so the pipeline can check it against the journal before any leaf is used.
 */
export interface HashSigner {
  height: number;
  /** the tree's generation, which must equal the account's epoch (spec, Key derivation) */
  generation: number;
  /** the tree seed T, public: the account stores it */
  treeSeed: Hex;
  sign(req: { chainId: bigint; leaf: number; msg: Hex }): Promise<Hex>;
}

/**
 * For accounts running the placeholder verifier only, which checks just that the entry carries the message hash.
 * The real verifier refuses this entry, and it holds no key material.
 */
export const placeholderSigner = (tree: { treeSeed: Hex; generation?: number; height?: number }): HashSigner => {
  const height = tree.height ?? 10;
  return {
    height, generation: tree.generation ?? 0, treeSeed: tree.treeSeed,
    async sign({ msg }) { return concat(["0x0100", msg, toHex(new Uint8Array(hashEntryLength(height) - 34))]); },
  };
};

export type SignatureSlot =
  /** signer "0x" means tx.sender (a plain EOA); the account's hybrid co-signer passes the owner address */
  | { kind: "ecdsa"; privateKey: Hex; signer: Address | "0x" }
  | { kind: "hash"; signer: HashSigner; leaf: number };

const zeros = (n: number) => toHex(new Uint8Array(n));

/** Pass 1: entries of the exact final lengths, so the transaction's size never changes. */
export function placeholders(slots: SignatureSlot[]): SignatureEntry[] {
  return slots.map((s) =>
    s.kind === "ecdsa"
      ? { scheme: SIG_SCHEME.SECP256K1, signer: s.signer, msg: "0x", signature: zeros(ECDSA_ENTRY_LENGTH) }
      : { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: zeros(hashEntryLength(s.signer.height)) },
  );
}

/** Pass 2: sig hash over the placeholder transaction, then each entry. Returns the signed tx and the hash. */
export async function signFrameTx(unsigned: FrameTransaction, slots: SignatureSlot[]): Promise<{ tx: FrameTransaction; sigHash: Hex }> {
  const draft: FrameTransaction = { ...unsigned, signatures: placeholders(slots) };
  const sigHash = computeSigHash(draft);

  const entries: SignatureEntry[] = [];
  for (const [i, slot] of slots.entries()) {
    const placeholder = draft.signatures[i]!;
    if (slot.kind === "ecdsa") {
      const s = await sign({ hash: sigHash, privateKey: slot.privateKey });
      if (hexToBigInt(s.s) > SECP256K1_HALF_N) throw new Error("ECDSA signature is not low-s");
      const packed = concat([toHex(s.yParity ?? Number(s.v) - 27, { size: 1 }), s.r, s.s]);
      if (size(packed) !== ECDSA_ENTRY_LENGTH) throw new Error(`ECDSA entry is ${size(packed)} bytes, expected 65`);
      entries.push({ ...placeholder, signature: packed });
    } else {
      const entry = await slot.signer.sign({ chainId: unsigned.chainId, leaf: slot.leaf, msg: sigHash });
      const want = hashEntryLength(slot.signer.height);
      if (size(entry) !== want) throw new Error(`hash-based entry is ${size(entry)} bytes, expected ${want}`);
      entries.push({ ...placeholder, signature: entry });
    }
  }

  const tx: FrameTransaction = { ...draft, signatures: entries };
  if (computeSigHash(tx) !== sigHash) throw new Error("sig hash changed after filling the entries");
  return { tx, sigHash };
}

export class HashSignerError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`hashsig CLI: ${code}: ${detail}`);
  }
}
