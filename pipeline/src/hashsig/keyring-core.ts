// Key generation, signing and verification for the nonce-bound tree (spec, "Signer core" and Cryptography).
// Stateless like the spec's signer: it never tracks used leaves (the pipeline's journal does) and never prints a
// secret. Leaf nodes are public and can be cached through a LeafCache, per (tree seed, chain, height).
// Browser- and Snap-safe (Nov 6): no file system here. keyring.ts (Node) adds the disk cache and the seed file.
// Written with Claude Code (AI) for Vicky.
import { bytesToHex, hexToBytes, type Hex } from "viem";
import {
  CHAINS, HASH_LEN, SIGNATURE_BYTES, W, concatBytes, keccak, leafSecrets, publicKeyHashOf, publicKeyOf, publicSeedOf,
  randomization, treeSeedOf, u256, wotsPublicKeyFromSignature, wotsSign,
} from "./scheme.ts";
import { EMPTY_SUBTREE, SLOTS, SLOT_BITS, buildLevels, leafNodeOf, rootFromPath, siblings } from "./tree.ts";
import type { HashSigner } from "../signer.ts";

export const ENTRY_VERSION = 0x01;
export const MAX_HEIGHT = 28; // (slot << h) | leaf must fit the uint32 index
/** Signature entry: version (1) ‖ slot (1) ‖ WOTS+ signature (2,144) ‖ path 32 x (h + 4). */
export const entryLength = (height: number) => 2 + SIGNATURE_BYTES + HASH_LEN * (height + SLOT_BITS);

export class HashSigError extends Error {
  constructor(readonly code: "bad_seed" | "bad_height" | "bad_chain" | "leaf_out_of_range" | "bad_msg_length" | "bad_entry_length", detail: string) {
    super(`${code}: ${detail}`);
  }
}

export interface KeyringParams {
  seed: Uint8Array;
  /** the account's epoch the tree is built for */
  generation: number;
  height: number;
  /** chain ids in slot order: chains[s] uses slot s */
  chains: bigint[];
  /** where leaf nodes are cached; no cache when omitted */
  leafCache?: LeafCache;
}

/**
 * A store for one subtree's leaf nodes (public data: 32 bytes per leaf), so a tree is built once. load returns null
 * when it holds nothing under `name`; bytes it returns of another length are ignored and rebuilt.
 */
export interface LeafCache {
  load(name: string): Uint8Array | null;
  save(name: string, nodes: Uint8Array): void;
}

export class Keyring {
  readonly treeSeed: Uint8Array;
  private readonly seed: Uint8Array;
  private readonly leafCache = new Map<number, Uint8Array[]>(); // slot -> leaf nodes
  private slotRoots: Uint8Array[] | null = null;
  private topLevels: Uint8Array[][] | null = null;

  constructor(private readonly p: KeyringParams) {
    if (p.seed.length !== 32) throw new HashSigError("bad_seed", `seed must be 32 bytes, got ${p.seed.length}`);
    if (!Number.isInteger(p.height) || p.height < 1 || p.height > MAX_HEIGHT) throw new HashSigError("bad_height", `height must be 1 to ${MAX_HEIGHT}, got ${p.height}`);
    if (p.chains.length < 1 || p.chains.length > SLOTS) throw new HashSigError("bad_chain", `1 to ${SLOTS} chains, got ${p.chains.length}`);
    if (new Set(p.chains.map(String)).size !== p.chains.length) throw new HashSigError("bad_chain", "a chain id is listed twice");
    this.seed = Uint8Array.from(p.seed);
    this.treeSeed = treeSeedOf(this.seed, p.generation);
  }

  get height() { return this.p.height; }
  get generation() { return this.p.generation; }
  get chains() { return [...this.p.chains]; }

  slotOf(chainId: bigint): number {
    const s = this.p.chains.findIndex((c) => c === chainId);
    if (s < 0) throw new HashSigError("bad_chain", `chain ${chainId} is not in this tree's chain list`);
    return s;
  }

  private indexOf(slot: number, leaf: number): number {
    if (!Number.isInteger(leaf) || leaf < 0 || leaf >= 2 ** this.p.height) throw new HashSigError("leaf_out_of_range", `leaf ${leaf} not in [0, 2^${this.p.height})`);
    return slot * 2 ** this.p.height + leaf; // (slot << h) | leaf, without 32-bit shift overflow
  }

  /** One leaf's public seed, public key hash and leaf node. */
  publicKey(chainId: bigint, leaf: number) {
    const slot = this.slotOf(chainId);
    const index = this.indexOf(slot, leaf);
    const P = publicSeedOf(this.treeSeed, index);
    const pkHash = publicKeyHashOf(publicKeyOf(leafSecrets(this.seed, this.p.generation, index), randomization(P)));
    return { slot, index, publicSeed: P, publicKeyHash: pkHash, leafNode: leafNodeOf(P, chainId, pkHash) };
  }

