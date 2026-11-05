import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readState, requireState, writeState } from "../../src/lib/state.js";
import { loadConfig, setConfig } from "../../src/lib/config.js";
import { StepError } from "../../src/lib/output.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-state-"));
  setConfig({ ...loadConfig(), stateFile: path.join(dir, "state.json") });
});
afterEach(() => {
  setConfig(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("state", () => {
  it("readState returns an empty object when the file is missing", () => {
    expect(readState()).toEqual({});
  });

  it("writeState merges patches", () => {
    writeState({ wallet: "0x0000000000000000000000000000000000000001" });
    writeState({ lastTxHash: "0xabc" });
    expect(readState()).toEqual({ wallet: "0x0000000000000000000000000000000000000001", lastTxHash: "0xabc" });
  });

  it("requireState on missing key throws a StepError naming the creating step", () => {
    try {
      requireState("wallet", "step_4_wallet_deploy");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StepError);
      expect((e as StepError).code).toBe("STATE_MISSING");
      expect((e as StepError).hint).toContain("step_4_wallet_deploy");
    }
  });
});
