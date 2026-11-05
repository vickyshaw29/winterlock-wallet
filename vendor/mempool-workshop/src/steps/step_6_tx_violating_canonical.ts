import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../lib/config.js";
import { deployContract, deployForeign, getStake, reusable } from "../lib/contracts.js";
import { buildWalletTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { accountNonce, explainRejection, sendFrameTx, sendRawFrameTx, type Rejection } from "../lib/frameTx/send.js";
import { StepError, runStep } from "../lib/output.js";
import { ensureParticipantKey, writeState } from "../lib/state.js";

runStep("step_6_tx_violating_canonical", async (ctx) => {
  const cfg = loadConfig();
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;

  let wallet = await reusable("violating", ctx.fresh);
  if (!wallet) {
    const foreign = await deployForeign(ctx.fresh);
    ctx.log("deploying ViolatingWallet…");
    wallet = await deployContract("ViolatingWallet", [owner, foreign], cfg.violatingWalletFundingWei);
    writeState({ violating: wallet });
  }

  // VERIFY frame data 0x01 makes the wallet read a storage slot it does not own.
  const tx = await signFrameTx(
    buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(wallet), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei, verifyData: "0x01" }),
    ownerKey
  );

  type Verdict = { accepted: boolean; skipped?: string; rejection?: Rejection };
  const attempt = async (send: () => Promise<unknown>): Promise<Verdict> => {
    try {
      await send();
      return { accepted: true };
    } catch (e) {
      if (!(e instanceof StepError) || !e.code.startsWith("RPC_")) throw e;
      return { accepted: false, rejection: explainRejection(e.message) };
    }
  };

  ctx.log("sending the violating tx to the canonical mempool (eth_sendRawTransaction, which the gateway forwards to ethrex)…");
  const canonical = await attempt(() => sendRawFrameTx(tx));

  // Once the wallet is staked (step 7), the sidecar would admit this tx and mine it, which would burn the wallet's nonce.
  const staked = (await getStake(wallet)).amount > 0n;
  let alt: Verdict;
  if (staked) {
    alt = { accepted: false, skipped: "wallet is staked (step 7): the sidecar would admit this tx, so it was not sent" };
  } else {
    ctx.log("sending the same tx to the standard alt-mempool (eth_sendFrameTransaction) for comparison…");
    alt = await attempt(() => sendFrameTx(tx));
  }

  const line = (label: string, v: Verdict) =>
    `${label}: ${v.skipped ? `skipped (${v.skipped})` : v.accepted ? "ACCEPTED" : `rejected [${v.rejection!.rule}] ${v.rejection!.message}`}`;
  return {
    ok: !canonical.accepted,
    hint: "the canonical mempool accepted a tx that reads foreign storage; the devnet's ethrex may have changed (see docs/findings.md)",
    summary: [
      line("canonical mempool (ethrex, via the gateway)", canonical),
      line("standard alt-mempool (sidecar)", alt),
      canonical.accepted ? "" : `why: ${canonical.rejection!.hint}`,
      `wallet: ${wallet}`,
      staked ? `tx hash: ${txHash(tx)}` : `tx hash: ${txHash(tx)} (debug with: yarn step_11_debug ${txHash(tx)})`,
      staked ? "next: yarn step_8_tx_violating_alt (the wallet is already staked)" : "next: yarn step_7_stake",
    ].filter(Boolean).join("\n"),
    data: { wallet, txHash: txHash(tx), canonical, alt, rule: canonical.rejection?.rule ?? null },
  };
});
