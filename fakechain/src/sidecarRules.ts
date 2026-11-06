// The sidecar's admission rules, ported so the fake refuses with the sidecar's own words and rule ids.
// Written with Claude Code (AI) for Vicky.
//
// Ported from vendor/mempool-workshop-sidecar (MIT, Copyright (c) 2023 Etherspot), commit 2e22ff0a:
//   packages/types/src/contracts/frameModes.ts            classifyFrame
//   packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts   recognizeValidationPrefix, validateStructuralRules
//   packages/executor/src/services/FrameTxService/signature.ts                  validateSignature (made synchronous with noble)
//   packages/executor/src/services/UserOpValidation/validators/frameTx.ts       describeStructuredFailure, explainFailure
//   packages/executor/src/services/ExplorerService/checkCollector.ts            CheckCollector, rule orders (types/src/explorer)
// The logic is kept as it is upstream, including its exact-string target comparison in validateStructuralRules.
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/p256";
import { APPROVE_SCOPE, ATOMIC_BATCH_FLAG, FRAME_MODE, SIG_SCHEME, type Frame, type FrameTransaction, type SignatureEntry } from "../../pipeline/src/codec/FrameTx.ts";

// ------------------------------------------------------------------ frame subclasses
export const FRAME_SUBCLASS = {
  SELF_VERIFY: "self_verify", ONLY_VERIFY: "only_verify", PAY: "pay", EXPIRY_VERIFY: "expiry_verify",
  DEPLOY_OR_POST_OP: "deploy_or_post_op", USER_OP: "user_op",
} as const;
export type FrameSubclass = (typeof FRAME_SUBCLASS)[keyof typeof FRAME_SUBCLASS];

