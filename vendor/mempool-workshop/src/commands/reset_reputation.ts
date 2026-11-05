import { setReputation } from "../lib/explorer.js";
import { runStep } from "../lib/output.js";
import { CHEAT_NOTICE, waitForReputation } from "../lib/reputationCheat.js";
import { requireState } from "../lib/state.js";

// Not a workshop step: undoes step 9 so the wallet can send again.
runStep("reset_reputation", async () => {
  // Only ever the participant's own entity, taken from the state file.
  const wallet = requireState("violating", "step_6_tx_violating_canonical");

  await setReputation(wallet, 0, 0);
  const r = await waitForReputation(wallet, "OK");
  return {
    summary: [CHEAT_NOTICE, "", `reputation of ${wallet} reset: ${r.status} (opsSeen ${r.opsSeen}, opsIncluded ${r.opsIncluded})`, "next: yarn step_8_tx_violating_alt   (accepted again while the wallet is staked)"].join("\n"),
    data: { shortcut: true, wallet, ...r },
  };
});
