import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { toWire as libToWire } from "@forshtat/hegota-support/rpc";
import * as lib from "@forshtat/hegota-support/tx";
import { computeSigHash, encodeRawFrameTx } from "./codec.js";
import { profile } from "./profile.js";
import type { Frame, FrameTransaction } from "./types.js";
import type { RecentRootReference } from "@forshtat/hegota-support/tx";

/** A frame of the named mode. `scope` is an approve scope of the devnet (`"EXECUTION_AND_PAYMENT"`), `null` target = the sender. */
const frame = (mode: "VERIFY" | "SENDER", scope: string | undefined, target: Address | null, execution: bigint, opts: { value?: bigint; data?: Hex; state?: bigint } = {}): Frame =>
  lib.frame(profile, mode, { scope, target, execution, state: opts.state, value: opts.value, data: opts.data });

const SECP256K1_PLACEHOLDER = (signer: Hex = "0x") => lib.secp256k1Placeholder(profile, signer);

function assembleTx(f: {
  sender: Address; nonceSeq: bigint; chainId: number; maxFeePerGas: bigint; frames: Frame[]; signer?: Hex;
  /** EIP-8250 keys; the default `[0n]` is the sender's ordinary account nonce. */
  nonceKeys?: bigint[];
  /** EIP-8272 references to recent roots, declared in the signed envelope. */
  recentRootReferences?: RecentRootReference[];
}): FrameTransaction {
  const tx = lib.newTx({
    chainId: f.chainId,
    sender: f.sender,
    nonceSeq: f.nonceSeq,
    nonceKeys: f.nonceKeys,
    frames: f.frames,
    signatures: [SECP256K1_PLACEHOLDER(f.signer)],
    fees: { maxFeePerGas: f.maxFeePerGas },
  });
  return f.recentRootReferences ? { ...tx, recentRootReferences: f.recentRootReferences } : tx;
}

/** `[self_verify]` + one SENDER transfer; the EOA signs and pays for itself. */
export function buildSelfRelayTx(a: {
  from: Address; to: Address; value: bigint; nonce: bigint; chainId: number; maxFeePerGas: bigint;
}): FrameTransaction {
  return assembleTx({
    sender: a.from, nonceSeq: a.nonce, chainId: a.chainId, maxFeePerGas: a.maxFeePerGas,
    frames: [
      frame("VERIFY", "EXECUTION_AND_PAYMENT", null, 30_000n),
      // state limit: a transfer to a brand-new account is charged state gas on this devnet
      frame("SENDER", undefined, a.to, 50_000n, { value: a.value, state: 200_000n }),
    ],
  });
}

/** Signs over the signature hash and packs the result as `v(0/1) || r || s`. */
export const signFrameTx = (tx: FrameTransaction, privateKey: Hex): Promise<FrameTransaction> => lib.signTx(profile, tx, privateKey);

/** The JSON shape `eth_sendFrameTransaction` expects. */
export const toWire = libToWire;

export const txHash = (tx: FrameTransaction): Hex => lib.txHash(profile, tx);

/** `[VERIFY(execution) on sender, VERIFY(payment) on paymaster, SENDER]`: the paymaster pays, the sender needs no ETH. */
export function buildPaymasterTx(a: {
  from: Address; paymaster: Address; to: Address; nonce: bigint; chainId: number; maxFeePerGas: bigint;
}): FrameTransaction {
  return assembleTx({
    sender: a.from, nonceSeq: a.nonce, chainId: a.chainId, maxFeePerGas: a.maxFeePerGas,
    frames: [
      frame("VERIFY", "EXECUTION", null, 30_000n),
      frame("VERIFY", "PAYMENT", a.paymaster, 50_000n),
      frame("SENDER", undefined, a.to, 50_000n),
    ],
  });
}

/** `[VERIFY(both) on the wallet, SENDER]`; the owner signs with an explicit `signer`, the wallet checks it via SIGPARAM. */
export function buildWalletTx(a: {
  wallet: Address; owner: Address; to: Address; value: bigint; nonce: bigint; chainId: number; maxFeePerGas: bigint;
  /** Calldata of the VERIFY frame. ViolatingWallet breaks a storage rule when this is non-empty. */
  verifyData?: Hex;
  /** Keyed nonces (EIP-8250): `nonce` is then the next sequence number of that key, not the account nonce. */
  nonceKeys?: bigint[];
  /** Recent roots (EIP-8272) to declare in the envelope. */
  recentRootReferences?: RecentRootReference[];
}): FrameTransaction {
  return assembleTx({
    sender: a.wallet, nonceSeq: a.nonce, chainId: a.chainId, maxFeePerGas: a.maxFeePerGas,
    signer: a.owner, nonceKeys: a.nonceKeys, recentRootReferences: a.recentRootReferences,
    frames: [
      frame("VERIFY", "EXECUTION_AND_PAYMENT", null, 70_000n, { data: a.verifyData }),
      frame("SENDER", undefined, a.to, 50_000n, { value: a.value, state: 200_000n }),
    ],
  });
}

const ADD_STAKE_ABI = [{ type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] }] as const;

/**
 * The wallet stakes itself: in a self-relay the SENDER frame calls as `tx.sender`, so a SENDER frame that calls the
 * registry's `addStake` makes the wallet the staker. The VERIFY frame stays on the clean path (empty data).
 */
export function buildStakeTx(a: {
  registry: Address; wallet: Address; owner: Address; amount: bigint; unstakeDelaySec: number; nonce: bigint; chainId: number; maxFeePerGas: bigint;
}): FrameTransaction {
  return assembleTx({
    sender: a.wallet, nonceSeq: a.nonce, chainId: a.chainId, maxFeePerGas: a.maxFeePerGas,
    signer: a.owner,
    frames: [
      frame("VERIFY", "EXECUTION_AND_PAYMENT", null, 70_000n),
      frame("SENDER", undefined, a.registry, 150_000n, {
        value: a.amount, state: 300_000n,
        data: encodeFunctionData({ abi: ADD_STAKE_ABI, functionName: "addStake", args: [a.unstakeDelaySec] }),
      }),
    ],
  });
}
