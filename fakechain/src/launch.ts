// The launcher's body: throwaway keys, the chain and its sidecar, the first account and env.sh, then run until Ctrl-C.
// Written with Claude Code (AI) for Vicky.
// fakechain/run.ts points the environment at the fake first and only then loads this file.
import "./guard.ts";
import fs from "node:fs";
import path from "node:path";
import { formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET } from "../../pipeline/src/config.ts";
import { FakeChain } from "./chain.ts";
import { CLIENT_VERSION, COINBASE, ETH, FACTORY, IMPLEMENTATION, SHOP, type FakeChainOptions } from "./constants.ts";
import { serve } from "./server.ts";
import { createFirstAccount } from "./setup.ts";
import { Sidecar } from "./sidecar.ts";
import { genesisState } from "./world.ts";

export interface LaunchFlags extends FakeChainOptions { port: number; height: number; dataDir: string }

export async function launch(f: LaunchFlags) {
  const log = (s: string) => console.log(`[fakechain] ${s}`);
  const env = {
    WL_CHAIN_ID: "31337", WL_NODE_URL: DEVNET.node, WL_GATEWAY_URL: DEVNET.gateway, WL_EXPLORER_URL: DEVNET.explorer,
    WL_DATA_DIR: process.env.WL_DATA_DIR!, WL_BACKEND_DIR: process.env.WL_BACKEND_DIR!, WL_EOA_KEY_FILE: process.env.WL_EOA_KEY_FILE!, WL_SEED_FILE: process.env.WL_SEED_FILE!,
  };
  for (const d of [env.WL_DATA_DIR, env.WL_BACKEND_DIR]) fs.mkdirSync(d, { recursive: true });

  // Throwaway keys, new on every run. The EOA's key is written for the backend and scripts; the faucet's stays in memory.
  const eoaKey = generatePrivateKey(), faucetKey = generatePrivateKey();
  fs.writeFileSync(env.WL_EOA_KEY_FILE, `${eoaKey}\n`, { mode: 0o600, flag: "wx" });
  const eoa = privateKeyToAccount(eoaKey);
  const genesis = genesisState({ eoa: eoa.address, faucet: privateKeyToAccount(faucetKey).address });

  const opts: FakeChainOptions = { blockTime: f.blockTime, baseFee: f.baseFee, publicPerSender: f.publicPerSender, bundleInterval: f.bundleInterval, proxyHoldback: f.proxyHoldback, enforceGasPrice: f.enforceGasPrice };
  const chain = new FakeChain(opts, genesis.state);
  const sidecar = new Sidecar(chain, faucetKey);
  let server: ReturnType<typeof serve>;
  try {
    server = serve(chain, sidecar, f.port, (s) => log(s));
  } catch (e) {
    throw new Error(`cannot listen on 127.0.0.1:${f.port}: ${(e as Error).message} (is another fakechain running? pass --port)`);
  }
  chain.onBlock = (b) => { if (b.txHashes.length) log(`block ${b.number}: ${b.txHashes.length} transaction(s)`); };
  chain.start();
  sidecar.start();
  let ready = false;
  const halt = () => { chain.stop(); sidecar.stop(); server.stop(true); };
  const stop = () => {
    halt();
    if (!ready) fs.rmSync(f.dataDir, { recursive: true, force: true }); // stopped mid-start: no throwaway key left behind
    log(ready ? `stopped. This run's files stay in ${f.dataDir}; a restart is a new world (new genesis, new keys).` : `stopped before it was ready; removed ${f.dataDir}.`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log(`${CLIENT_VERSION}: chain 31337, genesis ${chain.genesisHash}, a block every ${f.blockTime} s, base fee ${f.baseFee} wei`);
  if (genesis.implementation.placeholder) log(`WARNING: no usable ${genesis.implementation.source}: the implementation's code is a marked placeholder (the model still runs Account.yul's checks)`);
  let first: Awaited<ReturnType<typeof createFirstAccount>>;
  const envFile = path.join(f.dataDir, "env.sh");
  try {
    first = await createFirstAccount({
      seedFile: env.WL_SEED_FILE, height: f.height, eoaKey, fund: 10n * ETH, implementationCodeHash: genesis.implementation.initCodeHash, genesisHash: chain.genesisHash, log,
    });
    fs.writeFileSync(envFile, [
      `# fakechain: the environment of one local FAKE devnet run (started ${new Date().toISOString()}, pid ${process.pid}).`,
      "# Written by fakechain/run.ts. Source it in another shell; it points the pipeline and the backend at this run only.",
      "# Take every WL_* from here: the pipeline has no fake-chain guard and uses whatever WL_* it is given.",
      ...Object.entries(env).map(([k, v]) => `export ${k}=${v}`), "",
    ].join("\n"), { mode: 0o600 });
  } catch (e) {
    halt(); // run.ts then removes the data directory
    throw e;
  }
  ready = true;

  const d = first.deployment;
  console.log(`
==================================================================== FAKE DEVNET READY
 node     ${env.WL_NODE_URL}            (ethrex-shaped JSON-RPC, modelled)
 sidecar  ${env.WL_GATEWAY_URL}        (alt mempool, modelled)
 explorer ${env.WL_EXPLORER_URL}/tx/<hash>
 data     ${f.dataDir}
 account  ${d.account} (${formatEther(10n * ETH)} ETH, height ${f.height}, hot band from leaf ${2 ** f.height - 16})
 shop     ${SHOP} (the hot tickets' one target)    coinbase ${COINBASE}
 factory  ${FACTORY}    implementation ${IMPLEMENTATION}
 EOA      ${eoa.address} (key in ${env.WL_EOA_KEY_FILE}, mode 0600, throwaway)
 options  bundle pass every ${f.bundleInterval} s, public pool ${f.publicPerSender} per sender, proxy 63/64 holdback ${f.proxyHoldback ? "on" : "off"}, enforceGasPrice ${f.enforceGasPrice ? "on" : "off"}

 In another shell:
   source ${envFile}
   cd ${path.resolve(import.meta.dir, "../../pipeline")} && bun scripts/hashsig-devnet.ts
 Every WL_* must come from that env.sh: override none on a command line (not even a WL_GATEWAY_URL=... prefix). The
 pipeline has no fake-chain guard: a mixed environment can reach the real devnet or write this run's leaves into a
 real journal, and only the chain pin (31337 and this run's genesis) stops a signature.
 Never run deploy-account.ts, smoke.ts, account-sim.ts or measure-verifier.ts here: they read the real EOA key.
 ${f.height !== 10 ? `WARNING: scripts/lib/wallet.ts and hashsig-devnet.ts assume height 10; this run uses ${f.height}.\n ` : ""}${f.proxyHoldback ? "Verify frames go through the account's proxy, whose DELEGATECALL keeps 1/64 of the gas back (EIP-150): a 90,000\n limit leaves the account about 88,640. --proxy-holdback off models the plain 'up to the declared limit' rule.\n " : ""}Ctrl-C stops it. Nothing here touches the real devnet.
====================================================================`);
}
