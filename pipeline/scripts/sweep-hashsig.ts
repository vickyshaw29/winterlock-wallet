// Moves an older real-verifier account's ETH into the current account with a real hash-signed transaction:
// signed by the old account's own WOTS+ keyring (the seed file its deployment record names), verified on chain by
// its own Yul verifier. Grinds with that account's measured verify cost.
// Written with Claude Code (AI) for Vicky.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/sweep-hashsig.ts .data/deployment-1337.<old account>.json [baseGas] [gasPerStep]
import { node, sendKeyed, formatAdmissionReport, simulationSummary } from "../src/index.ts";
import { accountSigner, loadDeployment, openJournal } from "./lib/wallet.ts";

const fromFile = process.argv[2];
if (!fromFile) throw new Error("usage: sweep-hashsig.ts <archived deployment record> [baseGas] [gasPerStep]");
const from = loadDeployment(fromFile);
const to = loadDeployment().account;
if (from.verifier !== "hashsig") throw new Error(`${from.account} does not run the real verifier`);
if (from.account.toLowerCase() === to.toLowerCase()) throw new Error("source and destination are the same account");
const grind = { baseGas: Number(process.argv[3] ?? 55_400), gasPerStep: Number(process.argv[4] ?? 84) };
const RESERVE = 5_000_000_000_000_000n;

const signer = await accountSigner(from); // refuses a seed file that does not build this account's tree
const journal = openJournal(from);
const balance = await node.balance(from.account);
console.log(`from ${from.account} (${Number(balance) / 1e18} ETH) to ${to}, grinding for ${grind.baseGas} + ${grind.gasPerStep} x steps <= 94,900`);
const r = await sendKeyed({
  journal, band: { from: 1, to: 500 }, sender: from.account, calls: [{ to, value: balance - RESERVE }], verifyGas: 94_900n,
  grind, preflight: true, signatures: (leaf) => [{ kind: "hash", signer, leaf }],
  onStatus: (s) => console.log(`  status ${s}`),
});
const verify = r.receipt ? BigInt(r.receipt.frameReceipts[1]!.gasUsed.execution) : 0n;
const total = await node.receipt(r.txHash);
console.log(`\n${r.outcome} in block ${r.receipt ? BigInt(r.receipt.blockNumber) : "-"}: tx ${r.txHash}`);
console.log(`  leaf ${r.leaf}, nonce key 0x${r.nonceKey.toString(16)}, message ${r.sigHash}`);
console.log(`  ${r.grind!.steps} WOTS+ chain steps (limit ${r.grind!.maxSteps}, ${r.grind!.tries.length} deadline(s) tried); verify frame ${verify} of 94,900; whole transaction ${total?.gasUsed ? BigInt(total.gasUsed) : "?"} gas`);
if (r.simulation) console.log(`  ${simulationSummary(r.simulation)}`);
if (r.admission) console.log(formatAdmissionReport(r.admission).split("\n").map((l) => `  ${l}`).join("\n"));
console.log(`  ${r.explorerUrl}`);
console.log(`\n${to} now holds ${Number(await node.balance(to)) / 1e18} ETH`);
