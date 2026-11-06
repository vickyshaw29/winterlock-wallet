// The transaction store, <backendDir>/txs.json: one record per transaction the backend sent or saw refused, written
// atomically after every change and read back at startup. It is the lane board's memory; the journals stay the
// authority on which leaves are spent.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import type { Address, Hex } from "viem";
import { explorerTxUrl, type AdmissionReport, type FrameTxReceipt } from "../../pipeline/src/index.ts";
import { writeJsonAtomic } from "./files.ts";

/** Shared interfaces 5, transaction status values (Nov 6). */
export type TxStatus = "Submitted" | "OnChain" | "Reverted" | "Included" | "Expired" | "Refused" | "Unknown";

export interface TxRecord {
  txHash: Hex;
  status: TxStatus;
  explorerUrl: string;
  receipt: FrameTxReceipt | null;
  simulation: { verifyGas: string | null; violations: string[] };
  wallet: Address;
  /** what the transaction does: a send, or one of the two admin calls */
  kind: "send" | "rotate" | "hot-policy";
  leaf: number;
  /** 0x hex */
  nonceKey: Hex;
  nonceSeq: "0x0";
  mode: "keyed" | "hot";
  mempool: "alt" | "public";
  to: Address;
  /** decimal wei */
  valueWei: string;
  deadline: number | null;
  admission: AdmissionReport | null;
  timeline: { status: string; at: string }[];
  retryOf: Hex | null;
  retriedAs: Hex | null;
  /** why it was refused, or what is not known about it */
  detail: string | null;
  /**
   * decimal wei (parallel lanes, Nov 6): the most this transaction can be charged for gas while it is pending, which
   * the sidecar sets aside for its payer: ethrex's maxCost from the dry run of exactly this transaction, else
   * maxFeePerGas x total_gas_limit of the JSON sent (laneCost). Its whole set-aside is this plus valueWei. Null when
   * neither is known (a dry run that failed without an answer, before anything was sent; a record written earlier)
   */
  maxCostWei: string | null;
  /**
   * the exact JSON sent (eth_sendFrameTransaction's argument; for mempool "public", the JSON of the raw transaction
   * sent to the node), from the pipeline's onSend; null when nothing was sent. GET /tx/:hash only, never the txs list
   */
  wire: unknown | null;
  createdAt: string;
  updatedAt: string;
}

/** The defaults every new record starts from; a record read from an older store gets the ones it lacks. */
const DEFAULTS_OF_NEW = { maxCostWei: null, wire: null } as const;

export const newRecord = (r: Omit<TxRecord, "explorerUrl" | "receipt" | "simulation" | "admission" | "timeline" | "retryOf" | "retriedAs" | "detail" | "createdAt" | "updatedAt" | "nonceSeq" | "maxCostWei" | "wire"> & Partial<TxRecord>): TxRecord => {
  const now = new Date().toISOString();
  return {
    explorerUrl: explorerTxUrl(r.txHash), receipt: null, simulation: { verifyGas: null, violations: [] }, admission: null,
    timeline: [], retryOf: null, retriedAs: null, detail: null, createdAt: now, updatedAt: now, nonceSeq: "0x0", ...DEFAULTS_OF_NEW, ...r,
    txHash: r.txHash.toLowerCase() as Hex,
  };
};

export class TxStore {
  private txs = new Map<string, TxRecord>();

  constructor(readonly file: string) {}

  load(): void {
    this.txs.clear();
    if (!fs.existsSync(this.file)) return;
    const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version: number; txs: TxRecord[] };
    if (data.version !== 1 || !Array.isArray(data.txs)) throw new Error(`${this.file} is not a version 1 transaction store`);
    for (const t of data.txs) this.txs.set(t.txHash.toLowerCase(), { ...DEFAULTS_OF_NEW, ...t }); // fields added since: null
  }

  get(hash: string): TxRecord | undefined { return this.txs.get(hash.toLowerCase()); }
  all(): TxRecord[] { return [...this.txs.values()]; }

  /** The wallet's records, newest first. */
  forWallet(address: string): TxRecord[] {
    const a = address.toLowerCase();
    return this.all().filter((t) => t.wallet.toLowerCase() === a).sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  }

  put(rec: TxRecord): TxRecord {
    this.txs.set(rec.txHash.toLowerCase(), rec);
    this.persist();
    return rec;
  }

  /** Merges a change into a record; unknown hashes are ignored. A status line goes on the timeline when given. */
  update(hash: string, patch: Partial<TxRecord>, timeline?: string): TxRecord | undefined {
    const rec = this.txs.get(hash.toLowerCase());
    if (!rec) return undefined;
    const now = new Date().toISOString();
    Object.assign(rec, patch, { updatedAt: now });
    if (timeline && rec.timeline.at(-1)?.status !== timeline) rec.timeline.push({ status: timeline, at: now });
    this.persist();
    return rec;
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, txs: this.all() });
  }
}
