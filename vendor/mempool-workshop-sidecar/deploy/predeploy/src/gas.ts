/**
 * Gas limit for a transaction: the node's estimate plus a margin, never above
 * the block gas limit. An estimate that already exceeds the block gas limit
 * can never be mined, so it is an error.
 */
export function planGas(estimate: bigint, blockGasLimit: bigint, marginPercent: bigint): bigint {
  if (estimate > blockGasLimit) {
    throw new Error(`estimated gas ${estimate} exceeds the block gas limit ${blockGasLimit}`);
  }
  const withMargin = (estimate * (100n + marginPercent)) / 100n;
  return withMargin > blockGasLimit ? blockGasLimit : withMargin;
}

/**
 * Multiplies the node's quoted gas price, capped at a hard ceiling. The ceiling guards against a
 * reactive gas-price oracle feeding back on its own recently-paid prices: on the ethrex devnet,
 * `eth_gasPrice` climbed from ~2 gwei to over 33,000 gwei purely from this tool repeatedly paying
 * `nodeGasPrice * multiplier`, while the chain's real EIP-1559 base fee stayed flat at 7 wei the
 * entire time - a self-inflicted runaway, not genuine congestion.
 */
export function planGasPrice(nodeGasPrice: bigint, multiplier: bigint, ceiling: bigint): bigint {
  const planned = nodeGasPrice * multiplier;
  return planned > ceiling ? ceiling : planned;
}
