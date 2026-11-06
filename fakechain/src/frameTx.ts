// A frame transaction run against the world state as the protocol would, for simulation, admission and inclusion.
// Written with Claude Code (AI) for Vicky.
// Static, chain, fee and nonce checks, signatures, the validation prefix (the expiry frame, then the account's verify
// frame through its proxy), payment, the SENDER frames, gas, refund and the effects.
import { getAddress, hexToBytes, keccak256, size, type Address, type Hex } from "viem";
import { computeSigHash, decodeFrameTx, encodeRawFrameTx } from "../../pipeline/src/codec/codec.ts";
import { FRAME_MODE, SIG_SCHEME, frameTxNonceAndRootsViolation, type FrameTransaction } from "../../pipeline/src/codec/FrameTx.ts";
import { EXPIRY_VERIFIER, NONCE_MANAGER } from "../../pipeline/src/config.ts";
import { nonceManagerSlot } from "../../pipeline/src/builder.ts";
import { frameGasModel } from "../../pipeline/src/estimate.ts";
import { proxyRuntimeCode } from "../../pipeline/src/account.ts";
import { Meter, OutOfGas, Revert, StateMeter, StorageCtx, VERIFY_GAS, accountCall, calleeBudget, decodeReason, verifyFrame, type Approval, type TxView } from "./accountModel.ts";
import { factoryCall, type Log } from "./factoryModel.ts";
import { ENTRY_POINT, FACTORY, IMPLEMENTATION, UINT256, UINT64_MAX } from "./constants.ts";
import { FRAME_SUBCLASS, classifyFrame, recognizeValidationPrefix, resolvedSigner, validateSignature, validateStructuralRules, type PrefixFailure } from "./sidecarRules.ts";
import type { WorldState } from "./state.ts";

export interface BlockCtx { number: bigint; timestamp: bigint; baseFee: bigint; coinbase: Address; chainId: bigint }
export interface ModelOpts { proxyHoldback: boolean }

/** A refusal the node answers as a JSON-RPC error, before any frame runs (ethrex: fees, nonce, malformed input). */
export class ProtocolRefusal extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const notModelled = (what: string) => new ProtocolRefusal(-32000, `fakechain does not model ${what}`);

export interface FrameResult {
  status: "success" | "reverted";
  gas: bigint;
  stateGas: bigint;
  logs: Log[];
  /** fakechain's own note on why a frame reverted; the real receipt carries no reason */
  reason?: string;
}

export interface RunResult {
  hash: Hex;
  sender: Address;
  sigHash: Hex;
  gasLimit: bigint;
  /** TXPARAM 0x06: the gas limit at maxFeePerGas, escrowed at payment approval */
  maxCost: bigint;
  effectivePrice: bigint;
  prefixShape: string | null;
  /** the public mempool's rules (MAX_VERIFY_GAS and the rest), decoupled from execution as in ethrex */
  canonicalViolation: string | null;
  /** first entry that failed EIP-8141 signature validation; nothing ran */
  signatureError: number | null;
  /** a prefix this model cannot run or that matches no recognised shape; nothing ran */
  shapeError: string | null;
  prefixFailure: PrefixFailure | null;
  /** every frame, once the prefix approved */
  frames: FrameResult[] | null;
  gasUsed: bigint | null;
  approval: (Approval & { gas: number }) | null;
  /** the state after the transaction, when it can be included */
  post: WorldState | null;
  verifyIndex: number;
}

export const decodeRawFrameTx = (raw: Hex): FrameTransaction => {
  const bytes = hexToBytes(raw);
  if (bytes[0] !== 0x06) throw new ProtocolRefusal(-32602, "not a frame transaction (type byte is not 0x06)");
  try {
    return decodeFrameTx(bytes.subarray(1));
  } catch (e) {
    throw new ProtocolRefusal(-32602, `cannot decode the frame transaction: ${(e as Error).message}`);
  }
};
export const frameTxHash = (tx: FrameTransaction): Hex => keccak256(encodeRawFrameTx(tx));

