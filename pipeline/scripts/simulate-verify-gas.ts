// Measures the real account's verify-frame gas on the devnet by simulation, with real signatures. While the chain
// makes no blocks this is the only way: the node reports no frame gas for a refused verify frame (Nov 6), so random
// entries (calibrate-verify-gas.ts) measure nothing. Each point signs ONE message with ONE fresh cold leaf, which is
// journaled before it signs and burned after. Nothing is sent and no ETH is spent; the deadline stays 90 s ahead, so a
// signed transaction can never land later, when the chain is back. The message is picked by grinding the fee one wei
// at a time, as sendKeyed does, so the deadline never moves; only the picked transaction is signed.
// Fixed after review (Nov 6): step counts are 255*c0 + 15*c1 + 45 (multiples of 15, never 540), so targets come from
// that lattice and are matched exactly; the account is an EIP-1167 proxy, whose DELEGATECALL passes on only 63/64 of
// the gas left (EIP-150), so the targets stay below what 94,900 declared can really use; a key used on chain but missing
// from the journal stops the run (another signer used this tree); the first invalid result stops it, and the points
// already measured are still fitted.
// Written with Claude Code (AI) for Vicky.
//   bun scripts/simulate-verify-gas.ts [count]   (default 8, at most 10)
import type { Hex } from "viem";
import {
  DEVNET, GRIND, GRIND_MARGIN, NONCE_MANAGER, PROXY_PRE_CALL, buildFrameTx, computeSigHash, gateway, node, nonceManagerSlot,
  placeholders, signFrameTx, usableVerifyGas, wotsVerifySteps, type FrameTransaction, type SignatureSlot,
} from "../src/index.ts";
import { accountSigner, loadDeployment, openJournal } from "./lib/wallet.ts";

// Reachable step counts only, around the 90,000 boundary and up to the top of what 94,900 can carry through the proxy.
const LATTICE_TARGETS = [420, 450, 480, 495, 510, 525, 555, 570, 435, 465];
const COUNT = Number(process.argv[2] ?? 8);
if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > LATTICE_TARGETS.length) {
  throw new Error(`count must be a whole number from 1 to ${LATTICE_TARGETS.length}, got ${process.argv[2]}`);
}
const TARGETS = LATTICE_TARGETS.slice(0, COUNT);
// The most the 100,000 prefix cap allows beside the 5,000 expiry frame and the entry's 100.
const VERIFY_LIMIT = 94_900n;
const MAX_TRIES = 50_000;
/** The most a verify frame declared with `limit` can use through the proxy: 1/64 of what is left at the call is held back. */
const usable = (limit: number) => usableVerifyGas(BigInt(limit), PROXY_PRE_CALL);
/** GRIND.cold carries a safety margin; compare measurements with the central model. */
const CENTRAL = { base: GRIND.cold.baseGas - GRIND_MARGIN, perStep: GRIND.cold.gasPerStep };

const d = loadDeployment();
if (d.verifier !== "hashsig") throw new Error(`${d.account} runs the ${d.verifier} verifier; this script measures the real one`);
const COLD = { from: 1, to: Number(d.params.hotStart) };
for (const t of TARGETS) {
  const need = CENTRAL.base + CENTRAL.perStep * t;
  if (need > usable(Number(VERIFY_LIMIT)) - 300) throw new Error(`target ${t} steps needs about ${need} gas, too close to the ${usable(Number(VERIFY_LIMIT))} usable`);
}
const signer = await accountSigner(d);
const gp = await gateway.gasPrice();
const baseFee = BigInt(gp.maxFeePerGas), priority = BigInt(gp.maxPriorityFeePerGas);
const head = await node.block("latest");
console.log(`account ${d.account} (${d.verifier} verifier); chain head ${head.number}, made ${Math.round(Date.now() / 1000 - Number(head.timestamp))} s ago`);
console.log(`${COUNT} simulations at ${TARGETS.join(", ")} steps, each signed by one fresh cold leaf that is then burned; nothing is sent\n`);

