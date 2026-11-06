// Measures the account's verify-frame gas against WOTS+ chain steps on the devnet, without any real signature:
// each simulated transaction carries a random entry (right version and slot, random bytes), so the verify frame
// does all the hashing and then reverts at the final root comparison, and a revert reports the gas used up to it.
// The deadline is varied to pick messages across the step range. Nothing is signed, so no leaf is spent.
// The success path costs this plus what APPROVE adds (the fresh key's 20,000 and the approval itself).
// Written with Claude Code (AI) for Vicky.
//   bun scripts/calibrate-verify-gas.ts
import { concat, hexToBytes, toHex, type Hex } from "viem";
import { DEVNET, buildFrameTx, computeSigHash, gateway, node, nonceKeyFor, wotsVerifySteps } from "../src/index.ts";
import { SIG_SCHEME } from "../src/codec/FrameTx.ts";
import { loadDeployment } from "./lib/wallet.ts";

const d = loadDeployment();
const LEAF = 900; // a cold leaf nothing ever signs here; the key stays unused
const gp = await gateway.gasPrice();
const base = Math.floor(Date.now() / 1000) + 120;
const build = (deadline: number, entry: Hex) => buildFrameTx({
  chainId: DEVNET.chainId, sender: d.account, nonce: { keys: [nonceKeyFor(0, LEAF)], seq: 0n }, verifyGas: 94_900n, deadline,
  calls: [{ to: d.params.allowedTarget, value: 1n }], fees: { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) },
  signatures: [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: entry }],
});
const randomEntry = () => concat(["0x0100", toHex(crypto.getRandomValues(new Uint8Array(2_592)))]);

// pick deadlines whose messages span the step range
const byStep = new Map<number, number>();
for (let i = 0; i < 3000; i++) {
  const steps = wotsVerifySteps(computeSigHash(build(base + i, randomEntry())));
  const bucket = Math.round(steps / 25) * 25;
  if (!byStep.has(bucket)) byStep.set(bucket, base + i);
}
const picks = [...byStep.entries()].sort((a, b) => a[0] - b[0]);
console.log(`account ${d.account} (${d.verifier} verifier); ${picks.length} messages from ${picks[0]![0]} to ${picks.at(-1)![0]} steps\n`);

const points: { steps: number; gas: number }[] = [];
for (const [, deadline] of picks) {
  const tx = build(deadline, randomEntry());
  const steps = wotsVerifySteps(computeSigHash(tx));
  const sim: any = await node.simulate(tx, false);
  const reason = sim.revertData && sim.revertData !== "0x" ? new TextDecoder().decode(hexToBytes(sim.revertData)).replace(/\0+$/, "") : sim.haltReason ?? sim.canonicalMempoolViolation;
  const gas = Number(BigInt(sim.frames?.[1]?.gasUsed ?? "0x0"));
  if (reason !== "sig: hash-based check") { console.log(`  ${steps} steps: unexpected ${reason} (${gas} gas), skipped`); continue; }
  points.push({ steps, gas });
  console.log(`  ${String(steps).padStart(4)} steps: verify frame ${gas} gas up to the root comparison`);
}
const n = points.length;
const mx = points.reduce((s, p) => s + p.steps, 0) / n, my = points.reduce((s, p) => s + p.gas, 0) / n;
const slope = points.reduce((s, p) => s + (p.steps - mx) * (p.gas - my), 0) / points.reduce((s, p) => s + (p.steps - mx) ** 2, 0);
const intercept = my - slope * mx;
const maxResidual = Math.max(...points.map((p) => Math.abs(p.gas - (intercept + slope * p.steps))));
console.log(`\nverify frame up to the comparison = ${intercept.toFixed(0)} + ${slope.toFixed(2)} x steps (largest residual ${maxResidual.toFixed(0)} gas)`);
console.log(`one real success (leaf 2, 465 steps) used 92,558: APPROVE and the fresh key add ${(92_558 - (intercept + slope * 465)).toFixed(0)}`);
