import { loadConfig } from "../lib/config.js";
import { setReputation } from "../lib/explorer.js";
import { runStep } from "../lib/output.js";
import { CHEAT_NOTICE, waitForReputation } from "../lib/reputationCheat.js";
import { requireState } from "../lib/state.js";

runStep("step_9_reputation_burn", async () => {
  // Only ever the participant's own entity, taken from the state file.
  const wallet = requireState("violating", "step_6_tx_violating_canonical");

  await setReputation(wallet, loadConfig().banOpsSeenPenalty, 0);
  const r = await waitForReputation(wallet, "BANNED");
  return {
    summary: [CHEAT_NOTICE, "", `reputation of ${wallet}: ${r.status} (opsSeen ${r.opsSeen}, opsIncluded ${r.opsIncluded}, staked ${r.isStaked})`, "next: yarn step_10_tx_violating_alt_banned   (undo with: yarn reset_reputation)"].join("\n"),
    data: { shortcut: true, wallet, ...r },
  };
});
