// V2 done-means: one transaction built by this pipeline, admitted and included on the devnet.
// Sender is the test EOA (native ECDSA, the protocol's default code); the hash-signed path follows
// in V3 once the account exists. Prints the exact JSON it sends.
//   bun scripts/smoke.ts
import os from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { LeafJournal, sendKeyed, node } from "../src/index.ts";

const KEY_FILE = `${os.homedir()}/.winterlock/devnet-eoa.key`;
const RECIPIENT = "0x5544596212F91984C986A919C8026DF0576816f9"; // devnet genesis account, already exists
// The EOA has no account epoch; 2 keeps its lanes clear of the raw keys 1 to 4 the Day-0 probes used.
const EPOCH = 2;

const key = (await Bun.file(KEY_FILE).text()).trim() as Hex;
const me = privateKeyToAccount(key).address;
const journal = LeafJournal.open(`${import.meta.dir}/../.data/journal-${me.toLowerCase()}-epoch${EPOCH}.json`, { wallet: me, chainId: 1337n, epoch: EPOCH, height: 10 });

console.log(`sender ${me}, balance ${Number(await node.balance(me)) / 1e18} ETH`);
const r = await sendKeyed({
  journal,
  band: { from: 0, to: 1024 },
  sender: me,
  calls: [{ to: RECIPIENT, value: 1n }],
  verifyGas: 50_000n,
  signatures: () => [{ kind: "ecdsa", privateKey: key, signer: "0x" }],
  preflight: true,
  onSend: (json) => console.log("sent JSON:", JSON.stringify(json)),
  onStatus: (s) => console.log(`  status: ${s}`),
});

console.log(`\nleaf ${r.leaf}, nonce key 0x${r.nonceKey.toString(16)}, sig hash ${r.sigHash}`);
console.log(`preflight: canonical-valid ${r.simulation?.canonicalMempoolValid}, prefix shape ${r.simulation?.prefixShape}, frame gas ${r.simulation?.frames?.map((f) => BigInt(f.gasUsed)).join(" / ")}`);
console.log(`outcome ${r.outcome}, timeline ${r.timeline.map((t) => `${t.status}@${t.at}s`).join(" ")}`);
if (r.receipt) {
  console.log(`block ${BigInt(r.receipt.blockNumber)}, frames: ${r.receipt.frameReceipts.map((f, i) => `#${i} ${f.status} ${BigInt(f.gasUsed.execution)} gas`).join(", ")}`);
}
console.log(`explorer: ${r.explorerUrl}`);
console.log(`journal: leaf ${r.leaf} is ${journal.get(r.leaf)?.status}`);
