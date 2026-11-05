import { privateKeyToAccount } from "viem/accounts";
import { getBalance } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { deployContract, reusable } from "../lib/contracts.js";
import { runStep } from "../lib/output.js";
import { ensureParticipantKey, writeState } from "../lib/state.js";

runStep("step_4_wallet_deploy", async (ctx) => {
  const cfg = loadConfig();
  const owner = privateKeyToAccount(ensureParticipantKey()).address;
  const existing = await reusable("wallet", ctx.fresh);
  if (existing) {
    return {
      summary: `wallet already deployed: ${existing} (owner ${owner}); pass --fresh to deploy a new one`,
      data: { wallet: existing, owner, reused: true, balanceWei: (await getBalance(existing)).toString() },
    };
  }
  ctx.log("deploying ExampleWallet (funded through its creation value)…");
  const wallet = await deployContract("ExampleWallet", [owner], cfg.walletFundingWei);
  writeState({ wallet });
  return {
    summary: [`ExampleWallet deployed: ${wallet}`, `owner: ${owner}`, `balance: ${Number(await getBalance(wallet)) / 1e18} ETH`, `next: yarn step_5_tx_wallet`].join("\n"),
    data: { wallet, owner, reused: false },
  };
});
