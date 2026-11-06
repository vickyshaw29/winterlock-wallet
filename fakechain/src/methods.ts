// The JSON-RPC methods of the fake node (at /) and of the fake sidecar (at /rpc), in the shapes the pipeline parses.
// Written with Claude Code (AI) for Vicky.
// See pipeline/src/rpc.ts: SimulationResult, normalizeNodeReceipt, gateway.status, gateway.receipt.
import { getAddress, hexToBytes, isAddress, keccak256, numberToHex, pad, toHex, zeroAddress, type Address, type Hex } from "viem";
import { toWire } from "../../pipeline/src/rpc.ts";
import { Meter } from "./accountModel.ts";
import { BLOCK_GAS_LIMIT, CHAIN_ID, CLIENT_VERSION, GWEI } from "./constants.ts";
import { SharedStateMeter, intrinsicGas } from "./eoaTx.ts";
import { ProtocolRefusal, callFailure, codeKind, decodeRawFrameTx, executeCall, runFrameTx, type RunResult } from "./frameTx.ts";
import { StateUnavailable, type Block, type FakeChain, type TxRecord } from "./chain.ts";
import { SidecarError, type Sidecar } from "./sidecar.ts";

export type Method = (params: unknown[]) => unknown | Promise<unknown>;
/** A JSON-RPC error with its code (and data, e.g. revert data). */
export class RpcFailure extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

const q = (n: bigint | number) => numberToHex(n);
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const addr = (v: unknown, what = "address"): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new RpcFailure(-32602, `invalid ${what}: ${JSON.stringify(v)}`);
  return getAddress(v);
};
const hexArg = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new RpcFailure(-32602, `invalid ${what}`);
  return v as Hex;
};

// ------------------------------------------------------------------ shapes
export function formatTx(chain: FakeChain, rec: TxRecord) {
  const inc = rec.inclusion;
  const base = { hash: rec.hash, blockHash: inc?.blockHash ?? null, blockNumber: inc ? q(inc.blockNumber) : null, transactionIndex: inc ? q(inc.index) : null, chainId: q(CHAIN_ID) };
  if (rec.kind === "eoa") {
    const t = rec.tx;
    const receipt = chain.receipt(rec.hash);
    return {
      ...base, type: t.type === "legacy" ? "0x0" : "0x2", from: t.from, to: t.to, nonce: q(t.nonce), value: q(t.value), gas: q(t.gas), input: t.data,
      gasPrice: q(receipt ? BigInt(receipt.effectiveGasPrice as Hex) : t.gasPrice ?? t.maxFeePerGas!),
      ...(t.type === "eip1559" ? { maxFeePerGas: q(t.maxFeePerGas!), maxPriorityFeePerGas: q(t.maxPriorityFeePerGas!), accessList: [], yParity: q(t.yParity) } : {}),
      v: q(t.v), r: t.r, s: t.s,
    };
  }
  // ethrex's shape for a frame transaction is not known here: the standard fields, plus the frame transaction's own.
  const w = toWire(rec.tx);
  return {
    ...base, type: "0x6", from: getAddress(rec.tx.sender), to: null, nonce: w.nonceSeq, value: "0x0", gas: q(rec.gasLimit), input: "0x",
    gasPrice: q(rec.effectivePrice ?? rec.tx.fees.maxFeePerGas), maxFeePerGas: w.fees.maxFeePerGas, maxPriorityFeePerGas: w.fees.maxPriorityFeePerGas,
    maxFeePerBlobGas: w.fees.maxFeePerBlobGas, nonceKeys: w.nonceKeys, nonceSeq: w.nonceSeq, sender: w.sender, frames: w.frames, signatures: w.signatures,
    blobVersionedHashes: w.blobVersionedHashes, recentRootReferences: w.recentRootReferences,
  };
}

