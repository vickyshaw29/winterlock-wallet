// A frame transaction carried as an ERC-4337 user operation, so MetaMask Flask can send it (Nov 6, approved by Vicky).
// MetaMask sends user operations only for an Account Snap's account (type eip155:erc4337), to the bundler URL the Snap
// names; it never touches an EntryPoint. Nothing on chain is ERC-4337: the user operation is only the envelope.
//
//   nonce                 nonceKey << 64: an ERC-4337 nonce is a 192-bit key and a 64-bit sequence, ours is key ‖ 0
//   callData              WL_CALLS_PREFIX ‖ abi.encode((address to, uint256 value, bytes data)[]): the SENDER frames
//   verificationGasLimit  the execution limits of the expiry and self_verify frames
//   callGasLimit          the SENDER frames' execution limits
//   preVerificationGas    the rest of the transaction's gas limit (intrinsic, calldata floor, state gas), so the three
//                         sum to an upper bound of ethrex's total gas limit and MetaMask's "max fee" is an upper bound
//   maxFeePerGas, maxPriorityFeePerGas  the frame transaction's fees, exactly
//   initCode, paymasterAndData          empty: accounts are created by an EOA call to the factory and pay for themselves
//   signature             the whole signed frame transaction, 0x06 ‖ rlp, in canonical encoding
//
// checkUserOpTx is the one check both ends run: the Snap on what it signed, before the signature leaves it, and the
// local bundler before it sends anything. It ties every frame, fee and limit of the transaction to the user operation
// MetaMask showed the user, so a transaction that pays anyone else, more, or at another fee is never sent.
// Written with Claude Code (AI) for Vicky.
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, type Address, type Hex } from "viem";
import { DEFAULTS, MAX_VERIFY_GAS } from "./config.ts";
import { buildFrameTx, expiryFrame, prefixBudget, selfVerifyFrame, senderFrame, type Call } from "./builder.ts";
import { placeholders, type SignatureSlot } from "./signer.ts";
import { laneCost } from "./lanes.ts";
import { decodeFrameTx, encodeRawFrameTx } from "./codec/codec.ts";
import { FRAME_MODE, FRAME_TX_TYPE, SIG_SCHEME, type Frame, type FrameTransaction } from "./codec/FrameTx.ts";

/** "WL", version 0001: the four bytes before the ABI-encoded calls. */
export const WL_CALLS_PREFIX: Hex = "0x574c0001";
/** At most this many SENDER frames per user operation. */
export const USEROP_MAX_CALLS = 16;
/**
 * How far the signer may raise the last SENDER frame's execution limit while grinding (one gas per try, fees stay
 * exactly what the user approved). The envelope MetaMask shows is computed with this headroom already added.
 */
export const USEROP_GRIND_HEADROOM = 4_096;
/** What MetaMask Flask passes as the EntryPoint (builds.yml, EIP_4337_ENTRYPOINT, v0.6). Nothing calls it. */
export const FLASK_ENTRYPOINT: Address = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";

const CALLS_ABI = [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }] as const;
const U64 = (1n << 64n) - 1n;
const lower = <T extends string>(s: T) => s.toLowerCase() as T;

export class UserOpError extends Error {}
const fail = (msg: string): never => { throw new UserOpError(msg); };

export interface Intent { to: Address; value: bigint; data: Hex }

/** callData for these calls. */
export function encodeIntents(intents: Intent[]): Hex {
  if (intents.length === 0 || intents.length > USEROP_MAX_CALLS) fail(`a user operation carries 1 to ${USEROP_MAX_CALLS} calls, got ${intents.length}`);
  const body = encodeAbiParameters(CALLS_ABI, [intents.map((c) => ({ to: c.to, value: c.value, data: c.data }))]);
  return lower(`${WL_CALLS_PREFIX}${body.slice(2)}` as Hex);
}

