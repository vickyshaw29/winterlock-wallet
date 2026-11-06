// The fake chain itself: genesis, blocks on a timer, per-block state, the node's public pool, transactions and receipts.
// Written with Claude Code (AI) for Vicky.
// A random genesis per start; each block is stamped with the host clock; the state of the last 130 blocks is kept.
import "./guard.ts";
import { concat, getAddress, keccak256, numberToHex, pad, toHex, type Address, type Hex } from "viem";
import type { FrameTransaction } from "../../pipeline/src/codec/FrameTx.ts";
import { BLOCK_GAS_LIMIT, CHAIN_ID, COINBASE, STATE_WINDOW, type FakeChainOptions } from "./constants.ts";
import { applyEoaTx, checkEoaAdmission, parseEoaTx, type EoaTx } from "./eoaTx.ts";
import { ProtocolRefusal, decodeRawFrameTx, frameTxHash, runFrameTx, type BlockCtx, type RunResult } from "./frameTx.ts";
import type { Log } from "./factoryModel.ts";
import { WorldState } from "./state.ts";

export interface Block {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  baseFee: bigint;
  miner: Address;
  gasUsed: bigint;
  txHashes: Hex[];
  /** the state after this block; null once it is older than the state window */
  state: WorldState | null;
}

export interface Inclusion { blockNumber: bigint; blockHash: Hex; index: number }
export type TxRecord =
  | { kind: "eoa"; hash: Hex; tx: EoaTx; inclusion: Inclusion | null }
  | { kind: "frame"; hash: Hex; tx: FrameTransaction; via: "alt" | "public"; inclusion: Inclusion | null; gasLimit: bigint; effectivePrice: bigint | null };

/** A block candidate, ordered by `seq`: when it reached the public pool, or when the sidecar relayed it. */
export type Candidate =
  | { kind: "eoa"; seq: number; tx: EoaTx }
  | { kind: "frame"; seq: number; tx: FrameTransaction; hash: Hex; via: "alt" | "public" };

/** A read at a block whose state is no longer kept. The devnet node would silently answer with the latest state. */
export class StateUnavailable extends Error {}

const ZERO_BLOOM = `0x${"00".repeat(256)}` as Hex;
const q = (n: bigint | number) => numberToHex(n);