  /** Every leaf node of one listed chain's subtree, from the cache or computed (2^h x 67 x 15 hashes). */
  private leaves(slot: number): Uint8Array[] {
    const hit = this.leafCache.get(slot);
    if (hit) return hit;
    const chainId = this.p.chains[slot]!;
    const cache = this.p.leafCache;
    const name = cache ? `${bytesToHex(keccak(this.treeSeed, u256(chainId), Uint8Array.of(this.p.height))).slice(2, 18)}.leaves` : null;
    let nodes: Uint8Array[] | null = null;
    const raw = cache && name ? cache.load(name) : null;
    if (raw && raw.length === 32 * 2 ** this.p.height) nodes = Array.from({ length: 2 ** this.p.height }, (_, i) => new Uint8Array(raw.subarray(i * 32, i * 32 + 32)));
    if (!nodes) {
      nodes = Array.from({ length: 2 ** this.p.height }, (_, leaf) => this.publicKey(chainId, leaf).leafNode);
      if (cache && name) cache.save(name, concatBytes(...nodes));
    }
    this.leafCache.set(slot, nodes);
    return nodes;
  }

  private subtreeRoots(): Uint8Array[] {
    if (!this.slotRoots) {
      this.slotRoots = Array.from({ length: SLOTS }, (_, s) => (s < this.p.chains.length ? buildLevels(this.leaves(s)).at(-1)![0]! : EMPTY_SUBTREE));
      this.topLevels = buildLevels(this.slotRoots);
    }
    return this.slotRoots;
  }

  /** The root at height h + 4: what the account stores. */
  root(): Uint8Array {
    this.subtreeRoots();
    return this.topLevels!.at(-1)![0]!;
  }

  /** The h + 4 siblings for one leaf, leaf level first. */
  authPath(chainId: bigint, leaf: number): Uint8Array[] {
    const slot = this.slotOf(chainId);
    this.indexOf(slot, leaf);
    this.subtreeRoots();
    return [...siblings(buildLevels(this.leaves(slot)), leaf), ...siblings(this.topLevels!, slot)];
  }

  /** The signature entry for (chain, leaf) over a 32-byte message. The caller makes sure a leaf signs once. */
  sign(chainId: bigint, leaf: number, msg: Uint8Array): { entry: Uint8Array; slot: number; signature: Uint8Array[]; authPath: Uint8Array[] } {
    if (msg.length !== 32) throw new HashSigError("bad_msg_length", `message must be 32 bytes, got ${msg.length}`);
    const slot = this.slotOf(chainId);
    const index = this.indexOf(slot, leaf);
    const P = publicSeedOf(this.treeSeed, index);
    const signature = wotsSign(msg, leafSecrets(this.seed, this.p.generation, index), randomization(P));
    const authPath = this.authPath(chainId, leaf);
    return { entry: encodeEntry(slot, signature, authPath), slot, signature, authPath };
  }
}

export function encodeEntry(slot: number, signature: Uint8Array[], authPath: Uint8Array[]): Uint8Array {
  if (signature.length !== CHAINS) throw new Error(`signature must have ${CHAINS} elements`);
  return concatBytes(Uint8Array.of(ENTRY_VERSION, slot), ...signature, ...authPath);
}

export function decodeEntry(entry: Uint8Array, height: number) {
  if (entry.length !== entryLength(height)) throw new HashSigError("bad_entry_length", `entry is ${entry.length} bytes, expected ${entryLength(height)}`);
  const at = (o: number) => entry.subarray(o, o + HASH_LEN);
  return {
    version: entry[0]!,
    slot: entry[1]!,
    signature: Array.from({ length: CHAINS }, (_, j) => at(2 + HASH_LEN * j)),
    authPath: Array.from({ length: height + SLOT_BITS }, (_, k) => at(2 + SIGNATURE_BYTES + HASH_LEN * k)),
  };
}

/**
 * Off-chain mirror of the Yul verifier (spec steps 5 to 8), for the pre-flight check: it must give the same
 * answer as hashsig_verify for every input.
 */
export function verifyEntry(v: { entry: Uint8Array; msg: Uint8Array; root: Uint8Array; treeSeed: Uint8Array; height: number; chainId: bigint; leaf: number }): { ok: boolean; reason: string | null } {
  if (v.msg.length !== 32) return { ok: false, reason: "bad_msg_length" };
  if (v.height < 1 || v.height > MAX_HEIGHT) return { ok: false, reason: "bad_height" };
  if (v.entry.length !== entryLength(v.height)) return { ok: false, reason: "bad_entry_length" };
  if (v.leaf < 0 || v.leaf >= 2 ** v.height) return { ok: false, reason: "leaf_out_of_range" };
  const e = decodeEntry(v.entry, v.height);
  if (e.version !== ENTRY_VERSION) return { ok: false, reason: "bad_version" };
  if (e.slot >= SLOTS) return { ok: false, reason: "bad_slot" };
  const index = e.slot * 2 ** v.height + v.leaf;
  const P = publicSeedOf(v.treeSeed, index);
  const pkHash = publicKeyHashOf(wotsPublicKeyFromSignature(v.msg, e.signature, randomization(P)));
  const node = rootFromPath(leafNodeOf(P, v.chainId, pkHash), index, e.authPath);
  return equalBytes(node, v.root) ? { ok: true, reason: null } : { ok: false, reason: "verify_failed" };
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The pipeline's HashSigner over a keyring. */
export const keyringSigner = (k: Keyring): HashSigner => ({
  height: k.height,
  generation: k.generation,
  treeSeed: bytesToHex(k.treeSeed) as Hex,
  async sign({ chainId, leaf, msg }) {
    return bytesToHex(k.sign(chainId, leaf, hexToBytes(msg)).entry) as Hex;
  },
});

export { W };
