// A devnet reset gives the same chain id a new history: a seed used before the reset would sign leaf 0 again
// on the new chain, and two signatures on one leaf leak its key (spec, "Trade-offs and risks"). So the chain's
// genesis hash is pinned beside the seed, and nothing signs on a chain whose genesis differs.
// The check itself, browser- and Snap-safe (Nov 6): where the pin is stored is the host's business (genesis.ts keeps
// it in a file beside the seed; a Snap would keep it in its state, written once and never replaced).
// Written with Claude Code (AI) for Vicky.
import type { Hex } from "viem";
import { defaultNetwork, type Network } from "./network.ts";

export interface ChainPin {
  chainId: string;
  genesisHash: Hex;
  pinnedAt: string;
}

export interface ChainIdentity { chainId: bigint; genesisHash: Hex }

/** The connected node's chain id and genesis block hash. */
export async function currentChain(net: Network = defaultNetwork): Promise<ChainIdentity> {
  const [chainId, genesis] = await Promise.all([
    net.node.request<Hex>("eth_chainId"),
    net.node.request<{ hash: Hex }>("eth_getBlockByNumber", ["0x0", false]),
  ]);
  return { chainId: BigInt(chainId), genesisHash: genesis.hash };
}

export class ChainChanged extends Error {}

/** Throws unless `now` is the chain the pin was made on. */
export function checkChainPin(pin: ChainPin, now: ChainIdentity): void {
  if (BigInt(pin.chainId) !== now.chainId) {
    throw new ChainChanged(`pinned to chain ${pin.chainId}, connected to chain ${now.chainId}`);
  }
  if (pin.genesisHash.toLowerCase() !== now.genesisHash.toLowerCase()) {
    throw new ChainChanged(
      `chain ${pin.chainId} was reset: genesis ${now.genesisHash}, not the pinned ${pin.genesisHash}. ` +
        "This seed's leaves may already be exposed on the old chain: make a new seed and a new account.",
    );
  }
}

/** A new pin for the chain `now` names. */
export const pinFor = (now: ChainIdentity): ChainPin => ({ chainId: now.chainId.toString(), genesisHash: now.genesisHash, pinnedAt: new Date().toISOString() });
