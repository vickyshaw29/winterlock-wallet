import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getBalance } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { deployContract, reusable } from "../lib/contracts.js";
import { buildPaymasterTx, signFrameTx } from "../lib/frameTx/build.js";
import { explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { runStep } from "../lib/output.js";
import { writeState } from "../lib/state.js";

runStep("step_3_tx_paymaster", async (ctx) => {
  const cfg = loadConfig();

  let paymaster = await reusable("paymaster", ctx.fresh);
  if (!paymaster) {
    ctx.log("deploying SponsorPaymaster (funded through its creation value)…");
    paymaster = await deployContract("SponsorPaymaster", [], cfg.paymasterFundingWei);
    writeState({ paymaster });
  }

  // A brand-new key with no ETH at all: the paymaster has to pay.
  const senderKey = generatePrivateKey();
  const sender = privateKeyToAccount(senderKey).address;
  const before = await getBalance(paymaster);

  const tx = await signFrameTx(
    buildPaymasterTx({ from: sender, paymaster, to: cfg.recipient, nonce: 0n, chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
    senderKey
  );
  ctx.log(`sender ${sender} holds 0 ETH; sending through paymaster ${paymaster}…`);
  const hash = await sendFrameTx(tx);
  const receipt = await waitForReceipt(hash);
  writeState({ lastTxHash: hash });

  const after = await getBalance(paymaster);
  const senderBalance = await getBalance(sender);
  return {
    summary: [
      `sponsored frame tx mined: ${hash}`,
      `sender balance: ${senderBalance} wei (it never held ETH)`,
      `paymaster ${paymaster}: ${Number(before) / 1e18} -> ${Number(after) / 1e18} ETH (it paid)`,
      `explorer: ${explorerLink(hash)}`,
      `next: yarn step_4_wallet_deploy`,
    ].join("\n"),
    data: { txHash: hash, block: Number(receipt.blockNumber), sender, paymaster, paymasterBalanceBefore: before.toString(), paymasterBalanceAfter: after.toString(), senderBalance: senderBalance.toString() },
    ok: after < before && senderBalance === 0n,
    hint: "the paymaster balance did not drop, so it did not pay; run `yarn step_11_debug` on the tx hash",
  };
});
