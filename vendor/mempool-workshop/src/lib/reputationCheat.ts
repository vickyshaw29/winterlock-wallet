import type { Address } from "viem";
import { getReputation } from "./explorer.js";
import { StepError } from "./output.js";

export const CHEAT_NOTICE = [
  "THIS CHEATS.",
  "Reputation normally falls because an entity keeps producing txs that are admitted and then never included.",
  "That cannot be reproduced reliably on this devnet, so this writes the counters directly with the devnet's open",
  "debug_bundler_setReputation method, for your own wallet only. Real nodes restrict that method.",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the explorer until it shows `status` for `address`. */
export async function waitForReputation(address: Address, status: "OK" | "BANNED") {
  for (let i = 0; i < 10; i++) {
    const r = await getReputation(address);
    if (r.status === status) return r;
    await sleep(1000);
  }
  throw new StepError("REPUTATION_NOT_APPLIED", `the explorer never showed ${status} for ${address}`, { hint: "is the node started with --explorer.enable, and is debug_bundler_setReputation reachable?" });
}
