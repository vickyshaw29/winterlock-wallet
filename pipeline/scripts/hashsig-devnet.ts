// The real thing on the devnet: hash-signed transactions from the account with the real Yul verifier, signed by
// the TypeScript keyring (pipeline/src/hashsig). Every leaf signs once: real sends and simulations alike take a
// fresh leaf from the journal, and simulated ones are burned.
//   1. a cold transfer (the qualification milestone), 2. two forgeries refused in simulation, 3. more sends to
//   measure verify gas against WOTS+ chain steps, 4. a hot ticket.
// Written with Claude Code (AI) for Vicky.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/hashsig-devnet.ts
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import {
  DEVNET, GRIND, buildFrameTx, formatAdmissionReport, gateway, node, nonceKeyFor, placeholders, sendKeyed, signFrameTx,
  simulationSummary, wotsVerifySteps, usableVerifyGas, GRIND_MARGIN, PROXY_PRE_CALL, type FrameTransaction, type SignatureSlot,
} from "../src/index.ts";
import { accountSigner, loadDeployment, openJournal } from "./lib/wallet.ts";

const d = loadDeployment();
if (d.verifier !== "hashsig") throw new Error("this script needs the account with the real verifier (scripts/deploy-account.ts)");
const ACCOUNT = d.account;
const TARGET: Address = d.params.allowedTarget;
const signer = await accountSigner(d);
const journal = openJournal(d);
const COLD = { from: 1, to: 500 }, HOT = { from: d.params.hotStart as number, to: 1024 };
const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
// The spec's ceiling for the declared verify limit (Transaction format; Level A "declared verify limit at most 90k").
const VERIFY_LIMIT = 90_000n;
// Cost model before section 3 measures it on this account: hashsig_verify on the devnet = 24,070 + 66.06 x steps
// (measure-verifier.ts, Nov 6), plus about 30,396 for the account's own checks (the earlier account's 53,828 minus the
// earlier verifier's 23,432), plus a 600-gas margin. A preflight refuses any message the model gets wrong.
const GRIND_START = GRIND.cold;
const points: { steps: number; gas: bigint }[] = [];

async function send(label: string, value: bigint, band: { from: number; to: number }) {
  const r = await sendKeyed({ journal, band, sender: ACCOUNT, calls: [{ to: TARGET, value }], verifyGas: VERIFY_LIMIT, grind: band === HOT ? GRIND.hot : GRIND_START, preflight: true, signatures: slots });
  const verify = r.receipt ? BigInt(r.receipt.frameReceipts[1]!.gasUsed.execution) : 0n;
  const total = r.receipt ? (await node.receipt(r.txHash))?.gasUsed : undefined;
  points.push({ steps: r.grind!.steps, gas: verify });
  console.log(`   ${label}: leaf ${r.leaf}, key 0x${r.nonceKey.toString(16)}, ${r.outcome} in block ${r.receipt ? BigInt(r.receipt.blockNumber) : "-"}`);
  console.log(`     message ${r.sigHash}: ${r.grind!.steps} chain steps (limit ${r.grind!.maxSteps}, ${r.grind!.tries.length} fee value(s) tried)`);
  console.log(`     verify frame ${verify} gas of ${VERIFY_LIMIT} declared; whole transaction ${total ? BigInt(total) : "?"} gas`);
  console.log(`     ${r.admission?.summary ?? "no admission record"}`);
  console.log(`     ${r.explorerUrl}`);
  return r;
}

// ------------------------------------------------------------------ 1. the first hash-signed transfer
console.log(`account ${ACCOUNT} (real verifier), ${Number(await node.balance(ACCOUNT)) / 1e18} ETH\n\n== 1. first hash-signed transfer`);
const first = await send("cold transfer, 1 wei", 1n, COLD);
if (first.simulation) console.log(`     ${simulationSummary(first.simulation)}`);
if (first.admission) console.log(formatAdmissionReport(first.admission).split("\n").map((l) => `     ${l}`).join("\n"));

