import { describe, expect, it } from "vitest";
import { retry } from "../../src/lib/chain.js";

describe("retry", () => {
  it("retries a failing call and returns the first success", async () => {
    let calls = 0;
    const r = await retry(async () => { calls++; if (calls < 4) throw new Error("nonce"); return "ok"; }, { retries: 10, delayMs: () => 0 });
    expect(r).toBe("ok");
    expect(calls).toBe(4);
  });

  it("throws the last error once retries are exhausted", async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error(`e${calls}`); }, { retries: 2, delayMs: () => 0 })).rejects.toThrow("e3");
    expect(calls).toBe(3);
  });
});