// ------------------------------------------------------------------ code at an address
export type CodeKind = "none" | "proxy" | "implementation" | "factory" | "nonceManager" | "expiryVerifier" | "other";
const PROXY_CODE = proxyRuntimeCode(IMPLEMENTATION).toLowerCase();
export function codeKind(state: WorldState, a: string): CodeKind {
  const code = state.code(a);
  if (code === "0x") return "none";
  if (code === PROXY_CODE) return "proxy";
  const l = a.toLowerCase();
  if (l === IMPLEMENTATION.toLowerCase()) return "implementation";
  if (l === FACTORY.toLowerCase()) return "factory";
  if (l === NONCE_MANAGER) return "nonceManager";
  if (l === EXPIRY_VERIFIER) return "expiryVerifier";
  return "other";
}
export const isAccount = (state: WorldState, a: string) => ["proxy", "implementation"].includes(codeKind(state, a));

// ------------------------------------------------------------------ gas
/** Gas limit charged up front: max(intrinsic + every frame's limits, mandatory + calldata floor + state limits). */
export function frameGasLimit(tx: FrameTransaction): bigint {
  const m = frameGasModel(tx);
  const exec = tx.frames.reduce((s, f) => s + f.limits.execution, 0n);
  const state = tx.frames.reduce((s, f) => s + f.limits.state, 0n);
  const standard = m.intrinsic + exec + state;
  const floored = m.mandatory + m.floor + state;
  return standard > floored ? standard : floored;
}
export const effectivePrice = (fees: FrameTransaction["fees"], baseFee: bigint) =>
  fees.maxFeePerGas < baseFee + fees.maxPriorityFeePerGas ? fees.maxFeePerGas : baseFee + fees.maxPriorityFeePerGas;
/** Gas used: mandatory + max(calldata + execution, floor), plus state gas (estimate.ts, frameGasModel). */
export function frameGasUsed(tx: FrameTransaction, frames: { gas: bigint; stateGas: bigint }[]): bigint {
  const m = frameGasModel(tx);
  const exec = frames.reduce((s, f) => s + f.gas, 0n), state = frames.reduce((s, f) => s + f.stateGas, 0n);
  return m.floored(m.intrinsic + exec) + state;
}
const gasNumber = (limit: bigint) => Number(limit > 2n ** 52n ? 2n ** 52n : limit);
const words = (n: number) => Math.ceil(n / 32);

