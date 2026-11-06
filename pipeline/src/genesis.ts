// The genesis pin of a seed, kept in a file beside the seed (Node only). The check is in chain-pin.ts.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import { currentChain, checkChainPin, pinFor, type ChainIdentity, type ChainPin } from "./chain-pin.ts";

export { ChainChanged, checkChainPin, currentChain, type ChainIdentity, type ChainPin } from "./chain-pin.ts";

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
  const pin = pinFor(now);
  fs.writeFileSync(pinFile, JSON.stringify(pin, null, 2) + "\n", { mode: 0o600, flag: "wx" }); // wx: never replace a pin
  return pin;
}
