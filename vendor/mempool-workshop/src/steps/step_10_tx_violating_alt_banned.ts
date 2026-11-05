import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../lib/config.js";
import { getReputation } from "../lib/explorer.js";
import { buildWalletTx, signFrameTx, txHash } from "../lib/frameTx/build.js";
import { accountNonce, explainRejection, sendFrameTx } from "../lib/frameTx/send.js";
import { StepError, runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState } from "../lib/state.js";

runStep("step_10_tx_violating_alt_banned", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("violating", "step_6_tx_violating_canonical");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;
  const reputation = await getReputation(wallet);

  const tx = await signFrameTx(
    buildWalletTx({ wallet, owner, to: cfg.recipient, value: cfg.transferWei, nonce: await accountNonce(wallet), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei, verifyData: "0x01" }),
    ownerKey
  );
  ctx.log(`sending the step 8 tx again; the wallet's reputation is ${reputation.status}…`);
  try {
    const hash = await sendFrameTx(tx);
    return { ok: false, summary: `accepted: ${hash}`, hint: "the wallet is not banned: run `yarn step_9_reputation_burn` first", data: { accepted: true, txHash: hash, reputation } };
  } catch (e) {
    if (!(e instanceof StepError) || !e.code.startsWith("RPC_")) throw e;
    const r = explainRejection(e.message);
    const banned = reputation.status === "BANNED";
    return {
      ok: banned,
      hint: "the tx was rejected, but the wallet is not banned, so reputation is not the cause; the wallet may be unstaked (step_7_stake) or banned status was reset",
      summary: [
        `rejected: ${r.message}`,
        `tx hash: ${txHash(tx)} (debug with: yarn step_11_debug ${txHash(tx)})`,
        `reputation of ${wallet}: ${reputation.status} (opsSeen ${reputation.opsSeen}, opsIncluded ${reputation.opsIncluded}, staked ${reputation.isStaked})`,
        banned ? "why: the node's error text is generic (it treats the banned entity as unstaked), but the explorer shows the real cause: BANNED. A banned entity is excluded from the mempool even though it is staked." : "",
        "undo: yarn reset_reputation",
      ].filter(Boolean).join("\n"),
      data: { accepted: false, txHash: txHash(tx), rule: r.rule, message: r.message, reputation },
    };
  }
});