export function formatBlock(chain: FakeChain, b: Block, full: boolean) {
  return {
    number: q(b.number), hash: b.hash, parentHash: b.parentHash, nonce: "0x0000000000000000",
    sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: b.txHashes.length ? keccak256(`0x${b.txHashes.map((h) => h.slice(2)).join("")}`) : "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    stateRoot: keccak256(`0x${b.hash.slice(2)}00`), receiptsRoot: keccak256(`0x${b.hash.slice(2)}01`), miner: b.miner, difficulty: "0x0", totalDifficulty: "0x0",
    extraData: toHex("fakechain"), size: q(600 + 100 * b.txHashes.length), gasLimit: q(BLOCK_GAS_LIMIT), gasUsed: q(b.gasUsed), timestamp: q(b.timestamp),
    transactions: full ? b.txHashes.map((h) => formatTx(chain, chain.tx(h)!)) : b.txHashes, uncles: [], baseFeePerGas: q(b.baseFee), mixHash: ZERO32,
    withdrawals: [], withdrawalsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421", blobGasUsed: "0x0", excessBlobGas: "0x0", parentBeaconBlockRoot: ZERO32,
  };
}

/** ethrex_simulateFrameTransaction's result. A refused verify frame reports no frame gas (Nov 6), only the detail. */
export function simulationResult(run: RunResult, trace: boolean) {
  const none = { payer: null, maxCost: q(run.maxCost), gasUsed: null, frames: null, executionStatus: null, executionError: null, erc7562Trace: null, erc7562TraceError: null };
  if (run.signatureError !== null) return { canonicalMempoolValid: false, canonicalMempoolViolation: `signature ${run.signatureError} is not valid`, prefixShape: null, ...none };
  if (run.shapeError) return { canonicalMempoolValid: false, canonicalMempoolViolation: run.shapeError, prefixShape: null, ...none };
  if (run.prefixFailure) {
    const f = run.prefixFailure;
    return {
      canonicalMempoolValid: false, canonicalMempoolViolation: "validation prefix frame reverted", prefixShape: run.prefixShape, ...none,
      failedFrameIndex: f.failedFrameIndex, haltReason: f.haltReason, haltDetail: f.haltDetail,
      ...(f.revertData !== undefined ? { revertData: f.revertData } : {}),
      ...(f.account ? { account: f.account, balance: q(f.balance!), required: q(f.required!) } : {}),
    };
  }
  const frames = run.frames!;
  const reasons = Object.fromEntries(frames.flatMap((f, i) => (f.reason ? [[String(i), f.reason]] : [])));
  return {
    canonicalMempoolValid: run.canonicalViolation === null, canonicalMempoolViolation: run.canonicalViolation, prefixShape: run.prefixShape,
    payer: run.sender, maxCost: q(run.maxCost), gasUsed: q(run.gasUsed!),
    frames: frames.map((f) => ({ gasUsed: q(f.gas), succeeded: f.status === "success" })),
    executionStatus: frames.every((f) => f.status === "success") ? "success" : "reverted", executionError: null,
    erc7562Trace: null, erc7562TraceError: trace ? "fakechain runs no EVM code, so it has no ERC-7562 opcode trace" : null,
    ...(Object.keys(reasons).length ? { fakechainRevertReasons: reasons } : {}),
  };
}