// ------------------------------------------------------------------ checks before any frame runs
/** What ethrex refuses outright, and what this model does not cover. Throws ProtocolRefusal. */
export function protocolChecks(tx: FrameTransaction, world: WorldState, ctx: BlockCtx): void {
  const statics = frameTxNonceAndRootsViolation(tx);
  if (statics) throw new ProtocolRefusal(-32602, statics);
  if (tx.recentRootReferences.length) throw notModelled("EIP-8272 recent-root references");
  if (tx.blobVersionedHashes.length) throw notModelled("blob transactions");
  if (tx.frames.length === 0 || tx.frames.length > 64) throw new ProtocolRefusal(-32602, `a frame transaction has 1 to 64 frames, got ${tx.frames.length}`);
  const isAddressHex = (h: string) => /^0x[0-9a-fA-F]{40}$/.test(h);
  if (!isAddressHex(tx.sender)) throw new ProtocolRefusal(-32602, `sender must be 20 bytes, got ${tx.sender}`);
  tx.signatures.forEach((s, i) => {
    if (s.signer !== "0x" && !isAddressHex(s.signer)) throw new ProtocolRefusal(-32602, `signature ${i}: signer must be empty or 20 bytes`);
  });
  tx.frames.forEach((f, i) => {
    if (f.target !== null && !isAddressHex(f.target)) throw new ProtocolRefusal(-32602, `frame ${i}: target must be empty or 20 bytes`);
    if (![FRAME_MODE.DEFAULT, FRAME_MODE.VERIFY, FRAME_MODE.SENDER].includes(f.mode as 0 | 1 | 2)) throw new ProtocolRefusal(-32602, `frame ${i}: unknown mode ${f.mode}`);
    if (f.limits.execution > UINT64_MAX || f.limits.state > UINT64_MAX) throw new ProtocolRefusal(-32602, `frame ${i}: gas limits must fit in 64 bits`);
    if (f.value >= UINT256) throw new ProtocolRefusal(-32602, `frame ${i}: value must fit in 256 bits`);
    if (f.value !== 0n && f.mode !== FRAME_MODE.SENDER) throw new ProtocolRefusal(-32602, `frame ${i}: only SENDER frames may carry value`);
  });
  if (tx.chainId !== ctx.chainId) throw new ProtocolRefusal(-32000, `Vm execution error: Invalid Transaction: Invalid chain id (expected ${ctx.chainId}, got ${tx.chainId})`);
  if (!isAccount(world, tx.sender)) {
    throw notModelled(`frame transactions from ${tx.sender}: it has no Winterlock account code (EOA default code is not modelled)`);
  }
  if (tx.fees.maxPriorityFeePerGas > tx.fees.maxFeePerGas) throw new ProtocolRefusal(-32000, "Vm execution error: Invalid Transaction: Priority fee is greater than max fee per gas");
  if (tx.fees.maxFeePerGas < ctx.baseFee) throw new ProtocolRefusal(-32000, "Vm execution error: Invalid Transaction: Insufficient max fee per gas");
  for (const key of tx.nonceKeys) {
    const expected = key === 0n ? world.nonce(tx.sender) : world.sload(NONCE_MANAGER, BigInt(nonceManagerSlot(getAddress(tx.sender), key)));
    if (expected !== tx.nonceSeq) throw new ProtocolRefusal(-32000, `Nonce mismatch: expected ${expected}, got ${tx.nonceSeq}`);
  }
}

/** The validation prefix this model runs: [expiry_verify to the expiry verifier] self_verify on the sender. */
function modelledPrefix(tx: FrameTransaction): { verifyIndex: number; error: string | null; violation: string | null } {
  const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
  if (!prefix) return { verifyIndex: -1, error: "frame transaction validation prefix not recognized", violation: null };
  const only = prefix.frames.length === 1 && prefix.frames[0]!.role === "payer" ? prefix.frames[0]! : null;
  const verify = only ? tx.frames[only.frameIndex]! : null;
  const ok = only && classifyFrame(verify!) === FRAME_SUBCLASS.SELF_VERIFY && (verify!.target === null || verify!.target.toLowerCase() === tx.sender.toLowerCase()) &&
    (only.frameIndex === 0 || (only.frameIndex === 1 && tx.frames[0]!.target?.toLowerCase() === EXPIRY_VERIFIER));
  if (!ok) return { verifyIndex: -1, error: "fakechain models only the [expiry_verify] self_verify validation prefix (no deploy, pre_verify or paymaster frames)", violation: null };
  const structural = validateStructuralRules(tx, prefix);
  for (let i = only.frameIndex + 1; i < tx.frames.length; i++) {
    if (tx.frames[i]!.flags !== 0 && tx.frames[i]!.mode !== FRAME_MODE.VERIFY) {
      return { verifyIndex: -1, error: `fakechain does not model flags on frames after the validation prefix (frame ${i} has ${tx.frames[i]!.flags})`, violation: null };
    }
  }
  return { verifyIndex: only.frameIndex, error: null, violation: structural.valid ? null : structural.reason };
}

