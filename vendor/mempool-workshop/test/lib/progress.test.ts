import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { blockedBy, gated, PREREQUISITES } from "../../src/lib/progress.js";
import { readState, writeState } from "../../src/lib/state.js";
import { loadConfig, setConfig } from "../../src/lib/config.js";
import { StepError } from "../../src/lib/output.js";

const KEY = `0x${"11".repeat(32)}` as const;
const OTHER = `0x${"22".repeat(32)}` as const;
const account = privateKeyToAccount(KEY).address;
const ok = async () => ({ summary: "", data: {} });
const ctx = { json: true, fresh: false, args: [], log: () => {} };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-progress-"));
  setConfig({ ...loadConfig(), stateFile: path.join(dir, "state.json") });
});
afterEach(() => {
  setConfig(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("step order", () => {
  it("every prerequisite is a known step", () => {
    for (const needs of Object.values(PREREQUISITES)) for (const n of needs) expect(PREREQUISITES).toHaveProperty(n);
  });

  it("nothing but step 1 runs on an empty workshop", () => {
    expect(blockedBy("step_2_tx_first", {})?.code).toBe("STEP_ORDER");
    expect(blockedBy("step_1_check", {})).toBeNull();
    expect(blockedBy("step_11_debug", {})).toBeNull();
  });

  it("names the step that has to run first", () => {
    const state = { participantKey: KEY, account, completedSteps: ["step_1_check"] };
    const e = blockedBy("step_5_tx_wallet", state)!;
    expect(e.code).toBe("STEP_ORDER");
    expect(e.hint).toContain("step_4_wallet_deploy");
    expect(blockedBy("step_2_tx_first", state)).toBeNull();
  });

  it("blocks a participant key that is not the one step 1 recorded", () => {
    const e = blockedBy("step_2_tx_first", { participantKey: OTHER, account, completedSteps: ["step_1_check"] })!;
    expect(e.code).toBe("STATE_KEY_CHANGED");
    expect(e.hint).toContain("step_1_check");
  });
});

describe("gated", () => {
  it("step 1 resets the workshop but keeps the participant key, and records itself", async () => {
    writeState({ participantKey: KEY, wallet: "0x0000000000000000000000000000000000000001", completedSteps: ["step_1_check", "step_4_wallet_deploy"], account });
    await gated("step_1_check", ok)(ctx);
    expect(readState()).toEqual({ participantKey: KEY, account, completedSteps: ["step_1_check"] });
  });

  it("refuses to run a step out of order, without running it", async () => {
    writeState({ participantKey: KEY, account, completedSteps: ["step_1_check"] });
    let ran = false;
    await expect(gated("step_7_stake", async () => ((ran = true), { summary: "", data: {} }))(ctx)).rejects.toBeInstanceOf(StepError);
    expect(ran).toBe(false);
  });

  it("records a finished step, but not one that missed its expected outcome", async () => {
    writeState({ participantKey: KEY, account, completedSteps: ["step_1_check"] });
    await gated("step_4_wallet_deploy", async () => ({ summary: "", data: {}, ok: false }))(ctx);
    expect(readState().completedSteps).toEqual(["step_1_check"]);
    await gated("step_4_wallet_deploy", ok)(ctx);
    expect(readState().completedSteps).toEqual(["step_1_check", "step_4_wallet_deploy"]);
  });
});
