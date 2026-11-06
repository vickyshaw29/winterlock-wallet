// Thin JSON-RPC client for the gateway (sidecar) and the ethrex node. No retries, no caching:
// callers see every error with its code.
// Written with Claude Code (AI) for Vicky; after the Nov 6 review an error says whether the server answered.
import type { Address, Hex } from "viem";
import { DEVNET } from "./config.ts";
import { encodeRawFrameTx } from "./codec/codec.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

/**
 * How a call failed:
 *   "answered":  HTTP 200 with a JSON-RPC error object. The server processed the request and refused it on
 *                purpose (the sidecar answers every deliberate RpcError this way, api/src/utils/errorResponse.ts).
 *   "http":      another HTTP status, e.g. a proxy's 502. The request may or may not have reached the server.
 *   "transport": no response: network error, connection cut, or our timeout. Same: outcome unknown.
 *   "malformed": a response that is not JSON-RPC.
 * Only "answered" can mean "refused"; everything else means "we do not know".
 */
export type RpcFailure = "answered" | "http" | "transport" | "malformed";

/** JSON-RPC's own code for an internal error: a server bug, not a verdict on the request. */
export const INTERNAL_ERROR = -32603;

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
    readonly failure: RpcFailure = "answered",
  ) {
    super(`${method}: ${message}${code === undefined ? "" : ` (${code})`}`);
  }
  /** A deliberate refusal by the server, as opposed to a lost or broken exchange or a server bug. */
  get refused(): boolean { return this.failure === "answered" && this.code !== INTERNAL_ERROR; }
}

/** Tests lower the timeout; nothing else should change it. */
export const RPC = { timeoutMs: 20_000 };

export async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  let res: Response, text: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC.timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new RpcError(method, undefined, `no response: ${(e as Error).message}`, undefined, "transport");
  }
  let body: { result?: T; error?: { code?: number; message?: string; data?: unknown } } | undefined;
  try { body = JSON.parse(text); } catch { /* handled below */ }
  if (res.status !== 200) {
    throw new RpcError(method, res.status, `HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`, body?.error?.data, "http");
  }
  if (!body || typeof body !== "object") throw new RpcError(method, undefined, `not JSON-RPC: ${text.slice(0, 120)}`, undefined, "malformed");
  if (body.error) throw new RpcError(method, body.error.code, body.error.message ?? "error without a message", body.error.data, "answered");
  if (!("result" in body)) throw new RpcError(method, undefined, "neither result nor error", undefined, "malformed");
  return body.result as T;
}

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;

/** The JSON shape eth_sendFrameTransaction takes: every number as a hex string. */
export function toWire(tx: FrameTransaction) {
  return {
    chainId: hex(tx.chainId),
    nonceKeys: tx.nonceKeys.map(hex),
    nonceSeq: hex(tx.nonceSeq),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.limits.execution), state: hex(f.limits.state) },
      value: hex(f.value),
      data: f.data,
    })),
    signatures: tx.signatures.map((s) => ({ scheme: s.scheme, signer: s.signer, msg: s.msg, signature: s.signature })),
    fees: {
      maxPriorityFeePerGas: hex(tx.fees.maxPriorityFeePerGas),
      maxFeePerGas: hex(tx.fees.maxFeePerGas),
      maxFeePerBlobGas: hex(tx.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: tx.blobVersionedHashes,
    recentRootReferences: tx.recentRootReferences.map((r) => ({ sourceId: r.sourceId, slot: hex(r.slot), root: r.root })),
  };
}

