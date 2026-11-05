import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../lib/config.js";
import { runStep } from "../lib/output.js";
import { ensureParticipantKey, writeState } from "../lib/state.js";
import { buildSelfRelayTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { accountNonce, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";

runStep("step_2_tx_first", async (ctx) => {
  const cfg = loadConfig();
  const key = ensureParticipantKey();
  const from = privateKeyToAccount(key).address;
  const tx = await signFrameTx(
    buildSelfRelayTx({ from, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(from), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
    key
  );
  ctx.log(`sending ${txHash(tx)} to the standard alt-mempool…`);
  const hash = await sendFrameTx(tx);
  const receipt = await waitForReceipt(hash);
  writeState({ lastTxHash: hash });
  return {
    summary: [`frame tx mined: ${hash}`, `block: ${Number(receipt.blockNumber)}`, `frames: ${receipt.frameReceipts?.length} (all succeeded)`, `explorer: ${explorerLink(hash)}`, `next: yarn step_3_tx_paymaster`].join("\n"),
    data: { txHash: hash, block: Number(receipt.blockNumber), frames: receipt.frameReceipts?.length ?? 0 },
  };
});