// ------------------------------------------------------------------ the run
export function runFrameTx(tx: FrameTransaction, world: WorldState, ctx: BlockCtx, opts: ModelOpts): RunResult {
  protocolChecks(tx, world, ctx);
  const sigHash = computeSigHash(tx);
  const gasLimit = frameGasLimit(tx);
  const maxCost = gasLimit * tx.fees.maxFeePerGas;
  const price = effectivePrice(tx.fees, ctx.baseFee);
  const out: RunResult = {
    hash: frameTxHash(tx), sender: getAddress(tx.sender), sigHash, gasLimit, maxCost, effectivePrice: price, prefixShape: null, canonicalViolation: null,
    signatureError: null, shapeError: null, prefixFailure: null, frames: null, gasUsed: null, approval: null, post: null, verifyIndex: -1,
  };

  // The protocol validates every signature entry before any frame runs.
  const bad = tx.signatures.findIndex((s) => !validateSignature(s, tx.sender, sigHash));
  if (bad >= 0) return { ...out, signatureError: bad };

  const shape = modelledPrefix(tx);
  if (shape.error) return { ...out, shapeError: shape.error };
  out.prefixShape = "SelfVerify";
  out.canonicalViolation = shape.violation;
  out.verifyIndex = shape.verifyIndex;

  const sender = getAddress(tx.sender);
  const state = world.clone();
  const access = new Set<string>([sender.toLowerCase(), ctx.coinbase.toLowerCase(), ENTRY_POINT]);
  const warm = new Map<string, Set<bigint>>(); // storage slots already read in this transaction, per address
  const frames: FrameResult[] = [];

  // 1. The expiry frame: 8 bytes of deadline, reverts once the block's timestamp is later (EXPIRY_VERIFIER_CODE).
  if (shape.verifyIndex === 1) {
    const f = tx.frames[0]!;
    const entry = access.has(EXPIRY_VERIFIER) ? 100 : 3_000;
    access.add(EXPIRY_VERIFIER);
    const fail = (haltReason: string, haltDetail: string, revertData?: Hex): RunResult => ({ ...out, prefixFailure: { failedFrameIndex: 0, haltReason, haltDetail, ...(revertData !== undefined ? { revertData } : {}) } });
    if (gasNumber(f.limits.execution) < entry + 51) return fail("out_of_gas", "Out Of Gas");
    if (size(f.data) !== 8) return fail("revert", "the frame reverted", "0x");
    if (ctx.timestamp > BigInt(f.data)) return fail("revert", "the frame reverted", "0x");
    frames.push({ status: "success", gas: BigInt(entry + 51), stateGas: 0n, logs: [] });
  }

  // 2. The account's verify frame, through its EIP-1167 proxy.
  const vi = shape.verifyIndex;
  const vf = tx.frames[vi]!;
  const view: TxView = {
    nonceKeys: tx.nonceKeys, nonceSeq: tx.nonceSeq, sigHash, maxCost, chainId: ctx.chainId, currentFrame: vi,
    frames: tx.frames.map((f) => ({ mode: f.mode, target: getAddress(f.target ?? sender), dataLength: size(f.data), value: f.value })),
    signatures: tx.signatures.map((s) => ({
      scheme: s.scheme, msgEmpty: s.msg === "0x", resolvedSigner: s.scheme === SIG_SCHEME.ARBITRARY ? null : resolvedSigner(s, sender), bytes: hexToBytes(s.signature),
    })),
  };
  const viaProxy = codeKind(state, sender) === "proxy";
  const limit = gasNumber(vf.limits.execution);
  const pre = viaProxy ? VERIFY_GAS.proxyPreCall : 100;
  const failVerify = (haltReason: string, haltDetail: string, revertData?: Hex): RunResult =>
    ({ ...out, prefixFailure: { failedFrameIndex: vi, haltReason, haltDetail, ...(revertData !== undefined ? { revertData } : {}) } });
  if (limit < pre) return failVerify("out_of_gas", "Out Of Gas");
  if (viaProxy) access.add(IMPLEMENTATION.toLowerCase());
  const meter = new Meter(viaProxy ? calleeBudget(limit, pre, opts.proxyHoldback) : limit - pre);
  let approval: Approval;
  try {
    approval = verifyFrame(view, { sload: (slot) => state.sload(sender, slot) }, meter);
  } catch (e) {
    if (e instanceof Revert) return failVerify("revert", "the frame reverted", e.data);
    if (e instanceof OutOfGas) {
      // The account's code ran dry inside the proxy's DELEGATECALL; the proxy then reverts with the empty return data.
      return viaProxy ? failVerify("revert", `the account ran out of gas inside the proxy's DELEGATECALL (budget ${meter.budget} of the frame's ${limit}); the proxy reverted with no data`, "0x")
        : failVerify("out_of_gas", "Out Of Gas");
    }
    throw e;
  }
  const verifyGas = pre + meter.used;
  out.approval = { ...approval, gas: verifyGas };
  warm.set(sender.toLowerCase(), new Set(approval.hot ? [0n, 1n, 2n, 3n, 4n, 5n] : [0n, 1n, 2n]));

  // 3. APPROVE(payment): the payer escrows the maximum cost, and every nonce key is consumed.
  const balance = state.balance(sender);
  if (balance < maxCost) {
    return { ...out, prefixFailure: { failedFrameIndex: vi, haltReason: "insufficient_funds", haltDetail: "the payer cannot cover the maximum cost", account: sender, balance, required: maxCost } };
  }
  state.addBalance(sender, -maxCost);
  for (const key of tx.nonceKeys) {
    if (key === 0n) state.setNonce(sender, state.nonce(sender) + 1n);
    else state.sstore(NONCE_MANAGER, BigInt(nonceManagerSlot(sender, key)), tx.nonceSeq + 1n);
  }
  access.add(NONCE_MANAGER);
  frames.push({ status: "success", gas: BigInt(verifyGas), stateGas: 0n, logs: [] });

  // 4. Every later frame. A failed frame undoes only its own effects; the key stays used.
  let current = state;
  for (let i = vi + 1; i < tx.frames.length; i++) {
    const r = runBodyFrame(i, tx, current, world, ctx, opts, access, warm);
    frames.push(r.result);
    if (r.state) current = r.state;
  }

  // 5. Gas: the floor-aware total, the refund of the unused escrow, the priority fee to the block producer.
  const gasUsed = frameGasUsed(tx, frames);
  current.addBalance(sender, maxCost - gasUsed * price);
  current.addBalance(ctx.coinbase, gasUsed * (price - ctx.baseFee));
  return { ...out, frames, gasUsed, post: current };
}

