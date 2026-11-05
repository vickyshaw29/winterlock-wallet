import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../lib/config.js";
import { getStake } from "../lib/contracts.js";
import { getReputation } from "../lib/explorer.js";
import { buildStakeTx, signFrameTx } from "../lib/frameTx/build.js";
import { accountNonce, explorerLink, sendFrameTx, waitForReceipt } from "../lib/frameTx/send.js";
import { StepError, runStep } from "../lib/output.js";
import { ensureParticipantKey, requireState } from "../lib/state.js";

runStep("step_7_stake", async (ctx) => {
  const cfg = loadConfig();
  const wallet = requireState("violating", "step_6_tx_violating_canonical");
  const ownerKey = ensureParticipantKey();
  const owner = privateKeyToAccount(ownerKey).address;

  const existing = await getStake(wallet);
  if (existing.amount >= cfg.stakeWei && existing.withdrawTime === 0) {
    return {
      summary: `wallet ${wallet} is already staked: ${Number(existing.amount) / 1e18} ETH, unstake delay ${existing.unstakeDelay}s\nnext: yarn step_8_tx_violating_alt`,
      data: { wallet, staked: true, alreadyStaked: true, stakeWei: existing.amount.toString(), unstakeDelaySec: existing.unstakeDelay },
    };
  }

  const tx = await signFrameTx(
    buildStakeTx({ registry: cfg.stakingRegistry, wallet, owner, amount: cfg.stakeWei, unstakeDelaySec: cfg.unstakeDelaySec, nonce: await accountNonce(wallet), chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei }),
    ownerKey
  );
  ctx.log(`the wallet ${wallet} stakes itself with a SENDER frame calling the registry…`);
  const hash = await sendFrameTx(tx);
  await waitForReceipt(hash);

  const after = await getStake(wallet);
  if (after.amount < cfg.stakeWei) {
    throw new StepError("STAKE_NOT_RECORDED", `the tx was mined but the registry shows ${after.amount} wei for ${wallet}`, { hint: "run `yarn step_11_debug " + hash + "`" });
  }
  const explorerStaked = await getReputation(wallet).then((r) => r.isStaked, () => undefined);
  return {
    summary: [`staked: ${hash}`, `wallet ${wallet}: ${Number(after.amount) / 1e18} ETH, unstake delay ${after.unstakeDelay}s`, `explorer: ${explorerLink(hash)}`, "next: yarn step_8_tx_violating_alt"].join("\n"),
    data: { txHash: hash, wallet, staked: true, alreadyStaked: false, stakeWei: after.amount.toString(), unstakeDelaySec: after.unstakeDelay, explorerIsStaked: explorerStaked ?? null },
  };
});
