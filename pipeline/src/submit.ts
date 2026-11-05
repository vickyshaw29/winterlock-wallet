// Send, follow the status to inclusion or expiry, and the whole keyed flow with the journal.
// Status machine (spec): Draft -> Signed (leaf reserved) -> Submitted -> OnChain,
// or Submitted -> Expired / Reverted / Cancelled -> leaf burned. Nothing goes back to Draft on the same leaf.
import type { Address, Hex } from "viem";
import { DEFAULTS, DEVNET, NONCE_MANAGER, explorerTxUrl } from "./config.ts";
import { buildFrameTx, nonceManagerSlot, type Call } from "./builder.ts";
import { placeholders, signFrameTx, type SignatureSlot } from "./signer.ts";
import { gateway, node, simulationVerdict, toWire, type FrameTxReceipt, type FrameTxStatus, type SimulationResult } from "./rpc.ts";
import type { LeafJournal } from "./leaves.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

export type Outcome = "OnChain" | "Expired" | "Reverted" | "Cancelled";

export interface InclusionResult {
  txHash: Hex;
  outcome: Outcome;
  receipt: FrameTxReceipt | null;
  explorerUrl: string;
  /** every status change seen, with seconds since sending */
  timeline: { status: FrameTxStatus | "Expired"; at: number }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Polls the gateway until the transaction is on chain, reverted, cancelled, or one block past its
 * deadline. Before calling it expired it reads the receipt: a stale status is not proof of non-inclusion.
 */
export async function waitForInclusion(
  txHash: Hex,
  opts: { deadline: number | null; pollMs?: number; timeoutMs?: number; onStatus?: (s: FrameTxStatus | "Expired") => void },
): Promise<InclusionResult> {
  const started = Date.now();
  const timeline: InclusionResult["timeline"] = [];
  const seen = (status: FrameTxStatus | "Expired") => {
    if (timeline.at(-1)?.status === status) return;
    timeline.push({ status, at: Math.round((Date.now() - started) / 1000) });
    opts.onStatus?.(status);
  };
  const done = (outcome: Outcome, receipt: FrameTxReceipt | null): InclusionResult => ({ txHash, outcome, receipt, explorerUrl: explorerTxUrl(txHash), timeline });

  for (;;) {
    const status = await gateway.status(txHash).catch(() => null);
    if (status) seen(status);
    if (status === "OnChain" || status === "Finalized") return done("OnChain", await gateway.receipt(txHash));
    if (status === "Reverted" || status === "Cancelled") return done(status, await gateway.receipt(txHash).catch(() => null));

    if (opts.deadline !== null && nowSeconds() > opts.deadline + DEVNET.blockTime) {
      const receipt = await gateway.receipt(txHash).catch(() => null);
      if (receipt) { seen("OnChain"); return done("OnChain", receipt); }
      seen("Expired");
      return done("Expired", null);
    }
    if (opts.deadline === null && Date.now() - started > (opts.timeoutMs ?? 300_000)) {
      throw new Error(`no final status for ${txHash} after ${(opts.timeoutMs ?? 300_000) / 1000} s`);
    }
    await sleep(opts.pollMs ?? DEFAULTS.pollMs);
  }
}

export interface SendKeyedParams {
  journal: LeafJournal;
  /** leaves this send may use, e.g. the cold band [0, hotStart) */
  band: { from: number; to: number };
  sender: Address;
  calls: Call[];
  /** declared execution limit of the self_verify frame */
  verifyGas: bigint;
  /** signature entries for the reserved leaf, in order */
  signatures: (leaf: number) => SignatureSlot[];
  expirySeconds?: number;
  /** run ethrex_simulateFrameTransaction first and stop if it says invalid */
  preflight?: boolean;
  onStatus?: (s: FrameTxStatus | "Expired") => void;
  /** called with the exact JSON before it is sent, so scripts can print it */
  onSend?: (json: unknown) => void;
}

export interface SendKeyedResult extends InclusionResult {
  leaf: number;
  nonceKey: bigint;
  sigHash: Hex;
  simulation: SimulationResult | null;
}

/**
 * One hash-signed (or, for a plain EOA, ECDSA) transaction on a fresh nonce key:
 * reserve a leaf -> check the key is unused on chain -> build -> sign -> send -> follow -> journal.
 * Any failure after signing burns the leaf; a leaf is never signed twice.
 */
export async function sendKeyed(p: SendKeyedParams): Promise<SendKeyedResult> {
  // 1. A leaf the journal has never seen, whose key the chain has never consumed either.
  let leaf: number, nonceKey: bigint;
  for (;;) {
    ({ leaf, nonceKey } = p.journal.reserveNext(p.band));
    const seq = BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(p.sender, nonceKey)));
    if (seq === 0n) break;
    p.journal.mark(leaf, "burned", { note: `key already at sequence ${seq} on chain, missing from this journal` });
  }

  // 2. Build with placeholders, then sign. From here on the leaf counts as exposed.
  const gp = await gateway.gasPrice();
  const deadline = nowSeconds() + (p.expirySeconds ?? DEFAULTS.expirySeconds);
  const slots = p.signatures(leaf);
  let signed: { tx: FrameTransaction; sigHash: Hex };
  try {
    const unsigned = buildFrameTx({
      chainId: DEVNET.chainId, sender: p.sender, nonce: { keys: [nonceKey], seq: 0n },
      verifyGas: p.verifyGas, calls: p.calls, deadline,
      fees: { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) },
      signatures: placeholders(slots),
    });
    signed = await signFrameTx(unsigned, slots);
  } catch (e) {
    p.journal.mark(leaf, "burned", { note: `build or sign failed: ${(e as Error).message}` });
    throw e;
  }

  // 3. Optional dry run on the node.
  let simulation: SimulationResult | null = null;
  if (p.preflight) {
    simulation = await node.simulate(signed.tx);
    const verdict = simulationVerdict(simulation);
    if (!verdict.ok) {
      p.journal.mark(leaf, "burned", { note: `preflight: ${verdict.reason}` });
      throw new Error(`preflight refused leaf ${leaf}: ${verdict.reason}`);
    }
  }

  // 4. Send to the alt mempool. A refusal burns the leaf: its signature exists now.
  p.onSend?.(toWire(signed.tx));
  let txHash: Hex;
  try {
    txHash = await gateway.send(signed.tx);
  } catch (e) {
    p.journal.mark(leaf, "burned", { note: `refused at submission: ${(e as Error).message}` });
    throw e;
  }
  p.journal.mark(leaf, "submitted", { txHash });

  // 5. Follow it. Anything but OnChain burns the leaf; the retry takes a fresh one.
  const result = await waitForInclusion(txHash, { deadline, onStatus: p.onStatus });
  p.journal.mark(leaf, result.outcome === "OnChain" ? "onchain" : "burned", { note: result.outcome === "OnChain" ? undefined : result.outcome });
  return { ...result, leaf, nonceKey, sigHash: signed.sigHash, simulation };
}
