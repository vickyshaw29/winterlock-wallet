// Transaction records as the backend's store writes them (backend/src/store.ts), for the lane board's tests.
// Written with Claude Code (AI) for Vicky.
import type { TxRecord } from "../src/domain/api.js";

export const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const T0 = Date.parse("2026-11-06T10:00:00.000Z");
export const at = (ms: number) => new Date(T0 + ms).toISOString();

/** A record; `lines` are its timeline as [status, ms after T0]. */
export function rec(over: Partial<TxRecord> & { lines?: [string, number][] } = {}): TxRecord {
  const { lines = [["Submitted", 0]], ...rest } = over;
  const hash = rest.txHash ?? H(1);
  return {
    txHash: hash, status: "Submitted", explorerUrl: `https://explorer.altmempool.wtf/tx/${hash}`, receipt: null,
    simulation: { verifyGas: null, violations: [] }, wallet: "0x00000000000000000000000000000000000ACC01", kind: "send", leaf: 16,
    nonceKey: "0x10", nonceSeq: "0x0", mode: "hot", mempool: "alt", to: "0x5544596212F91984C986A919C8026DF0576816f9", valueWei: "1000",
    deadline: 1_762_423_290, admission: null, timeline: lines.map(([status, ms]) => ({ status, at: at(ms) })), retryOf: null, retriedAs: null,
    detail: null, createdAt: at(0), updatedAt: at(lines.at(-1)?.[1] ?? 0), ...rest,
  };
}

export const receipt = (block: number) => ({ blockNumber: `0x${block.toString(16)}`, status: "success" as const, payer: "0x0", cumulativeGasUsed: "0x0", frameReceipts: [] });