export function classifyFrame(frame: Frame): FrameSubclass | null {
  const scope = frame.flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT;
  switch (frame.mode) {
    case FRAME_MODE.VERIFY:
      if (scope === APPROVE_SCOPE.EXECUTION_AND_PAYMENT) return FRAME_SUBCLASS.SELF_VERIFY;
      if (scope === APPROVE_SCOPE.EXECUTION) return FRAME_SUBCLASS.ONLY_VERIFY;
      if (scope === APPROVE_SCOPE.PAYMENT) return FRAME_SUBCLASS.PAY;
      return FRAME_SUBCLASS.EXPIRY_VERIFY;
    case FRAME_MODE.DEFAULT:
      return FRAME_SUBCLASS.DEPLOY_OR_POST_OP;
    case FRAME_MODE.SENDER:
      return FRAME_SUBCLASS.USER_OP;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ validation prefix
export const MAX_VERIFY_GAS = 100_000n;
export const MAX_VERIFY_STATE_GAS = 500_000n;
const SIGNATURE_VERIFICATION_GAS_COST: Record<number, bigint> = { [SIG_SCHEME.ARBITRARY]: 100n, [SIG_SCHEME.SECP256K1]: 2_800n, [SIG_SCHEME.P256]: 6_700n };
export const signatureVerificationCost = (tx: FrameTransaction) =>
  tx.signatures.reduce((sum, sig) => sum + (SIGNATURE_VERIFICATION_GAS_COST[sig.scheme] ?? 0n), 0n);

export interface ValidationPrefixMatch {
  payerFrameIndex: number;
  frames: { frame: Frame; frameIndex: number; role: "sender" | "payer" | "factory" }[];
}

const resolvedTarget = (target: Hex | null, txSender: Hex) => getAddress(target ?? txSender);

function matchPreVerify(all: Frame[], approvingIndex: number, approving: Frame, role: "sender" | "payer", txSender: Hex): ValidationPrefixMatch["frames"][number] | null {
  const i = approvingIndex - 1;
  if (i < 0) return null;
  const candidate = all[i]!;
  if (classifyFrame(candidate) !== FRAME_SUBCLASS.DEPLOY_OR_POST_OP) return null;
  if (resolvedTarget(candidate.target, txSender) !== resolvedTarget(approving.target, txSender)) return null;
  return { frame: candidate, frameIndex: i, role };
}

function matchApprovingSkeleton(all: Frame[], start: number, txSender: Hex): ValidationPrefixMatch | null {
  for (const selfVerifyIndex of [start, start + 1]) {
    if (selfVerifyIndex >= all.length) continue;
    const candidate = all[selfVerifyIndex]!;
    if (classifyFrame(candidate) !== FRAME_SUBCLASS.SELF_VERIFY) continue;
    const frames: ValidationPrefixMatch["frames"] = [];
    if (selfVerifyIndex === start + 1) {
      const pv = matchPreVerify(all, selfVerifyIndex, candidate, "payer", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: candidate, frameIndex: selfVerifyIndex, role: "payer" });
    return { payerFrameIndex: selfVerifyIndex, frames };
  }
  for (const onlyVerifyIndex of [start, start + 1]) {
    if (onlyVerifyIndex >= all.length) continue;
    const onlyVerify = all[onlyVerifyIndex]!;
    if (classifyFrame(onlyVerify) !== FRAME_SUBCLASS.ONLY_VERIFY) continue;
    const frames: ValidationPrefixMatch["frames"] = [];
    if (onlyVerifyIndex === start + 1) {
      const pv = matchPreVerify(all, onlyVerifyIndex, onlyVerify, "sender", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: onlyVerify, frameIndex: onlyVerifyIndex, role: "sender" });
    for (const payIndex of [onlyVerifyIndex + 1, onlyVerifyIndex + 2]) {
      if (payIndex >= all.length) continue;
      const pay = all[payIndex]!;
      if (classifyFrame(pay) !== FRAME_SUBCLASS.PAY) continue;
      const withPay = [...frames];
      if (payIndex === onlyVerifyIndex + 2) {
        const pv = matchPreVerify(all, payIndex, pay, "payer", txSender);
        if (!pv) continue;
        withPay.push(pv);
      }
      withPay.push({ frame: pay, frameIndex: payIndex, role: "payer" });
      return { payerFrameIndex: payIndex, frames: withPay };
    }
  }
  return null;
}

export function recognizeValidationPrefix(all: Frame[], txSender: Hex): ValidationPrefixMatch | null {
  let offset = 0;
  if (all.length > 0 && classifyFrame(all[0]!) === FRAME_SUBCLASS.EXPIRY_VERIFY) offset = 1;
  const withoutDeploy = matchApprovingSkeleton(all, offset, txSender);
  if (withoutDeploy) return withoutDeploy;
  if (all.length > offset && classifyFrame(all[offset]!) === FRAME_SUBCLASS.DEPLOY_OR_POST_OP) {
    const withDeploy = matchApprovingSkeleton(all, offset + 1, txSender);
    if (withDeploy) {
      const deployTarget = resolvedTarget(all[offset]!.target, txSender);
      const senderAddr = resolvedTarget(null, txSender);
      const payerFrame = withDeploy.frames.find((f) => f.frameIndex === withDeploy.payerFrameIndex)!.frame;
      const payerAddr = resolvedTarget(payerFrame.target, txSender);
      if (deployTarget !== senderAddr && deployTarget !== payerAddr) {
        return { payerFrameIndex: withDeploy.payerFrameIndex, frames: [{ frame: all[offset]!, frameIndex: offset, role: "factory" }, ...withDeploy.frames] };
      }
    }
  }
  return null;
}

export type StructuralRulesResult = { valid: true } | { valid: false; reason: string };

export function validateStructuralRules(tx: FrameTransaction, prefix: ValidationPrefixMatch): StructuralRulesResult {
  const lastPrefixIndex = Math.max(...prefix.frames.map((f) => f.frameIndex));
  let executionSum = 0n, stateSum = 0n;
  for (let i = 0; i <= lastPrefixIndex; i++) {
    const frame = tx.frames[i]!;
    const subclass = classifyFrame(frame);
    if ((subclass === FRAME_SUBCLASS.SELF_VERIFY || subclass === FRAME_SUBCLASS.ONLY_VERIFY) && frame.target !== null && frame.target !== tx.sender) {
      return { valid: false, reason: `frame ${i} (${subclass}) targets ${frame.target}, expected tx.sender ${tx.sender} or null` };
    }
    if ((frame.flags & ATOMIC_BATCH_FLAG) !== 0) return { valid: false, reason: `frame ${i} in validation prefix has ATOMIC_BATCH_FLAG set` };
    executionSum += frame.limits.execution;
    stateSum += frame.limits.state;
  }
  const sigCost = signatureVerificationCost(tx);
  const totalVerifyGas = executionSum + sigCost;
  if (totalVerifyGas > MAX_VERIFY_GAS) {
    return { valid: false, reason: `validation prefix execution gas sum ${executionSum} + signature-verification cost ${sigCost} = ${totalVerifyGas} exceeds MAX_VERIFY_GAS ${MAX_VERIFY_GAS}` };
  }
  if (stateSum > MAX_VERIFY_STATE_GAS) return { valid: false, reason: `validation prefix state gas sum ${stateSum} exceeds MAX_VERIFY_STATE_GAS ${MAX_VERIFY_STATE_GAS}` };
  for (let i = lastPrefixIndex + 1; i < tx.frames.length; i++) {
    if (tx.frames[i]!.mode === FRAME_MODE.VERIFY) return { valid: false, reason: `frame ${i} is a VERIFY frame after the validation prefix (ends at index ${lastPrefixIndex})` };
  }
  return { valid: true };
}

// ------------------------------------------------------------------ signatures (EIP-8141 validate_signature)
const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256R1N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** The address that signed `hash` with a 65-byte y-parity ‖ r ‖ s entry, or null. Never throws. */
export function recoverSigner(hash: Hex, v: number, r: bigint, s: bigint): Address | null {
  try {
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(v);
    const pub = sig.recoverPublicKey(hash.slice(2)).toRawBytes(false);
    return getAddress(`0x${keccak256(pub.slice(1)).slice(-40)}`);
  } catch {
    return null;
  }
}

/** The signer an entry names: its own field, or tx.sender when empty. Null for a malformed field. */
export function resolvedSigner(sig: SignatureEntry, txSender: Hex): Address | null {
  if (sig.signer === "0x") return getAddress(txSender);
  if (sig.signer.length === 42) { try { return getAddress(sig.signer); } catch { return null; } }
  return null;
}

export function validateSignature(sig: SignatureEntry, txSender: Hex, sigHash: Hex): boolean {
  let msg: Hex;
  if (sig.msg === "0x") msg = sigHash;
  else {
    const bytes = sig.msg.slice(2);
    if (bytes.length !== 64 || /^0{64}$/.test(bytes)) return false;
    msg = sig.msg as Hex;
  }
  const signer = resolvedSigner(sig, txSender);
  if (!signer) return false;
  if (sig.scheme === SIG_SCHEME.SECP256K1) {
    const b = sig.signature.slice(2);
    if (b.length !== 130) return false;
    const v = parseInt(b.slice(0, 2), 16);
    const r = BigInt(`0x${b.slice(2, 66)}`), s = BigInt(`0x${b.slice(66, 130)}`);
    if (v > 1 || !(r > 0n && r < SECP256K1N) || !(s > 0n && s <= SECP256K1N / 2n)) return false;
    const recovered = recoverSigner(msg, v, r, s);
    return recovered !== null && recovered.toLowerCase() === signer.toLowerCase();
  }
  if (sig.scheme === SIG_SCHEME.P256) {
    const b = sig.signature.slice(2);
    if (b.length !== 256) return false;
    const r = BigInt(`0x${b.slice(0, 64)}`), s = BigInt(`0x${b.slice(64, 128)}`);
    const qx = `0x${b.slice(128, 192)}` as Hex, qy = `0x${b.slice(192, 256)}` as Hex;
    if (!(r > 0n && r < SECP256R1N) || !(s > 0n && s <= SECP256R1N / 2n)) return false;
    const expected = `0x${keccak256(`0x${qx.slice(2)}${qy.slice(2)}`).slice(26)}`;
    if (expected.toLowerCase() !== signer.toLowerCase()) return false;
    try {
      return p256.verify({ r, s }, toBytes(msg), new Uint8Array([0x04, ...toBytes(qx), ...toBytes(qy)]), { lowS: false });
    } catch { return false; }
  }
  if (sig.scheme === SIG_SCHEME.ARBITRARY) return sig.signer === "0x";
  return false;
}

// ------------------------------------------------------------------ failure texts
/** Structured failure detail of a refused validation prefix, as ethrex reports it. */
export interface PrefixFailure {
  failedFrameIndex: number;
  haltReason: string;
  haltDetail: string;
  revertData?: Hex;
  account?: Address;
  balance?: bigint;
  required?: bigint;
}

export function describeStructuredFailure(f: PrefixFailure): string {
  const at = `validation frame ${f.failedFrameIndex}`;
  switch (f.haltReason) {
    case "insufficient_funds":
      if (f.account && f.balance !== undefined && f.required !== undefined) {
        return `${at}: the payer ${f.account} has ${f.balance} wei, the transaction's maximum cost is ${f.required} wei`;
      }
      break;
    case "out_of_gas":
      return `${at}: ran out of gas${f.haltDetail ? ` (${f.haltDetail})` : ""}`;
    case "revert":
      return f.revertData && f.revertData !== "0x" ? `${at}: reverted with data ${f.revertData}` : `${at}: reverted`;
    case "static_violation":
      return `${at}: wrote state or sent value in a read-only validation frame`;
    case "invalid_opcode":
      return `${at}: hit an invalid opcode`;
  }
  return f.haltDetail ? `${at}: ${f.haltDetail}` : `${at}: failed (${f.haltReason})`;
}

// ------------------------------------------------------------------ admission report
export const EXPLORER_RULES = {
  GAS_LIMIT: "gas-limit", RECENT_ROOT: "recent-root", PREFIX: "prefix", STRUCTURE: "structure", SIGNATURE: "signature",
  SIMULATION: "simulation", TRACE_ALIGNMENT: "trace-alignment", NESTED_CALL_VALUE: "OP-061", EXECUTION: "execution",
  OUT_OF_GAS: "out-of-gas", BANNED_OPCODE: "OP-011", CREATE: "create", STORAGE: "storage", CODE_ACCESS: "COD-010",
  ENTRYPOINT_ACCESS: "entrypoint-access", MEMPOOL: "mempool", ADMISSION: "admission",
} as const;
export type RuleId = (typeof EXPLORER_RULES)[keyof typeof EXPLORER_RULES];
const R = EXPLORER_RULES;
export const GLOBAL_RULE_ORDER: RuleId[] = [R.GAS_LIMIT, R.RECENT_ROOT, R.PREFIX, R.STRUCTURE, R.SIGNATURE, R.SIMULATION, R.TRACE_ALIGNMENT, R.NESTED_CALL_VALUE, R.EXECUTION, R.MEMPOOL];
export const ENTITY_RULE_ORDER: RuleId[] = [R.OUT_OF_GAS, R.BANNED_OPCODE, R.CREATE, R.STORAGE, R.CODE_ACCESS, R.ENTRYPOINT_ACCESS];

export interface RuleCheck { rule: RuleId; frameIndex?: number; entity?: "sender" | "payer" | "factory"; verdict: "pass" | "fail" | "skipped"; detail?: string }

/** Collects one admission attempt's verdicts; on a failure, every rule that never ran is listed as skipped. */
export class CheckCollector {
  private checks: RuleCheck[] = [];
  pass(rule: RuleId, ctx: { frameIndex?: number; entity?: RuleCheck["entity"] } = {}) { this.checks.push({ rule, ...ctx, verdict: "pass" }); }
  fail(rule: RuleId, detail: string, ctx: { frameIndex?: number; entity?: RuleCheck["entity"] } = {}) {
    this.checks.push({ rule, ...ctx, verdict: "fail", detail: detail.length > 1024 ? `${detail.slice(0, 1023)}…` : detail });
  }
  hasFailure() { return this.checks.some((c) => c.verdict === "fail"); }
  toChecks(): RuleCheck[] {
    const out = this.checks.map((c) => ({ ...c }));
    if (!this.hasFailure()) return out;
    for (const rule of GLOBAL_RULE_ORDER) {
      if (!out.some((c) => c.rule === rule && c.entity === undefined)) out.push({ rule, verdict: "skipped" });
    }
    if (!out.some((c) => c.entity !== undefined)) for (const rule of ENTITY_RULE_ORDER) out.push({ rule, verdict: "skipped" });
    return out;
  }
}

/** JSON-RPC error codes the sidecar uses (packages/types/src/api/errors/rpc-error-codes.ts). */
export const CODES = {
  INVALID_USEROP: -32602, VALIDATION_FAILED: -32500, INVALID_OPCODE: -32502, INVALID_SIGNATURE: -32507,
  INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603, SERVER_ERROR: -32000,
} as const;