/** The calls in a callData; strict: the prefix, 1 to 16 calls, and the canonical encoding only. */
export function decodeIntents(callData: Hex): Intent[] {
  const h = lower(callData);
  if (!/^0x([0-9a-f]{2})*$/.test(h)) fail("callData is not hex bytes");
  if (!h.startsWith(WL_CALLS_PREFIX)) fail("callData is not a Winterlock call list (prefix 0x574c0001)");
  let decoded: readonly { to: Address; value: bigint; data: Hex }[];
  try {
    [decoded] = decodeAbiParameters(CALLS_ABI, `0x${h.slice(WL_CALLS_PREFIX.length)}`);
  } catch (e) {
    return fail(`callData does not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  const intents = decoded.map((c) => ({ to: lower(c.to), value: c.value, data: lower(c.data) }));
  if (encodeIntents(intents) !== h) fail("callData is not in canonical encoding");
  return intents;
}

/** The user operation nonce that names this nonce key at sequence 0. */
export function userOpNonce(nonceKey: bigint): bigint {
  if (nonceKey <= 0n || nonceKey >= 1n << 192n) fail(`nonce key must be in (0, 2^192), got ${nonceKey}`);
  return nonceKey << 64n;
}

/** The nonce key a user operation nonce names; its sequence part must be 0 (a fresh key, as the account requires). */
export function nonceKeyOf(nonce: bigint): bigint {
  if (nonce < 0n || nonce >= 1n << 256n) fail("nonce out of range");
  if ((nonce & U64) !== 0n) fail(`nonce sequence must be 0, got ${nonce & U64}: every Winterlock transaction uses a fresh nonce key`);
  const key = nonce >> 64n;
  if (key === 0n) fail("nonce key 0 is the legacy nonce, which the account refuses");
  return key;
}

/** A user operation with its numbers read strictly (0x hex only, lowercase out). */
export interface UserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const BYTES = /^0x([0-9a-fA-F]{2})*$/;

export function parseUserOp(raw: unknown): UserOp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("the user operation must be an object");
  const o = raw as Record<string, unknown>;
  const num = (k: string): bigint => {
    const v = o[k];
    if (typeof v !== "string" || !QUANTITY.test(v) || v.length > 66) return fail(`${k} must be a 0x quantity of at most 256 bits`);
    return BigInt(v);
  };
  const bytes = (k: string): Hex => {
    const v = o[k];
    if (typeof v !== "string" || !BYTES.test(v)) return fail(`${k} must be 0x bytes`);
    return lower(v as Hex);
  };
  const sender = o.sender;
  if (typeof sender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(sender)) fail("sender must be an address");
  return {
    sender: lower(sender as Address), nonce: num("nonce"), initCode: bytes("initCode"), callData: bytes("callData"),
    callGasLimit: num("callGasLimit"), verificationGasLimit: num("verificationGasLimit"), preVerificationGas: num("preVerificationGas"),
    maxFeePerGas: num("maxFeePerGas"), maxPriorityFeePerGas: num("maxPriorityFeePerGas"),
    paymasterAndData: bytes("paymasterAndData"), signature: bytes("signature"),
  };
}

/** The three gas fields for a transaction: sums of its frames' limits, and the rest of its total gas limit. */
export interface Envelope { verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint }

export function envelopeOf(tx: FrameTransaction): Envelope {
  const selfVerify = tx.frames.findIndex((f) => f.mode === FRAME_MODE.VERIFY && f.target === null);
  if (selfVerify < 0) fail("no self_verify frame");
  const verificationGasLimit = tx.frames.slice(0, selfVerify + 1).reduce((s, f) => s + f.limits.execution, 0n);
  const callGasLimit = tx.frames.slice(selfVerify + 1).reduce((s, f) => s + f.limits.execution, 0n);
  const total = laneCost(tx).gasLimit;
  const preVerificationGas = total - verificationGasLimit - callGasLimit;
  if (preVerificationGas < 0n) fail("internal: the total gas limit is below the frames' execution limits");
  return { verificationGasLimit, callGasLimit, preVerificationGas };
}

/**
 * The envelope to declare at prepare time, before fees, deadline or grinding are known: the transaction built with
 * placeholder signatures (priced as non-zero bytes) and the last call's limit raised by the whole grind headroom, so
 * whatever is signed later fits it. Fees and the deadline do not change the gas (fees are not billed bytes, the
 * deadline is always 8 bytes).
 */
export function envelopeFor(p: { chainId: bigint; sender: Address; nonceKey: bigint; verifyGas: bigint; calls: Call[]; slots: SignatureSlot[] }): Envelope & { signatureBytes: number } {
  const last = p.calls.at(-1);
  if (!last) fail("a user operation needs at least one call");
  const calls = p.calls.map((c, i) => (i === p.calls.length - 1 ? { ...c, gas: (c.gas ?? DEFAULTS.transferGas) + BigInt(USEROP_GRIND_HEADROOM) } : c));
  const tx = buildFrameTx({
    chainId: p.chainId, sender: p.sender, nonce: { keys: [p.nonceKey], seq: 0n }, verifyGas: p.verifyGas, calls,
    deadline: 0xffff_ffff, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, signatures: placeholders(p.slots),
  });
  return { ...envelopeOf(tx), signatureBytes: (encodeRawFrameTx(tx).length - 2) / 2 + 64 };
}

/** The signed frame transaction a user operation carries in its signature: 0x06 ‖ rlp, canonical. */
export function txOfSignature(signature: Hex): FrameTransaction {
  const h = lower(signature);
  if (!BYTES.test(h) || h.length < 4) fail("the signature does not hold a frame transaction");
  if (parseInt(h.slice(2, 4), 16) !== FRAME_TX_TYPE) fail(`the signature does not start with the frame transaction type 0x0${FRAME_TX_TYPE.toString(16)}`);
  let tx: FrameTransaction;
  try {
    tx = decodeFrameTx(hexToBytes(`0x${h.slice(4)}`));
  } catch (e) {
    return fail(`the frame transaction does not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (lower(encodeRawFrameTx(tx)) !== h) fail("the frame transaction is not in canonical encoding");
  return tx;
}

const sameFrame = (a: Frame, b: Frame) =>
  a.mode === b.mode && a.flags === b.flags && (a.target === null ? b.target === null : b.target !== null && lower(a.target) === lower(b.target)) &&
  a.limits.execution === b.limits.execution && a.limits.state === b.limits.state && a.value === b.value && lower(a.data) === lower(b.data);

export interface CheckOptions {
  chainId: bigint;
  /** unix seconds; the deadline must be after it */
  now: number;
  /** the longest deadline accepted, in seconds from now (default 1 day, sendKeyed's limit) */
  maxExpirySeconds?: number;
}

/**
 * Throws UserOpError unless `tx` is exactly the transaction `op` describes:
 *   - same chain, sender, and nonce key at sequence 0;
 *   - frames: one expiry frame with a deadline after `now`, one self_verify frame, then one SENDER frame per call in
 *     callData, same target, value and data, in order; nothing else (no deploy frame, no DEFAULT frame);
 *   - fees exactly the user operation's, no blob fee, no blobs, no recent-root references;
 *   - limits inside the envelope: prefix ≤ verificationGasLimit, SENDER frames ≤ callGasLimit, and the transaction's
 *     total gas limit (laneCost) ≤ the sum of the three gas fields, so it can never cost more than MetaMask showed;
 *     prefix plus signature costs ≤ MAX_VERIFY_GAS;
 *   - one signature entry, ARBITRARY, signer and msg empty (the account's hash-based entry; hybrid is off);
 *   - initCode and paymasterAndData empty.
 * It does not verify the WOTS+ signature: the account does that on chain, and a preflight shows it before sending.
 */
export function checkUserOpTx(op: UserOp, tx: FrameTransaction, o: CheckOptions): void {
  if (tx.chainId !== o.chainId) fail(`the transaction is for chain ${tx.chainId}, not ${o.chainId}`);
  if (lower(tx.sender) !== op.sender) fail(`the transaction's sender ${tx.sender} is not the user operation's ${op.sender}`);
  if (op.initCode !== "0x") fail("initCode must be empty: accounts are created by an EOA call to the factory");
  if (op.paymasterAndData !== "0x") fail("paymasterAndData must be empty: the account pays for itself");
  const key = nonceKeyOf(op.nonce);
  if (tx.nonceKeys.length !== 1 || tx.nonceKeys[0] !== key) fail(`the transaction's nonce keys [${tx.nonceKeys.map((k) => `0x${k.toString(16)}`).join(", ")}] are not [0x${key.toString(16)}]`);
  if (tx.nonceSeq !== 0n) fail(`the transaction's nonce sequence is ${tx.nonceSeq}, not 0`);

  const intents = decodeIntents(op.callData);
  if (tx.frames.length !== 2 + intents.length) fail(`the transaction has ${tx.frames.length} frames; expected expiry, self_verify and ${intents.length} call(s)`);
  const [expiry, verify, ...calls] = tx.frames as [Frame, Frame, ...Frame[]];
  if (!/^0x[0-9a-f]{16}$/.test(lower(expiry.data))) fail("frame 0 is not an expiry frame with an 8-byte deadline");
  const deadline = Number(BigInt(expiry.data));
  if (!sameFrame(expiry, expiryFrame(deadline))) fail("frame 0 is not the expiry frame");
  if (deadline <= o.now) fail(`the deadline ${deadline} has passed (now ${o.now})`);
  const maxExpiry = o.maxExpirySeconds ?? 86_400;
  if (deadline > o.now + maxExpiry) fail(`the deadline ${deadline} is more than ${maxExpiry} s away`);
  if (!sameFrame(verify, selfVerifyFrame(verify.limits.execution))) fail("frame 1 is not the self_verify frame");
  calls.forEach((f, i) => {
    const want = senderFrame({ to: intents[i]!.to, value: intents[i]!.value, data: intents[i]!.data, gas: f.limits.execution, stateGas: f.limits.state });
    if (!sameFrame(f, want)) fail(`frame ${i + 2} is not call ${i} of the user operation (SENDER to ${intents[i]!.to}, value ${intents[i]!.value})`);
  });

  if (tx.fees.maxFeePerGas !== op.maxFeePerGas) fail(`maxFeePerGas ${tx.fees.maxFeePerGas} is not the user operation's ${op.maxFeePerGas}`);
  if (tx.fees.maxPriorityFeePerGas !== op.maxPriorityFeePerGas) fail(`maxPriorityFeePerGas ${tx.fees.maxPriorityFeePerGas} is not the user operation's ${op.maxPriorityFeePerGas}`);
  if (tx.fees.maxFeePerBlobGas !== 0n || tx.blobVersionedHashes.length) fail("blobs are not allowed");
  if (tx.recentRootReferences.length) fail("recent-root references are not allowed");

  if (tx.signatures.length !== 1) fail(`${tx.signatures.length} signature entries; expected one hash-based entry`);
  const [sig] = tx.signatures;
  if (sig!.scheme !== SIG_SCHEME.ARBITRARY || sig!.signer !== "0x" || sig!.msg !== "0x" || sig!.signature === "0x") fail("the signature entry is not one ARBITRARY entry with empty signer and msg");

  if (prefixBudget(tx) > MAX_VERIFY_GAS) fail(`the validation prefix declares ${prefixBudget(tx)} gas, above ${MAX_VERIFY_GAS}`);
  const env = envelopeOf(tx);
  if (env.verificationGasLimit > op.verificationGasLimit) fail(`the prefix limits ${env.verificationGasLimit} exceed verificationGasLimit ${op.verificationGasLimit}`);
  if (env.callGasLimit > op.callGasLimit) fail(`the SENDER limits ${env.callGasLimit} exceed callGasLimit ${op.callGasLimit}`);
  const gasLimit = laneCost(tx).gasLimit;
  const shown = op.verificationGasLimit + op.callGasLimit + op.preVerificationGas;
  if (gasLimit > shown) fail(`the transaction's gas limit ${gasLimit} exceeds the ${shown} the user operation declares`);
}

/** The deadline of a checked transaction (its expiry frame's data). */
export const deadlineOf = (tx: FrameTransaction): number => Number(BigInt(tx.frames[0]!.data));

/** The user operation's whole envelope as MetaMask's keyring API wants it: lowercase 0x quantities. */
export const quantity = (n: bigint): Hex => `0x${n.toString(16)}`;

/** The intents a transfer list maps to, from MetaMask's eth_prepareUserOperation params. */
export function parseIntents(raw: unknown): Intent[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > USEROP_MAX_CALLS) fail(`expected 1 to ${USEROP_MAX_CALLS} transaction intents`);
  return (raw as unknown[]).map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.to)) fail(`intent ${i}: to must be an address`);
    const value = o.value ?? "0x0";
    if (typeof value !== "string" || !QUANTITY.test(value) || value.length > 66) fail(`intent ${i}: value must be a 0x quantity`);
    const data = o.data ?? "0x";
    if (typeof data !== "string" || !BYTES.test(data)) fail(`intent ${i}: data must be 0x bytes`);
    return { to: lower(o.to as Address), value: BigInt(value as string), data: lower(data as Hex) };
  });
}

