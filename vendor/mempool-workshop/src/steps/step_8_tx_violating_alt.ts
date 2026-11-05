import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../lib/config.js";
import { buildWalletTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { accountNonce, explainRejection, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { StepError, runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState, writeState } from "../lib/state.js";

runStep("step_8_tx_violating_alt", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("violating", "step_6_tx_violating_canonical");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;

  // Exactly the tx of step 6 (VERIFY data 0x01 = read foreign storage), now sent to the standard alt-mempool.
  const tx = await signFrameTx(
    buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(wallet), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei, verifyData: "0x01" }),
    ownerKey
  );
  ctx.log("sending the step 6 tx to the standard alt-mempool (sidecar)…");
  let hash;
  try {
    hash = await sendFrameTx(tx);
  } catch (e) {
    if (!(e instanceof StepError) || !e.code.startsWith("RPC_")) throw e;
    const r = explainRejection(e.message);
    return {
      ok: false,
      summary: `rejected [${r.rule}] ${r.message}\ntx hash: ${txHash(tx)} (debug with: yarn step_11_debug ${txHash(tx)})`,
      hint: r.rule === "STO" ? "the wallet is not (or no longer) staked: run `yarn step_7_stake`; if it is banned, run `yarn reset_reputation`" : r.hint,
      data: { wallet, accepted: false, txHash: txHash(tx), rule: r.rule, message: r.message },
    };
  }
  const receipt = await waitForReceipt(hash);
  writeState({ lastTxHash: hash });
  return {
    summary: [`accepted and mined: ${hash}`, "the same tx the canonical mempool rejected in step 6 (the wallet reads foreign storage; staking relaxes that rule)", `explorer: ${explorerLink(hash)}`, "next: yarn step_9_reputation_burn"].join("\n"),
    data: { txHash: hash, block: Number(receipt.blockNumber), wallet, accepted: true },
  };
});
