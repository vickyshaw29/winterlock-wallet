// Deploys the Yul account implementation and the factory from the test EOA, creates one account through
// the factory and funds it. Idempotent: reuses what .data/deployment-<chain>.json records if the code is there.
// Accounts are always created this way, by an EOA calling the factory (decided Nov 6): no deploy frame.
// With the real verifier the account's root and tree seed come from the keyring (lib/wallet.ts: a seed file only
// its owner can read, the genesis pinned beside it). A deployment record for the other verifier is archived.
// Written with Claude Code (AI) for Vicky.
//   (cd ../account && scripts/build.sh && forge build) && bun scripts/deploy-account.ts
import fs from "node:fs";
import os from "node:os";
import { bytesToHex, encodeDeployData, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, node, rpc } from "../src/index.ts";
import { DATA_DIR, DEPLOYMENT_FILE, SEED_FILE, TREE, journalFile, openJournal, openKeyring, type Deployment } from "./lib/wallet.ts";

const ACCOUNT_DIR = `${import.meta.dir}/../../account`;
const RECIPIENT: Address = "0x5544596212F91984C986A919C8026DF0576816f9"; // devnet genesis account: the hot tickets' one target
const key = (await Bun.file(`${os.homedir()}/.winterlock/devnet-eoa.key`).text()).trim() as Hex;
const eoa = privateKeyToAccount(key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FACTORY_ABI = parseAbi([
  "function createAccount(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt) returns (address)",
  "function predictAddress(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt) view returns (address)",
]);

const accountBin = `0x${(await Bun.file(`${ACCOUNT_DIR}/build/Account.bin`).text()).trim()}` as Hex;
const flat = await Bun.file(`${ACCOUNT_DIR}/build/Account.flat.yul`).text();
const verifier: "hashsig" | "placeholder" = flat.includes("PLACEHOLDER for hashsig_verify") ? "placeholder" : "hashsig";
const factoryArtifact = JSON.parse(await Bun.file(`${ACCOUNT_DIR}/out/Factory.sol/Factory.json`).text());

// The tree the account trusts: the real keyring's, or fixed placeholders the placeholder verifier ignores.
let root: Hex, treeSeed: Hex;
if (verifier === "hashsig") {
  const k = await openKeyring();
  const t = performance.now();
  root = bytesToHex(k.root());
  treeSeed = bytesToHex(k.treeSeed);
  console.log(`keyring: seed ${SEED_FILE}, generation ${TREE.generation}, height ${TREE.height}, chains [${TREE.chains}], root ${root.slice(0, 18)}… (${((performance.now() - t) / 1000).toFixed(1)} s)`);
} else {
  root = keccak256(toHex("winterlock devnet placeholder root"));
  treeSeed = keccak256(toHex("winterlock devnet placeholder tree seed"));
}
const PARAMS = {
  root, treeSeed, height: TREE.height,
  owner: eoa.address, // the hybrid co-signer, used once hybrid is switched on
  hotStart: 1008, // plan section 8: 16 hot leaves per chain
  hotValueCap: 10_000_000_000_000_000n, // 0.01 ETH per hot transaction
  hotFeeCap: 2_000_000_000_000_000n, // 0.002 ETH of maximum cost per hot transaction
  allowedTarget: RECIPIENT,
  salt: keccak256(toHex(`winterlock devnet account (${verifier}) 1`)),
} as const;
const args = [PARAMS.root, PARAMS.treeSeed, PARAMS.height, PARAMS.owner, PARAMS.hotStart, PARAMS.hotValueCap, PARAMS.hotFeeCap, PARAMS.allowedTarget, PARAMS.salt] as const;

/**
 * One EOA transaction, waited for. The nonce is the mined one ("latest"), and nothing is sent while an earlier
 * transaction of the EOA is still pending (review, Nov 6: a re-run after a failed wait queued a second payment).
 */
async function legacyTx(to: Address | null, data: Hex, value: bigint, gas: bigint, label: string) {
  const [nonce, pending] = [await node.nonce(eoa.address, "latest"), await node.nonce(eoa.address, "pending")];
  if (pending > nonce) {
    throw new Error(`${label}: the EOA has ${pending - nonce} transaction(s) still pending (nonce ${nonce}). Run again once they are mined; nothing was sent.`);
  }
  const raw = await eoa.signTransaction({ chainId: Number(DEVNET.chainId), nonce: Number(nonce), to, value, gas, gasPrice: 2_000_000_000n, data, type: "legacy" });
  const hash = await rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [raw]);
  for (let i = 0; i < 40; i++) {
    const r = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`${label} reverted: ${JSON.stringify(r)}`);
      console.log(`${label}: block ${BigInt(r.blockNumber)}, gas ${BigInt(r.gasUsed)}, tx ${hash}`);
      return r;
    }
    await sleep(3000);
  }
  throw new Error(`${label}: not mined in 120 s`);
}
const hasCode = async (a?: string) => !!a && (await node.code(a as Address)) !== "0x";

