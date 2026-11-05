// Builds frame transactions: frame order, nonce fields, and the prefix budget the sidecar enforces.
// Layout (spec, "Transaction format"): [expiry_verify] [deploy] self_verify user_op...
import { concat, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { APPROVE_SCOPE, FRAME_MODE, type Frame, type FrameTransaction, type SignatureEntry } from "./codec/FrameTx.ts";
import { DEFAULTS, EXPIRY_VERIFIER, MAX_VERIFY_GAS, SIG_SCHEME_COST } from "./config.ts";

// ------------------------------------------------------------------ nonce fields

export interface NonceFields { keys: bigint[]; seq: bigint }

/**
 * Shared interfaces 3: a hash-signed transaction uses one fresh nonce key, (epoch << 32) | leaf,
 * at sequence 0. The account requires sequence 0, so a used key can never sign again.
 */
export function nonceKeyFor(epoch: number, leaf: number): bigint {
  for (const [name, v] of [["epoch", epoch], ["leaf", leaf]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${name} must be a uint32, got ${v}`);
  }
  const key = (BigInt(epoch) << 32n) | BigInt(leaf);
  // Epoch 0, leaf 0 would be key 0, which is the legacy account nonce, not a keyed lane.
  if (key === 0n) throw new Error("epoch 0, leaf 0 gives nonce key 0 (the legacy nonce); that leaf cannot sign");
  return key;
}

export const splitNonceKey = (key: bigint) => ({ epoch: Number(key >> 32n), leaf: Number(key & 0xffff_ffffn) });

/** Every hash-signed transaction. */
export const keyedNonce = (epoch: number, leaf: number): NonceFields => ({ keys: [nonceKeyFor(epoch, leaf)], seq: 0n });

/** The deployment transaction only: on the devnet the legacy nonce is the key list [0] (Day-0). */
export const legacyNonce = (accountNonce: bigint): NonceFields => ({ keys: [0n], seq: accountNonce });

/** NONCE_MANAGER storage slot holding (sender, key)'s sequence: keccak256(pad32(sender) ‖ key). */
export const nonceManagerSlot = (sender: Address, key: bigint): Hex => keccak256(concat([pad(sender), pad(toHex(key))]));

// ------------------------------------------------------------------ frames

/** VERIFY frame to EXPIRY_VERIFIER: reverts once block.timestamp is later than the deadline. */
export function expiryFrame(deadlineUnixSeconds: number): Frame {
  return {
    mode: FRAME_MODE.VERIFY,
    flags: APPROVE_SCOPE.NONE,
    target: EXPIRY_VERIFIER,
    limits: { execution: DEFAULTS.expiryFrameGas, state: 0n },
    value: 0n,
    data: toHex(BigInt(deadlineUnixSeconds), { size: 8 }), // 8-byte big-endian unix timestamp
  };
}

/** VERIFY frame on the sender itself, approving execution and payment. */
export function selfVerifyFrame(executionLimit: bigint): Frame {
  return {
    mode: FRAME_MODE.VERIFY,
    flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
    target: null,
    limits: { execution: executionLimit, state: 0n },
    value: 0n,
    data: "0x",
  };
}

/** DEFAULT frame calling the factory; must land code at tx.sender. */
export function deployFrame(factory: Address, calldata: Hex, limits: { execution: bigint; state: bigint }): Frame {
  return { mode: FRAME_MODE.DEFAULT, flags: APPROVE_SCOPE.NONE, target: factory, limits, value: 0n, data: calldata };
}

export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
  /** execution limit, default DEFAULTS.transferGas */
  gas?: bigint;
  /** state limit; at least 183,600 when `to` is a brand-new account */
  stateGas?: bigint;
}

/** SENDER frame: runs with the account as caller and debits `value` from it. */
export function senderFrame(call: Call): Frame {
  return {
    mode: FRAME_MODE.SENDER,
    flags: APPROVE_SCOPE.NONE,
    target: call.to,
    limits: { execution: call.gas ?? DEFAULTS.transferGas, state: call.stateGas ?? 0n },
    value: call.value ?? 0n,
    data: call.data ?? "0x",
  };
}

// ------------------------------------------------------------------ transaction

export interface BuildParams {
  chainId: bigint;
  sender: Address;
  nonce: NonceFields;
  /** declared execution limit of the self_verify frame */
  verifyGas: bigint;
  calls: Call[];
  /** unix seconds; null for no expiry frame */
  deadline: number | null;
  deploy?: { factory: Address; calldata: Hex; limits: { execution: bigint; state: bigint } };
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** final entries or placeholders of the final lengths (see signer.placeholders) */
  signatures: SignatureEntry[];
}

export function buildFrameTx(p: BuildParams): FrameTransaction {
  if (p.calls.length === 0) throw new Error("a transaction needs at least one call");
  const frames: Frame[] = [];
  if (p.deadline !== null) frames.push(expiryFrame(p.deadline));
  if (p.deploy) frames.push(deployFrame(p.deploy.factory, p.deploy.calldata, p.deploy.limits));
  frames.push(selfVerifyFrame(p.verifyGas));
  frames.push(...p.calls.map(senderFrame));
  if (frames.length > 64) throw new Error(`at most 64 frames, got ${frames.length}`);

  const tx: FrameTransaction = {
    chainId: p.chainId,
    nonceKeys: p.nonce.keys,
    nonceSeq: p.nonce.seq,
    sender: p.sender,
    frames,
    signatures: p.signatures,
    fees: { ...p.fees, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
  const budget = prefixBudget(tx);
  if (budget > MAX_VERIFY_GAS) {
    throw new Error(`validation prefix declares ${budget} gas (frames plus signature costs), above the ${MAX_VERIFY_GAS} cap`);
  }
  return tx;
}

/**
 * What the sidecar compares with MAX_VERIFY_GAS: the declared execution limits of every frame up to
 * and including self_verify, plus each signature entry's scheme cost (Day-0 rejection string).
 */
export function prefixBudget(tx: FrameTransaction): bigint {
  const selfVerify = tx.frames.findIndex((f) => f.mode === FRAME_MODE.VERIFY && f.target === null);
  if (selfVerify < 0) throw new Error("no self_verify frame");
  const frames = tx.frames.slice(0, selfVerify + 1).reduce((sum, f) => sum + f.limits.execution, 0n);
  const sigs = tx.signatures.reduce((sum, s) => sum + (SIG_SCHEME_COST[s.scheme] ?? 0n), 0n);
  return frames + sigs;
}
