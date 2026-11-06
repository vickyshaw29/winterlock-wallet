// Gas estimation on the devnet account: three calls estimated (each on its own throwaway leaf, burned), then
// the one that creates a new account sent with the estimated limits. Without its 183,600 state gas that frame
// would fail while the transaction still landed and burned its key.
// Written with Claude Code (AI) for Vicky. Placeholder-verifier account only for now (its signer below); hybrid off.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/estimate-demo.ts .data/deployment-1337.placeholder.json
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { estimateCalls, placeholderSigner, sendKeyed, withEstimates, type Call, type HashSigner } from "../src/index.ts";
import { loadDeployment, openJournal, requirePlaceholder } from "./lib/wallet.ts";

const deployment = loadDeployment(process.argv[2]);
requirePlaceholder(deployment, "estimate-demo.ts");
const ACCOUNT: Address = deployment.account;
const TARGET: Address = deployment.params.allowedTarget;
const hashSigner: HashSigner = placeholderSigner({ treeSeed: deployment.params.treeSeed });
const signatures = (leaf: number) => [{ kind: "hash" as const, signer: hashSigner, leaf }];
const journal = openJournal(deployment);
const COLD = { from: 1, to: 500 };
const fresh = privateKeyToAccount(generatePrivateKey()).address; // an address the chain has never seen

const calls: { label: string; call: Call }[] = [
  { label: "1 wei to an existing account", call: { to: TARGET, value: 1n } },
  { label: "1 wei to a brand-new address", call: { to: fresh, value: 1n } },
  { label: "admin setHotPolicy (no new slot)", call: { to: ACCOUNT, data: encodeFunctionData({ abi: parseAbi(["function setHotPolicy(uint32,uint256,uint256,address)"]), functionName: "setHotPolicy", args: [deployment.params.hotStart, BigInt(deployment.params.hotValueCap), BigInt(deployment.params.hotFeeCap), TARGET] }) } },
];
console.log(`account ${ACCOUNT}, estimating ${calls.length} calls, one throwaway leaf each\n`);
const est = await estimateCalls({ journal, band: COLD, sender: ACCOUNT, calls: calls.map((c) => c.call), signatures });
for (const [i, e] of est.entries()) {
  console.log(`  ${calls[i]!.label.padEnd(36)} used ${String(e.used).padStart(6)}  -> limit ${String(e.execution).padStart(6)}, state ${String(e.state).padStart(6)}  (estimate leaf ${e.leaf}: ${journal.get(e.leaf)?.status})`);
}

console.log(`\nsending "${calls[1]!.label}" with the estimated limits`);
const r = await sendKeyed({
  journal, band: COLD, sender: ACCOUNT, calls: withEstimates([calls[1]!.call], [est[1]!]), verifyGas: 60_000n, preflight: true, signatures,
});
const body = r.receipt!.frameReceipts.at(-1)!;
console.log(`  leaf ${r.leaf}: ${r.outcome} in block ${BigInt(r.receipt!.blockNumber)}; the transfer frame ${body.status}, used ${BigInt(body.gasUsed.execution)} execution + ${BigInt(body.gasUsed.state)} state`);
console.log(`  ${r.admission?.summary ?? "no admission record"}\n  ${r.explorerUrl}`);
