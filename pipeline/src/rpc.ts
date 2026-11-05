// Thin JSON-RPC client for the gateway (sidecar) and the ethrex node. No retries, no caching:
// callers see every error with its code.
import type { Address, Hex } from "viem";
import { DEVNET } from "./config.ts";
import { encodeRawFrameTx } from "./codec/codec.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(`${method}: ${message}${code === undefined ? "" : ` (${code})`}`);
  }
}

export async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new RpcError(method, res.status, `HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code?: number; message: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
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

export interface FrameReceipt {
  status: "success" | "failure" | string;
  gasUsed: { execution: Hex; state: Hex };
  logs: { address: Address; data: Hex; topics: Hex[] }[];
}
export interface FrameTxReceipt {
  blockNumber: Hex;
  status: string;
  payer: Address;
  cumulativeGasUsed: Hex;
  frameReceipts: FrameReceipt[];
}

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
  status: async (hash: Hex) => (await rpc<{ status: FrameTxStatus } | null>(DEVNET.gateway, "skandha_frameTransactionStatus", [hash]))?.status ?? null,
  receipt: (hash: Hex) => rpc<FrameTxReceipt | null>(DEVNET.gateway, "eth_getFrameTransactionReceipt", [hash]),
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
  /** Dry run with ethrex's own admission checks; trace: true adds the ERC-7562 trace. */
  simulate: (tx: FrameTransaction, trace = true) =>
    rpc<SimulationResult>(DEVNET.node, "ethrex_simulateFrameTransaction", [encodeRawFrameTx(tx), "latest", { trace }]),
  /** The public mempool path: ethrex's own validation, one pending frame tx per sender. */
  sendRawPublic: (tx: FrameTransaction) => rpc<Hex>(DEVNET.node, "eth_sendRawTransaction", [encodeRawFrameTx(tx)]),
};
