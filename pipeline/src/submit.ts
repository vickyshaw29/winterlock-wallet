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
//   - for the backend (Nov 6): onSubmitted lets a caller answer once the transaction has left, with the dry run it was
//     checked with (parallel lanes: its maxCost is the lane's set-aside); mempool "public" sends to the node's own pool
//     under the same refusal rule; a refusal carries the dry run it was based on; a fee the caller fixed is never
//     ground (the last frame's limit is), so a stuck payment stays stuck.
//   - for browsers and Snaps (Nov 6): every function takes an optional network (network.ts) and falls back to the
//     default one (DEVNET and the module-level clients), and a send reads its chain id once; a journal that stores
//     after its methods return (Journal.durable) is waited for before the leaf signs and before the transaction is sent.
import type { Address, Hex } from "viem";
import { DEFAULTS, EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE } from "./config.ts";
import { buildFrameTx, nonceKeyFor, nonceManagerSlot, type Call } from "./builder.ts";
import { encodeRawFrameTx } from "./codec/codec.ts";
import { placeholders, signFrameTx, type SignatureSlot } from "./signer.ts";
import { RpcError, receiptSucceeded, simulationVerdict, toWire, type FrameTxReceipt, type SimulationResult } from "./rpc.ts";
import { defaultNetwork, type Network } from "./network.ts";
import { grind, maxStepsFor, type GrindConfig, type GrindTry } from "./grind.ts";
import { WOTS } from "./wots.ts";
import { admissionReport, frameTxHash, type AdmissionReport } from "./admission.ts";
import type { Journal } from "./journal.ts";
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