/** One frame after the prefix, run on a copy of the state that replaces it only when the frame succeeds. */
function runBodyFrame(i: number, tx: FrameTransaction, state: WorldState, original: WorldState, ctx: BlockCtx, opts: ModelOpts, access: Set<string>, warm: Map<string, Set<bigint>>): { result: FrameResult; state: WorldState | null } {
  const f = tx.frames[i]!;
  const sender = getAddress(tx.sender);
  const target = getAddress(f.target ?? sender);
  const limit = gasNumber(f.limits.execution);
  const meter = new Meter(limit);
  const stateMeter = new StateMeter(f.limits.state);
  const scratch = state.clone();
  try {
    meter.charge(access.has(target.toLowerCase()) ? 100 : 3_000); // frame entry, cold or warm target
    access.add(target.toLowerCase());
    const { logs } = executeCall({
      state: scratch, original, from: f.mode === FRAME_MODE.SENDER ? sender : ENTRY_POINT, to: target, value: f.value,
      data: hexToBytes(f.data), meter, stateMeter, ctx, opts, access, warm, defaultFrame: f.mode !== FRAME_MODE.SENDER,
    });
    return { result: { status: "success", gas: BigInt(meter.used), stateGas: stateMeter.used, logs }, state: scratch };
  } catch (e) {
    const failed = callFailure(e, f.limits.state);
    return { result: { status: "reverted", gas: failed.outOfGas ? BigInt(limit) : BigInt(Math.min(meter.used, limit)), stateGas: 0n, logs: [], reason: failed.reason }, state: null };
  }
}

/** Why a call stopped, in fakechain's words, and whether it burned all its gas. Rethrows anything else. */
export function callFailure(e: unknown, stateLimit?: bigint): { reason: string; outOfGas: boolean; data: Hex } {
  if (e instanceof Revert) return { reason: decodeReason(e.data) ?? (e.reason || "reverted with no data"), outOfGas: false, data: e.data };
  if (e instanceof OutOfGas) {
    return { reason: e.kind === "state" ? `out of state gas${stateLimit !== undefined ? `: the state limit is ${stateLimit}` : ""}` : "out of gas", outOfGas: true, data: "0x" };
  }
  throw e;
}

