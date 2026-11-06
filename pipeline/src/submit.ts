// Send, follow the transaction to its end, and the whole keyed flow with the journal.
// Status machine (spec): Draft -> Signed (leaf reserved) -> Submitted -> OnChain, or Submitted -> Expired -> leaf
// burned -> a retry on the next leaf. Nothing goes back to Draft on the same leaf.
// Written with Claude Code (AI) for Vicky. Hardened after two reviews on Nov 6:
//   - inclusion and death are decided by protocol state two blocks below the head: the nonce manager says whether
//     the key was consumed, and a block past the deadline with the key still unused proves the transaction can never
//     land. Receipts only classify an included transaction; a failed lookup is never read as "not included", and a
//     used key with no readable receipt is "Included", never "unknown".
//   - OnChain means the transaction and every frame succeeded; included with a failed frame is Reverted, and the
//     journal says which frames ran.
//   - the two system contracts these decisions trust must hold the code Day-0 measured, or nothing is sent.
//   - a lost answer from eth_sendFrameTransaction is not a refusal: the hash and deadline are journaled before the
//     send, and the transaction is followed to its end. Only a deliberate JSON-RPC refusal, for a hash the sidecar
//     does not hold, burns the leaf at once.
//   - the signer's leaf, generation, height and tree, the journal's sender and chain, the deadline, the prefix budget
//     and the grind limit are all checked before a leaf is reserved, so a mistake wastes no leaf.
//   - every failure after the reservation is written on the leaf; sendWithRetry sends the next attempt only after the
//     sidecar has dropped the dead one, and keeps the attempts it made when it stops.
import type { Address, Hex } from "viem";
import { DEFAULTS, DEVNET, EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE, explorerTxUrl } from "./config.ts";
import { buildFrameTx, nonceManagerSlot, type Call } from "./builder.ts";
import { placeholders, signFrameTx, type SignatureSlot } from "./signer.ts";
import { RpcError, gateway, node, receiptSucceeded, simulationVerdict, toWire, type FrameTxReceipt, type SimulationResult } from "./rpc.ts";
import { grind, maxStepsFor, type GrindTry } from "./grind.ts";
import { WOTS } from "./wots.ts";
import { admissionReport, frameTxHash, type AdmissionReport } from "./admission.ts";
import type { LeafJournal } from "./leaves.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

/**
 * OnChain: included, the transaction and every frame succeeded.
 * Reverted: included (key consumed), but a frame failed; earlier frames may have paid.
 * Included: included (key consumed), but no receipt could be read, so which frames succeeded is unknown.
 * Expired: can never land.
 * Only Expired means "nothing happened". Never pay again after any of the other three.
 */
export type Outcome = "OnChain" | "Reverted" | "Included" | "Expired";