// ------------------------------------------------------------------ eth_call and eth_estimateGas on the model
function callOn(chain: FakeChain, call: unknown, tag: unknown, mode: "call" | "estimate") {
  if (!call || typeof call !== "object") throw new RpcFailure(-32602, "missing call object");
  const c = call as Record<string, unknown>;
  if (c.to === undefined || c.to === null) throw new RpcFailure(-32000, "fakechain does not model contract creation");
  const block = chain.blockByTag(tag);
  if (!block) throw new RpcFailure(-32000, `block ${String(tag)} not found`);
  const state = chain.stateAt(tag).clone();
  const from = c.from ? addr(c.from, "from") : zeroAddress;
  const to = addr(c.to, "to");
  // ethrex refuses a contract as eth_call's sender (EIP-3607); a SENDER frame cannot be stood in for this way
  if (state.code(from) !== "0x") throw new RpcFailure(-32000, `sender ${from} has deployed code (EIP-3607): eth_call cannot act as an account's SENDER frame`);
  const data = hexArg(c.data ?? c.input ?? "0x", "data");
  const value = c.value === undefined ? 0n : BigInt(hexArg(c.value, "value"));
  const gas = c.gas === undefined ? BLOCK_GAS_LIMIT : BigInt(hexArg(c.gas, "gas"));
  if (mode === "call" && value > 0n && state.balance(from) < value) state.addBalance(from, value); // eth_call does not charge the caller
  const intrinsic = mode === "estimate" ? intrinsicGas(data) : 0n;
  const meter = new Meter(Number(gas - intrinsic));
  const ctx = { number: block.number, timestamp: block.timestamp, baseFee: block.baseFee, coinbase: block.miner, chainId: CHAIN_ID };
  try {
    const r = executeCall({
      state, original: chain.stateAt(tag), from, to, value, data: hexToBytes(data), meter, stateMeter: new SharedStateMeter(meter), ctx,
      opts: chain.modelOpts(), access: new Set([from.toLowerCase(), to.toLowerCase()]), warm: new Map(),
    });
    return mode === "call" ? r.returnData : q(intrinsic + BigInt(meter.used));
  } catch (e) {
    const f = callFailure(e);
    if (f.outOfGas && mode === "estimate") throw new RpcFailure(-32000, `gas required exceeds allowance (${gas})`);
    const text = f.data && f.data.length === 66 ? Buffer.from(f.data.slice(2), "hex").toString().replace(/\0+$/, "") : "";
    throw new RpcFailure(3, `execution reverted${/^[\x20-\x7e]+$/.test(text) ? `: ${text}` : ""}`, f.data);
  }
}

// ------------------------------------------------------------------ the node at /
export function nodeMethods(chain: FakeChain): Record<string, Method> {
  const latestBlock = () => chain.head;
  return {
    web3_clientVersion: () => CLIENT_VERSION,
    eth_chainId: () => q(CHAIN_ID),
    net_version: () => CHAIN_ID.toString(),
    net_listening: () => true,
    eth_syncing: () => false,
    eth_accounts: () => [],
    eth_blockNumber: () => q(latestBlock().number),
    eth_gasPrice: () => q(chain.opts.baseFee + GWEI),
    eth_maxPriorityFeePerGas: () => q(GWEI),
    eth_getBlockByNumber: ([tag, full]) => { const b = chain.blockByTag(tag); return b ? formatBlock(chain, b, full === true) : null; },
    eth_getBlockByHash: ([hash, full]) => { const b = chain.blockByHash(hexArg(hash, "block hash")); return b ? formatBlock(chain, b, full === true) : null; },
    eth_getBalance: ([a, tag]) => q(chain.stateAt(tag).balance(addr(a))),
    eth_getCode: ([a, tag]) => chain.stateAt(tag).code(addr(a)),
    eth_getStorageAt: ([a, slot, tag]) => pad(q(chain.stateAt(tag).sload(addr(a), BigInt(hexArg(slot, "slot")))), { size: 32 }),
    eth_getTransactionCount: ([a, tag]) => q(tag === "pending" ? chain.pendingNonce(addr(a)) : chain.stateAt(tag).nonce(addr(a))),
    eth_call: ([call, tag]) => callOn(chain, call, tag, "call"),
    eth_estimateGas: ([call, tag]) => callOn(chain, call, tag ?? "latest", "estimate"),
    eth_feeHistory: ([count, newest, percentiles]) => {
      const head = chain.blockByTag(newest ?? "latest") ?? chain.head;
      const n = Math.max(1, Math.min(Number(BigInt(hexArg(typeof count === "number" ? q(count) : count, "block count"))), 1024, Number(head.number) + 1));
      const oldest = head.number - BigInt(n) + 1n;
      const blocks = chain.blocks.slice(Number(oldest), Number(head.number) + 1);
      const pct = Array.isArray(percentiles) ? percentiles : [];
      return {
        oldestBlock: q(oldest), baseFeePerGas: [...blocks.map((b) => q(b.baseFee)), q(chain.opts.baseFee)],
        gasUsedRatio: blocks.map((b) => Number(b.gasUsed) / Number(BLOCK_GAS_LIMIT)), ...(pct.length ? { reward: blocks.map(() => pct.map(() => q(GWEI))) } : {}),
      };
    },
    eth_sendRawTransaction: ([raw]) => {
      const r = hexArg(raw, "raw transaction");
      return r.slice(0, 4).toLowerCase() === "0x06" ? chain.submitPublicFrame(r) : chain.submitEoa(r);
    },
    eth_getTransactionByHash: ([hash]) => { const rec = chain.tx(hexArg(hash, "hash")); return rec ? formatTx(chain, rec) : null; },
    eth_getTransactionReceipt: ([hash]) => chain.receipt(hexArg(hash, "hash")),
    ethrex_simulateFrameTransaction: ([raw, tag, options]) => {
      const tx = decodeRawFrameTx(hexArg(raw, "raw transaction"));
      const b = chain.blockByTag(tag ?? "latest");
      if (!b) throw new RpcFailure(-32000, `block ${String(tag)} not found`);
      const ctx = { number: b.number, timestamp: b.timestamp, baseFee: b.baseFee, coinbase: b.miner, chainId: CHAIN_ID };
      const run = runFrameTx(tx, chain.stateAt(tag ?? "latest"), ctx, chain.modelOpts());
      return simulationResult(run, (options as { trace?: boolean } | undefined)?.trace === true);
    },
  };
}

