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

/** Produces the hash-based signature entry for one leaf over one 32-byte message. */
export interface HashSigner {
  height: number;
  sign(req: { chainId: bigint; leaf: number; msg: Hex }): Promise<Hex>;
}

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

/**
 * Shell-out to the hashsig CLI's `sign` (plan, interface 4). The seed goes in through PQ_SEED, which
 * both the spec and the plan accept, so it never appears as an argument.
 * VERIFY against the published CLI: the --chains format (comma-separated here) and the output fields.
 */
export function cliHashSigner(opts: { bin: string; seedFile: string; height: number; generation: number; chains: bigint[] }): HashSigner {
  return {
    height: opts.height,
    async sign({ chainId, leaf, msg }) {
      const seed = (await Bun.file(opts.seedFile).text()).trim();
      const proc = Bun.spawn(
        [opts.bin, "sign", "--height", String(opts.height), "--generation", String(opts.generation),
          "--chains", opts.chains.join(","), "--chain-id", String(chainId), "--leaf", String(leaf), "--msg", msg],
        { env: { ...process.env, PQ_SEED: seed }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) {
        let parsed: { error?: string; detail?: string } = {};
        try { parsed = JSON.parse(err); } catch { /* not JSON */ }
        throw new HashSignerError(parsed.error ?? `exit_${code}`, parsed.detail ?? err.trim());
      }
      const res = JSON.parse(out) as { leaf: number; entry: Hex };
      if (res.leaf !== leaf) throw new HashSignerError("leaf_mismatch", `asked for leaf ${leaf}, CLI signed ${res.leaf}`);
      return res.entry;
    },
  };
}