export interface CallParams {
  /** mutated in place: the caller passes a copy and keeps it only when the call succeeds */
  state: WorldState;
  /** the state at the start of the transaction, for SSTORE pricing */
  original: WorldState;
  from: Address;
  to: Address;
  value: bigint;
  data: Uint8Array;
  meter: Meter;
  stateMeter: StateMeter;
  ctx: BlockCtx;
  opts: ModelOpts;
  access: Set<string>;
  warm: Map<string, Set<bigint>>;
  /** a DEFAULT frame calls with the entry point as caller */
  defaultFrame?: boolean;
}

/**
 * One call: the value moves first (a new account costs 183,600 state gas), then the target's code runs as modelled:
 * the account (through its proxy), the factory, the two system contracts; other code succeeds at a fixed cost.
 * Throws Revert or OutOfGas, as the EVM would stop the call.
 */
export function executeCall(p: CallParams): { returnData: Hex; logs: Log[] } {
  const { state, from, to, value, data, meter, stateMeter } = p;
  if (value > 0n) {
    if (state.balance(from) < value) throw new Revert("value exceeds the sender's balance", "0x");
    const created = state.isEmpty(to) && to.toLowerCase() !== from.toLowerCase();
    state.addBalance(from, -value);
    state.addBalance(to, value);
    if (created) stateMeter.charge(183_600n); // a new account (EIP-8037)
  }
  const kind = codeKind(state, to);
  if (kind === "proxy" || kind === "implementation") {
    if (p.defaultFrame) throw new Revert("fakechain does not model a DEFAULT frame into an account", "0x");
    const viaProxy = kind === "proxy";
    if (viaProxy) {
      meter.charge(24 + 6 * words(data.length)); // the proxy's opcodes and its calldata copy
      meter.charge(p.access.has(IMPLEMENTATION.toLowerCase()) ? 100 : 3_000);
      p.access.add(IMPLEMENTATION.toLowerCase());
    }
    const budget = viaProxy ? calleeBudget(meter.budget, meter.used, p.opts.proxyHoldback) : meter.budget - meter.used;
    const callee = new Meter(budget);
    const slots = p.warm.get(to.toLowerCase()) ?? new Set<bigint>();
    p.warm.set(to.toLowerCase(), slots);
    const storage = new StorageCtx((s) => state.sload(to, s), (s) => p.original.sload(to, s), (s, v) => state.sstore(to, s, v), slots, callee, stateMeter);
    let out: { returnData: Hex };
    try {
      out = accountCall(data, to.toLowerCase() === from.toLowerCase(), storage, callee);
    } catch (e) {
      const dry = e instanceof OutOfGas && e.kind === "execution";
      meter.used += dry ? budget : callee.used; // what the account's code burned before it stopped
      if (dry && viaProxy) throw new Revert("the account ran out of gas inside the proxy; the proxy reverted with no data", "0x");
      throw e; // a revert bubbles up through the proxy with its data
    }
    meter.charge(callee.used + (viaProxy ? 30 : 0));
    return { returnData: out.returnData, logs: [] };
  }
  if (kind === "factory") {
    const r = factoryCall(data, state, meter, stateMeter, value);
    return { returnData: r.returnData, logs: r.logs };
  }
  if (kind === "nonceManager") throw new Revert("the nonce manager's code is revert(0, 0)", "0x");
  if (kind === "expiryVerifier") {
    meter.charge(51);
    if (data.length !== 8 || p.ctx.timestamp > BigInt(`0x${Buffer.from(data).toString("hex")}`)) throw new Revert("the expiry verifier reverted", "0x");
    return { returnData: "0x", logs: [] };
  }
  if (kind === "other") meter.charge(2_000); // code this model does not run: a fixed modelled cost, success
  return { returnData: "0x", logs: [] };
}