/** The node reads the real sidecar proxies to its execution client (redirectRpc). */
const PROXIED = [
  "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_sendRawTransaction", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "net_version",
];

// ------------------------------------------------------------------ the sidecar at /rpc
export function sidecarMethods(chain: FakeChain, sidecar: Sidecar): Record<string, Method> {
  const node = nodeMethods(chain);
  return {
    ...Object.fromEntries(PROXIED.map((m) => [m, node[m]!])),
    web3_clientVersion: () => "fakechain-sidecar/0.1.0 (modelled on the workshop sidecar skandha/v4.1.1, not skandha)",
    eth_chainId: () => q(CHAIN_ID),
    skandha_getGasPrice: () => sidecar.gasPrice(),
    eth_sendFrameTransaction: ([tx]) => sidecar.send(tx),
    eth_estimateFrameTransactionGas: ([tx]) => sidecar.estimate(tx),
    eth_getFrameTransactionReceipt: ([hash]) => sidecar.receipt(hash),
    eth_getFrameTransactionByHash: ([hash]) => sidecar.entry(hash),
    skandha_frameTransactionStatus: ([hash]) => sidecar.status(hash),
    skandha_explorer_faucet: ([a]) => sidecar.faucet(a),
    skandha_explorer_getTransaction: ([hash]) => sidecar.explorerTransaction(hash),
    skandha_explorer_listAdmissions: ([p]) => sidecar.explorerAdmissions((p ?? {}) as { outcome?: string; limit?: number }),
    skandha_explorer_listTransactions: ([p]) => sidecar.explorerTransactions((p ?? {}) as { status?: string; limit?: number }),
    skandha_explorer_info: () => sidecar.explorerInfo(),
    skandha_explorer_peers: () => [],
  };
}

/** Maps a thrown error to a JSON-RPC error object. Anything unexpected is an internal error (-32603). */
export function toRpcError(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof RpcFailure || e instanceof SidecarError) return { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
  if (e instanceof ProtocolRefusal) return { code: e.code, message: e.message };
  if (e instanceof StateUnavailable) return { code: -32000, message: e.message };
  return { code: -32603, message: `Internal error: ${(e as Error)?.message ?? String(e)}` };
}

export { codeKind };
