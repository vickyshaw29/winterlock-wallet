// The many-time layer (spec, Cryptography): one subtree of height h per listed chain, 16 chain slots above them
// (4 more levels), the root at height h + 4. Leaf node L_i = keccak256(P_i ‖ uint256(chainId) ‖ pkHash_i);
// internal node = keccak256(left ‖ right); an unlisted slot holds EMPTY_SUBTREE at height h.
// Authentication path: h + 4 siblings, leaf level first; bit k of the full index (slot << h) | leaf says which
// side our node is on at level k (0: our node is the left child).
// Written with Claude Code (AI) for Vicky.
import { keccak, u256 } from "./scheme.ts";

export const SLOT_BITS = 4;
export const SLOTS = 16;
export const EMPTY_SUBTREE = keccak(new TextEncoder().encode("nonce-bound-pq-wallet/empty-slot"));

export const leafNodeOf = (publicSeed: Uint8Array, chainId: bigint, publicKeyHash: Uint8Array) =>
  keccak(publicSeed, u256(chainId), publicKeyHash);

export const parentOf = (left: Uint8Array, right: Uint8Array) => keccak(left, right);

/** All levels of a complete binary tree over a power-of-two number of nodes: levels[0] = the nodes, last = [root]. */
export function buildLevels(nodes: Uint8Array[]): Uint8Array[][] {
  if (nodes.length === 0 || (nodes.length & (nodes.length - 1)) !== 0) throw new Error(`need a power-of-two count, got ${nodes.length}`);
  const levels = [nodes];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(parentOf(prev[i]!, prev[i + 1]!));
    levels.push(next);
  }
  return levels;
}

/** Siblings from the bottom of `levels` up, for the node at `position`. */
export function siblings(levels: Uint8Array[][], position: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = position;
  for (let k = 0; k < levels.length - 1; k++) {
    out.push(levels[k]![p ^ 1]!);
    p >>= 1;
  }
  return out;
}

/** Recompute the root from a leaf node, its full index and its path (what the Yul verifier does). */
export function rootFromPath(leafNode: Uint8Array, index: number, path: Uint8Array[]): Uint8Array {
  let node = leafNode;
  for (let k = 0; k < path.length; k++) {
    node = (Math.floor(index / 2 ** k) & 1) === 0 ? parentOf(node, path[k]!) : parentOf(path[k]!, node);
  }
  return node;
}
