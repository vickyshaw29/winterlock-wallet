import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reusable } from "../../src/lib/contracts.js";
import { loadConfig, setConfig } from "../../src/lib/config.js";
import { writeState } from "../../src/lib/state.js";

const ADDR = "0x00000000000000000000000000000000000000b1";
let dir: string;

const mockCode = (code: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: code }))));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-stale-"));
  setConfig({ ...loadConfig(), stateFile: path.join(dir, "state.json") });
  writeState({ wallet: ADDR });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setConfig(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reusable (devnet reset detection)", () => {
  it("a recorded address with no code on chain throws STATE_STALE and tells you to use --fresh", async () => {
    mockCode("0x");
    await expect(reusable("wallet", false)).rejects.toMatchObject({ code: "STATE_STALE", hint: expect.stringContaining("--fresh") });
  });

  it("a recorded address that still has code is reused", async () => {
    mockCode("0x6001");
    await expect(reusable("wallet", false)).resolves.toBe(ADDR);
  });

  it("--fresh ignores the recorded address without asking the chain", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(reusable("wallet", true)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
