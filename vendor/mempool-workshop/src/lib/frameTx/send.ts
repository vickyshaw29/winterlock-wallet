import * as lib from "@forshtat/hegota-support/rpc";
import type { Address, Hex } from "viem";
import { waitMined } from "../chain.js";
import { loadConfig } from "../config.js";
import { StepError } from "../output.js";
import { rpc } from "../rpc.js";
import { toWire } from "./build.js";
import { encodeRawFrameTx } from "./codec.js";
import type { FrameTransaction } from "./types.js";

/** Submits to the standard alt-mempool (`eth_sendFrameTransaction`), through the gateway. */
export async function sendFrameTx(tx: FrameTransaction): Promise<Hex> {
  return await rpc(loadConfig().gatewayUrl, "eth_sendFrameTransaction", [toWire(tx)]);
}

/**
 * Submits the raw type-0x06 transaction (`eth_sendRawTransaction`). The gateway forwards it to ethrex, so this is
 * the canonical mempool's verdict.
 */
export async function sendRawFrameTx(tx: FrameTransaction): Promise<Hex> {
  return await rpc(loadConfig().gatewayUrl, "eth_sendRawTransaction", [encodeRawFrameTx(tx)]);
}

export interface FrameReceipt {
  status: Hex;
  blockNumber: Hex;
  frameReceipts?: { status: Hex }[];
  [k: string]: unknown;
}

/** Waits for ethrex's receipt and fails loudly if any frame did not succeed. */
export async function waitForReceipt(hash: Hex): Promise<FrameReceipt> {
  const r = (await waitMined(hash)) as FrameReceipt;
  const failed = (r.frameReceipts ?? []).map((f, i) => ({ i, ok: f.status === "0x1" })).filter((f) => !f.ok);
  if (r.status !== "0x1" || failed.length) {
    throw new StepError("TX_REVERTED", `Transaction ${hash} was mined but frame(s) ${failed.map((f) => f.i).join(", ") || "?"} failed`, {
      hint: "run `yarn step_11_debug " + hash + "`",
    });
  }
  return r;
}

export async function accountNonce(address: Address): Promise<bigint> {
  return BigInt(await rpc(loadConfig().gatewayUrl, "eth_getTransactionCount", [address, "latest"]));
}

export const explorerLink = (hash: Hex) => `${loadConfig().explorerUrl} (search ${hash})`;

export interface Rejection {
  rule: string;
  message: string;
  hint: string;
}

const REJECTION_HINTS: Record<lib.Rejection["rule"], string> = {
  "OP-011": "validation code may not use environment opcodes (TIMESTAMP, NUMBER, BALANCE…); remove the opcode",
  STO: "validation may only touch the sender's own or associated storage; a staked entity may read more in the standard alt-mempool (yarn step_7_stake)",
  UNKNOWN: "run `yarn step_11_debug <txHash>` if the tx was accepted, or check the node's error text",
};

/** Maps a node's rejection text (ethrex or the sidecar) to a rule family from the mempool rules and a next step. */
export function explainRejection(message: string): Rejection {
  const { rule } = lib.explainRejection(message);
  return { rule, message, hint: REJECTION_HINTS[rule] };
}
