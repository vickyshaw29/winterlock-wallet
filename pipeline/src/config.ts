// Devnet endpoints and protocol constants. Every value here was checked on the devnet on
// 2026-11-05 (spec, Day-0 results). Override the endpoints with env vars to switch devnet.
// Browser- and Snap-safe (Nov 6): the WL_* variables are read only where a `process` exists (Node, Bun), so importing
// this file never throws in a browser or a MetaMask Snap, where DEVNET keeps the defaults below. Code there passes its
// own endpoints to createPipeline (pipeline.ts) instead of relying on DEVNET.
import type { Address } from "viem";

/** process.env where there is one; undefined in a browser or a Snap, which have no `process` global. */
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const env = (name: string, fallback: string) => processEnv?.[name] ?? fallback;

/** One network the pipeline talks to. */
export interface NetworkConfig {
  chainId: bigint;
  /** ethrex node: standard eth_* reads, ethrex_simulateFrameTransaction, the public mempool */
  node: string;
  /** sidecar gateway: eth_sendFrameTransaction, status, receipts, gas price, faucet, explorer records */
  gateway: string;
  explorer: string;
  /** seconds per block */
  blockTime: number;
}

/**
 * The default network, from the WL_* variables when this file loads. Node code (backend, scripts, tests) reaches it
 * through the module-level gateway, node and send functions; createPipeline makes networks of its own.
 */
export const DEVNET = {
  chainId: BigInt(env("WL_CHAIN_ID", "1337")),
  /** ethrex node: standard eth_* reads, ethrex_simulateFrameTransaction, the public mempool */
  node: env("WL_NODE_URL", "https://altmempool.forshtat.com"),
  /** sidecar gateway: eth_sendFrameTransaction, status, receipts, gas price, faucet, explorer records */
  gateway: env("WL_GATEWAY_URL", "https://altmempoolgateway.forshtat.com/rpc"),
  explorer: env("WL_EXPLORER_URL", "https://explorer.altmempool.wtf"),
  /** seconds per block, measured */
  blockTime: 6,
} as const satisfies NetworkConfig;

/**
 * Tip floor (Nov 6, Vicky; spec "Fees"). The devnet sidecar relays the highest maxPriorityFeePerGas first, 4 per 10 s
 * pass, and its own quote (skandha_getGasPrice) sat a few wei below teams that fix 2 gwei, so oracle-priced lanes waited
 * behind them past their deadline. Every quote is raised to this tip. WL_MIN_TIP_WEI overrides it; the default is
 * 3 gwei on chain 1337 (the devnet) and off on any other chain (the local fake chain is 31337).
 */
export const tipFloorFor = (chainId: bigint): bigint => (chainId === 1337n ? 3_000_000_000n : 0n);
/** The default network's tip floor: WL_MIN_TIP_WEI where a process exists, else tipFloorFor(DEVNET.chainId). */
export const MIN_TIP_WEI = BigInt(env("WL_MIN_TIP_WEI", String(tipFloorFor(DEVNET.chainId))));

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
 * Gas the account's EIP-1167 proxy spends before its DELEGATECALL: frame entry 100, a few pushes, the cold call 3,000
 * (Day-0 notes). Only an estimate, and it barely matters: it shifts the usable gas by a few gas.
 */
export const PROXY_PRE_CALL = 3_124;
/** Safety margin in GRIND's base gas, above the largest residual of the measured fit (252). */
export const GRIND_MARGIN = 300;

/**
 * Verify-frame cost model for grinding: baseGas + gasPerStep x WOTS+ chain steps must fit what the declared limit can
 * really use. Measured on account 2 (the bit-split verifier) by simulate-verify-gas.ts on Nov 6, from 8 real-signature
 * simulations at 420 to 570 steps: 54,630 + 66.09 x steps, largest residual 252 gas; GRIND_MARGIN on top. The account
 * is an EIP-1167 proxy whose DELEGATECALL passes on only 63/64 of the gas left (EIP-150), so 90,000 declared can use
 * about 88,643: cold messages fit up to 510 chain steps, 66 % of messages. (The model before Nov 6, 55,100 with no
 * holdback, allowed 525 steps, and a 525-step message runs out of gas behind the proxy: 89,356 used against 88,643.)
 * A hot leaf adds about 6,623 for the policy reads: a Day-0 estimate, not yet measured on account 2. Hot messages then
 * fit up to 409 steps, about 1 in 227. A preflight still refuses any message the model gets wrong.
 */
export const GRIND = {
  cold: { baseGas: 54_630 + GRIND_MARGIN, gasPerStep: 66.1, proxyPreCall: PROXY_PRE_CALL },
  hot: { baseGas: 54_630 + 6_623 + GRIND_MARGIN, gasPerStep: 66.1, proxyPreCall: PROXY_PRE_CALL },
} as const;

export const explorerTxUrl = (hash: string) => `${DEVNET.explorer}/tx/${hash}`;