export interface InclusionResult {
  txHash: Hex;
  outcome: Outcome;
  receipt: FrameTxReceipt | null;
  /** the block, `confirmations` below the head, whose state decided the outcome */
  decidedAt: bigint;
  explorerUrl: string;
  /** what the sidecar reported and what the chain decided, with seconds since following began */
  timeline: { status: string; at: number }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function currentFees() {
  const gp = await gateway.gasPrice();
  return { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
}

let systemCheck: Promise<void> | null = null;
/**
 * The nonce manager decides inclusion and the expiry verifier decides when a transaction dies, so both must hold the
 * code Day-0 read on this chain. Checked once per process; a failed read is retried next time.
 */
export function checkSystemContracts(): Promise<void> {
  systemCheck ??= (async () => {
    for (const [name, address, want] of [["NONCE_MANAGER", NONCE_MANAGER, NONCE_MANAGER_CODE], ["EXPIRY_VERIFIER", EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE]] as const) {
      const have = (await node.code(address)).toLowerCase();
      if (have !== want) throw new Error(`${name} at ${address} holds ${have.length > 24 ? `${have.slice(0, 24)}…` : have}, not the code Day-0 measured: this is not the chain the pipeline was checked on`);
    }
  })().catch((e) => { systemCheck = null; throw e; });
  return systemCheck;
}
/** For tests: forget the cached check. */
export const forgetSystemCheck = () => { systemCheck = null; };

/** A nonce key's state at the block `confirmations` below the head, with that same block's timestamp. */
export async function pinnedKeyState(sender: Address, nonceKey: bigint, confirmations: number) {
  const head = await node.blockNumber();
  const block = head - BigInt(confirmations);
  if (block < 0n) throw new Error(`the chain is shorter than ${confirmations} blocks`);
  const [{ timestamp }, seq] = await Promise.all([node.block(block), node.storageAt(NONCE_MANAGER, nonceManagerSlot(sender, nonceKey), block)]);
  return { block, timestamp, consumed: BigInt(seq) !== 0n };
}

/** The receipt under any of the hashes, from the node, else from the sidecar; null while none can be read. */
async function findReceipt(hashes: Hex[]): Promise<FrameTxReceipt | null> {
  for (const h of hashes) {
    const r = (await node.receipt(h).catch(() => null)) ?? (await gateway.receipt(h).catch(() => null));
    if (r) return r;
  }
  return null;
}

/** Which frames of an included transaction did not succeed, for the journal. */
function frameNote(r: FrameTxReceipt): string {
  const failed = r.frameReceipts.flatMap((f, i) => (f.status === "success" ? [] : [`frame ${i} ${f.status}`]));
  const ok = r.frameReceipts.flatMap((f, i) => (f.status === "success" ? [i] : []));
  return `included, but ${failed.join(", ") || `transaction status ${r.status}`}${ok.length ? ` (frames ${ok.join(", ")} succeeded)` : ""}: ` +
    "read the receipt before paying again";
}

export interface FollowParams {
  sender: Address;
  nonceKey: bigint;
  /** the expiry frame's deadline. Without one a transaction can never be proven dead: following it ends in inclusion or a timeout */
  deadline: number | null;
  /** other hashes the same transaction may be known by, e.g. one the sidecar answered */
  altHashes?: Hex[];
  confirmations?: number;
  pollMs?: number;
  /** report the outcome unknown (throw) this long after the deadline, or after starting when there is no deadline */
  timeoutMs?: number;
  /** once the key is seen used, how long to look for a receipt before answering Included (default DEFAULTS.receiptWaitMs) */
  receiptWaitMs?: number;
  onStatus?: (status: string) => void;
}

/**
 * No outcome in time: the node could not be read, or the key stayed unused before the deadline was reached. The
 * transaction may still land; its leaf stays "submitted". Never pay again until waitForInclusion says Expired.
 */
export class OutcomeUnknown extends Error {
  constructor(readonly txHash: Hex, detail: string) {
    super(`no outcome for ${txHash}: ${detail}`);
  }
}

/**
 * Follows a keyed transaction until protocol state decides it, `confirmations` blocks deep:
 *   - its key consumed by then: included. The receipt says OnChain (every frame succeeded) or Reverted; with no
 *     readable receipt it is still included: Included.
 *   - its key unused at a block whose timestamp is past the deadline: Expired. The expiry frame reverts in that
 *     block and every later one (timestamps only grow), so the transaction can never land.
 * The sidecar's status is shown, never decisive: "Cancelled" is not final (the sidecar can re-admit it, a peer
 * can hold a copy) and a stale "Submitted" proves nothing either. Errors only mean "ask again".
 */
export async function waitForInclusion(txHash: Hex, p: FollowParams): Promise<InclusionResult> {
  await checkSystemContracts();
  const started = Date.now();
  const confirmations = p.confirmations ?? DEFAULTS.confirmations;
  const hashes = [txHash, ...(p.altHashes ?? []).filter((h) => h.toLowerCase() !== txHash.toLowerCase())];
  const timeline: InclusionResult["timeline"] = [];
  const seen = (status: string) => {
    if (timeline.at(-1)?.status === status) return;
    timeline.push({ status, at: Math.round((Date.now() - started) / 1000) });
    p.onStatus?.(status);
  };
  const result = (outcome: Outcome, receipt: FrameTxReceipt | null, decidedAt: bigint): InclusionResult =>
    ({ txHash, outcome, receipt, decidedAt, explorerUrl: explorerTxUrl(txHash), timeline });
  const timeout = p.timeoutMs ?? (p.deadline === null ? 300_000 : DEFAULTS.followTimeoutMs);
  const giveUpAt = (p.deadline === null ? started : Math.max(started, p.deadline * 1000)) + timeout;
  /** once the key is seen used two blocks deep, it stays used: the transaction is included, whatever comes next */
  let included: { since: number; block: bigint } | null = null;
  let last = "no answer from the node yet";

  for (;;) {
    const status = await gateway.status(txHash).catch(() => undefined);
    if (status) seen(`sidecar: ${status}`);
    try {
      const state = await pinnedKeyState(p.sender, p.nonceKey, confirmations);
      if (state.consumed) {
        included ??= { since: Date.now(), block: state.block };
        seen(`chain: key used by block ${state.block}`);
        const receipt = await findReceipt(hashes);
        if (receipt && BigInt(receipt.blockNumber) <= state.block) {
          const outcome: Outcome = receiptSucceeded(receipt) ? "OnChain" : "Reverted";
          seen(`chain: ${outcome} in block ${BigInt(receipt.blockNumber)}`);
          return result(outcome, receipt, state.block);
        }
        last = `key used by block ${state.block}, but no receipt at or below it yet`;
      } else if (p.deadline !== null && state.timestamp > BigInt(p.deadline)) {
        seen(`chain: Expired (block ${state.block} is past the deadline, key unused)`);
        return result("Expired", null, state.block);
      } else {
        last = `key unused at block ${state.block} (timestamp ${state.timestamp}, deadline ${p.deadline ?? "none"})`;
      }
    } catch (e) {
      last = `node unreadable: ${message(e)}`;
    }
    if (included && Date.now() - included.since >= (p.receiptWaitMs ?? DEFAULTS.receiptWaitMs)) {
      seen(`chain: Included by block ${included.block}, no receipt readable`);
      return result("Included", null, included.block);
    }
    if (!included && Date.now() > giveUpAt) throw new OutcomeUnknown(txHash, last);
    await sleep(p.pollMs ?? DEFAULTS.pollMs);
  }
}

export interface SendKeyedParams {
  journal: LeafJournal;
  /** leaves this send may use, e.g. the cold band [1, hotStart) */
  band: { from: number; to: number };
  sender: Address;
  calls: Call[];
  /** declared execution limit of the self_verify frame */
  verifyGas: bigint;
  /** signature entries for the reserved leaf, in order; called before the leaf is reserved and checked against it */
  signatures: (leaf: number) => SignatureSlot[];
  expirySeconds?: number;
  /** fixed fees instead of skandha_getGasPrice (e.g. a fee below market, to show a stuck payment) */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** grind the expiry deadline until the WOTS+ chain work fits verifyGas (cost model: GRIND in config) */
  grind?: { baseGas: number; gasPerStep: number; maxTries?: number };
  /** run ethrex_simulateFrameTransaction first and stop if it says invalid */
  preflight?: boolean;
  /** fetch the sidecar's admission report after the outcome (default true) */
  admission?: boolean;
  confirmations?: number;
  pollMs?: number;
  /** how long past the deadline to keep following before reporting the outcome unknown (default DEFAULTS.followTimeoutMs) */
  timeoutMs?: number;
  receiptWaitMs?: number;
  onStatus?: (status: string) => void;
  /** called with the exact JSON before it is sent, so scripts can print it */
  onSend?: (json: unknown) => void;
}

export interface SendKeyedResult extends InclusionResult {
  leaf: number;
  nonceKey: bigint;
  sigHash: Hex;
  deadline: number;
  simulation: SimulationResult | null;
  admission: AdmissionReport | null;
  /** present when the send was ground: the chain steps of the signed message and every deadline tried */
  grind: { steps: number; maxSteps: number; tries: GrindTry<number>[] } | null;
}

export type SendStage = "check" | "prepare" | "sign" | "preflight" | "submit" | "follow";

export interface SendErrorInfo {
  stage: SendStage;
  leaf?: number | null;
  nonceKey?: bigint | null;
  txHash?: Hex | null;
  deadline?: number | null;
  admission?: AdmissionReport | null;
  cause?: unknown;
}

/**
 * A send that stopped before an outcome. `leaf` is null when nothing was reserved. When `txHash` is set, the signed
 * transaction left this process and may land until it is proven dead: pay the same thing again only after
 * waitForInclusion(txHash, { sender, nonceKey, deadline }) answers Expired. A passed deadline alone is not enough:
 * the transaction may have landed before it.
 */
export class SendError extends Error {
  readonly stage: SendStage;
  readonly leaf: number | null;
  readonly nonceKey: bigint | null;
  readonly txHash: Hex | null;
  readonly deadline: number | null;
  readonly admission: AdmissionReport | null;
  constructor(message: string, info: SendErrorInfo) {
    super(message, { cause: info.cause });
    this.stage = info.stage;
    this.leaf = info.leaf ?? null;
    this.nonceKey = info.nonceKey ?? null;
    this.txHash = info.txHash ?? null;
    this.deadline = info.deadline ?? null;
    this.admission = info.admission ?? null;
  }
}
/** The node's dry run said the transaction is invalid. Its leaf is burned. */
export class PreflightRefused extends SendError {}
/** The sidecar refused the signed transaction on purpose and does not hold it. Its leaf is burned. */
export class SubmissionRefused extends SendError {}
/** No unused leaf is left in the band (for a hot band: the tickets are used up). Nothing was reserved. */
export class LeavesExhausted extends SendError {}

/** One hash entry at most, for exactly the leaf about to be reserved, from the journal's tree. */
function checkSlots(slots: SignatureSlot[], leaf: number, j: LeafJournal) {
  const hash = slots.filter((s) => s.kind === "hash");
  if (hash.length > 1) throw new Error(`${hash.length} hash-based entries: a transaction carries at most one leaf`);
  for (const s of hash) {
    if (s.leaf !== leaf) throw new Error(`the hash-based entry is for leaf ${s.leaf}, but the next leaf is ${leaf}`);
    if (s.signer.generation !== j.epoch) throw new Error(`the signer's tree is generation ${s.signer.generation}, the journal's epoch is ${j.epoch}`);
    if (s.signer.height !== j.height) throw new Error(`the signer's tree has height ${s.signer.height}, the journal's ${j.height}`);
    if (j.treeSeed && s.signer.treeSeed.toLowerCase() !== j.treeSeed) throw new Error(`the signer's tree seed ${s.signer.treeSeed} is not the journal's ${j.treeSeed}`);
  }
}

/**
 * One hash-signed (or, for a plain EOA, ECDSA) transaction on a fresh nonce key:
 * checks -> reserve a leaf whose key the chain has never consumed -> sign once -> dry run -> journal the hash ->
 * send -> follow to an outcome decided by chain state -> journal -> admission report. A leaf signs exactly once.
 */
export async function sendKeyed(p: SendKeyedParams): Promise<SendKeyedResult> {
  const j = p.journal;
  const fail = (msg: string, cause?: unknown): never => { throw new SendError(msg, { stage: "check", cause }); };

  // 0. Everything that needs no leaf. Nothing is reserved if one of these fails.
  if (p.sender.toLowerCase() !== j.wallet) fail(`journal ${j.file} belongs to ${j.wallet}, not ${p.sender}`);
  if (DEVNET.chainId !== j.chainId) fail(`journal ${j.file} is for chain ${j.chainId}, this pipeline sends to ${DEVNET.chainId}`);
  const expiry = p.expirySeconds ?? DEFAULTS.expirySeconds;
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 86_400) fail(`expirySeconds must be a whole number of seconds from 1 to 86,400, got ${expiry}`);
  if (p.grind) {
    const maxSteps = maxStepsFor({ ...p.grind, verifyGasLimit: p.verifyGas });
    if (maxSteps < WOTS.bestSteps) fail(`verify limit ${p.verifyGas} leaves room for ${maxSteps} chain steps; even the best message needs ${WOTS.bestSteps}`);
  }
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, chainNow: number;
  try {
    await checkSystemContracts();
    fees = p.fees ?? (await currentFees());
    chainNow = Number(await node.blockTimestamp());
  } catch (e) {
    return fail(`cannot start: ${message(e)}`, e);
  }
  const localNow = nowSeconds();
  if (Math.abs(localNow - chainNow) > DEFAULTS.maxClockSkewSeconds) {
    fail(`host clock ${localNow} and the latest block's timestamp ${chainNow} differ by more than ${DEFAULTS.maxClockSkewSeconds} s: the deadline would be wrong`);
  }
  // The expiry frame compares against block.timestamp, so the deadline counts from chain time when the host is behind.
  const baseDeadline = Math.max(localNow, chainNow) + expiry;
  const buildAt = (nonceKey: bigint, slots: SignatureSlot[], deadline: number) => buildFrameTx({
    chainId: DEVNET.chainId, sender: p.sender, nonce: { keys: [nonceKey], seq: 0n },
    verifyGas: p.verifyGas, calls: p.calls, deadline, fees, signatures: placeholders(slots),
  });
  const peek = () => {
    try {
      return j.peekNext(p.band);
    } catch (e) {
      if (/no unused leaf/.test(message(e))) throw new LeavesExhausted(`${message(e)}: no leaf left to sign with`, { stage: "check", cause: e });
      return fail(message(e), e);
    }
  };

  // 1. The leaf. Its key is read on chain first; then, with no await until the reservation, the leaf is checked
  //    against the signer, the transaction is built (and ground), and the leaf is reserved. A send running beside
  //    this one in the same process cannot take the leaf in between, and a failed check reserves nothing.
  let leaf: number, nonceKey: bigint, slots: SignatureSlot[], unsigned: FrameTransaction, deadline: number;
  let ground: SendKeyedResult["grind"] = null;
  for (;;) {
    const next = peek();
    let seq: bigint;
    try {
      seq = BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(p.sender, next.nonceKey)));
    } catch (e) {
      return fail(`cannot read nonce key 0x${next.nonceKey.toString(16)} on chain: ${message(e)}`, e);
    }
    if (peek().leaf !== next.leaf) continue; // another send took it during the read
    if (seq !== 0n) {
      j.reserveNext(p.band);
      j.mark(next.leaf, "burned", { note: `key already at sequence ${seq} on chain, missing from this journal` });
      continue;
    }
    try {
      slots = p.signatures(next.leaf);
      checkSlots(slots, next.leaf, j);
      if (p.grind) {
        const g = grind((i) => ({ value: baseDeadline + i, tx: buildAt(next.nonceKey, slots, baseDeadline + i) }), { ...p.grind, verifyGasLimit: p.verifyGas });
        unsigned = g.tx;
        deadline = g.value;
        ground = { steps: g.steps, maxSteps: g.maxSteps, tries: g.tries };
      } else {
        deadline = baseDeadline;
        unsigned = buildAt(next.nonceKey, slots, deadline);
      }
    } catch (e) {
      return fail(`leaf ${next.leaf} not reserved: ${message(e)}`, e);
    }
    ({ leaf, nonceKey } = j.reserveNext(p.band));
    if (leaf !== next.leaf) throw new Error(`internal: reserved leaf ${leaf}, checked leaf ${next.leaf}`); // impossible with no await between
    break;
  }
  const at = (stage: SendStage, extra: Omit<SendErrorInfo, "stage" | "leaf" | "nonceKey"> = {}): SendErrorInfo => ({ stage, leaf, nonceKey, ...extra });

  // 2. Sign, once. From here on the leaf counts as exposed.
  let signed: { tx: FrameTransaction; sigHash: Hex };
  try {
    signed = await signFrameTx(unsigned, slots);
  } catch (e) {
    j.mark(leaf, "burned", { note: `signing failed: ${message(e)}` });
    throw new SendError(`leaf ${leaf}: signing failed: ${message(e)}`, at("sign", { cause: e }));
  }
  const txHash = frameTxHash(signed.tx);

  // 3. Optional dry run on the node, of exactly the transaction that will be sent. The node now holds it signed.
  let simulation: SimulationResult | null = null;
  if (p.preflight) {
    let verdict: { ok: boolean; reason: string | null };
    try {
      simulation = await node.simulate(signed.tx);
      if (!simulation || typeof simulation !== "object") throw new Error(`the node answered ${JSON.stringify(simulation)}, not a simulation`);
      verdict = simulationVerdict(simulation);
    } catch (e) {
      j.mark(leaf, "burned", { note: `preflight: ${message(e)}` });
      const refused = e instanceof RpcError && e.refused;
      throw new (refused ? PreflightRefused : SendError)(`leaf ${leaf}: preflight ${refused ? "refused" : "failed"}: ${message(e)}`, at("preflight", { txHash, deadline, cause: e }));
    }
    if (!verdict.ok) {
      j.mark(leaf, "burned", { note: `preflight: ${verdict.reason}` });
      throw new PreflightRefused(`leaf ${leaf}: preflight refused: ${verdict.reason}`, at("preflight", { txHash, deadline }));
    }
  }

  // 4. Journal the hash and deadline, then send. A deliberate refusal for a hash the sidecar does not hold burns the
  //    leaf; any other failure (timeout, proxy error, cut connection, a server bug, "already known") leaves the outcome
  //    unknown, so the transaction is followed like any other.
  j.mark(leaf, "submitted", { txHash, deadline });
  p.onSend?.(toWire(signed.tx));
  const altHashes: Hex[] = [];
  try {
    const returned = await gateway.send(signed.tx);
    if (returned.toLowerCase() !== txHash.toLowerCase()) {
      altHashes.push(returned);
      j.note(leaf, `the sidecar answered hash ${returned}`);
    }
  } catch (e) {
    const alreadyKnown = e instanceof RpcError && /already known/i.test(e.message);
    const held = alreadyKnown ? true : await gateway.status(txHash).then((s) => s !== null, () => undefined);
    if (e instanceof RpcError && e.refused && held === false) {
      j.mark(leaf, "burned", { note: `refused at submission: ${message(e)}` });
      const admission = p.admission === false ? null : await admissionReport(txHash).catch(() => null);
      throw new SubmissionRefused(`leaf ${leaf}: refused at submission: ${message(e)}`, at("submit", { txHash, deadline, admission, cause: e }));
    }
    j.note(leaf, `send outcome unknown (${message(e)}); followed by its key`);
  }

  // 5. Follow it to its end.
  let result: InclusionResult;
  try {
    result = await waitForInclusion(txHash, {
      sender: p.sender, nonceKey, deadline, altHashes, confirmations: p.confirmations, pollMs: p.pollMs,
      timeoutMs: p.timeoutMs, receiptWaitMs: p.receiptWaitMs, onStatus: p.onStatus,
    });
  } catch (e) {
    j.note(leaf, `outcome unknown: ${message(e)}`);
    throw new SendError(`leaf ${leaf}: ${message(e)}`, at("follow", { txHash, deadline, cause: e }));
  }
  if (result.outcome === "Expired") j.mark(leaf, "burned", { note: `expired: key unused at block ${result.decidedAt}, past the deadline` });
  else if (result.outcome === "OnChain") j.mark(leaf, "onchain");
  else if (result.outcome === "Reverted") j.mark(leaf, "onchain", { note: frameNote(result.receipt!) });
  else j.mark(leaf, "onchain", { note: `included by block ${result.decidedAt}, but no receipt was readable: which frames succeeded is unknown; read the receipt before paying again` });
  const admission = p.admission === false ? null : await admissionReport(txHash).catch(() => null);
  return { ...result, leaf, nonceKey, sigHash: signed.sigHash, deadline, simulation, admission, grind: ground };
}

