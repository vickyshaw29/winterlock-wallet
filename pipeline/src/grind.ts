// Signer-side grinding (spec, Cryptography, "Expected cost"): try values of one free field of the transaction
// until the message's WOTS+ chain work fits the verify limit the transaction declares.
// Written with Claude Code (AI) for Vicky.
//
// Nothing is signed here. Each try only computes a candidate sig hash, and the caller signs the one returned,
// so a leaf still signs exactly one message.
import type { Hex } from "viem";
import { computeSigHash } from "./codec/codec.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";
import { WOTS, wotsVerifySteps } from "./wots.ts";

/** Verify-frame cost model: baseGas + gasPerStep x chain steps must stay within verifyGasLimit. */
export interface GrindConfig {
  verifyGasLimit: bigint;
  /** the verify frame's cost without the chain work (account checks, key, proxy, the verifier's fixed part) */
  baseGas: number;
  gasPerStep: number;
  maxTries?: number;
}

export interface GrindTry<T> { value: T; steps: number }
export interface GrindResult<T> {
  value: T;
  tx: FrameTransaction;
  sigHash: Hex;
  steps: number;
  maxSteps: number;
  /** every candidate tried, in order: the gas gauge of scene 4 */
  tries: GrindTry<T>[];
}

export const maxStepsFor = (c: GrindConfig) => Math.floor((Number(c.verifyGasLimit) - c.baseGas) / c.gasPerStep);

/**
 * candidate(i) returns the i-th value of the free field and the transaction built with it (placeholders
 * of the final lengths in the signature slots). Returns the first candidate whose chain work fits.
 */
export function grind<T>(candidate: (i: number) => { value: T; tx: FrameTransaction }, c: GrindConfig): GrindResult<T> {
  const maxSteps = maxStepsFor(c);
  if (maxSteps < WOTS.bestSteps) {
    throw new Error(`verify limit ${c.verifyGasLimit} leaves room for ${maxSteps} steps; even the best message needs ${WOTS.bestSteps}`);
  }
  const tries: GrindTry<T>[] = [];
  const limit = c.maxTries ?? 256;
  for (let i = 0; i < limit; i++) {
    const { value, tx } = candidate(i);
    const sigHash = computeSigHash(tx);
    const steps = wotsVerifySteps(sigHash);
    tries.push({ value, steps });
    if (steps <= maxSteps) return { value, tx, sigHash, steps, maxSteps, tries };
  }
  throw new Error(`no candidate fit ${maxSteps} chain steps in ${limit} tries`);
}