/** The reverse of toWire, e.g. for a transaction read back from the explorer. */
export function fromWire(w: ReturnType<typeof toWire>): FrameTransaction {
  return {
    chainId: BigInt(w.chainId),
    nonceKeys: w.nonceKeys.map((k) => BigInt(k)),
    nonceSeq: BigInt(w.nonceSeq),
    sender: w.sender,
    frames: w.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: BigInt(f.limits.execution), state: BigInt(f.limits.state) },
      value: BigInt(f.value),
      data: f.data,
    })),
    signatures: w.signatures,
    fees: {
      maxPriorityFeePerGas: BigInt(w.fees.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(w.fees.maxFeePerGas),
      maxFeePerBlobGas: BigInt(w.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: w.blobVersionedHashes,
    recentRootReferences: w.recentRootReferences.map((r) => ({ sourceId: r.sourceId, slot: BigInt(r.slot), root: r.root })),
  };
}

export type FrameTxStatus ="New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";

/** One vocabulary for both receipt sources, the sidecar's (ReceiptService/index.ts): a frame can also be skipped. */
export type FrameStatus = "success" | "reverted" | "skipped";

export interface FrameReceipt {
  status: FrameStatus;
  gasUsed: { execution: Hex; state: Hex };
  logs: { address: Address; data: Hex; topics: Hex[] }[];
}
export interface FrameTxReceipt {
  blockNumber: Hex;
  status: "success" | "reverted";
  payer: Address;
  cumulativeGasUsed: Hex;
  frameReceipts: FrameReceipt[];
  /** the transaction's own gas used; only the node's receipt carries it */
  gasUsed?: Hex;
}

const FRAME_STATUS: Record<string, FrameStatus> = {
  "0x0": "reverted", "0x1": "success", "0x2": "skipped", reverted: "reverted", success: "success", skipped: "skipped",
};
const TX_STATUS: Record<string, "success" | "reverted"> = { "0x0": "reverted", "0x1": "success", reverted: "reverted", success: "success" };

/**
 * A receipt from either source in one shape. The node writes per-frame gas as gasUsed plus stateGasUsed and
 * statuses as bytes (frame 0x0 reverted, 0x1 success, 0x2 skipped; transaction 0x0/0x1); the sidecar writes
 * gasUsed: {execution, state} and the words. An unknown status is an error, never a guess.
 */
export function normalizeNodeReceipt(n: any): FrameTxReceipt {
  const pick = <T>(table: Record<string, T>, v: unknown, what: string): T => {
    const out = table[String(v)];
    if (out === undefined) throw new Error(`unknown ${what} status ${JSON.stringify(v)} in receipt`);
    return out;
  };
  return {
    blockNumber: n.blockNumber,
    status: pick(TX_STATUS, n.status, "transaction"),
    payer: n.payer,
    cumulativeGasUsed: n.cumulativeGasUsed,
    gasUsed: n.gasUsed,
    frameReceipts: (n.frameReceipts ?? []).map((f: any) => ({
      status: pick(FRAME_STATUS, f.status, "frame"),
      gasUsed: typeof f.gasUsed === "object" ? f.gasUsed : { execution: f.gasUsed, state: f.stateGasUsed ?? "0x0" },
      logs: f.logs ?? [],
    })),
  };
}

/** Included and every frame ran: the payment happened. Anything else included is "Reverted". */
export const receiptSucceeded = (r: FrameTxReceipt) => r.status === "success" && r.frameReceipts.every((f) => f.status === "success");

/**
 * ethrex_simulateFrameTransaction result. The devnet build returns canonicalMempoolValid and
 * canonicalMempoolViolation where the sidecar's devnet-readme still says valid and violation
 * (seen 2026-11-05); both spellings are accepted.
 */
export interface SimulationResult {
  canonicalMempoolValid?: boolean;
  canonicalMempoolViolation?: string | null;
  valid?: boolean;
  violation?: string | null;
  prefixShape: string | null;
  payer: Address | null;
  maxCost: Hex;
  gasUsed: Hex | null;
  frames: { gasUsed: Hex; succeeded: boolean }[] | null;
  executionStatus: "success" | "reverted" | null;
  executionError?: string | null;
  erc7562Trace?: unknown;
  erc7562TraceError?: string | null;
}

/**
 * The verdict a preflight acts on: the public (canonical) mempool's rules passed and every frame ran.
 * On this devnet the sidecar enforces the same 100k prefix cap, so canonical-valid is the right gate;
 * if a devnet runs per-entity alt budgets, a canonical refusal alone must stop being fatal.
 */
export function simulationVerdict(r: SimulationResult): { ok: boolean; reason: string | null } {
  const valid = r.canonicalMempoolValid ?? r.valid ?? false;
  const violation = r.canonicalMempoolViolation ?? r.violation ?? null;
  if (!valid) return { ok: false, reason: violation ?? "simulation says invalid, no reason given" };
  if (r.executionStatus !== "success") return { ok: false, reason: r.executionError ?? `execution ${r.executionStatus}` };
  return { ok: true, reason: null };
}

/** Sidecar gateway: the alt mempool. */
export const gateway = {
  gasPrice: () => rpc<{ maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }>(DEVNET.gateway, "skandha_getGasPrice"),
  send: (tx: FrameTransaction) => rpc<Hex>(DEVNET.gateway, "eth_sendFrameTransaction", [toWire(tx)]),
  /**
   * The sidecar's status for a hash, or null when it answers that it holds no such transaction (a deliberate
   * "Frame transaction not found", -32600). Throws when it cannot be asked: then nobody knows.
   */
  status: async (hash: Hex): Promise<FrameTxStatus | null> => {
    try {
      return (await rpc<{ status: FrameTxStatus } | null>(DEVNET.gateway, "skandha_frameTransactionStatus", [hash]))?.status ?? null;
    } catch (e) {
      if (e instanceof RpcError && e.refused && e.code === -32600 && /not found/i.test(e.message)) return null;
      throw e;
    }
  },
  /** Throws while the transaction is not in a block (the sidecar answers "not found" with an error, never null). */
  receipt: async (hash: Hex) => {
    const r = await rpc<any>(DEVNET.gateway, "eth_getFrameTransactionReceipt", [hash]);
    return r ? normalizeNodeReceipt(r) : null;
  },
  faucet: (address: Address) => rpc<{ txHash: Hex; amount: string }>(DEVNET.gateway, "skandha_explorer_faucet", [address]),
  /** The explorer's record, including the per-rule admission report. In memory only: lost on restart. */
  explorerRecord: (hash: Hex) => rpc<any>(DEVNET.gateway, "skandha_explorer_getTransaction", [hash]),
};

/** ethrex node. */
export const node = {
  nonce: async (address: Address, block = "pending") => BigInt(await rpc<Hex>(DEVNET.node, "eth_getTransactionCount", [address, block])),
  balance: async (address: Address) => BigInt(await rpc<Hex>(DEVNET.node, "eth_getBalance", [address, "latest"])),
  code: (address: Address) => rpc<Hex>(DEVNET.node, "eth_getCode", [address, "latest"]),
  storage: (address: Address, slot: Hex) => rpc<Hex>(DEVNET.node, "eth_getStorageAt", [address, slot, "latest"]),
  /**
   * Storage at one block. The devnet node serves real state for about the last 126 blocks only; for an older block
   * it silently answers with the latest state (Day-0 finding, Nov 6), so callers stay within a few blocks of the head.
   */
  storageAt: (address: Address, slot: Hex, block: bigint) => rpc<Hex>(DEVNET.node, "eth_getStorageAt", [address, slot, `0x${block.toString(16)}`]),
  blockNumber: async () => BigInt(await rpc<Hex>(DEVNET.node, "eth_blockNumber")),
  /** A block's number and timestamp; throws if the node has no such block. */
  block: async (tag: bigint | "latest") => {
    const b = await rpc<{ number: Hex; timestamp: Hex } | null>(DEVNET.node, "eth_getBlockByNumber", [typeof tag === "bigint" ? `0x${tag.toString(16)}` : tag, false]);
    if (!b) throw new Error(`no block ${tag}`);
    return { number: BigInt(b.number), timestamp: BigInt(b.timestamp) };
  },
  /** Timestamp of the latest block: the clock the expiry frame checks. */
  blockTimestamp: async () => BigInt((await rpc<{ timestamp: Hex }>(DEVNET.node, "eth_getBlockByNumber", ["latest", false])).timestamp),
  /** The node's own receipt (null until the transaction is in a block), in the sidecar's receipt shape. */
  receipt: async (hash: Hex) => {
    const r = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [hash]);
    return r ? normalizeNodeReceipt(r) : null;
  },
  /** Dry run with ethrex's own admission checks; trace: true adds the ERC-7562 trace. */
  simulate: (tx: FrameTransaction, trace = true) =>
    rpc<SimulationResult>(DEVNET.node, "ethrex_simulateFrameTransaction", [encodeRawFrameTx(tx), "latest", { trace }]),
  /** The public mempool path: ethrex's own validation, one pending frame tx per sender. */
  sendRawPublic: (tx: FrameTransaction) => rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [encodeRawFrameTx(tx)]),
};
