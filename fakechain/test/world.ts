// One fake world per test file: chain, sidecar and server on the preload's port, with the launcher's first account.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FakeChain } from "../src/chain.ts";
import { DEFAULT_OPTIONS, ETH, type FakeChainOptions } from "../src/constants.ts";
import { serve } from "../src/server.ts";
import { createFirstAccount, type FirstAccount } from "../src/setup.ts";
import { Sidecar } from "../src/sidecar.ts";
import { genesisState } from "../src/world.ts";

export interface World {
  chain: FakeChain;
  sidecar: Sidecar;
  dir: string;
  first: FirstAccount;
  deployment: FirstAccount["deployment"];
  eoaKey: Hex;
  stop(): void;
}

/** Fast blocks (1 s) and bundler passes (1 s) by default; everything else as the launcher's defaults. */
export async function startWorld(o: Partial<FakeChainOptions> = {}): Promise<World> {
  const port = Number(process.env.FAKECHAIN_TEST_PORT);
  const dir = fs.mkdtempSync(path.join(process.env.FAKECHAIN_TEST_ROOT!, "world-"));
  const eoaKey = generatePrivateKey(), faucetKey = generatePrivateKey();
  const genesis = genesisState({ eoa: privateKeyToAccount(eoaKey).address, faucet: privateKeyToAccount(faucetKey).address });
  const chain = new FakeChain({ ...DEFAULT_OPTIONS, blockTime: 1, bundleInterval: 1, ...o }, genesis.state);
  const sidecar = new Sidecar(chain, faucetKey);
  const server = serve(chain, sidecar, port, (s) => console.error(s));
  chain.start();
  sidecar.start();
  const first = await createFirstAccount({
    seedFile: path.join(dir, "seeds", "account-1.seed"), height: 10, eoaKey, fund: 10n * ETH,
    implementationCodeHash: genesis.implementation.initCodeHash, genesisHash: chain.genesisHash,
  });
  return {
    chain, sidecar, dir, first, deployment: first.deployment, eoaKey,
    stop: () => { chain.stop(); sidecar.stop(); server.stop(true); },
  };
}