// One seed serves one account (spec). A changed implementation means a new factory and a new account address, and
// the same tree under a second address would hand out its leaves again: refuse before archiving or spending gas.
if (verifier === "hashsig" && fs.existsSync(DATA_DIR)) {
  for (const name of fs.readdirSync(DATA_DIR).filter((f) => /^deployment-.*\.json$/.test(f))) {
    const other = JSON.parse(fs.readFileSync(`${DATA_DIR}/${name}`, "utf8"));
    if (other.verifier === "hashsig" && String(other.params?.treeSeed).toLowerCase() === treeSeed.toLowerCase() && other.implementationCodeHash !== keccak256(accountBin)) {
      throw new Error(`the tree of ${SEED_FILE} already serves account ${other.account} (${name}) under other code. ` +
        "A new implementation needs a new account and a new seed: set WL_ACCOUNT_LABEL to a new label.");
    }
  }
}
let saved = fs.existsSync(DEPLOYMENT_FILE) ? JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")) : {};
// A different verifier, implementation or seed means a different account: keep the old record under its address.
const sameAccount = saved.verifier === verifier && saved.implementationCodeHash === keccak256(accountBin) &&
  (verifier === "placeholder" || saved.tree?.seedFile === SEED_FILE);
if (saved.account && !sameAccount) {
  const archive = DEPLOYMENT_FILE.replace(/\.json$/, `.${String(saved.account).toLowerCase()}.json`);
  fs.renameSync(DEPLOYMENT_FILE, archive);
  console.log(`archived the previous deployment record (${saved.account}) to ${archive}`);
  saved = {};
}

// 1. Implementation (the Yul account), unless this exact code is already deployed.
let implementation: Address = saved.implementation;
if (!(await hasCode(implementation)) || saved.implementationCodeHash !== keccak256(accountBin)) {
  const r = await legacyTx(null, accountBin, 0n, 8_000_000n, "implementation");
  implementation = r.contractAddress;
}
// 2. Factory bound to that implementation.
let factory: Address = saved.factory;
if (!(await hasCode(factory)) || saved.implementation !== implementation) {
  const data = encodeDeployData({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode.object, args: [implementation] });
  const r = await legacyTx(null, data, 0n, 6_000_000n, "factory");
  factory = r.contractAddress;
}
// 3. The account, at its counterfactual address.
const predicted = await rpc<Hex>(DEVNET.node, "eth_call", [{ to: factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "predictAddress", args }) }, "latest"]);
const account = `0x${predicted.slice(26)}` as Address;
const createdNow = !(await hasCode(account));
// Record the addresses now, so a failure while funding never loses them.
const deployment: Deployment & Record<string, unknown> = {
  chainId: DEVNET.chainId.toString(), verifier, implementation, implementationCodeHash: keccak256(accountBin), factory, account,
  params: { ...PARAMS, hotValueCap: PARAMS.hotValueCap.toString(), hotFeeCap: PARAMS.hotFeeCap.toString() },
  ...(verifier === "hashsig" ? { tree: { seedFile: SEED_FILE, generation: TREE.generation, height: TREE.height, chains: TREE.chains.map(String) } } : {}),
  updatedAt: new Date().toISOString(),
};
fs.mkdirSync(DATA_DIR, { recursive: true });
if (createdNow) {
  // The last guard before the account exists: no other record may hold this tree under another address.
  if (verifier === "hashsig") {
    for (const name of fs.readdirSync(DATA_DIR).filter((f) => /^deployment-.*\.json$/.test(f))) {
      const other = JSON.parse(fs.readFileSync(`${DATA_DIR}/${name}`, "utf8"));
      if (other.verifier === "hashsig" && String(other.params?.treeSeed).toLowerCase() === treeSeed.toLowerCase() && String(other.account).toLowerCase() !== account.toLowerCase()) {
        throw new Error(`the tree seed of ${SEED_FILE} already serves account ${other.account} (${name}). Set WL_ACCOUNT_LABEL to a new label for a new seed.`);
      }
    }
  }
  // The leaf journal is born before the account, so nothing can ever sign for it without one. Opening it with the tree
  // seed also refuses when another journal already names this tree.
  if (!fs.existsSync(journalFile(deployment))) openJournal(deployment, 0, { create: true }).close();
  console.log(`journal ${journalFile(deployment)}`);
  await legacyTx(factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args }), 0n, 2_000_000n, "createAccount");
} else if (!fs.existsSync(journalFile(deployment))) {
  console.log(`WARNING: ${account} existed before this run and has no journal at ${journalFile(deployment)}. Recover it; ` +
    "only for an account whose seed never signed, scripts/init-journal.ts creates one.");
}
fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n");

// 4. Fund it, if the EOA can (the devnet faucet can run dry).
const balance = await node.balance(account);
const eoaBalance = await node.balance(eoa.address);
if (balance < 100_000_000_000_000_000n) {
  const need = 200_000_000_000_000_000n - balance;
  if (eoaBalance > need + 10_000_000_000_000_000n) await legacyTx(account, "0x", need, 100_000n, "fund 0.2 ETH");
  else console.log(`not funded: the EOA holds ${Number(eoaBalance) / 1e18} ETH; fund ${account} another way`);
}
console.log(`\naccount ${account} (proxy, ${((await node.code(account)).length - 2) / 2} bytes), balance ${Number(await node.balance(account)) / 1e18} ETH`);
console.log(`implementation ${implementation} (${verifier} verifier), factory ${factory}`);
if (verifier === "placeholder") console.log("WARNING: placeholder verifier, which checks no signature. Devnet testing only.");
