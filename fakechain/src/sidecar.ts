// The alt mempool, modelled on the workshop sidecar (skandha v4.1.1 fork, commit 2e22ff0a).
// Written with Claude Code (AI) for Vicky.
// Admission with the explorer's rule-by-rule report, one pending transaction per (sender, nonce key), fee-bump
// replacement, balance obligations, and the cron that relays up to four entries a pass and reconciles each new block.
import { getAddress, isAddress, numberToHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { frameTxNonceAndRootsViolation, type FrameTransaction } from "../../pipeline/src/codec/FrameTx.ts";
import { toWire } from "../../pipeline/src/rpc.ts";
import { CHAIN_ID, GAS_PRICE_QUOTE, SIDECAR } from "./constants.ts";
import { estimateEoaGas } from "./eoaTx.ts";
import { ProtocolRefusal, frameTxHash, runFrameTx, type RunResult } from "./frameTx.ts";
import { CODES, CheckCollector, EXPLORER_RULES as R, describeStructuredFailure, recognizeValidationPrefix, validateSignature, validateStructuralRules, type RuleCheck, type RuleId } from "./sidecarRules.ts";
import type { FakeChain, Candidate } from "./chain.ts";

export type EntryStatus = "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";
/** MempoolEntryStatus order: below OnChain is pending; above it no longer holds its slot. */
const RANK: Record<EntryStatus, number> = { New: 0, Pending: 1, Submitted: 2, OnChain: 3, Finalized: 4, Cancelled: 5, Reverted: 6 };

/** A JSON-RPC error the sidecar answers on purpose. */
export class SidecarError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export interface Entry {
  tx: FrameTransaction;
  hash: Hex;
  slot: string;
  status: EntryStatus;
  submittedTime: number;
  lastUpdatedTime: number;
  submitAttempts: number;
  maxCost: bigint;
  gasLimit: bigint;
  payer: Address;
  revertReason?: string;
  transaction?: Hex;
  relaySeq: number | null;
}

export interface AdmissionRecord {
  id: number;
  txHash: Hex;
  sender: Address;
  nonce: Hex;
  nonceKeys: Hex[];
  at: number;
  source: "rpc";
  outcome: "accepted" | "rejected" | "included" | "replaced" | "dropped";
  errorCode?: number;
  includer?: Address;
  checks: RuleCheck[];
  frames: ReturnType<typeof toWire>["frames"];
  frameStatuses: ("success" | "reverted" | "not-run")[];
}

export interface LifecycleEvent { seq: number; txHash: Hex; at: number; kind: string; status?: EntryStatus; reason?: string; blockNumber?: number }

const isKeyed = (tx: Pick<FrameTransaction, "nonceKeys">) => !(tx.nonceKeys.length === 1 && tx.nonceKeys[0] === 0n);
/** frameTxSlotKey: one slot per (sender, keys, seq); the same slot is a replacement. */
export const slotKey = (tx: FrameTransaction) =>
  isKeyed(tx) ? `${CHAIN_ID}:${tx.sender.toLowerCase()}:k[${tx.nonceKeys.map((k) => toHex(k)).join(",")}]:${tx.nonceSeq}` : `${CHAIN_ID}:${tx.sender.toLowerCase()}:${tx.nonceSeq}`;

function failed(c: CheckCollector, rule: RuleId, code: number, message: string, ctx: { frameIndex?: number; entity?: RuleCheck["entity"] } = {}) {
  c.fail(rule, message, ctx);
  return new SidecarError(code, message);
}

export class Sidecar {
  private readonly entries = new Map<string, Entry>(); // by slot
  private readonly byHash = new Map<string, Entry>();
  /** cancelled or replaced entries, checked each pass for a late inclusion */
  private readonly watch = new Map<string, Entry>();
  private readonly admissions = new Map<string, AdmissionRecord>();
  private readonly events: LifecycleEvent[] = [];
  private nextId = 1;
  private nextEventSeq = 1;
  private lastReconciled = 0n;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly faucetLast = new Map<string, number>();
  private faucetRecent: number[] = [];
  readonly bootId = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");

  constructor(private readonly chain: FakeChain, private readonly faucetKey: Hex) {
    chain.relayed = () => this.relayedCandidates();
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), this.chain.opts.bundleInterval * 1000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ---------------------------------------------------------------- eth_sendFrameTransaction
  send(wire: unknown): Hex {
    const tx = parseWireTx(wire);
    const statics = frameTxNonceAndRootsViolation(tx);
    if (statics) throw new SidecarError(CODES.INVALID_USEROP, statics); // refused by the API layer: no admission record
    const hash = frameTxHash(tx);
    const at = Date.now();
    const c = new CheckCollector();
    let statuses: AdmissionRecord["frameStatuses"] = tx.frames.map(() => "not-run");
    try {
      if (tx.chainId !== CHAIN_ID) throw failed(c, R.STRUCTURE, CODES.INVALID_USEROP, `frame transaction chain id ${tx.chainId} does not match this node's chain id ${CHAIN_ID}`);
      const total = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
      if (total > SIDECAR.userOpGasLimit) throw failed(c, R.GAS_LIMIT, CODES.INVALID_USEROP, "Frame transaction's gas limit is too high");
      c.pass(R.GAS_LIMIT);
      if (tx.recentRootReferences.length) throw failed(c, R.RECENT_ROOT, CODES.INVALID_USEROP, "fakechain does not model EIP-8272 recent-root references");
      c.pass(R.RECENT_ROOT);
      const run = this.simulateAndValidate(tx, c, (s) => { statuses = s; });
      let replaced: Entry | null;
      try {
        replaced = this.mempoolChecks(tx, hash, run);
      } catch (e) {
        if (e instanceof SidecarError) throw failed(c, R.MEMPOOL, e.code, e.message);
        throw e;
      }
      c.pass(R.MEMPOOL);
      const now = Date.now();
      const entry: Entry = {
        tx, hash, slot: slotKey(tx), status: "New", submittedTime: now, lastUpdatedTime: now, submitAttempts: 0,
        maxCost: run.maxCost, gasLimit: run.gasLimit, payer: getAddress(tx.sender), relaySeq: null,
      };
      if (replaced) {
        this.byHash.delete(replaced.hash);
        if (RANK[replaced.status] < RANK.OnChain) this.watch.set(replaced.hash, replaced);
      }
      this.entries.set(entry.slot, entry);
      this.byHash.set(hash, entry);
      this.watch.delete(hash);
      this.record(tx, hash, at, "accepted", c.toChecks(), statuses);
      this.event(hash, "admitted", { status: "New" });
      if (replaced) {
        const old = this.admissions.get(replaced.hash);
        if (old && old.outcome !== "included") old.outcome = "replaced";
        this.event(replaced.hash, "replaced", { reason: `replaced by ${hash}` });
      }
      return hash;
    } catch (e) {
      if (e instanceof SidecarError) {
        const existing = this.admissions.get(hash);
        if (!existing || existing.outcome === "rejected") {
          this.record(tx, hash, at, "rejected", c.toChecks(), statuses, e.code);
          this.event(hash, "rejected", { reason: e.message });
        }
      }
      throw e;
    }
  }

  /** The node's simulation, then the sidecar's own validate(): prefix, structure, signatures, simulation, entity rules. */
  private simulateAndValidate(tx: FrameTransaction, c: CheckCollector, onFrames: (s: AdmissionRecord["frameStatuses"]) => void = () => {}): RunResult {
    let run: RunResult;
    try {
      run = runFrameTx(tx, this.chain.latest(), this.chain.latestCtx(), this.chain.modelOpts());
    } catch (e) {
      if (e instanceof ProtocolRefusal) throw failed(c, R.SIMULATION, CODES.VALIDATION_FAILED, e.message); // ethrex answered with an error
      throw e;
    }
    if (run.frames) onFrames(run.frames.map((f) => (f.status === "success" ? "success" : "reverted")));
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    if (!prefix) throw failed(c, R.PREFIX, CODES.INVALID_OPCODE, "frame transaction validation prefix not recognized");
    c.pass(R.PREFIX);
    const structural = validateStructuralRules(tx, prefix);
    if (!structural.valid) throw failed(c, R.STRUCTURE, CODES.INVALID_USEROP, structural.reason);
    c.pass(R.STRUCTURE);
    for (const sig of tx.signatures) {
      if (!validateSignature(sig, tx.sender, run.sigHash)) throw failed(c, R.SIGNATURE, CODES.INVALID_SIGNATURE, "Invalid frame transaction signature");
    }
    c.pass(R.SIGNATURE);
    if (run.shapeError) throw failed(c, R.SIMULATION, CODES.VALIDATION_FAILED, run.shapeError);
    if (run.prefixFailure) throw failed(c, R.SIMULATION, CODES.VALIDATION_FAILED, describeStructuredFailure(run.prefixFailure));
    c.pass(R.SIMULATION);
    c.pass(R.TRACE_ALIGNMENT);
    c.pass(R.NESTED_CALL_VALUE);
    c.pass(R.EXECUTION); // ethrex reports no executionError for a body frame that reverts
    for (const f of prefix.frames) {
      const ctx = { frameIndex: f.frameIndex, entity: f.role };
      for (const rule of [R.TRACE_ALIGNMENT, R.OUT_OF_GAS, R.BANNED_OPCODE, R.CREATE, R.STORAGE, R.CODE_ACCESS, R.ENTRYPOINT_ACCESS]) c.pass(rule, ctx);
    }
    return run;
  }

  /** Key conflicts, replacement, then the balance obligations of every pending transaction. Returns the entry replaced. */
  private mempoolChecks(tx: FrameTransaction, hash: Hex, run: RunResult): Entry | null {
    const slot = slotKey(tx);
    const pending = this.pending();
    if (isKeyed(tx)) {
      for (const p of pending) {
        if (p.tx.sender.toLowerCase() !== tx.sender.toLowerCase() || !isKeyed(p.tx) || p.slot === slot) continue;
        const shared = p.tx.nonceKeys.find((k) => tx.nonceKeys.includes(k));
        if (shared !== undefined) throw new SidecarError(CODES.INVALID_USEROP, `Frame transaction nonce key ${toHex(shared)} is already held by pending transaction ${p.hash}`);
      }
    }
    const existing = this.entries.get(slot) ?? null;
    if (existing) {
      if (RANK[existing.status] <= RANK.OnChain && existing.hash === hash) throw new SidecarError(CODES.INVALID_USEROP, "Frame transaction already known");
      const ttlPassed = Date.now() - existing.lastUpdatedTime > SIDECAR.replaceTtlSeconds * 1000;
      const bumped = tx.fees.maxPriorityFeePerGas >= (existing.tx.fees.maxPriorityFeePerGas * 11n) / 10n && tx.fees.maxFeePerGas >= (existing.tx.fees.maxFeePerGas * 11n) / 10n;
      if (!(RANK[existing.status] > RANK.OnChain || ttlPassed || bumped)) throw new SidecarError(CODES.INVALID_USEROP, "Frame transaction cannot be replaced: fee too low");
    }
    const owedBy = (txs: { tx: FrameTransaction; maxCost: bigint }[]) => {
      const m = new Map<string, bigint>();
      const owe = (a: string, n: bigint) => { if (n > 0n) m.set(getAddress(a), (m.get(getAddress(a)) ?? 0n) + n); };
      for (const t of txs) { owe(t.tx.sender, t.maxCost); owe(t.tx.sender, t.tx.frames.reduce((s, f) => s + f.value, 0n)); }
      return m;
    };
    const totals = owedBy(pending.filter((p) => p.slot !== existing?.slot));
    for (const [address, amount] of owedBy([{ tx, maxCost: run.maxCost }])) {
      const owed = (totals.get(address) ?? 0n) + amount;
      const balance = this.chain.latest().balance(address);
      if (owed > balance) {
        throw new SidecarError(CODES.INVALID_USEROP, `${address} cannot cover its pending frame transactions: they would owe ${owed} wei (${amount} for this one), its balance is ${balance} wei`);
      }
    }
    return existing;
  }

  private pending(): Entry[] { return [...this.entries.values()].filter((e) => RANK[e.status] < RANK.OnChain); }

  // ---------------------------------------------------------------- the cron
  /** One bundler pass: reconcile once per new block, then relay. */
  tick() {
    const head = this.chain.head.number;
    if (head > this.lastReconciled) {
      this.lastReconciled = head;
      this.reconcile(head);
    }
    this.relay();
  }

  private relay() {
    const pick = () => [...this.entries.values()].filter((e) => e.status === "New")
      .sort((a, b) => Number(b.tx.fees.maxPriorityFeePerGas - a.tx.fees.maxPriorityFeePerGas)).slice(0, SIDECAR.bundleSize);
    let picked = pick();
    const tooMany = picked.filter((e) => e.submitAttempts > SIDECAR.maxSubmitAttempts);
    for (const e of tooMany) this.cancel(e, `relayed ${e.submitAttempts} times without being included in a block`);
    if (tooMany.length) picked = pick();
    for (const e of picked) {
      // enforceGasPrice: a transaction priced below the quote is not relayed; it stays New until it can no longer land
      if (this.chain.opts.enforceGasPrice && (e.tx.fees.maxFeePerGas < GAS_PRICE_QUOTE.maxFeePerGas || e.tx.fees.maxPriorityFeePerGas < GAS_PRICE_QUOTE.maxPriorityFeePerGas)) continue;
      e.submitAttempts++;
      e.relaySeq = this.chain.nextSeq();
      e.transaction = e.hash;
      this.chain.noteRelayed(e.hash, e.tx, e.gasLimit);
      this.setStatus(e, "Submitted");
    }
  }

  private relayedCandidates(): Candidate[] {
    return [...this.entries.values()].filter((e) => e.status === "Submitted" && e.relaySeq !== null)
      .map((e) => ({ kind: "frame" as const, seq: e.relaySeq!, tx: e.tx, hash: e.hash, via: "alt" as const }));
  }

  private reconcile(head: bigint) {
    for (const e of this.pending()) {
      const r = this.chain.receipt(e.hash);
      if (r) this.landed(e, r);
      else if (e.status === "Submitted") this.setStatus(e, "New"); // the relay missed its block: requeue
    }
    for (const e of [...this.entries.values()].filter((x) => x.status === "New")) {
      const reason = this.revalidate(e.tx);
      if (reason) this.cancel(e, `revalidation failed as of block ${head}: ${reason}`);
    }
    this.enforceBalances(head);
    for (const e of [...this.watch.values()]) {
      const r = this.chain.receipt(e.hash);
      if (!r) continue;
      this.watch.delete(e.hash);
      if (this.entries.get(e.slot)?.hash === e.hash) this.landed(e, r); // still in its own slot (cancelled, not replaced)
      else this.markIncluded(e.hash, r);
    }
  }

  /** The reason an entry could no longer be admitted on the latest state, or null. */
  private revalidate(tx: FrameTransaction): string | null {
    try {
      this.simulateAndValidate(tx, new CheckCollector());
      return null;
    } catch (e) {
      if (e instanceof SidecarError) return e.message;
      throw e;
    }
  }

  private enforceBalances(head: bigint) {
    const pending = this.pending();
    const owed = new Map<string, bigint>();
    const obligations = (e: Entry) => {
      const m = new Map<string, bigint>();
      const add = (a: string, n: bigint) => { if (n > 0n) m.set(getAddress(a), (m.get(getAddress(a)) ?? 0n) + n); };
      add(e.payer, e.maxCost);
      add(e.tx.sender, e.tx.frames.reduce((s, f) => s + f.value, 0n));
      return m;
    };
    for (const e of pending) for (const [a, n] of obligations(e)) owed.set(a, (owed.get(a) ?? 0n) + n);
    for (const [address, total] of owed) {
      const balance = this.chain.latest().balance(address);
      let left = total;
      if (left <= balance) continue;
      const evictable = pending.filter((e) => e.status === "New" && obligations(e).has(address)).sort((a, b) => b.submittedTime - a.submittedTime);
      for (const e of evictable) {
        if (left <= balance) break;
        left -= obligations(e).get(address)!;
        this.cancel(e, `${address} can no longer cover its pending frame transactions as of block ${head}: balance ${balance} wei`);
      }
    }
  }

  private landed(e: Entry, receipt: Record<string, unknown>) {
    const ok = receipt.status === "0x1";
    e.transaction = e.hash;
    if (ok) this.setStatus(e, "OnChain");
    else {
      const failedFrames = (receipt.frameReceipts as { status: string }[]).flatMap((f, i) => (f.status === "0x1" ? [] : [`${i} (${f.status === "0x2" ? "skipped" : "reverted"})`]));
      e.revertReason = failedFrames.length ? `frame(s) ${failedFrames.join(", ")} did not succeed` : "transaction reverted (no individual frame reported non-success)";
      this.setStatus(e, "Reverted");
    }
    this.markIncluded(e.hash, receipt);
  }

  private markIncluded(hash: Hex, receipt: Record<string, unknown>) {
    const a = this.admissions.get(hash);
    if (a) { a.outcome = "included"; a.includer = this.chain.head.miner; }
    this.event(hash, "included", { status: receipt.status === "0x1" ? "OnChain" : "Reverted", blockNumber: Number(BigInt(receipt.blockNumber as Hex)) });
  }

  private cancel(e: Entry, reason: string) {
    e.revertReason = reason;
    this.setStatus(e, "Cancelled", false);
    this.watch.set(e.hash, e);
    const a = this.admissions.get(e.hash);
    if (a && a.outcome !== "included") a.outcome = "dropped";
    this.event(e.hash, "dropped", { status: "Cancelled", reason });
  }

  private setStatus(e: Entry, status: EntryStatus, log = true) {
    if (e.status === status) return;
    e.status = status;
    e.lastUpdatedTime = Date.now();
    if (log) this.event(e.hash, "statusChanged", { status });
  }

  private record(tx: FrameTransaction, hash: Hex, at: number, outcome: AdmissionRecord["outcome"], checks: RuleCheck[], frameStatuses: AdmissionRecord["frameStatuses"], errorCode?: number) {
    const old = this.admissions.get(hash);
    const w = toWire(tx);
    this.admissions.set(hash, {
      id: old?.id ?? this.nextId++, txHash: hash, sender: getAddress(tx.sender), nonce: numberToHex(tx.nonceSeq), nonceKeys: tx.nonceKeys.map((k) => numberToHex(k)),
      at: old?.at ?? at, source: "rpc", outcome, ...(errorCode !== undefined ? { errorCode } : {}), checks, frames: w.frames, frameStatuses,
    });
  }

  private event(txHash: Hex, kind: string, extra: Omit<LifecycleEvent, "seq" | "txHash" | "at" | "kind"> = {}) {
    this.events.push({ seq: this.nextEventSeq++, txHash, at: Date.now(), kind, ...extra });
    if (this.events.length > 10_000) this.events.shift();
  }

  // ---------------------------------------------------------------- reads
  /** skandha_frameTransactionStatus */
  status(hash: unknown) {
    const e = typeof hash === "string" ? this.byHash.get(hash.toLowerCase()) : undefined;
    if (!e) throw new SidecarError(CODES.INVALID_REQUEST, "Frame transaction not found");
    return { tx: toWire(e.tx), sender: getAddress(e.tx.sender), payer: e.payer, status: e.status, ...(e.revertReason ? { reason: e.revertReason } : {}), ...(e.transaction ? { transaction: e.transaction } : {}) };
  }

  /** eth_getFrameTransactionByHash: the mempool entry, or null. */
  entry(hash: unknown) {
    const e = typeof hash === "string" ? this.byHash.get(hash.toLowerCase()) : undefined;
    return e ? { ...this.summary(e), tx: toWire(e.tx) } : null;
  }

  /** eth_getFrameTransactionReceipt: the node's receipt in the sidecar's shape; an error until it is in a block. */
  receipt(hash: unknown) {
    if (typeof hash !== "string") throw new SidecarError(CODES.INVALID_REQUEST, "Expected a transaction hash");
    const r = this.chain.receipt(hash);
    if (!r) throw new SidecarError(CODES.SERVER_ERROR, `transaction receipt not found for ${hash}`);
    if (!r.payer) throw new SidecarError(CODES.SERVER_ERROR, `transaction ${hash} is not a frame transaction (its receipt has no payer/frameReceipts)`);
    const word = (s: string) => (s === "0x1" ? "success" : s === "0x2" ? "skipped" : "reverted");
    return {
      cumulativeGasUsed: r.cumulativeGasUsed, payer: r.payer, blockNumber: r.blockNumber, status: r.status === "0x1" ? "success" : "reverted",
      frameReceipts: (r.frameReceipts as { status: string; gasUsed: Hex; stateGasUsed: Hex; logs: unknown[] }[]).map((f) => ({
        status: word(f.status), gasUsed: { execution: f.gasUsed, state: f.stateGasUsed }, logs: f.logs,
      })),
    };
  }

  /** eth_estimateFrameTransactionGas: every frame after the prefix gets 10,000,000 / 10,000,000; gas used per frame. */
  estimate(wire: unknown) {
    const w = (wire ?? {}) as Record<string, unknown>;
    if (!w.sender) throw new SidecarError(CODES.INVALID_REQUEST, "Frame transaction requires a sender");
    if (!Array.isArray(w.frames) || w.frames.length === 0) throw new SidecarError(CODES.INVALID_REQUEST, "Frame transaction requires at least one frame");
    // The sidecar's defaults (toPartialFrameTransaction): the nonce [0]/0 only when no nonce field was sent, so the legacy
    // shorthand `nonce` alone means [0]/nonce, as it does for eth_sendFrameTransaction.
    const noNonce = w.nonce === undefined && w.nonceKeys === undefined && w.nonceSeq === undefined;
    const tx = parseWireTx({
      chainId: numberToHex(CHAIN_ID), ...(noNonce ? { nonceKeys: ["0x0"], nonceSeq: "0x0" } : {}), signatures: [], blobVersionedHashes: [], recentRootReferences: [],
      fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x1", maxFeePerBlobGas: "0x0" }, ...w,
    });
    const statics = frameTxNonceAndRootsViolation(tx);
    if (statics) throw new SidecarError(CODES.INVALID_USEROP, statics);
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    const last = prefix ? Math.max(...prefix.frames.map((f) => f.frameIndex)) : -1;
    const est: FrameTransaction = {
      ...tx,
      frames: tx.frames.map((f, i) => (i <= last ? f : { ...f, limits: { execution: SIDECAR.estimateBodyLimit, state: SIDECAR.estimateBodyLimit } })),
    };
    const run = this.simulateAndValidate(est, new CheckCollector());
    return {
      frames: run.frames!.map((f) => ({ execution: numberToHex(f.gas), state: "0x0" })), // the simulation breaks out no state gas
      cumulativeGasUsed: numberToHex(run.gasUsed!),
      maxFeePerGas: numberToHex(GAS_PRICE_QUOTE.maxFeePerGas),
      maxPriorityFeePerGas: numberToHex(GAS_PRICE_QUOTE.maxPriorityFeePerGas),
    };
  }

  gasPrice() {
    return { maxFeePerGas: numberToHex(GAS_PRICE_QUOTE.maxFeePerGas), maxPriorityFeePerGas: numberToHex(GAS_PRICE_QUOTE.maxPriorityFeePerGas) };
  }

  /** skandha_explorer_faucet: 1 ETH from the faucet account, once per address per hour, 100 an hour in all. */
  async faucet(to: unknown): Promise<{ txHash: Hex; amount: string }> {
    if (typeof to !== "string" || !isAddress(to, { strict: false })) throw new SidecarError(CODES.INVALID_REQUEST, "Expected an address");
    const now = Date.now();
    const last = this.faucetLast.get(to.toLowerCase());
    if (last !== undefined && now - last < SIDECAR.faucetCooldownMs) {
      throw new SidecarError(CODES.INVALID_REQUEST, `This address already received funds: try again in ${Math.ceil((SIDECAR.faucetCooldownMs - (now - last)) / 60_000)} min`);
    }
    this.faucetRecent = this.faucetRecent.filter((t) => now - t < SIDECAR.faucetCooldownMs);
    if (this.faucetRecent.length >= SIDECAR.faucetGlobalLimit) throw new SidecarError(CODES.INVALID_REQUEST, "The faucet is rate limited right now: try again later");
    const faucet = privateKeyToAccount(this.faucetKey);
    if (this.chain.latest().balance(faucet.address) < SIDECAR.faucetAmount) throw new SidecarError(CODES.INVALID_REQUEST, "The faucet is empty");
    // The real faucet leaves the gas to viem, which asks the node (eth_estimateGas): an address with code, the account's
    // proxy included, gets the gas its code needs. When the transfer would fail at any gas, viem's estimate throws and the
    // sidecar answers its generic "Internal error" (toErrorResponse): nothing is sent and no drip is counted. The estimate
    // runs the transfer as it will be included, so a success answered here is a payment that arrives.
    const est = estimateEoaGas(this.chain.latest(), this.chain.latestCtx(), this.chain.modelOpts(), { from: faucet.address, to: getAddress(to), value: SIDECAR.faucetAmount, data: "0x" });
    if ("reason" in est) throw new SidecarError(-32603, "Internal error", { fakechain: `the faucet's 1 ETH to ${getAddress(to)} would fail (${est.reason}); the real sidecar answers only "Internal error"` });
    const raw = await faucet.signTransaction({
      chainId: Number(CHAIN_ID), nonce: Number(this.chain.pendingNonce(faucet.address)), to: getAddress(to), value: SIDECAR.faucetAmount,
      gas: est.gas, maxFeePerGas: GAS_PRICE_QUOTE.maxFeePerGas, maxPriorityFeePerGas: GAS_PRICE_QUOTE.maxPriorityFeePerGas,
    });
    const txHash = this.chain.submitEoa(raw);
    this.faucetLast.set(to.toLowerCase(), now);
    this.faucetRecent.push(now);
    return { txHash, amount: SIDECAR.faucetAmount.toString() };
  }

  /** skandha_explorer_getTransaction */
  explorerTransaction(hash: unknown) {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SidecarError(CODES.INVALID_REQUEST, "Expected a 32-byte hex transaction hash");
    const h = hash.toLowerCase();
    const e = this.byHash.get(h) ?? this.watch.get(h) ?? null;
    const admission = this.admissions.get(h) ?? null;
    const events = this.events.filter((x) => x.txHash === h);
    if (!e && !admission && events.length === 0) throw new SidecarError(CODES.INVALID_REQUEST, "Frame transaction not found");
    return {
      hash: h,
      entry: e && this.byHash.get(h) ? { ...this.summary(e), tx: toWire(e.tx), ...(e.revertReason ? { revertReason: e.revertReason } : {}), ...(e.transaction ? { transaction: e.transaction } : {}) } : null,
      admission, events,
    };
  }

  explorerAdmissions(params: { outcome?: string; limit?: number } = {}) {
    const items = [...this.admissions.values()].filter((a) => !params.outcome || a.outcome === params.outcome).sort((a, b) => b.id - a.id);
    return { items: items.slice(0, clampLimit(params.limit)) };
  }
  explorerTransactions(params: { status?: string; limit?: number } = {}) {
    const items = [...this.entries.values()].filter((e) => !params.status || e.status === params.status).sort((a, b) => b.submittedTime - a.submittedTime);
    return { items: items.slice(0, clampLimit(params.limit)).map((e) => this.summary(e)) };
  }
  explorerInfo() {
    return {
      protocolVersion: 1, chainId: Number(CHAIN_ID), version: "fakechain-0.1.0", commit: "fake", bundlingMode: "auto", p2pEnabled: false,
      latestSeq: this.events.at(-1)?.seq ?? 0, oldestSeq: this.events[0]?.seq ?? 0, historyCapacity: 10_000, bootId: this.bootId, faucetEnabled: true,
      fake: "fakechain: a local fake devnet, not the workshop sidecar",
    };
  }

  private summary(e: Entry) {
    return {
      txHash: e.hash, sender: getAddress(e.tx.sender), payer: e.payer, nonce: numberToHex(e.tx.nonceSeq), nonceKeys: e.tx.nonceKeys.map((k) => numberToHex(k)),
      status: e.status, frames: e.tx.frames.length, maxFeePerGas: numberToHex(e.tx.fees.maxFeePerGas), submittedTime: e.submittedTime, lastUpdatedTime: e.lastUpdatedTime, source: "rpc",
    };
  }
}

const clampLimit = (l: unknown) => { const n = Math.floor(Number(l)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 200) : 50; };

// ------------------------------------------------------------------ the wire shape (toWire in pipeline/src/rpc.ts)
const bad = (field: string) => new SidecarError(CODES.INVALID_USEROP, `invalid params: ${field}`);
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const qty = (v: unknown, field: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (!isHex(v) || v === "0x") throw bad(field);
  return BigInt(v);
};
const bytes = (v: unknown, field: string): Hex => { if (!isHex(v) || v.length % 2) throw bad(field); return v.toLowerCase() as Hex; };
const address = (v: unknown, field: string): Hex => { if (!isHex(v) || v.length !== 42) throw bad(field); return v as Hex; };

/** eth_sendFrameTransaction's JSON (every quantity a hex string) back into a FrameTransaction, checking each field. */
export function parseWireTx(wire: unknown): FrameTransaction {
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) throw bad("the transaction must be an object");
  const w = wire as Record<string, unknown>;
  const keyed = w.nonceKeys !== undefined || w.nonceSeq !== undefined;
  if (w.nonce !== undefined && keyed) throw new SidecarError(CODES.INVALID_USEROP, "send either nonce or nonceKeys/nonceSeq, not both");
  if (keyed && (w.nonceKeys === undefined || w.nonceSeq === undefined)) throw new SidecarError(CODES.INVALID_USEROP, "nonceKeys and nonceSeq must be sent together");
  const nonceKeys = w.nonce !== undefined ? [0n] : Array.isArray(w.nonceKeys) ? w.nonceKeys.map((k, i) => qty(k, `nonceKeys[${i}]`)) : (() => { throw bad("nonceKeys"); })();
  const nonceSeq = w.nonce !== undefined ? qty(w.nonce, "nonce") : qty(w.nonceSeq, "nonceSeq");
  if (!Array.isArray(w.frames)) throw bad("frames");
  if (!Array.isArray(w.signatures)) throw bad("signatures");
  const fees = (w.fees ?? {}) as Record<string, unknown>;
  const list = (v: unknown, field: string) => { if (v === undefined) return []; if (!Array.isArray(v)) throw bad(field); return v; };
  return {
    chainId: qty(w.chainId, "chainId"),
    nonceKeys,
    nonceSeq,
    sender: address(w.sender, "sender"),
    frames: w.frames.map((f: any, i: number) => {
      if (!f || typeof f !== "object") throw bad(`frames[${i}]`);
      return {
        mode: Number(qty(f.mode, `frames[${i}].mode`)) as 0 | 1 | 2,
        flags: Number(qty(f.flags, `frames[${i}].flags`)),
        target: f.target === null || f.target === undefined ? null : address(f.target, `frames[${i}].target`),
        limits: { execution: qty(f.limits?.execution, `frames[${i}].limits.execution`), state: qty(f.limits?.state, `frames[${i}].limits.state`) },
        value: qty(f.value, `frames[${i}].value`),
        data: bytes(f.data, `frames[${i}].data`),
      };
    }),
    signatures: w.signatures.map((s: any, i: number) => {
      if (!s || typeof s !== "object") throw bad(`signatures[${i}]`);
      return { scheme: Number(qty(s.scheme, `signatures[${i}].scheme`)) as 0 | 1 | 2, signer: bytes(s.signer, `signatures[${i}].signer`), msg: bytes(s.msg, `signatures[${i}].msg`), signature: bytes(s.signature, `signatures[${i}].signature`) };
    }),
    fees: { maxPriorityFeePerGas: qty(fees.maxPriorityFeePerGas, "fees.maxPriorityFeePerGas"), maxFeePerGas: qty(fees.maxFeePerGas, "fees.maxFeePerGas"), maxFeePerBlobGas: qty(fees.maxFeePerBlobGas ?? "0x0", "fees.maxFeePerBlobGas") },
    blobVersionedHashes: list(w.blobVersionedHashes, "blobVersionedHashes").map((h, i) => bytes(h, `blobVersionedHashes[${i}]`)),
    recentRootReferences: list(w.recentRootReferences, "recentRootReferences").map((r: any, i) => ({ sourceId: bytes(r?.sourceId, `recentRootReferences[${i}].sourceId`), slot: qty(r?.slot, `recentRootReferences[${i}].slot`), root: bytes(r?.root, `recentRootReferences[${i}].root`) })),
  };
}