async function currentFees(net: Network) {
  const gp = await net.gateway.gasPrice();
  return { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
}

const systemChecks = new WeakMap<Network, Promise<void>>();
/**
 * The nonce manager decides inclusion and the expiry verifier decides when a transaction dies, so both must hold the
 * code Day-0 read on this chain. Checked once per process and network; a failed read is retried next time.
 */
export function checkSystemContracts(net: Network = defaultNetwork): Promise<void> {
  let check = systemChecks.get(net);
  if (!check) {
    const started: Promise<void> = (async () => {
      // A network made by createNetwork names its chain id; its node must really be on it. (The default network is
      // DEVNET, whose node the backend and the scripts already pin by genesis.)
      if (net !== defaultNetwork) {
        const id = BigInt(await net.node.request<Hex>("eth_chainId"));
        if (id !== net.chainId) throw new Error(`the node of this network is on chain ${id}, not chain ${net.chainId}`);
      }
      for (const [name, address, want] of [["NONCE_MANAGER", NONCE_MANAGER, NONCE_MANAGER_CODE], ["EXPIRY_VERIFIER", EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE]] as const) {
        const have = (await net.node.code(address)).toLowerCase();
        if (have !== want) throw new Error(`${name} at ${address} holds ${have.length > 24 ? `${have.slice(0, 24)}…` : have}, not the code Day-0 measured: this is not the chain the pipeline was checked on`);
      }
    })().catch((e) => { if (systemChecks.get(net) === started) systemChecks.delete(net); throw e; });
    systemChecks.set(net, started);
    check = started;
  }
  return check;
}
/** For tests: forget the cached check. */
export const forgetSystemCheck = (net: Network = defaultNetwork) => { systemChecks.delete(net); };

/** A nonce key's state at the block `confirmations` below the head, with that same block's timestamp. */
export async function pinnedKeyState(sender: Address, nonceKey: bigint, confirmations: number, net: Network = defaultNetwork) {
  const head = await net.node.blockNumber();
  const block = head - BigInt(confirmations);
  if (block < 0n) throw new Error(`the chain is shorter than ${confirmations} blocks`);
  const [{ timestamp }, seq] = await Promise.all([net.node.block(block), net.node.storageAt(NONCE_MANAGER, nonceManagerSlot(sender, nonceKey), block)]);
  return { block, timestamp, consumed: BigInt(seq) !== 0n };
}

/** The receipt under any of the hashes, from the node, else from the sidecar; null while none can be read. */
async function findReceipt(hashes: Hex[], net: Network): Promise<FrameTxReceipt | null> {
  for (const h of hashes) {
    const r = (await net.node.receipt(h).catch(() => null)) ?? (await net.gateway.receipt(h).catch(() => null));
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
  /** the network to follow it on; default DEVNET and the module-level clients */
  network?: Network;
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
  const net = p.network ?? defaultNetwork;
  await checkSystemContracts(net);
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
    ({ txHash, outcome, receipt, decidedAt, explorerUrl: net.explorerTxUrl(txHash), timeline });
  const timeout = p.timeoutMs ?? (p.deadline === null ? 300_000 : DEFAULTS.followTimeoutMs);
  const giveUpAt = (p.deadline === null ? started : Math.max(started, p.deadline * 1000)) + timeout;
  /** once the key is seen used two blocks deep, it stays used: the transaction is included, whatever comes next */
  let included: { since: number; block: bigint } | null = null;
  let last = "no answer from the node yet";

  for (;;) {
    const status = await net.gateway.status(txHash).catch(() => undefined);
    if (status) seen(`sidecar: ${status}`);
    try {
      const state = await pinnedKeyState(p.sender, p.nonceKey, confirmations, net);
      if (state.consumed) {
        included ??= { since: Date.now(), block: state.block };
        seen(`chain: key used by block ${state.block}`);
        const receipt = await findReceipt(hashes, net);
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
  journal: Journal;
  /** leaves this send may use, e.g. the cold band [1, hotStart) */
  band: { from: number; to: number };
  sender: Address;
  calls: Call[];
  /** declared execution limit of the self_verify frame */
  verifyGas: bigint;
  /** signature entries for the reserved leaf, in order; called before the leaf is reserved and checked against it */
  signatures: (leaf: number) => SignatureSlot[];
  expirySeconds?: number;
  /** fixed fees instead of skandha_getGasPrice (e.g. a fee below market, to show a stuck payment); never ground */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /**
   * Grind until the WOTS+ chain work fits verifyGas (cost model: GRIND in config). The field ground is maxFeePerGas,
   * one wei per try, so the deadline stays exact (Vicky's decision, Nov 6); a few thousand wei at most, against fees
   * of about 2 gwei per gas. When the caller fixes `fees`, the fee stays exact too and the last SENDER frame's
   * execution limit moves instead, one gas per try (review, Nov 6: a ground fee climbed past the base fee, so a
   * stuck payment never stuck).
   */
  grind?: Omit<GrindConfig, "verifyGasLimit">;
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
  /**
   * Where to send: "alt" (default) is the sidecar's eth_sendFrameTransaction; "public" is the node's own pool,
   * eth_sendRawTransaction. Unverified on the devnet: ethrex's docs say its pool may admit several keyed
   * transactions with disjoint keys from one sender, so "one pending per sender" may not hold there.
   */
  mempool?: "alt" | "public";
  /**
   * Called once, right after the submission step and before following, so a caller (the backend) can answer while
   * the transaction is followed. A throw here is noted on the leaf and changes nothing else.
   */
  onSubmitted?: (s: SubmittedInfo) => void;
  /** the network to send on; default DEVNET and the module-level clients. Its chain id is read once per send */
  network?: Network;
}

export interface SubmittedInfo {
  leaf: number;
  nonceKey: bigint;
  txHash: Hex;
  deadline: number;
  /** another hash the mempool answered for the same transaction, when it differs */
  altHashes: Hex[];
  /** false when the send's answer was lost or unclear: the transaction is then followed by its key */
  accepted: boolean;
  /**
   * the node's dry run of exactly this transaction (preflight), or null without one: its maxCost is what the sidecar
   * sets aside for the payer while the lane is pending (parallel lanes, Nov 6)
   */
  simulation: SimulationResult | null;
  /** the grinding that fixed this transaction's message, or null when it was not ground (Nov 6: the gas gauge) */
  grind: GrindInfo | null;
}

/**
 * How a send was ground: the field varied, the chain steps of the signed message, the most the declared verify limit
 * allows (maxStepsFor), and every value tried in order with its message's chain steps; the last try is the one signed.
 */
export interface GrindInfo { field: "maxFeePerGas" | "lastFrameGas"; steps: number; maxSteps: number; tries: GrindTry<bigint>[] }

export interface SendKeyedResult extends InclusionResult {
  leaf: number;
  nonceKey: bigint;
  sigHash: Hex;
  deadline: number;
  simulation: SimulationResult | null;
  admission: AdmissionReport | null;
  /** present when the send was ground: the chain steps of the signed message and every value tried of the field ground */
  grind: GrindInfo | null;
}

export type SendStage = "check" | "prepare" | "sign" | "preflight" | "submit" | "follow";

export interface SendErrorInfo {
  stage: SendStage;
  leaf?: number | null;
  nonceKey?: bigint | null;
  txHash?: Hex | null;
  deadline?: number | null;
  admission?: AdmissionReport | null;
  /** the node's dry run, when one ran: a refusal's verify gas and revert reason are in it */
  simulation?: SimulationResult | null;
  /** the grinding of the transaction that failed, when it was ground before the failure (a refusal's gas gauge) */
  grind?: GrindInfo | null;
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
  readonly simulation: SimulationResult | null;
  readonly grind: GrindInfo | null;
  constructor(message: string, info: SendErrorInfo) {
    super(message, { cause: info.cause });
    this.stage = info.stage;
    this.leaf = info.leaf ?? null;
    this.nonceKey = info.nonceKey ?? null;
    this.txHash = info.txHash ?? null;
    this.deadline = info.deadline ?? null;
    this.admission = info.admission ?? null;
    this.simulation = info.simulation ?? null;
    this.grind = info.grind ?? null;
  }
}
/** The node's dry run said the transaction is invalid. Its leaf is burned. */
export class PreflightRefused extends SendError {}
/** The sidecar refused the signed transaction on purpose and does not hold it. Its leaf is burned. */
export class SubmissionRefused extends SendError {}
/** No unused leaf is left in the band (for a hot band: the tickets are used up). Nothing was reserved. */
export class LeavesExhausted extends SendError {}

/**
 * Why this journal cannot be used for this sender on this chain, or null. Every path that reserves or settles leaves
 * checks it first (sendKeyed, estimateCalls, settleSubmitted): with pipelines on several chains (createPipeline), a
 * journal used on the wrong chain would let one leaf sign on that chain without the right journal knowing.
 */
export function journalMismatch(j: Journal, sender: Address, chainId: bigint): string | null {
  if (sender.toLowerCase() !== j.wallet) return `journal ${j.file} belongs to ${j.wallet}, not ${sender}`;
  if (chainId !== j.chainId) return `journal ${j.file} is for chain ${j.chainId}, this pipeline sends to ${chainId}`;
  return null;
}

/** One hash entry at most, for exactly the leaf about to be reserved, from the journal's tree. */
export function checkSlots(slots: SignatureSlot[], leaf: number, j: Journal) {
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
  const net = p.network ?? defaultNetwork;
  const chainId = net.chainId; // read once: the check below and every build use the same chain
  const fail = (msg: string, cause?: unknown): never => { throw new SendError(msg, { stage: "check", cause }); };

  // 0. Everything that needs no leaf. Nothing is reserved if one of these fails.
  const mismatch = journalMismatch(j, p.sender, chainId);
  if (mismatch) fail(mismatch);
  const expiry = p.expirySeconds ?? DEFAULTS.expirySeconds;
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 86_400) fail(`expirySeconds must be a whole number of seconds from 1 to 86,400, got ${expiry}`);
  if (p.grind) {
    const maxSteps = maxStepsFor({ ...p.grind, verifyGasLimit: p.verifyGas });
    if (maxSteps < WOTS.bestSteps) fail(`verify limit ${p.verifyGas} leaves room for ${maxSteps} chain steps; even the best message needs ${WOTS.bestSteps}`);
  }
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, chainNow: number;
  try {
    await checkSystemContracts(net);
    fees = p.fees ?? (await currentFees(net));
    chainNow = Number(await net.node.blockTimestamp());
  } catch (e) {
    return fail(`cannot start: ${message(e)}`, e);
  }
  const localNow = nowSeconds();
  if (Math.abs(localNow - chainNow) > DEFAULTS.maxClockSkewSeconds) {
    fail(`host clock ${localNow} and the latest block's timestamp ${chainNow} differ by more than ${DEFAULTS.maxClockSkewSeconds} s: the deadline would be wrong`);
  }
  // The expiry frame compares against block.timestamp, so the deadline counts from chain time when the host is behind.
  const baseDeadline = Math.max(localNow, chainNow) + expiry;
  // The last SENDER frame's execution limit, which a fixed-fee send grinds instead of the fee.
  const lastGas = p.calls.at(-1)?.gas ?? DEFAULTS.transferGas;
  const buildAt = (nonceKey: bigint, slots: SignatureSlot[], maxFeePerGas: bigint, lastFrameGas = lastGas) => buildFrameTx({
    chainId, sender: p.sender, nonce: { keys: [nonceKey], seq: 0n }, verifyGas: p.verifyGas,
    calls: p.calls.map((c, i) => (i === p.calls.length - 1 ? { ...c, gas: lastFrameGas } : c)),
    deadline: baseDeadline, fees: { ...fees, maxFeePerGas }, signatures: placeholders(slots),
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
  let leaf: number, nonceKey: bigint, slots: SignatureSlot[], unsigned: FrameTransaction;
  const deadline = baseDeadline;
  let ground: GrindInfo | null = null;
  for (;;) {
    const next = peek();
    let seq: bigint;
    try {
      seq = BigInt(await net.node.storage(NONCE_MANAGER, nonceManagerSlot(p.sender, next.nonceKey)));
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
        // A fee the caller fixed stays exact (a stuck payment must stay below the base fee): the limit moves instead.
        const field = p.fees ? "lastFrameGas" : "maxFeePerGas";
        const g = grind((i) => {
          if (field === "lastFrameGas") { const gas = lastGas + BigInt(i); return { value: gas, tx: buildAt(next.nonceKey, slots, fees.maxFeePerGas, gas) }; }
          const fee = fees.maxFeePerGas + BigInt(i);
          return { value: fee, tx: buildAt(next.nonceKey, slots, fee) };
        }, { ...p.grind, verifyGasLimit: p.verifyGas });
        unsigned = g.tx;
        ground = { field, steps: g.steps, maxSteps: g.maxSteps, tries: g.tries };
      } else {
        unsigned = buildAt(next.nonceKey, slots, fees.maxFeePerGas);
      }
    } catch (e) {
      return fail(`leaf ${next.leaf} not reserved: ${message(e)}`, e);
    }
    ({ leaf, nonceKey } = j.reserveNext(p.band));
    if (leaf !== next.leaf) throw new Error(`internal: reserved leaf ${leaf}, checked leaf ${next.leaf}`); // impossible with no await between
    break;
  }
  const at = (stage: SendStage, extra: Omit<SendErrorInfo, "stage" | "leaf" | "nonceKey"> = {}): SendErrorInfo => ({ stage, leaf, nonceKey, grind: ground, ...extra });

  // 1b. A journal that stores after its methods return (a Snap's) must have stored the reservation before the leaf
  //     signs. LeafJournal stores synchronously and has no durable(): nothing waits here for it.
  if (j.durable) {
    try {
      await j.durable();
    } catch (e) {
      try { j.mark(leaf, "burned", { note: `the reservation could not be stored, so the leaf never signed: ${message(e)}` }); } catch { /* the journal is broken */ }
      throw new SendError(`leaf ${leaf}: the journal could not store the reservation; nothing was signed: ${message(e)}`, at("prepare", { cause: e }));
    }
  }

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
      simulation = await net.node.simulate(signed.tx);
      if (!simulation || typeof simulation !== "object") throw new Error(`the node answered ${JSON.stringify(simulation)}, not a simulation`);
      verdict = simulationVerdict(simulation);
    } catch (e) {
      j.mark(leaf, "burned", { note: `preflight: ${message(e)}` });
      const refused = e instanceof RpcError && e.refused;
      throw new (refused ? PreflightRefused : SendError)(`leaf ${leaf}: preflight ${refused ? "refused" : "failed"}: ${message(e)}`, at("preflight", { txHash, deadline, cause: e }));
    }
    if (!verdict.ok) {
      j.mark(leaf, "burned", { note: `preflight: ${verdict.reason}` });
      throw new PreflightRefused(`leaf ${leaf}: preflight refused: ${verdict.reason}`, at("preflight", { txHash, deadline, simulation }));
    }
  }

  // 4. Journal the hash and deadline, then send. A deliberate refusal for a hash the mempool does not hold burns the
  //    leaf; any other failure (timeout, proxy error, cut connection, a server bug, "already known") leaves the outcome
  //    unknown, so the transaction is followed like any other. The public pool is asked the same way, by hash.
  const mempool = p.mempool ?? "alt";
  j.mark(leaf, "submitted", { txHash, deadline });
  // A journal that stores later must hold the hash and deadline before the transaction leaves: after a crash they
  // are how settleSubmitted follows it. The preflight already showed the signed transaction to the node.
  if (j.durable) {
    try {
      await j.durable();
    } catch (e) {
      try { j.mark(leaf, "burned", { note: `its hash could not be stored, so it was never sent: ${message(e)}` }); } catch { /* the journal is broken */ }
      throw new SendError(`leaf ${leaf}: the journal could not store the transaction's hash; nothing was sent: ${message(e)}`,
        at("submit", { txHash: p.preflight ? txHash : null, deadline: p.preflight ? deadline : null, simulation, cause: e }));
    }
  }
  p.onSend?.(toWire(signed.tx));
  const altHashes: Hex[] = [];
  let accepted = true;
  try {
    const returned = mempool === "public" ? await net.node.sendRawPublic(signed.tx) : await net.gateway.send(signed.tx);
    if (returned.toLowerCase() !== txHash.toLowerCase()) {
      altHashes.push(returned);
      j.note(leaf, `the ${mempool === "public" ? "node" : "sidecar"} answered hash ${returned}`);
    }
  } catch (e) {
    const alreadyKnown = e instanceof RpcError && /already known/i.test(e.message);
    // false only when the mempool answers that it holds no such transaction; undefined when it cannot be asked
    const held = alreadyKnown ? true : await (mempool === "public"
      ? net.node.transactionByHash(txHash).then((t) => t !== null, () => undefined)
      : net.gateway.status(txHash).then((s) => s !== null, () => undefined));
    if (e instanceof RpcError && e.refused && held === false) {
      j.mark(leaf, "burned", { note: `refused at submission: ${message(e)}` });
      // the sidecar never saw a transaction sent to the public pool, so it has no admission record for it
      const admission = p.admission === false || mempool === "public" ? null : await admissionReport(txHash, net).catch(() => null);
      throw new SubmissionRefused(`leaf ${leaf}: refused at submission: ${message(e)}`, at("submit", { txHash, deadline, admission, simulation, cause: e }));
    }
    accepted = false;
    j.note(leaf, `send outcome unknown (${message(e)}); followed by its key`);
  }
  if (p.onSubmitted) {
    // The caller's bookkeeping must never change what happens to a transaction that has left: note it and go on.
    const noteFailure = (e: unknown) => { try { j.note(leaf, `onSubmitted failed: ${message(e)}`); } catch { /* the journal is closed */ } };
    try {
      const r: unknown = p.onSubmitted({ leaf, nonceKey, txHash, deadline, altHashes: [...altHashes], accepted, simulation, grind: ground });
      if (r instanceof Promise) r.catch(noteFailure);
    } catch (e) {
      noteFailure(e);
    }
  }

  // 5. Follow it to its end.
  let result: InclusionResult;
  try {
    result = await waitForInclusion(txHash, {
      sender: p.sender, nonceKey, deadline, altHashes, confirmations: p.confirmations, pollMs: p.pollMs,
      timeoutMs: p.timeoutMs, receiptWaitMs: p.receiptWaitMs, onStatus: p.onStatus, network: net,
    });
  } catch (e) {
    j.note(leaf, `outcome unknown: ${message(e)}`);
    throw new SendError(`leaf ${leaf}: ${message(e)}`, at("follow", { txHash, deadline, cause: e }));
  }
  if (result.outcome === "Expired") j.mark(leaf, "burned", { note: `expired: key unused at block ${result.decidedAt}, past the deadline` });
  else if (result.outcome === "OnChain") j.mark(leaf, "onchain");
  else if (result.outcome === "Reverted") j.mark(leaf, "onchain", { note: frameNote(result.receipt!) });
  else j.mark(leaf, "onchain", { note: `included by block ${result.decidedAt}, but no receipt was readable: which frames succeeded is unknown; read the receipt before paying again` });
  const admission = p.admission === false || mempool === "public" ? null : await admissionReport(txHash, net).catch(() => null);
  return { ...result, leaf, nonceKey, sigHash: signed.sigHash, deadline, simulation, admission, grind: ground };
}

export interface SignPreparedParams {
  journal: Journal;
  /** a leaf the caller reserved earlier and never signed (MetaMask: reserved by eth_prepareUserOperation) */
  leaf: number;
  sender: Address;
  calls: Call[];
  /** declared execution limit of the self_verify frame */
  verifyGas: bigint;
  /** signature entries for the leaf, in order; checked against it */
  signatures: (leaf: number) => SignatureSlot[];
  /** the fees the user approved, exactly; never ground */
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  expirySeconds?: number;
  /** grinding: the last SENDER frame's execution limit rises by one gas per try, at most maxTries */
  grind: Omit<GrindConfig, "verifyGasLimit">;
  /** the unsigned transaction after grinding, before the leaf signs; a throw stops here and the leaf stays reserved, unsigned */
  checkUnsigned?: (tx: FrameTransaction) => void | Promise<void>;
  /** the signed transaction, before it is recorded or shown to anyone; a throw burns the leaf */
  checkSigned?: (tx: FrameTransaction) => void;
  /** run ethrex_simulateFrameTransaction after recording, and burn the leaf if it says invalid */
  preflight?: boolean;
  network?: Network;
}

export interface SignedPrepared {
  leaf: number;
  nonceKey: bigint;
  tx: FrameTransaction;
  /** 0x06 ‖ rlp: what the caller hands on */
  raw: Hex;
  txHash: Hex;
  sigHash: Hex;
  deadline: number;
  simulation: SimulationResult | null;
  grind: GrindInfo;
}

/**
 * Signs one transaction with a leaf reserved earlier, and sends nothing: for a host that hands the signed transaction
 * on (MetaMask Flask carries it to the local bundler as a user operation, Nov 6). The leaf must still be "reserved",
 * so it never signed before; it signs once, and it is "submitted" (hash and deadline stored, durably) before the
 * signed transaction is shown to anyone, the node's dry run included. So a leaf still "reserved" after a crash was
 * never seen outside this process, and the follow-up (settleSubmitted) finds every transaction that may land.
 * The fees are the user's, exactly; grinding moves the last SENDER frame's limit, at most grind.maxTries gas.
 */
export async function signPrepared(p: SignPreparedParams): Promise<SignedPrepared> {
  const j = p.journal;
  const net = p.network ?? defaultNetwork;
  const chainId = net.chainId;
  const leaf = p.leaf;
  const fail = (msg: string, cause?: unknown): never => { throw new SendError(msg, { stage: "check", leaf, cause }); };

  // 0. Checks that change nothing. The leaf stays reserved and unsigned if one fails.
  const mismatch = journalMismatch(j, p.sender, chainId);
  if (mismatch) fail(mismatch);
  const rec = j.get(leaf);
  if (!rec || rec.status !== "reserved") fail(`leaf ${leaf} is ${rec ? rec.status : "not in the journal"}: only a leaf reserved and never signed may sign`);
  const nonceKey = nonceKeyFor(j.epoch, leaf);
  if (BigInt(rec!.nonceKey) !== nonceKey) fail(`internal: leaf ${leaf}'s journal key ${rec!.nonceKey} is not 0x${nonceKey.toString(16)}`);
  if (p.calls.length === 0) fail("a transaction needs at least one call");
  const expiry = p.expirySeconds ?? DEFAULTS.expirySeconds;
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 86_400) fail(`expirySeconds must be a whole number of seconds from 1 to 86,400, got ${expiry}`);
  const maxSteps = maxStepsFor({ ...p.grind, verifyGasLimit: p.verifyGas });
  if (maxSteps < WOTS.bestSteps) fail(`verify limit ${p.verifyGas} leaves room for ${maxSteps} chain steps; even the best message needs ${WOTS.bestSteps}`);
  if (p.fees.maxPriorityFeePerGas > p.fees.maxFeePerGas) fail(`maxPriorityFeePerGas ${p.fees.maxPriorityFeePerGas} is above maxFeePerGas ${p.fees.maxFeePerGas}`);
  let chainNow: number, seq: bigint;
  try {
    await checkSystemContracts(net);
    chainNow = Number(await net.node.blockTimestamp());
    seq = BigInt(await net.node.storage(NONCE_MANAGER, nonceManagerSlot(p.sender, nonceKey)));
  } catch (e) {
    return fail(`cannot start: ${message(e)}`, e);
  }
  const localNow = nowSeconds();
  if (Math.abs(localNow - chainNow) > DEFAULTS.maxClockSkewSeconds) {
    fail(`host clock ${localNow} and the latest block's timestamp ${chainNow} differ by more than ${DEFAULTS.maxClockSkewSeconds} s: the deadline would be wrong`);
  }
  if (seq !== 0n) {
    j.mark(leaf, "burned", { note: `key already at sequence ${seq} on chain, missing from this journal` });
    throw new SendError(`leaf ${leaf}: its nonce key is already used on chain; it was burned, send again`, { stage: "check", leaf, nonceKey });
  }
  const deadline = Math.max(localNow, chainNow) + expiry;
  const lastGas = p.calls.at(-1)!.gas ?? DEFAULTS.transferGas;
  let slots: SignatureSlot[], unsigned: FrameTransaction, ground: GrindInfo;
  try {
    slots = p.signatures(leaf);
    checkSlots(slots, leaf, j);
    const g = grind((i) => {
      const gas = lastGas + BigInt(i);
      return {
        value: gas,
        tx: buildFrameTx({
          chainId, sender: p.sender, nonce: { keys: [nonceKey], seq: 0n }, verifyGas: p.verifyGas,
          calls: p.calls.map((c, k) => (k === p.calls.length - 1 ? { ...c, gas } : c)),
          deadline, fees: p.fees, signatures: placeholders(slots),
        }),
      };
    }, { ...p.grind, verifyGasLimit: p.verifyGas });
    unsigned = g.tx;
    ground = { field: "lastFrameGas", steps: g.steps, maxSteps: g.maxSteps, tries: g.tries };
    await p.checkUnsigned?.(unsigned);
  } catch (e) {
    return fail(`leaf ${leaf} not signed: ${message(e)}`, e);
  }
  const at = (stage: SendStage, extra: Omit<SendErrorInfo, "stage" | "leaf" | "nonceKey"> = {}): SendErrorInfo => ({ stage, leaf, nonceKey, grind: ground, ...extra });
  if (j.durable) {
    try {
      await j.durable();
    } catch (e) {
      throw new SendError(`leaf ${leaf}: the journal could not store its writes; nothing was signed: ${message(e)}`, at("prepare", { cause: e }));
    }
  }

  // 1. Sign, once. From here on the leaf never signs again.
  let signed: { tx: FrameTransaction; sigHash: Hex };
  try {
    signed = await signFrameTx(unsigned, slots);
    p.checkSigned?.(signed.tx);
  } catch (e) {
    j.mark(leaf, "burned", { note: `signing failed, nothing left this process: ${message(e)}` });
    throw new SendError(`leaf ${leaf}: signing failed: ${message(e)}`, at("sign", { cause: e }));
  }
  const txHash = frameTxHash(signed.tx);

  // 2. Recorded, durably, before anyone sees it: from here on it may land, and settleSubmitted follows it.
  j.mark(leaf, "submitted", { txHash, deadline });
  if (j.durable) {
    try {
      await j.durable();
    } catch (e) {
      try { j.mark(leaf, "burned", { note: `its hash could not be stored, so it was never handed on: ${message(e)}` }); } catch { /* the journal is broken */ }
      throw new SendError(`leaf ${leaf}: the journal could not store the transaction's hash; nothing was handed on: ${message(e)}`, at("submit", { cause: e }));
    }
  }

  // 3. Optional dry run on the node, of exactly this transaction.
  let simulation: SimulationResult | null = null;
  if (p.preflight) {
    let verdict: { ok: boolean; reason: string | null };
    try {
      simulation = await net.node.simulate(signed.tx);
      if (!simulation || typeof simulation !== "object") throw new Error(`the node answered ${JSON.stringify(simulation)}, not a simulation`);
      verdict = simulationVerdict(simulation);
    } catch (e) {
      j.mark(leaf, "burned", { note: `preflight: ${message(e)}` });
      const refused = e instanceof RpcError && e.refused;
      throw new (refused ? PreflightRefused : SendError)(`leaf ${leaf}: preflight ${refused ? "refused" : "failed"}: ${message(e)}`, at("preflight", { txHash, deadline, cause: e }));
    }
    if (!verdict.ok) {
      j.mark(leaf, "burned", { note: `preflight: ${verdict.reason}` });
      throw new PreflightRefused(`leaf ${leaf}: preflight refused: ${verdict.reason}`, at("preflight", { txHash, deadline, simulation }));
    }
  }
  return { leaf, nonceKey, tx: signed.tx, raw: encodeRawFrameTx(signed.tx), txHash, sigHash: signed.sigHash, deadline, simulation, grind: ground };
}

/**
 * After a crash: follows every leaf the journal holds as "submitted" to its end, by its key and deadline, and
 * journals the outcome. Leaves without a deadline (written before Nov 6) are reported, not guessed. With timeoutMs 0
 * past the deadline it takes one look and reports "unknown" when the chain cannot decide yet (the backend's re-check).
 */
export async function settleSubmitted(journal: Journal, opts: Pick<FollowParams, "confirmations" | "pollMs" | "onStatus" | "receiptWaitMs" | "timeoutMs" | "network"> = {}) {
  const net = opts.network ?? defaultNetwork;
  // On another chain its keys would look unused and its lanes, which may have landed, would be called Expired.
  if (net.chainId !== journal.chainId) throw new Error(`journal ${journal.file} is for chain ${journal.chainId}, this pipeline follows chain ${net.chainId}`);
  await checkSystemContracts(net);
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
 * Waits until the mempool no longer holds a dead transaction: until then it still counts the transaction's value and
 * gas against the balance, and would refuse a retry that needs the same funds. The alt mempool's sidecar says
 * Cancelled or gone; the public pool was never seen by the sidecar, so there the node is asked until it answers null
 * (review, Nov 6). An error means "ask again".
 */
async function waitUntilDropped(txHash: Hex, maxMs: number, pollMs: number, mempool: "alt" | "public", net: Network): Promise<boolean> {
  const until = Date.now() + maxMs;
  for (;;) {
    const dropped = mempool === "public"
      ? await net.node.transactionByHash(txHash).then((t) => t === null, () => false)
      : await net.gateway.status(txHash).then((s) => s === null || s === "Cancelled", () => false);
    if (dropped) return true;
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
      const holder = p.mempool === "public" ? "the node" : "the sidecar";
      if (!(await waitUntilDropped(r.txHash, waitMs, p.pollMs ?? DEFAULTS.pollMs, p.mempool ?? "alt", p.network ?? defaultNetwork))) {
        throw new RetryStopped(
          `attempt ${i + 1} expired, but after ${waitMs / 1000} s ${holder} still holds it and counts it against the balance; ` +
            `no retry was sent and no leaf was used. Run again once ${holder} has dropped it.`,
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
