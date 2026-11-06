// Frame limits from eth_estimateFrameTransactionGas, without ever signing one leaf twice.
// Written with Claude Code (AI) for Vicky. Facts below were measured on the devnet on Nov 6.
//
// The estimator runs the account's verify frame, so it needs a signed transaction, and it first replaces every
// frame after self_verify with limits {10e6, 10e6}: the message it checks is not the one later sent. With a
// one-time signer, estimating on the sending leaf would sign two messages on one leaf, which makes it forgeable.
// So each estimate is signed by its own leaf from the same band, exactly once; that leaf is never sent and is
// burned in the journal.
//
// The estimator returns the gas each frame USED (a limit at exactly that fails: SSTORE needs 2,300 left) and
// never estimates state gas (it reports 0x0). Only cumulativeGasUsed carries the state total, which ethrex's
// billing formula (frameGasModel) splits out. A frame that reverts still estimates fine, so callers should also
// preflight the final transaction.
import { concat, hexToBytes, numberToHex, toRlp, type Address, type Hex } from "viem";
import { DEFAULTS, DEVNET, NONCE_MANAGER, SIG_SCHEME_COST } from "./config.ts";
import { buildFrameTx, nonceManagerSlot, type Call } from "./builder.ts";
import { placeholders, signFrameTx, type SignatureSlot } from "./signer.ts";
import { rpc, toWire, node } from "./rpc.ts";
import type { LeafJournal } from "./leaves.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

/**
 * ethrex's gas model for a frame transaction (crates/common/types/transaction.rs at 9aa3645d), checked against
 * measured estimates: mandatory = 12,000 + 475 per frame + signature costs + 6,000 per value-carrying frame;
 * billed bytes = every frame's data, every signature's signer, msg and bytes, and the RLP of the nonce fields;
 * data cost = 4 per zero byte and 16 per other byte; floor = 64 per billed byte.
 */
export function frameGasModel(tx: FrameTransaction) {
  if (tx.recentRootReferences.length) throw new Error("frameGasModel does not bill recent-root references");
  const sigCost = tx.signatures.reduce((s, x) => s + (SIG_SCHEME_COST[x.scheme] ?? 0n), 0n);
  const valueFrames = BigInt(tx.frames.filter((f) => f.value !== 0n).length);
  const mandatory = 12_000n + 475n * BigInt(tx.frames.length) + sigCost + 6_000n * valueFrames;
  const minimal = (n: bigint): Hex => (n === 0n ? "0x" : numberToHex(n).length % 2 ? (`0x0${numberToHex(n).slice(2)}` as Hex) : numberToHex(n));
  const fields: Uint8Array[] = [
    ...tx.frames.map((f) => hexToBytes(f.data)),
    ...tx.signatures.flatMap((s) => [s.signer === "0x" ? new Uint8Array() : hexToBytes(s.signer), hexToBytes(s.msg), hexToBytes(s.signature)]),
    hexToBytes(concat([toRlp(tx.nonceKeys.map(minimal)), toRlp(minimal(tx.nonceSeq))])),
  ];
  let dataCost = 0n, bytes = 0n;
  for (const f of fields) for (const b of f) { dataCost += b === 0 ? 4n : 16n; bytes += 1n; }
  const floor = 64n * bytes;
  const intrinsic = mandatory + dataCost;
  /** gas used before refunds, without state: mandatory + max(everything else, floor) */
  const floored = (withoutState: bigint) => mandatory + (withoutState - mandatory > floor ? withoutState - mandatory : floor);
  return { mandatory, dataCost, intrinsic, floor, bytes, floored };
}

/** The state gas inside an estimate's cumulativeGasUsed: total minus the floored execution part. */
export function inferStateGas(tx: FrameTransaction, cumulativeGasUsed: bigint, frameExecution: bigint[]): bigint {
  const m = frameGasModel(tx);
  const execution = frameExecution.reduce((s, x) => s + x, 0n);
  return cumulativeGasUsed - m.floored(m.intrinsic + execution);
}

