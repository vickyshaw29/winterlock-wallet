// Creates the leaf journal of an account deployed before deploy-account.ts created journals (account 2, Nov 6).
// Refuses if the journal exists, if the account's on-chain tree differs from its record, or if the nonce manager
// shows any consumed key of the epoch: then the account has signed, its journal is lost, and only recovering the
// file or rotating is safe. Chain state is only a lower bound (a simulation or a dropped transaction exposes a
// signature without consuming its key), so the flag states what the chain cannot check: this seed never signed.
// Written with Claude Code (AI) for Vicky.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/init-journal.ts [deployment record] --seed-never-signed
import fs from "node:fs";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { DEVNET, NONCE_MANAGER, node, nonceKeyFor, nonceManagerSlot, rpc } from "../src/index.ts";
import { journalFile, loadDeployment, openJournal } from "./lib/wallet.ts";

const args = process.argv.slice(2);
if (!args.includes("--seed-never-signed")) {
  throw new Error("pass --seed-never-signed to state that no leaf of this account's seed has ever signed anything");
}
const d = loadDeployment(args.find((a) => !a.startsWith("--")));
const EPOCH = 0;
const file = journalFile(d, EPOCH);
if (fs.existsSync(file)) throw new Error(`${file} exists; this script never replaces a journal`);
if ((await node.code(d.account)) === "0x") throw new Error(`${d.account} has no code: deploy-account.ts creates the journal of a new account`);

// The account must still hold the tree its record names, at epoch 0.
const ABI = parseAbi(["function root() view returns (bytes32)", "function treeSeed() view returns (bytes32)", "function height() view returns (uint8)", "function epoch() view returns (uint32)"]);
/** Each view returns one 32-byte word. */
const word = async (fn: "root" | "treeSeed" | "height" | "epoch") => {
  const out = await rpc<Hex>(DEVNET.node, "eth_call", [{ to: d.account, data: encodeFunctionData({ abi: ABI, functionName: fn }) }, "latest"]);
  if (!/^0x[0-9a-f]{64}$/i.test(out)) throw new Error(`${fn}() returned ${out}`);
  return out.toLowerCase();
};
const onChain = { root: await word("root"), treeSeed: await word("treeSeed"), height: Number(BigInt(await word("height"))), epoch: Number(BigInt(await word("epoch"))) };
const recorded = { root: String(d.params.root).toLowerCase(), treeSeed: String(d.params.treeSeed).toLowerCase(), height: Number(d.params.height), epoch: EPOCH };
if (JSON.stringify(onChain) !== JSON.stringify(recorded)) {
  throw new Error(`${d.account} holds ${JSON.stringify(onChain)}, its record says ${JSON.stringify(recorded)}`);
}

// Every key of the epoch must be unused in the nonce manager (epoch 0 has no leaf 0: key 0 is the legacy nonce).
const leaves = Array.from({ length: 2 ** onChain.height }, (_, i) => i).filter((leaf) => EPOCH !== 0 || leaf !== 0);
const used: number[] = [];
for (let i = 0; i < leaves.length; i += 32) {
  const batch = leaves.slice(i, i + 32);
  const seqs = await Promise.all(batch.map((leaf) => node.storage(NONCE_MANAGER, nonceManagerSlot(d.account, nonceKeyFor(EPOCH, leaf)))));
  seqs.forEach((s, j) => { if (BigInt(s) !== 0n) used.push(batch[j]!); });
}
if (used.length) throw new Error(`${used.length} key(s) already consumed on chain (leaves ${used.slice(0, 10).join(", ")}…): the account has signed; recover its journal or rotate`);

openJournal(d, EPOCH, { create: true }).close();
console.log(`${file} created: ${leaves.length} keys of epoch ${EPOCH} checked unused on chain, tree matches the record`);