/**
 * After a crash: follows every leaf the journal holds as "submitted" to its end, by its key and deadline, and
 * journals the outcome. Leaves without a deadline (written before Nov 6) are reported, not guessed.
 */
export async function settleSubmitted(journal: LeafJournal, opts: Pick<FollowParams, "confirmations" | "pollMs" | "onStatus" | "receiptWaitMs"> = {}) {
  await checkSystemContracts();
  const out: { leaf: number; outcome: Outcome | "unknown"; detail?: string }[] = [];
  for (const rec of journal.all().filter((r) => r.status === "submitted")) {
    if (!rec.txHash || rec.deadline === undefined) {
      out.push({ leaf: rec.leaf, outcome: "unknown", detail: "no hash or deadline in the journal" });
      continue;
    }
    try {
      const r = await waitForInclusion(rec.txHash, { ...opts, sender: journal.wallet, nonceKey: BigInt(rec.nonceKey), deadline: rec.deadline });
      if (r.outcome === "Expired") journal.mark(rec.leaf, "burned", { note: `settled: expired at block ${r.decidedAt}` });
      else journal.mark(rec.leaf, "onchain", { note: `settled: ${r.outcome}${r.receipt && r.outcome === "Reverted" ? `; ${frameNote(r.receipt)}` : ""}` });
      out.push({ leaf: rec.leaf, outcome: r.outcome });
    } catch (e) {
      out.push({ leaf: rec.leaf, outcome: "unknown", detail: message(e) });
    }
  }
  return out;
}

