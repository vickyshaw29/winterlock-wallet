// End to end on the devnet for contracts/ (Account.sol and Verifier.yul). A throwaway EOA, funded by the sidecar's
// faucet, deploys the shared verifier and one account for a fresh tree (generation 1, the account's epoch) and funds
// the account. Then one hash-signed transfer goes through the pipeline: grind, simulate, submit, follow to inclusion.
// Idempotent: reuses the deployment that .data/contracts-e2e-<chain>.json records while its code is on chain.
// Written with Claude Code (AI).
// The default gateway (altmempoolgateway) bundles manually and never relays; the node's own sidecar does.
//   (cd ../contracts && forge build) && WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/contracts-e2e.ts
// First run, Nov 6: tx 0xc26fbab9da0ca9fd4c42418381d478c57c35e37f301f287d2b5a05dfb093086b, block 6,073.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bytesToHex, createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET, LeafJournal, SendError, formatAdmissionReport, gateway, pinFileFor, pinOrCheckChain, sendKeyed, simulationSummary,
} from "../src/index.ts";
import { Keyring, keyringSigner, loadOrCreateSeed } from "../src/hashsig/keyring.ts";

const DIR = path.join(os.homedir(), ".winterlock");
const SEED_FILE = path.join(DIR, `contracts-e2e-${DEVNET.chainId}.seed`);
const EOA_FILE = path.join(DIR, `contracts-e2e-${DEVNET.chainId}-eoa.key`);
const DATA = path.resolve(import.meta.dir, "../../.data");
const RECORD = path.join(DATA, `contracts-e2e-${DEVNET.chainId}.json`);
const OUT = path.resolve(import.meta.dir, "../../contracts/out");
const RECIPIENT: Address = "0x5544596212F91984C986A919C8026DF0576816f9"; // devnet genesis account
const TREE = { generation: 1, height: 10 };
// Verify frame of Account.sol + Verifier.yul on the devnet, the key's first use included: 48.9k + 81.5 per chain step
// (84,337 gas at 435 steps, 86,781 at 465). baseGas keeps a 600-gas margin.
const GRIND = { baseGas: 49_500, gasPerStep: 82 };
// 100k prefix cap - 5k declared for the expiry frame - 100 for the signature entry, rounded down.
const VERIFY_GAS = 94_000n;
const ETH = 10n ** 18n;
const eth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(EOA_FILE)) fs.writeFileSync(EOA_FILE, generatePrivateKey(), { mode: 0o600 });
const eoa = privateKeyToAccount(fs.readFileSync(EOA_FILE, "utf8").trim() as Hex);
const chain = defineChain({
  id: Number(DEVNET.chainId),
  name: "alt mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEVNET.node] } },
});
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account: eoa, chain, transport: http() });

// 1. The deployer's funds
let balance = await pub.getBalance({ address: eoa.address });
if (balance < ETH / 100n) {
  const f = await gateway.faucet(eoa.address);
  await pub.waitForTransactionReceipt({ hash: f.txHash });
  balance = await pub.getBalance({ address: eoa.address });
  console.log(`faucet ${f.txHash}`);
}
console.log(`deployer ${eoa.address}: ${eth(balance)}`);

// 2. The tree. The pin beside the seed refuses a reset chain before any leaf signs again.
await pinOrCheckChain(pinFileFor(SEED_FILE));
const keyring = new Keyring({
  seed: loadOrCreateSeed(SEED_FILE), ...TREE, chains: [DEVNET.chainId], cacheDir: path.join(DATA, "hashsig-cache"),
});
const root = bytesToHex(keyring.root());
const treeSeed = bytesToHex(keyring.treeSeed);
console.log(`tree: generation ${TREE.generation}, height ${TREE.height}, root ${root}`);

// 3. Verifier and account
type Deployment = { verifier: Address; account: Address; root: Hex };
const artifact = (name: string) => JSON.parse(fs.readFileSync(path.join(OUT, name), "utf8"));
const hasCode = async (a: Address) => ((await pub.getCode({ address: a })) ?? "0x") !== "0x";
let d: Deployment | null = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, "utf8")) : null;
if (!d || d.root !== root || !(await hasCode(d.account))) {
  const deploy = async (abi: unknown[], bytecode: Hex, args: unknown[] = []) => {
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment ${hash} failed`);
    console.log(`  ${hash}: ${r.contractAddress}, ${r.gasUsed} gas`);
    return r.contractAddress;
  };
  console.log("deploying");
  const verifier = await deploy([], artifact("Verifier.yul/Verifier.json").bytecode.object);
  const account = artifact("Account.sol/Account.json");
  d = {
    verifier,
    account: await deploy(account.abi, account.bytecode.object, [verifier, root, treeSeed, TREE.height, TREE.generation]),
    root,
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify(d, null, 2));
}
console.log(`verifier ${d.verifier}, account ${d.account}`);

// 4. The account pays its own fees
if ((await pub.getBalance({ address: d.account })) < ETH / 100n) {
  const hash = await wallet.sendTransaction({ to: d.account, value: ETH / 20n });
  await pub.waitForTransactionReceipt({ hash });
}
console.log(`account balance ${eth(await pub.getBalance({ address: d.account }))}`);

// 5. One hash-signed transfer
const journal = LeafJournal.open(
  `${SEED_FILE}.journal-epoch${TREE.generation}.json`,
  { wallet: d.account, chainId: DEVNET.chainId, epoch: TREE.generation, height: TREE.height, treeSeed },
  { create: true },
);
const signer = keyringSigner(keyring);
try {
  const r = await sendKeyed({
    journal, band: { from: 0, to: 1 << TREE.height }, sender: d.account,
    calls: [{ to: RECIPIENT, value: 1n }], verifyGas: VERIFY_GAS, grind: GRIND, preflight: true,
    signatures: (leaf) => [{ kind: "hash", signer, leaf }],
    onStatus: (s) => console.log(`  status ${s}`),
  });
  const verify = r.receipt ? BigInt(r.receipt.frameReceipts[1]!.gasUsed.execution) : null;
  console.log(`\nleaf ${r.leaf}, nonce key 0x${r.nonceKey.toString(16)}: ${r.outcome}${r.receipt ? ` in block ${BigInt(r.receipt.blockNumber)}` : ""}`);
  console.log(`tx ${r.txHash}`);
  console.log(`message ${r.sigHash}: ${r.grind?.steps} chain steps (limit ${r.grind?.maxSteps}, ${r.grind?.tries.length} fee value(s) tried)`);
  console.log(`verify frame ${verify ?? "?"} gas of ${VERIFY_GAS} declared`);
  if (r.simulation) console.log(simulationSummary(r.simulation));
  if (r.admission) console.log(formatAdmissionReport(r.admission));
  console.log(r.explorerUrl);
  if (r.outcome !== "OnChain") process.exitCode = 1;
} catch (e) {
  if (e instanceof SendError && e.simulation) console.error(simulationSummary(e.simulation));
  throw e;
}
