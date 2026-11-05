/**
 * The steps build on each other, and what they deploy belongs to the key that ran step 1. So:
 *   - step 1 always resets the workshop: it forgets every address and every finished step (the participant key stays,
 *     because the faucet funded it and gives each address ETH only once an hour)
 *   - every other step refuses to run unless the steps it needs have finished, and unless the participant key is still
 *     the one step 1 recorded
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { readState, resetState, writeState, type WorkshopState } from "./state.js";
import { StepError } from "./stepError.js";
import type { Result, StepContext } from "./output.js";

const FIRST = "step_1_check";

/** The steps that must have finished before each step. A name that is not listed (step_11_debug) runs any time. */
export const PREREQUISITES: Record<string, string[]> = {
  step_1_check: [],
  step_2_tx_first: [FIRST],
  step_3_tx_paymaster: [FIRST],
  step_4_wallet_deploy: [FIRST],
  step_5_tx_wallet: ["step_4_wallet_deploy"],
  step_6_tx_violating_canonical: [FIRST],
  step_7_stake: ["step_6_tx_violating_canonical"],
  step_8_tx_violating_alt: ["step_7_stake"],
  step_9_reputation_burn: ["step_6_tx_violating_canonical"],
  step_10_tx_violating_alt_banned: ["step_9_reputation_burn"],
  step_12_tx_keyed_nonces: ["step_4_wallet_deploy"],
  step_13_tx_recent_roots: ["step_4_wallet_deploy"],
  reset_reputation: ["step_6_tx_violating_canonical"],
};

/** Why `name` cannot run on this state, or `null`. Pure. */
export function blockedBy(name: string, state: WorkshopState): StepError | null {
  const needs = PREREQUISITES[name];
  if (needs === undefined || name === FIRST) return null;
  if (!state.account) {
    return new StepError("STEP_ORDER", `${name} needs the workshop to be set up`, { hint: `run \`yarn ${FIRST}\` first` });
  }
  const current = state.participantKey ? privateKeyToAccount(state.participantKey).address : undefined;
  if (current?.toLowerCase() !== state.account.toLowerCase()) {
    return new StepError(
      "STATE_KEY_CHANGED",
      `the participant key (${current ?? "none"}) is not the one step 1 set this workshop up for (${state.account})`,
      { hint: `everything deployed so far belongs to that key; run \`yarn ${FIRST}\` again, which resets the workshop` },
    );
  }
  const done = state.completedSteps ?? [];
  const missing = needs.filter((n) => !done.includes(n));
  if (missing.length === 0) return null;
  return new StepError("STEP_ORDER", `${name} needs ${missing.join(", ")} to have finished first`, {
    hint: `run ${missing.map((m) => `\`yarn ${m}\``).join(", ")}`,
  });
}

/** Wraps a step: step 1 resets the workshop first, the others are checked, and a step that reached its expected outcome is recorded. */
export function gated(name: string, fn: (ctx: StepContext) => Promise<Result>): (ctx: StepContext) => Promise<Result> {
  return async (ctx) => {
    if (name === FIRST) resetState();
    else {
      const blocked = blockedBy(name, readState());
      if (blocked) throw blocked;
    }
    const result = await fn(ctx);
    if (result.ok !== false && name in PREREQUISITES) {
      const state = readState();
      const account: Address = privateKeyToAccount(state.participantKey!).address;
      const completedSteps = name === FIRST ? [FIRST] : [...new Set([...(state.completedSteps ?? []), name])];
      writeState({ account: name === FIRST ? account : state.account, completedSteps });
    }
    return result;
  };
}
