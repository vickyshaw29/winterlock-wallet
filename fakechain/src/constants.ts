// Fixed addresses, protocol numbers and launch defaults of the fake chain.
// Written with Claude Code (AI) for Vicky.
import { getAddress, keccak256, toHex, type Address } from "viem";

/** Never 1337: nothing signed for the fake chain can be valid on the real devnet. */
export const CHAIN_ID = 31337n;
export const CLIENT_VERSION = "fakechain/0.1.0 (local fake devnet, not ethrex)";

/** An address derived from a label: the same on every run, so docs and tests can name it. */
export const fixedAddress = (label: string): Address => getAddress(`0x${keccak256(toHex(`fakechain/${label}`)).slice(-40)}`);
/** Where the account implementation (Account.yul's runtime) sits from genesis. */
export const IMPLEMENTATION = fixedAddress("implementation");
/** Where the factory (Factory.sol's runtime, bound to IMPLEMENTATION) sits from genesis. */
export const FACTORY = fixedAddress("factory");
/** The hot tickets' one allowed target, funded in genesis like the devnet's genesis account. */
export const SHOP = fixedAddress("shop");
/** Block producer: receives the priority fees. Kept apart from SHOP so the shop's balance only moves by payments. */
export const COINBASE = fixedAddress("coinbase");
/** EIP-8141's entry point sentinel: the caller of VERIFY and DEFAULT frames. */
export const ENTRY_POINT: Address = "0x00000000000000000000000000000000000000aa";

export const GWEI = 1_000_000_000n;
export const ETH = 10n ** 18n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256 = 1n << 256n;
/** Blocks whose state stays readable at a block number (the devnet node keeps about 126, then silently answers latest). */
export const STATE_WINDOW = 128;
export const BLOCK_GAS_LIMIT = 60_000_000n;

/** What skandha_getGasPrice answers (the devnet's sidecar quote seen in the pipeline's tests). */
export const GAS_PRICE_QUOTE = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI };

/** The sidecar's defaults that change behaviour here (packages/executor/src/config.ts at the pinned commit). */
export const SIDECAR = {
  userOpGasLimit: 25_000_000n,
  bundleSize: 4,
  maxSubmitAttempts: 3,
  replaceTtlSeconds: 300,
  /** what eth_estimateFrameTransactionGas puts in every frame after the validation prefix */
  estimateBodyLimit: 10_000_000n,
  faucetAmount: ETH,
  faucetCooldownMs: 3_600_000,
  faucetGlobalLimit: 100,
} as const;

export interface FakeChainOptions {
  /** seconds between blocks */
  blockTime: number;
  /** fixed base fee per gas, in wei */
  baseFee: bigint;
  /** frame transactions one sender may have pending in the public pool (eth_sendRawTransaction) */
  publicPerSender: number;
  /** seconds between the sidecar's bundler passes (relay and reconcile); its default is 10 */
  bundleInterval: number;
  /** model EIP-150: the account proxy's DELEGATECALL passes on only 63/64 of the gas left */
  proxyHoldback: boolean;
  /** the sidecar's enforceGasPrice: do not relay a transaction priced below the gas price quote */
  enforceGasPrice: boolean;
}

/**
 * Base fee 7 wei: the devnet's (estimate.ts asks for 2 x base fee, and the measured estimates carry 14 wei). The sidecar
 * relays everything it admits unless enforceGasPrice is set (default off there too).
 */
export const DEFAULT_OPTIONS: FakeChainOptions = {
  blockTime: 6, baseFee: 7n, publicPerSender: 1, bundleInterval: 10, proxyHoldback: true, enforceGasPrice: false,
};
