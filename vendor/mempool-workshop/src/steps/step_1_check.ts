import { privateKeyToAccount } from "viem/accounts";
import { fundFromFaucet, getBalance } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { ensureParticipantKey } from "../lib/state.js";
import { StepError, runStep } from "../lib/output.js";
import { rpc } from "../lib/rpc.js";

runStep("step_1_check", async (ctx) => {
  const cfg = loadConfig();
  const id = Number(await rpc(cfg.gatewayUrl, "eth_chainId", []));
  if (id !== cfg.chainId) {
    throw new StepError("WRONG_CHAIN", `the gateway at ${cfg.gatewayUrl} reports chain ${id}, expected ${cfg.chainId}`, { hint: "update chainId / gatewayUrl in workshop.config.json5, or the devnet was replaced" });
  }
  const skCfg = await rpc(cfg.gatewayUrl, "skandha_config", []);

  let explorer = "available";
  try {
    await rpc(cfg.gatewayUrl, "skandha_explorer_listReputation", [{ limit: 1 }]);
  } catch {
    explorer = "unavailable (steps still work, but step_10 and step_11 print less)";
    ctx.log("warning: sidecar explorer methods are not enabled on this node");
  }

  const account = privateKeyToAccount(ensureParticipantKey());
  let balance = await getBalance(account.address);
  let funded = false;
  if (balance < cfg.minBalanceWei) {
    ctx.log(`asking the faucet to fund ${account.address}…`);
    await fundFromFaucet(account.address);
    balance = await getBalance(account.address);
    funded = true;
  }
  return {
    summary: [
      `chain ${cfg.chainId}: ethrex and the sidecar reachable`,
      `participant: ${account.address}`,
      `balance: ${Number(balance) / 1e18} ETH${funded ? " (just funded)" : ""}`,
      `explorer: ${explorer}`,
    ].join("\n"),
    data: { chainId: cfg.chainId, participant: account.address, balanceWei: balance.toString(), funded, explorer, minStakeWei: skCfg.minStake },
  };
});