// ------------------------------------------------------------------ 2. forgeries, simulated on fresh burned leaves
console.log(`\n== 2. forgeries (simulated only; each signing leaf is burned)`);
async function simulateRefusal(label: string, make: () => Promise<FrameTransaction>) {
  const tx = await make();
  const sim: any = await node.simulate(tx, false);
  const reason = sim.revertData && sim.revertData !== "0x" ? new TextDecoder().decode(hexToBytes(sim.revertData)).replace(/\0+$/, "") : (sim.canonicalMempoolViolation ?? sim.executionStatus);
  const ok = !sim.canonicalMempoolValid && reason === "sig: hash-based check";
  console.log(`   ${ok ? "OK" : "XX"} ${label.padEnd(56)} ${reason}`);
  if (!ok) process.exitCode = 1;
}
const gp = await gateway.gasPrice();
const fees = { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
const buildFor = (keyLeaf: number, signLeaf: number) => buildFrameTx({
  chainId: DEVNET.chainId, sender: ACCOUNT, nonce: { keys: [nonceKeyFor(0, keyLeaf)], seq: 0n }, verifyGas: VERIFY_LIMIT,
  deadline: Math.floor(Date.now() / 1000) + 90, calls: [{ to: TARGET, value: 1n }], fees, signatures: placeholders(slots(signLeaf)),
});
await simulateRefusal("one signature byte flipped", async () => {
  const { leaf } = journal.reserveNext(COLD, "simulation: flipped byte");
  try {
    const { tx } = await signFrameTx(buildFor(leaf, leaf), slots(leaf));
    const e = hexToBytes(tx.signatures[0]!.signature as Hex);
    e[2 + 32 * 10 + 5]! ^= 0x01;
    return { ...tx, signatures: [{ ...tx.signatures[0]!, signature: toHex(e) }] };
  } finally { journal.mark(leaf, "burned", { note: "simulation only: signed once, never sent" }); }
});
await simulateRefusal("a valid signature of leaf A under leaf B's nonce key", async () => {
  const a = journal.reserveNext(COLD, "simulation: signing leaf A").leaf;
  const b = journal.reserveNext(COLD, "simulation: key of leaf B").leaf;
  try { return (await signFrameTx(buildFor(b, a), slots(a))).tx; }
  finally { journal.mark(a, "burned", { note: "simulation only" }); journal.mark(b, "burned", { note: "simulation only (never signed)" }); }
});

// ------------------------------------------------------------------ 3. gas against chain steps
console.log(`\n== 3. five more transfers, to measure verify gas against chain steps`);
for (let i = 0; i < 5; i++) await send(`cold transfer ${i + 2}`, 1n, COLD);
const n = BigInt(points.length);
const sx = points.reduce((s, p) => s + BigInt(p.steps), 0n), sy = points.reduce((s, p) => s + p.gas, 0n);
const sxx = points.reduce((s, p) => s + BigInt(p.steps) ** 2n, 0n), sxy = points.reduce((s, p) => s + BigInt(p.steps) * p.gas, 0n);
const slope = Number(n * sxy - sx * sy) / Number(n * sxx - sx * sx);
const intercept = Number(sy) / Number(n) - slope * (Number(sx) / Number(n));
console.log(`   verify gas = ${intercept.toFixed(0)} + ${slope.toFixed(2)} x chain steps   (${points.map((p) => `${p.steps}→${p.gas}`).join(", ")})`);
console.log(`   so a ${VERIFY_LIMIT} limit fits messages up to ${Math.floor((usableVerifyGas(VERIFY_LIMIT, PROXY_PRE_CALL) - GRIND_MARGIN - intercept) / slope)} steps behind the proxy, with the grinder's margin (average message: 506)`);

// ------------------------------------------------------------------ 4. a hot ticket
// Under the 90k limit a hot ticket's extra policy reads leave room for about 428 chain steps: about 1 message in 70
// fits, so the signer grinds the fee by a few wei (about 71 tries) and the deadline stays exact.
{
  console.log(`\n== 4. hot ticket (hot leaf, no classical key, capped value to the one target)`);
  await send("hot ticket, 0.001 ETH", 1_000_000_000_000_000n, HOT);
}
console.log(`\njournal: ${journal.all().map((l) => `${l.leaf}:${l.status}`).join(" ")}`);
