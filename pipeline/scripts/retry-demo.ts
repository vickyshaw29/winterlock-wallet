// Expiry instead of replacement, on the devnet account: the first attempt gets a 2-second expiry so it dies
// before inclusion; the pipeline proves it dead on chain, burns its leaf, and sends again on a fresh leaf,
// ground to fit the declared verify limit. Prints each attempt's admission report. (Scene 2's mechanics.)
// Written with Claude Code (AI) for Vicky. Placeholder-verifier account only for now (its signer below); the account
// must have hybrid off.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/retry-demo.ts .data/deployment-1337.placeholder.json
import type { Address } from "viem";
import { GRIND, formatAdmissionReport, placeholderSigner, sendWithRetry, simulationSummary, type HashSigner } from "../src/index.ts";
import { loadDeployment, openJournal, requirePlaceholder } from "./lib/wallet.ts";

const deployment = loadDeployment(process.argv[2]);
requirePlaceholder(deployment, "retry-demo.ts");
const ACCOUNT: Address = deployment.account;
const TARGET: Address = deployment.params.allowedTarget;
// Placeholder-format entry (the placeholder verifier checks only that it carries the message hash).
const hashSigner: HashSigner = placeholderSigner({ treeSeed: deployment.params.treeSeed });
const journal = openJournal(deployment);

console.log(`account ${ACCOUNT} (${deployment.verifier} verifier), paying 1 wei to ${TARGET}\n`);
const t0 = Date.now();
const r = await sendWithRetry({
  journal, band: { from: 1, to: 500 }, sender: ACCOUNT, calls: [{ to: TARGET, value: 1n }],
  verifyGas: 90_000n, grind: GRIND.cold, preflight: true,
  signatures: (leaf) => [{ kind: "hash", signer: hashSigner, leaf }],
  attempts: 3,
  firstAttempt: { expirySeconds: 2 }, // dies before any block can include it
  onStatus: (s) => console.log(`   ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s  status ${s}`),
  onRetry: (dead, next) => console.log(`\n   attempt ${next - 1} ${dead.outcome}: leaf ${dead.leaf} burned (key 0x${dead.nonceKey.toString(16)} never used on chain); attempt ${next} takes a fresh leaf\n`),
});

for (const [i, a] of r.attempts.entries()) {
  console.log(`\n== attempt ${i + 1}: leaf ${a.leaf}, key 0x${a.nonceKey.toString(16)}, deadline ${a.deadline}, ${a.outcome}${a.receipt ? ` in block ${BigInt(a.receipt.blockNumber)}` : ""}`);
  if (a.grind) console.log(`   grinding: message needs ${a.grind.steps} chain steps, limit allows ${a.grind.maxSteps}, ${a.grind.tries.length} fee value(s) tried: ${a.grind.tries.map((t) => `${t.value}→${t.steps}`).join(", ")}`);
  if (a.simulation) console.log(`   ${simulationSummary(a.simulation)}`);
  console.log(a.admission ? formatAdmissionReport(a.admission).split("\n").map((l) => `   ${l}`).join("\n") : "   admission: no record");
  console.log(`   ${a.explorerUrl}`);
}
console.log(`\nresult: ${r.final.outcome} after ${r.attempts.length} attempt(s); burned leaves: ${r.burnedLeaves.join(", ") || "none"}`);
console.log(`journal: ${r.attempts.map((a) => `leaf ${a.leaf} ${journal.get(a.leaf)?.status}`).join(", ")}`);