const journal = openJournal(d);
const points: { leaf: number; steps: number; verify: bigint; frames: bigint[]; total: bigint | null }[] = [];
let stopped: string | null = null;
try {
  for (const target of TARGETS) {
    // Journaled before anything is signed, so a crash can never hand this leaf out again.
    const { leaf, nonceKey } = journal.reserveNext(COLD, "simulation only: verify-gas measurement");
    let note = "simulation only: never signed";
    try {
      if (BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(d.account, nonceKey))) !== 0n) {
        // The journal is authoritative and does not know this key: something else signed with this tree. It may also
        // have exposed leaves whose keys never landed, which neither the journal nor the chain can show. Stop.
        note = "key already used on chain, missing from this journal; never signed here";
        throw new Error(`leaf ${leaf}: ${note}. Another signer used this tree; stopping before any signature. Find that journal first.`);
      }
      const slots: SignatureSlot[] = [{ kind: "hash", signer, leaf }];
      const deadline = Math.floor(Date.now() / 1000) + 90;
      let chosen: FrameTransaction | null = null;
      for (let i = 0; i < MAX_TRIES && !chosen; i++) {
        const tx = buildFrameTx({
          chainId: DEVNET.chainId, sender: d.account, nonce: { keys: [nonceKey], seq: 0n }, verifyGas: VERIFY_LIMIT, deadline,
          calls: [{ to: d.params.allowedTarget, value: 1n }], fees: { maxFeePerGas: baseFee + BigInt(i), maxPriorityFeePerGas: priority },
          signatures: placeholders(slots),
        });
        if (wotsVerifySteps(computeSigHash(tx)) === target) chosen = tx;
      }
      if (!chosen) {
        console.log(`  leaf ${leaf}: no message of exactly ${target} steps in ${MAX_TRIES} fees; never signed`);
        continue;
      }
      const { tx } = await signFrameTx(chosen, slots); // the one signature this leaf ever makes
      note = "simulation only: signed once, never sent";
      const sim: any = await node.simulate(tx, false);
      const revert = sim.revertData && sim.revertData !== "0x" ? Buffer.from((sim.revertData as Hex).slice(2), "hex").toString().replace(/\0+$/, "") : null;
      const reason = sim.canonicalMempoolViolation ?? sim.executionError ?? revert ?? sim.haltDetail ?? "no reason given";
      const verifyFrame = sim.frames?.[1];
      if (!verifyFrame?.gasUsed || verifyFrame.succeeded !== true) {
        stopped = `leaf ${leaf} (${target} steps): the verify frame ${verifyFrame ? "did not succeed" : "reported no gas"} (${reason})`;
        break;
      }
      // Once the verify frame approved, its gas is a valid measurement, whatever later frames or mempool rules say.
      const frames = (sim.frames as { gasUsed: Hex }[]).map((f) => BigInt(f.gasUsed));
      const total = sim.gasUsed ? BigInt(sim.gasUsed) : null;
      points.push({ leaf, steps: target, verify: frames[1]!, frames, total });
      const ok = (sim.canonicalMempoolValid ?? sim.valid) === true && sim.executionStatus === "success";
      console.log(`  leaf ${String(leaf).padStart(2)}: ${String(target).padStart(3)} steps, verify frame ${frames[1]} gas` +
        `   (frames ${frames.join(" / ")}${total !== null ? `, whole transaction ${total}` : ""})${ok ? "" : `  NOT VALID: ${reason}`}`);
      if (!ok) { stopped = `leaf ${leaf}: the simulation is not valid (${reason})`; break; }
    } finally {
      journal.mark(leaf, "burned", { note });
    }
  }
} finally {
  journal.close();
}
if (stopped) console.log(`\nstopped early: ${stopped}`);

if (points.length < 2) {
  console.log(`\n${points.length} point(s) measured: nothing to fit.`);
  process.exit(points.length ? 0 : 1);
}
const mx = points.reduce((s, p) => s + p.steps, 0) / points.length;
const my = points.reduce((s, p) => s + Number(p.verify), 0) / points.length;
const slope = points.reduce((s, p) => s + (p.steps - mx) * (Number(p.verify) - my), 0) / points.reduce((s, p) => s + (p.steps - mx) ** 2, 0);
const intercept = my - slope * mx;
const residual = Math.max(...points.map((p) => Math.abs(Number(p.verify) - (intercept + slope * p.steps))));
console.log(`\nmeasured: verify frame = ${intercept.toFixed(0)} + ${slope.toFixed(2)} x chain steps (largest residual ${residual.toFixed(0)} gas, ${points.length} points)`);
console.log(`central model (GRIND.cold without its ${GRIND_MARGIN} margin) ${CENTRAL.base} + ${CENTRAL.perStep} x steps; measured minus model: ` +
  points.map((p) => `${p.steps}: ${(Number(p.verify) - (CENTRAL.base + CENTRAL.perStep * p.steps)).toFixed(0)}`).join(", "));
const fitsUnder = (limit: number) => Math.floor((usable(limit) - intercept) / slope);
console.log(`through the proxy, a 90,000 declared limit can use about ${usable(90_000)} (1/64 of what is left at the DELEGATECALL is held back):`);
console.log(`  cold messages up to ${fitsUnder(90_000)} chain steps fit; reachable step counts are multiples of 15 (average message: 506)`);
