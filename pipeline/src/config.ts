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

/**
 * The code at both system contracts, read on the devnet on Nov 6: revert(0,0) for the nonce manager; for the expiry
 * verifier, "8 bytes of calldata, else revert; revert if TIMESTAMP > deadline". Inclusion and expiry are decided from
 * these two, so a send refuses to start on a chain where either differs (review, Nov 6).
 */
export const NONCE_MANAGER_CODE = "0x60006000fd";
export const EXPIRY_VERIFIER_CODE = "0x60083614600a575f5ffd5b5f3560c01c4211601657005b5f5ffd";

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
  /** inclusion and expiry are decided on the block this many below the head (review, Nov 6: zero-conf decisions) */
  confirmations: 2,
  /** the most the host clock and the latest block's timestamp may differ before a send is refused, in seconds */
  maxClockSkewSeconds: 60,
  /** how long a retry waits for the sidecar to drop a dead attempt (its reconciler: up to 4 passes of 10 s) */
  dropWaitMs: 60_000,
  /** how long a pending transaction is followed past its deadline before the outcome is reported unknown */
  followTimeoutMs: 600_000,
  /** once its key is seen used, how long to look for the receipt before reporting it "Included" without one */
  receiptWaitMs: 60_000,
} as const;

/**
 * Verify-frame cost model for grinding: baseGas + gasPerStep x WOTS+ chain steps. Estimates until the real
 * verifier is measured on the devnet: baseGas is the account's measured verify frame without hashing (cold
 * 30,677, hot 37,300; spec Day-0) plus about 5,000 for the verifier's fixed work; 80 gas per step is the top
 * of the spec's 75 to 80 estimate.
 */
export const GRIND = {
  cold: { baseGas: 36_000, gasPerStep: 80 },
  hot: { baseGas: 43_000, gasPerStep: 80 },
} as const;

export const explorerTxUrl = (hash: string) => `${DEVNET.explorer}/tx/${hash}`;
