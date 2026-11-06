// A devnet reset gives the same chain id a new history: a seed used before the reset would sign leaf 0 again
// on the new chain, and two signatures on one leaf leak its key (spec, "Trade-offs and risks"). So the chain's
// genesis hash is pinned in a file beside the seed, and nothing signs on a chain whose genesis differs.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import type { Hex } from "viem";
import { DEVNET } from "./config.ts";
import { rpc } from "./rpc.ts";

export interface ChainPin {
  chainId: string;
  genesisHash: Hex;
  pinnedAt: string;
}

export interface ChainIdentity { chainId: bigint; genesisHash: Hex }

/** The connected node's chain id and genesis block hash. */
export async function currentChain(): Promise<ChainIdentity> {
  const [chainId, genesis] = await Promise.all([
    rpc<Hex>(DEVNET.node, "eth_chainId"),
    rpc<{ hash: Hex }>(DEVNET.node, "eth_getBlockByNumber", ["0x0", false]),
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

/** Where the pin of a seed lives: beside the seed file. */
export const pinFileFor = (seedFile: string) => `${seedFile}.chain.json`;

/**
 * Pins the current chain for a seed the first time, and checks the pin every time after: call it before
 * every signature. Never overwrites an existing pin.
 */
export async function pinOrCheckChain(pinFile: string, chain: () => Promise<ChainIdentity> = currentChain): Promise<ChainPin> {
  const now = await chain();
  if (fs.existsSync(pinFile)) {
    const pin = JSON.parse(fs.readFileSync(pinFile, "utf8")) as ChainPin;
    checkChainPin(pin, now);
    return pin;
  }
  const pin: ChainPin = { chainId: now.chainId.toString(), genesisHash: now.genesisHash, pinnedAt: new Date().toISOString() };
  fs.writeFileSync(pinFile, JSON.stringify(pin, null, 2) + "\n", { mode: 0o600, flag: "wx" }); // wx: never replace a pin
  return pin;
}