export interface CallEstimate {
  /** execution gas the frame used in the estimate */
  used: bigint;
  /** the limit to declare: used plus the margin */
  execution: bigint;
  /** state gas the frame needs (new slots and accounts): declare exactly this */
  state: bigint;
  /** the throwaway leaf that signed this estimate, now burned */
  leaf: number;
}

export interface EstimateParams {
  journal: LeafJournal;
  /** the band the transaction will use: the verify frame's checks (and hot rules) must match */
  band: { from: number; to: number };
  sender: Address;
  calls: Call[];
  signatures: (leaf: number) => SignatureSlot[];
  /** limit = used + used * percent / 100 + extra; default 10 % + 2,500 (SSTORE needs 2,300 left) */
  margin?: { percent: number; extra: number };
}

const BODY_LIMIT = 10_000_000n; // what the sidecar puts in every frame after self_verify
const MAX_PREFIX = 100_000n;

/**
 * One estimate per call, each signed by its own fresh leaf, which is then burned. Calls are estimated alone, so
 * the state each one needs is known exactly; calls that depend on an earlier call's effects are estimated on
 * today's state. Returns the limits to put in each Call.
 */
export async function estimateCalls(p: EstimateParams): Promise<CallEstimate[]> {
  const margin = p.margin ?? { percent: 10, extra: 2_500 };
  const head = await rpc<{ baseFeePerGas?: Hex }>(DEVNET.node, "eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(head.baseFeePerGas ?? "0x1");
  // Low fees keep the simulated maximum cost (about 20 million gas per body frame) under a hot fee cap; gas used
  // does not depend on fees.
  const fees = { maxFeePerGas: baseFee * 2n > 0n ? baseFee * 2n : 1n, maxPriorityFeePerGas: 1n };
  const out: CallEstimate[] = [];
  for (const call of p.calls) {
    // A leaf the journal has never seen and the chain has never consumed, burned whatever happens next.
    let leaf: number, nonceKey: bigint;
    for (;;) {
      ({ leaf, nonceKey } = p.journal.reserveNext(p.band, "estimate only"));
      if (BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(p.sender, nonceKey))) === 0n) break;
      p.journal.mark(leaf, "burned", { note: "key already consumed on chain" });
    }
    try {
      const slots = p.signatures(leaf);
      // The largest verify limit the prefix cap allows, so the verify frame never runs short during the estimate.
      const verifyGas = MAX_PREFIX - DEFAULTS.expiryFrameGas - slots.reduce((s, x) => s + (x.kind === "ecdsa" ? 2_800n : 100n), 0n);
      const unsigned = buildFrameTx({
        chainId: DEVNET.chainId, sender: p.sender, nonce: { keys: [nonceKey], seq: 0n }, verifyGas,
        deadline: Math.floor(Date.now() / 1000) + DEFAULTS.expirySeconds, fees,
        calls: [{ ...call, gas: BODY_LIMIT, stateGas: BODY_LIMIT }], // exactly what the sidecar simulates
        signatures: placeholders(slots),
      });
      const { tx } = await signFrameTx(unsigned, slots); // the one signature this leaf ever makes
      const r = await rpc<{ frames: { execution: Hex }[]; cumulativeGasUsed: Hex }>(DEVNET.gateway, "eth_estimateFrameTransactionGas", [toWire(tx)]);
      const exec = r.frames.map((f) => BigInt(f.execution));
      const used = exec.at(-1)!;
      const state = inferStateGas(tx, BigInt(r.cumulativeGasUsed), exec);
      if (state < 0n) throw new Error(`state gas came out negative (${state}): the gas model no longer matches this node`);
      out.push({ used, execution: used + (used * BigInt(margin.percent)) / 100n + BigInt(margin.extra), state, leaf });
    } finally {
      p.journal.mark(leaf, "burned", { note: "estimate only: signed once, never sent" });
    }
  }
  return out;
}

/** The calls with their estimated limits filled in. */
export const withEstimates = (calls: Call[], est: CallEstimate[]): Call[] =>
  calls.map((c, i) => ({ ...c, gas: est[i]!.execution, stateGas: est[i]!.state }));