export interface RetryParams extends SendKeyedParams {
  /** total attempts, default 3 */
  attempts?: number;
  /** overrides for the first attempt only: a low fee or a short expiry, to show a stuck payment */
  firstAttempt?: Partial<Pick<SendKeyedParams, "fees" | "expirySeconds">>;
  /** called after a dead attempt, before the next one */
  onRetry?: (dead: SendKeyedResult, nextAttempt: number) => void;
  /** how long to wait for the sidecar to drop a dead attempt before giving up the retry (default DEFAULTS.dropWaitMs) */
  dropWaitMs?: number;
}

export interface RetryResult {
  final: SendKeyedResult;
  attempts: SendKeyedResult[];
  /** leaves spent on attempts that never landed */
  burnedLeaves: number[];
}

/** The retry loop stopped without an outcome for its last step; `attempts` holds every attempt made. */
export class RetryStopped extends Error {
  constructor(message: string, readonly attempts: SendKeyedResult[], options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Waits until the sidecar no longer holds a dead transaction (Cancelled or gone): until then it still counts the
 * transaction's value and gas against the balance, and would refuse a retry that needs the same funds.
 */
async function waitUntilDropped(txHash: Hex, maxMs: number, pollMs: number): Promise<boolean> {
  const until = Date.now() + maxMs;
  for (;;) {
    const s = await gateway.status(txHash).catch(() => undefined);
    if (s === null || s === "Cancelled") return true;
    if (Date.now() >= until) return false;
    await sleep(pollMs);
  }
}

/**
 * Expiry instead of replacement (spec): when an attempt is proven Expired, send again on the next leaf with fresh
 * fees and a new deadline, once the sidecar has dropped the dead attempt. Never the same nonce key with a higher fee,
 * which would sign one leaf twice. Any other outcome ends the loop: an included attempt (OnChain, Reverted, Included)
 * must never be paid again automatically.
 */
export async function sendWithRetry(p: RetryParams): Promise<RetryResult> {
  const max = p.attempts ?? 3;
  const attempts: SendKeyedResult[] = [];
  for (let i = 0; i < max; i++) {
    let r: SendKeyedResult;
    try {
      r = await sendKeyed({ ...p, ...(i === 0 ? p.firstAttempt : {}) });
    } catch (e) {
      throw new RetryStopped(`attempt ${i + 1} of ${max} stopped: ${message(e)}`, attempts, { cause: e });
    }
    attempts.push(r);
    if (r.outcome !== "Expired") break;
    if (i + 1 < max) {
      p.onRetry?.(r, i + 2);
      const waitMs = p.dropWaitMs ?? DEFAULTS.dropWaitMs;
      if (!(await waitUntilDropped(r.txHash, waitMs, p.pollMs ?? DEFAULTS.pollMs))) {
        throw new RetryStopped(
          `attempt ${i + 1} expired, but after ${waitMs / 1000} s the sidecar still holds it and counts it against the balance; ` +
            "no retry was sent and no leaf was used. Run again once the sidecar has dropped it.",
          attempts,
        );
      }
    }
  }
  return {
    final: attempts.at(-1)!,
    attempts,
    burnedLeaves: attempts.filter((a) => a.outcome === "Expired").map((a) => a.leaf),
  };
}
