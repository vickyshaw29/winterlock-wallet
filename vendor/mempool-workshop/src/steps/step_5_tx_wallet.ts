import { privateKeyToAccount } from "viem/accounts";
import { getBalance } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { buildWalletTx, signFrameTx } from "../lib/frameTx/build.js";
import { accountNonce, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState, writeState } from "../lib/state.js";

runStep("step_5_tx_wallet", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("wallet", "step_4_wallet_deploy");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;
  const before = await getBalance(wallet);
  const tx = await signFrameTx(
    buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(wallet), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
    ownerKey
  );
  ctx.log(`sending a tx whose sender is the wallet ${wallet}, signed by owner ${owner}…`);
  const hash = await sendFrameTx(tx);
  const receipt = await waitForReceipt(hash);
  writeState({ lastTxHash: hash });
  const after = await getBalance(wallet);
  return {
    summary: [`wallet tx mined: ${hash}`, `wallet balance: ${Number(before) / 1e18} -> ${Number(after) / 1e18} ETH (it paid)`, `explorer: ${explorerLink(hash)}`, `next: yarn step_6_tx_violating_canonical`].join("\n"),
    data: { txHash: hash, block: Number(receipt.blockNumber), wallet, owner, walletBalanceBefore: before.toString(), walletBalanceAfter: after.toString() },
  };
});
