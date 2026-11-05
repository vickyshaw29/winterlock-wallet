// Devnet endpoints and protocol constants. Every value here was checked on the devnet on
// 2026-11-05 (spec, Day-0 results). Override the endpoints with env vars to switch devnet.
import type { Address } from "viem";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const DEVNET = {
  chainId: BigInt(env("WL_CHAIN_ID", "1337")),
  /** ethrex node: standard eth_* reads, ethrex_simulateFrameTransaction, the public mempool */
  node: env("WL_NODE_URL", "https://altmempool.forshtat.com"),
  /** sidecar gateway: eth_sendFrameTransaction, status, receipts, gas price, faucet, explorer records */
  gateway: env("WL_GATEWAY_URL", "https://altmempoolgateway.forshtat.com/rpc"),
  explorer: env("WL_EXPLORER_URL", "https://explorer.altmempool.wtf"),
  /** seconds per block, measured */
  blockTime: 6,
} as const;

/** Live at the short address, not the EIP's 0x81413f0c…FfFf (Day-0). Data: 8-byte big-endian deadline. */
export const EXPIRY_VERIFIER: Address = "0x0000000000000000000000000000000000008141";
/** EIP-8250 nonce manager, short address on the devnet (Day-0). Slot = keccak256(pad32(sender) ‖ key). */
export const NONCE_MANAGER: Address = "0x0000000000000000000000000000000000008250";

/** Prefix cap the sidecar enforces: declared prefix execution limits + signature costs (Day-0). */
export const MAX_VERIFY_GAS = 100_000n;
/** Per-entry cost the sidecar adds to the prefix sum, by signature scheme (EIP-8141). */
export const SIG_SCHEME_COST: Record<number, bigint> = { 0: 100n, 1: 2_800n, 2: 6_700n };

export const DEFAULTS = {
  expirySeconds: 90,
  /** declared execution limit of the expiry frame; the frame counts toward the prefix cap */
  expiryFrameGas: 5_000n,
  /** declared execution limit of each plain value transfer */
  transferGas: 50_000n,
  pollMs: 3_000,
} as const;

export const explorerTxUrl = (hash: string) => `${DEVNET.explorer}/tx/${hash}`;
