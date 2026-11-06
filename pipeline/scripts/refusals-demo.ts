// Three refusals for the demo, all simulated on the devnet node (nothing is sent, no ETH is spent), for the contracts/
// account that scripts/contracts-e2e.ts deployed:
//   1. a payment on a nonce key the protocol already consumed: refused before any frame runs, no new signature;
//   2. a payment whose signature has one byte flipped: the account's verifier refuses it;
//   3. a valid signature of leaf A sent under leaf B's nonce key: the verifier refuses it.
// 2 and 3 sign real leaves, which are burned in the journal: the node saw their signatures.
// Written with Claude Code (AI).
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/refusals-demo.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import {
  DEVNET, LeafJournal, buildFrameTx, gateway, node, nonceKeyFor, placeholders, signFrameTx,
  type FrameTransaction, type SignatureSlot,
} from "../src/index.ts";
import { Keyring, keyringSigner, loadOrCreateSeed } from "../src/hashsig/keyring.ts";

const SEED_FILE = path.join(os.homedir(), ".winterlock", `contracts-e2e-${DEVNET.chainId}.seed`);
const DATA = path.resolve(import.meta.dir, "../../.data");
const TREE = { generation: 1, height: 10 };
const BAND = { from: 0, to: 1 << TREE.height };
const RECIPIENT: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
// Verifier.yul's Rejected(reason) codes
const REASONS = ["direct call", "nonce shape", "epoch", "leaf range", "signature count", "scheme", "entry length", "version", "slot", "signature"];

const { account } = JSON.parse(fs.readFileSync(path.join(DATA, `contracts-e2e-${DEVNET.chainId}.json`), "utf8")) as { account: Address };
const keyring = new Keyring({ seed: loadOrCreateSeed(SEED_FILE), ...TREE, chains: [DEVNET.chainId], cacheDir: path.join(DATA, "hashsig-cache") });
const journal = LeafJournal.open(
  `${SEED_FILE}.journal-epoch${TREE.generation}.json`,
  { wallet: account, chainId: DEVNET.chainId, epoch: TREE.generation, height: TREE.height, treeSeed: toHex(keyring.treeSeed) },
);
const signer = keyringSigner(keyring);
const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
const gp = await gateway.gasPrice();
const fees = { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
const build = (keyLeaf: number, signLeaf: number) => buildFrameTx({
  chainId: DEVNET.chainId, sender: account, nonce: { keys: [nonceKeyFor(TREE.generation, keyLeaf)], seq: 0n }, verifyGas: 94_000n,
  deadline: Math.floor(Date.now() / 1000) + 90, calls: [{ to: RECIPIENT, value: 1n }], fees, signatures: placeholders(slots(signLeaf)),
});

async function refusal(label: string, tx: FrameTransaction) {
  let verdict: string;
  try {
    const sim: any = await node.simulate(tx, false);
    const data = sim.revertData as Hex | undefined;
    const code = data?.startsWith("0x94064f91") ? Number(BigInt(`0x${data.slice(10)}`)) : null;
    verdict = code !== null
      ? `the account's verifier: Rejected(${code}), ${REASONS[code] ?? "unknown"}`
      : String(sim.canonicalMempoolViolation ?? sim.executionStatus ?? JSON.stringify(sim).slice(0, 240));
    if (sim.canonicalMempoolValid) verdict = `admitted, which it should not be: ${verdict}`;
  } catch (e) {
    verdict = `the node: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`  ${label}\n    -> ${verdict}`);
}

console.log(`account ${account}, simulations only\n`);

const used = journal.all().find((l) => l.status === "onchain")?.leaf;
if (used === undefined) throw new Error("no landed leaf in the journal: run scripts/contracts-e2e.ts first");
await refusal(`1. leaf ${used}'s nonce key again, already consumed on chain (no new signature)`, build(used, used));

{
  const { leaf } = journal.reserveNext(BAND, "simulation: flipped byte");
  try {
    const { tx } = await signFrameTx(build(leaf, leaf), slots(leaf));
    const entry = hexToBytes(tx.signatures[0]!.signature as Hex);
    entry[2 + 32 * 10 + 5]! ^= 0x01;
    await refusal(`2. leaf ${leaf} signs, then one signature byte is flipped`, { ...tx, signatures: [{ ...tx.signatures[0]!, signature: toHex(entry) }] });
  } finally {
    journal.mark(leaf, "burned", { note: "simulation only: signed once, never sent" });
  }
}

{
  const a = journal.reserveNext(BAND, "simulation: signing leaf A").leaf;
  const b = journal.reserveNext(BAND, "simulation: key of leaf B").leaf;
  try {
    await refusal(`3. a valid signature of leaf ${a} under leaf ${b}'s nonce key`, (await signFrameTx(build(b, a), slots(a))).tx);
  } finally {
    journal.mark(a, "burned", { note: "simulation only" });
    journal.mark(b, "burned", { note: "simulation only (never signed)" });
  }
}
