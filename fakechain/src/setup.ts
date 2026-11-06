// Creates the first account the way pipeline/scripts/deploy-account.ts does on the devnet, over HTTP.
// Written with Claude Code (AI) for Vicky.
// A fresh seed with the chain's genesis pinned beside it, the keyring for generation 0, the journal born before the
// account, the EOA's createAccount call to the factory, then the funding; all through the pipeline's own code.
import "./guard.ts";
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DEVNET, FACTORY_ABI, node, pinFileFor, pinOrCheckChain, rpc } from "../../pipeline/src/index.ts";
import { Keyring, loadOrCreateSeed } from "../../pipeline/src/hashsig/keyring.ts";
import { DATA_DIR, DEPLOYMENT_FILE, journalFile, openJournal, openKeyring, type Deployment } from "../../pipeline/scripts/lib/wallet.ts";
import { ETH, FACTORY, IMPLEMENTATION, SHOP } from "./constants.ts";

export interface FirstAccountParams {
  seedFile: string;
  height: number;
  eoaKey: Hex;
  /** wei sent to the account once it exists */
  fund: bigint;
  implementationCodeHash: Hex | null;
  genesisHash: Hex;
  log?: (s: string) => void;
}
export interface FirstAccount {
  deployment: Deployment & Record<string, unknown>;
  deploymentFile: string;
  journalFile: string;
  keyring: Keyring;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One legacy EOA transaction, waited for, as deploy-account.ts sends it (mined nonce, nothing else pending). */
async function legacyTx(eoa: PrivateKeyAccount, to: Address, data: Hex, value: bigint, gas: bigint, label: string, log: (s: string) => void) {
  const [nonce, pending] = [await node.nonce(eoa.address, "latest"), await node.nonce(eoa.address, "pending")];
  if (pending > nonce) throw new Error(`${label}: the EOA has ${pending - nonce} transaction(s) still pending`);
  const raw = await eoa.signTransaction({ chainId: Number(DEVNET.chainId), nonce: Number(nonce), to, value, gas, gasPrice: 2_000_000_000n, data, type: "legacy" });
  const hash = await rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [raw]);
  for (let i = 0; i < 600; i++) {
    const r = await rpc<Record<string, Hex> | null>(DEVNET.node, "eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`${label} reverted: ${JSON.stringify(r)}`);
      log(`${label}: block ${BigInt(r.blockNumber!)}, gas ${BigInt(r.gasUsed!)}, tx ${hash}`);
      return r;
    }
    await sleep(200);
  }
  throw new Error(`${label}: not mined in 120 s`);
}

export async function createFirstAccount(p: FirstAccountParams): Promise<FirstAccount> {
  const log = p.log ?? (() => {});
  fs.mkdirSync(path.dirname(p.seedFile), { recursive: true, mode: 0o700 });
  // Height 10 is what lib/wallet.ts assumes: then this is openKeyring itself, genesis pin first.
  const t = performance.now();
  const k = p.height === 10 ? await openKeyring(p.seedFile) : await (async () => {
    await pinOrCheckChain(pinFileFor(p.seedFile));
    return new Keyring({ seed: loadOrCreateSeed(p.seedFile), generation: 0, height: p.height, chains: [DEVNET.chainId], cacheDir: `${DATA_DIR}/hashsig-cache` });
  })();
  const root = bytesToHex(k.root()), treeSeed = bytesToHex(k.treeSeed);
  log(`keyring: seed ${p.seedFile}, generation 0, height ${p.height}, chains [${DEVNET.chainId}], root ${root.slice(0, 18)}… (${((performance.now() - t) / 1000).toFixed(1)} s)`);

  const eoa = privateKeyToAccount(p.eoaKey);
  const PARAMS = {
    root, treeSeed, height: p.height, owner: eoa.address, // the hybrid co-signer, used once hybrid is switched on
    hotStart: 2 ** p.height - 16, // plan section 8: 16 hot leaves per chain
    hotValueCap: 10_000_000_000_000_000n, // 0.01 ETH per hot transaction
    hotFeeCap: 2_000_000_000_000_000n, // 0.002 ETH of maximum cost per hot transaction
    allowedTarget: SHOP, salt: keccak256(toHex("winterlock fakechain account 1")),
  } as const;
  const args = [PARAMS.root, PARAMS.treeSeed, PARAMS.height, PARAMS.owner, PARAMS.hotStart, PARAMS.hotValueCap, PARAMS.hotFeeCap, PARAMS.allowedTarget, PARAMS.salt] as const;
  const predicted = await rpc<Hex>(DEVNET.node, "eth_call", [{ to: FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "predictAddress", args }) }, "latest"]);
  const account = getAddress(`0x${predicted.slice(26)}`);
  const deployment: Deployment & Record<string, unknown> = {
    chainId: DEVNET.chainId.toString(), verifier: "hashsig", implementation: IMPLEMENTATION, implementationCodeHash: p.implementationCodeHash, factory: FACTORY, account,
    params: { ...PARAMS, hotValueCap: PARAMS.hotValueCap.toString(), hotFeeCap: PARAMS.hotFeeCap.toString() },
    tree: { seedFile: p.seedFile, generation: 0, height: p.height, chains: [DEVNET.chainId.toString()] },
    fakechain: { note: "a local FAKE devnet account (fakechain), never on the real devnet", genesisHash: p.genesisHash },
    updatedAt: new Date().toISOString(),
  };
  // The leaf journal is born before the account, so nothing can ever sign for it without one.
  if (!fs.existsSync(journalFile(deployment))) openJournal(deployment, 0, { create: true }).close();
  log(`journal ${journalFile(deployment)}`);
  await legacyTx(eoa, FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args }), 0n, 2_000_000n, "createAccount", log);
  if ((await node.code(account)) === "0x") throw new Error(`createAccount left no code at ${account}`);
  await legacyTx(eoa, account, "0x", p.fund, 100_000n, `fund ${Number(p.fund) / Number(ETH)} ETH`, log);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n");
  return { deployment, deploymentFile: DEPLOYMENT_FILE, journalFile: journalFile(deployment), keyring: k };
}
