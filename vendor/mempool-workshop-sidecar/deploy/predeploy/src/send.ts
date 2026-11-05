import { GAS_MARGIN_PERCENT, GAS_PRICE_CEILING_WEI, GAS_PRICE_MULTIPLIER } from "./config";
import { planGas, planGasPrice } from "./gas";
import type { ChainPort, TxRequest, TxResult } from "./types";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split("\n").slice(0, 5).join(" | ") : String(error);
}

/**
 * Estimates, then sends and waits. Never sends blind: if the node cannot
 * estimate the transaction (a revert, usually), it stops and says why.
 */
export async function submit(
  chain: ChainPort,
  tx: TxRequest,
  label: string,
  log: (message: string) => void
): Promise<TxResult> {
  let estimate: bigint;
  try {
    estimate = await chain.estimateGas(tx);
  } catch (error) {
    throw new Error(`${label}: gas estimation failed, refusing to send: ${describeError(error)}`);
  }
  const [blockLimit, nodePrice] = await Promise.all([chain.blockGasLimit(), chain.gasPrice()]);
  const gas = planGas(estimate, blockLimit, GAS_MARGIN_PERCENT);
  const gasPrice = planGasPrice(nodePrice, GAS_PRICE_MULTIPLIER, GAS_PRICE_CEILING_WEI);
  log(`${label}: estimate ${estimate} gas, limit ${gas}`);

  const result = await chain.sendAndWait({ ...tx, gas, gasPrice });
  if (result.status !== "success") {
    throw new Error(`${label}: transaction ${result.hash} reverted`);
  }
  return result;
}
