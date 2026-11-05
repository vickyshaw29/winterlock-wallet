import type { Address, Hex } from "./types";

export const DEFAULT_RPC_URL = "https://altmempool.forshtat.com";
export const DEFAULT_CHAIN_ID = 1337;

/**
 * The devnet's only genesis-funded account. Throwaway key, already public in
 * deploy/devnet/genesis.values.env. Used only by `predeploy fund`.
 */
export const SHARED_DEVNET_KEY: Hex =
  "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15";

/**
 * Throwaway devnet deployer. Published on purpose: it owns every deployed
 * contract, so anyone holding it can administer them. It is separate from the
 * shared key so that other people's transactions never shift its nonce (and
 * with it every CREATE address). NEVER use it on a real network.
 */
export const DEPLOYER_KEY: Hex =
  "0xcbb754e47d54ec3bf76954e8e4df02e68d1484c703e47d29f189e32904545191";
export const DEPLOYER_ADDRESS: Address = "0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0";

/** Extra gas on top of eth_estimateGas, in percent. */
export const GAS_MARGIN_PERCENT = 20n;
/** Multiplier applied to eth_gasPrice. */
export const GAS_PRICE_MULTIPLIER = 2n;
/**
 * Hard cap on the planned gas price, regardless of what eth_gasPrice * GAS_PRICE_MULTIPLIER
 * comes to. Observed live on the ethrex devnet: eth_gasPrice reacts to recently-paid prices, so a
 * burst of large transactions (Railgun's 91 setVerificationKey calls) fed back on its own quotes
 * and climbed from ~2 gwei to over 33,000 gwei in one run, while the chain's real EIP-1559 base
 * fee stayed flat at 7 wei throughout - a self-inflicted runaway, not genuine congestion. 200 gwei
 * is already ~28,000x that real base fee, comfortable headroom for a devnet.
 */
export const GAS_PRICE_CEILING_WEI = 200n * 10n ** 9n;

/** `predeploy fund` tops the deployer up to FUND_AMOUNT_WEI when its balance is below FUND_MIN_BALANCE_WEI. */
export const FUND_AMOUNT_WEI = 10n * 10n ** 18n;
export const FUND_MIN_BALANCE_WEI = 2n * 10n ** 18n;

/** Etherscan's free tier allows 5 requests per second; stay under it. */
export const ETHERSCAN_MIN_INTERVAL_MS = 250;