export class FakeChain {
  readonly chainId = CHAIN_ID;
  readonly genesisHash: Hex;
  readonly blocks: Block[] = [];
  private readonly txs = new Map<string, TxRecord>();
  private readonly receipts = new Map<string, Record<string, unknown>>();
  private publicEoa: { seq: number; tx: EoaTx }[] = [];
  private publicFrames: { seq: number; tx: FrameTransaction; hash: Hex }[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  paused = false;
  /** the alt mempool's relayed entries: set by the sidecar */
  relayed: () => Candidate[] = () => [];
  /** called after each block, e.g. to log it */
  onBlock: (b: Block) => void = () => {};

  constructor(readonly opts: FakeChainOptions, genesis: WorldState) {
    this.genesisHash = toHex(crypto.getRandomValues(new Uint8Array(32))); // a new world every start
    this.blocks.push({
      number: 0n, hash: this.genesisHash, parentHash: `0x${"00".repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)),
      baseFee: opts.baseFee, miner: COINBASE, gasUsed: 0n, txHashes: [], state: genesis,
    });
  }

  get head(): Block { return this.blocks.at(-1)!; }
  latest(): WorldState { return this.head.state!; }
  nextSeq(): number { return ++this.seq; }
  modelOpts() { return { proxyHoldback: this.opts.proxyHoldback }; }
  /** Simulations run in the latest block's context, as ethrex_simulateFrameTransaction does at "latest". */
  latestCtx(): BlockCtx { const h = this.head; return { number: h.number, timestamp: h.timestamp, baseFee: h.baseFee, coinbase: h.miner, chainId: this.chainId }; }

  /** A block tag or number: latest, pending, safe, finalized, earliest, or a quantity. Null when there is no such block. */
  blockByTag(tag: unknown): Block | null {
    if (tag === undefined || tag === null || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return this.head;
    if (tag === "earliest") return this.blocks[0]!;
    if (typeof tag === "object" && tag !== null && "blockNumber" in tag) return this.blockByTag((tag as { blockNumber: unknown }).blockNumber);
    if (typeof tag !== "string" || !/^0x[0-9a-fA-F]+$/.test(tag)) throw new ProtocolRefusal(-32602, `invalid block tag ${JSON.stringify(tag)}`);
    const n = BigInt(tag);
    return n <= this.head.number ? this.blocks[Number(n)]! : null;
  }
  blockByHash(hash: string): Block | null { return this.blocks.find((b) => b.hash === hash.toLowerCase()) ?? null; }

  /** The state after a block. Old blocks answer an error, never the latest state in disguise. */
  stateAt(tag: unknown): WorldState {
    const b = this.blockByTag(tag);
    if (!b) throw new StateUnavailable(`block ${String(tag)} is beyond the head ${this.head.number}`);
    if (!b.state) {
      throw new StateUnavailable(`fakechain keeps state for the last ${STATE_WINDOW + 2} blocks only; block ${b.number} is older than that ` +
        "(the devnet's node would silently answer with the latest state here)");
    }
    return b.state;
  }

  // ---------------------------------------------------------------- the public pool (eth_sendRawTransaction)
  pendingNonce(a: Address): bigint {
    let n = this.latest().nonce(a);
    for (const p of this.publicEoa) if (p.tx.from.toLowerCase() === a.toLowerCase() && p.tx.nonce === n) n++;
    return n;
  }
  submitEoa(raw: Hex): Hex {
    const tx = parseEoaTx(raw);
    if (this.txs.has(tx.hash)) throw new ProtocolRefusal(-32000, "already known");
    const pooled = this.publicEoa.find((p) => p.tx.from.toLowerCase() === tx.from.toLowerCase() && p.tx.nonce === tx.nonce)?.tx ?? null;
    checkEoaAdmission(tx, this.latest(), this.pendingNonce(tx.from), this.head.baseFee, pooled);
    if (pooled) { // a fee-bumped replacement takes the pooled transaction's place, as ethrex removes the old one
      this.publicEoa = this.publicEoa.filter((p) => p.tx.hash !== pooled.hash);
      this.txs.delete(pooled.hash);
    }
    this.publicEoa.push({ seq: this.nextSeq(), tx });
    this.txs.set(tx.hash, { kind: "eoa", hash: tx.hash, tx, inclusion: null });
    return tx.hash;
  }
  /**
   * A frame transaction into the public pool: the node's own checks (the canonical rules) and, modelled on the spec's
   * assumption, at most --public-per-sender pending frame transactions per sender (ethrex's docs say it may admit more).
   */
  submitPublicFrame(raw: Hex): Hex {
    const tx = decodeRawFrameTx(raw);
    const hash = frameTxHash(tx);
    if (this.txs.has(hash)) throw new ProtocolRefusal(-32000, "already known");
    const run = runFrameTx(tx, this.latest(), this.latestCtx(), this.modelOpts());
    const refusal = publicRefusal(run);
    if (refusal) throw new ProtocolRefusal(-32000, `frame transaction refused by the public mempool: ${refusal}`);
    const mine = this.publicFrames.filter((p) => p.tx.sender.toLowerCase() === tx.sender.toLowerCase()).length;
    if (mine >= this.opts.publicPerSender) {
      throw new ProtocolRefusal(-32000, `public mempool (modelled): sender ${getAddress(tx.sender)} already has ${mine} pending frame transaction(s), ` +
        `the limit is ${this.opts.publicPerSender} per sender`);
    }
    this.publicFrames.push({ seq: this.nextSeq(), tx, hash });
    this.txs.set(hash, { kind: "frame", hash, tx, via: "public", inclusion: null, gasLimit: run.gasLimit, effectivePrice: null });
    return hash;
  }
  publicPending(): { eoa: number; frames: number } { return { eoa: this.publicEoa.length, frames: this.publicFrames.length }; }

  // ---------------------------------------------------------------- lookups
  tx(hash: string): TxRecord | null { return this.txs.get(hash.toLowerCase()) ?? null; }
  receipt(hash: string): Record<string, unknown> | null { return this.receipts.get(hash.toLowerCase()) ?? null; }
  /** Registers a relayed sidecar entry so eth_getTransactionByHash knows it once it is in a block. */
  noteRelayed(hash: Hex, tx: FrameTransaction, gasLimit: bigint) {
    if (!this.txs.has(hash)) this.txs.set(hash, { kind: "frame", hash, tx, via: "alt", inclusion: null, gasLimit, effectivePrice: null });
  }

  // ---------------------------------------------------------------- blocks
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { if (!this.paused) this.produceBlock(); }, this.opts.blockTime * 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One block: every candidate that is valid now, in arrival order, applied to a copy of the latest state. */
  produceBlock(): Block {
    const parent = this.head;
    const timestamp = BigInt(Math.floor(Date.now() / 1000)) > parent.timestamp ? BigInt(Math.floor(Date.now() / 1000)) : parent.timestamp + 1n;
    const ctx: BlockCtx = { number: parent.number + 1n, timestamp, baseFee: this.opts.baseFee, coinbase: COINBASE, chainId: this.chainId };
    let state = parent.state!.clone();
    const candidates: Candidate[] = [
      ...this.publicEoa.map((p) => ({ kind: "eoa" as const, seq: p.seq, tx: p.tx })),
      ...this.publicFrames.map((p) => ({ kind: "frame" as const, seq: p.seq, tx: p.tx, hash: p.hash, via: "public" as const })),
      ...this.relayed(),
    ].sort((a, b) => a.seq - b.seq);
    const done: { hash: Hex; build: (inc: Inclusion, cumulative: bigint) => Record<string, unknown>; gasUsed: bigint }[] = [];
    const leaving = new Set<string>(); // public-pool entries that are included or can never be
    let blockGas = 0n;
    for (const c of candidates) {
      if (c.kind === "eoa") {
        if (blockGas + c.tx.gas > BLOCK_GAS_LIMIT) continue;
        const r = applyEoaTx(c.tx, state, ctx, this.modelOpts());
        leaving.add(c.tx.hash); // included now, or never: the pool keeps no queue
        if (!r) continue;
        state = r.post;
        blockGas += r.gasUsed;
        const tx = c.tx;
        done.push({ hash: tx.hash, gasUsed: r.gasUsed, build: (inc, cumulative) => eoaReceipt(tx, r, inc, cumulative) });
      } else {
        const rec = this.txs.get(c.hash);
        if (rec?.inclusion) { leaving.add(c.hash); continue; }
        let run: RunResult | null = null;
        try { run = runFrameTx(c.tx, state, ctx, this.modelOpts()); } catch (e) { if (!(e instanceof ProtocolRefusal)) throw e; }
        if (c.via === "public") leaving.add(c.hash);
        if (!run?.post || blockGas + run.gasLimit > BLOCK_GAS_LIMIT) continue; // the sidecar's reconciler deals with its own
        state = run.post;
        blockGas += run.gasUsed!;
        const tx = c.tx, result = run;
        if (!this.txs.has(c.hash)) this.txs.set(c.hash, { kind: "frame", hash: c.hash, tx, via: c.via, inclusion: null, gasLimit: run.gasLimit, effectivePrice: null });
        done.push({ hash: c.hash, gasUsed: run.gasUsed!, build: (inc, cumulative) => frameReceipt(tx, result, inc, cumulative) });
      }
    }
    this.publicEoa = this.publicEoa.filter((p) => !leaving.has(p.tx.hash));
    this.publicFrames = this.publicFrames.filter((p) => !leaving.has(p.hash));
    const included = new Set(done.map((d) => d.hash));
    for (const h of leaving) if (!included.has(h as Hex) && !this.txs.get(h)?.inclusion) this.txs.delete(h); // dropped: no longer known

    const hash = keccak256(concat([this.genesisHash, pad(q(ctx.number), { size: 32 }), parent.hash, pad(q(timestamp), { size: 32 }), ...done.map((d) => d.hash)]));
    let cumulative = 0n;
    done.forEach((d, index) => {
      cumulative += d.gasUsed;
      const inc = { blockNumber: ctx.number, blockHash: hash, index };
      this.receipts.set(d.hash, d.build(inc, cumulative));
      const rec = this.txs.get(d.hash)!;
      rec.inclusion = inc;
      if (rec.kind === "frame") rec.effectivePrice = BigInt(this.receipts.get(d.hash)!.effectiveGasPrice as Hex);
    });
    const block: Block = { number: ctx.number, hash, parentHash: parent.hash, timestamp, baseFee: ctx.baseFee, miner: COINBASE, gasUsed: cumulative, txHashes: done.map((d) => d.hash), state };
    this.blocks.push(block);
    const drop = this.blocks.length - 1 - (STATE_WINDOW + 2);
    if (drop >= 0) this.blocks[drop]!.state = null;
    this.onBlock(block);
    return block;
  }
}

/** Why the public pool refuses a frame transaction its node would not admit, or null. */
export function publicRefusal(run: RunResult): string | null {
  if (run.signatureError !== null) return `signature ${run.signatureError} is not valid`;
  if (run.shapeError) return run.shapeError;
  if (run.canonicalViolation) return run.canonicalViolation;
  if (run.prefixFailure) {
    const f = run.prefixFailure;
    const reason = f.revertData && f.revertData.length === 66 ? Buffer.from(f.revertData.slice(2), "hex").toString().replace(/\0+$/, "") : null;
    return `validation prefix frame reverted (frame ${f.failedFrameIndex}: ${f.haltReason}${reason ? ` "${reason}"` : ""})`;
  }
  return null;
}

const formatLogs = (logs: Log[], hash: Hex, inc: Inclusion, firstIndex: number) => logs.map((l, i) => ({
  address: l.address, topics: l.topics, data: l.data, blockNumber: q(inc.blockNumber), transactionHash: hash,
  transactionIndex: q(inc.index), blockHash: inc.blockHash, logIndex: q(firstIndex + i), removed: false,
}));

function eoaReceipt(tx: EoaTx, r: { status: 0 | 1; gasUsed: bigint; logs: Log[]; reason?: string; price: bigint }, inc: Inclusion, cumulative: bigint) {
  return {
    type: tx.type === "legacy" ? "0x0" : "0x2", status: q(r.status), cumulativeGasUsed: q(cumulative), gasUsed: q(r.gasUsed),
    effectiveGasPrice: q(r.price), logsBloom: ZERO_BLOOM, logs: formatLogs(r.logs, tx.hash, inc, 0), transactionHash: tx.hash,
    transactionIndex: q(inc.index), blockHash: inc.blockHash, blockNumber: q(inc.blockNumber), from: tx.from, to: tx.to, contractAddress: null,
    ...(r.reason ? { fakechainRevertReason: r.reason } : {}),
  };
}

function frameReceipt(tx: FrameTransaction, run: RunResult, inc: Inclusion, cumulative: bigint) {
  const frames = run.frames!;
  const ok = frames.every((f) => f.status === "success");
  let logIndex = 0;
  const frameReceipts = frames.map((f) => {
    const logs = formatLogs(f.logs, run.hash, inc, logIndex);
    logIndex += logs.length;
    return { status: f.status === "success" ? "0x1" : "0x0", gasUsed: q(f.gas), stateGasUsed: q(f.stateGas), logs };
  });
  const reasons = Object.fromEntries(frames.flatMap((f, i) => (f.reason ? [[String(i), f.reason]] : [])));
  return {
    type: "0x6", status: ok ? "0x1" : "0x0", cumulativeGasUsed: q(cumulative), gasUsed: q(run.gasUsed!), effectiveGasPrice: q(run.effectivePrice),
    logsBloom: ZERO_BLOOM, logs: frameReceipts.flatMap((f) => f.logs), transactionHash: run.hash, transactionIndex: q(inc.index),
    blockHash: inc.blockHash, blockNumber: q(inc.blockNumber), from: getAddress(tx.sender), to: null, contractAddress: null,
    payer: getAddress(tx.sender), frameReceipts,
    ...(Object.keys(reasons).length ? { fakechainRevertReasons: reasons } : {}),
  };
}
