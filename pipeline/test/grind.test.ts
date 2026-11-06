import { describe, expect, test } from "bun:test";
import { concat, toHex, type Address, type Hex } from "viem";
import { buildFrameTx, keyedNonce } from "../src/builder.ts";
import { computeSigHash } from "../src/codec/codec.ts";
import { grind, maxStepsFor } from "../src/grind.ts";
import { placeholders, signFrameTx, type HashSigner, type SignatureSlot } from "../src/signer.ts";
import { wotsVerifySteps } from "../src/wots.ts";

const ACCOUNT: Address = "0x107445c26594fdb3eb62803a8e79b9d7732148c3";
const BOB: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
let signCalls = 0;
const signer: HashSigner = { height: 10, generation: 0, treeSeed: "0x", async sign({ msg }) { signCalls++; return concat(["0x0100", msg, toHex(new Uint8Array(2_594 - 34))]); } };
const slots: SignatureSlot[] = [{ kind: "hash", signer, leaf: 7 }];
const at = (deadline: number) => buildFrameTx({
  chainId: 1337n, sender: ACCOUNT, nonce: keyedNonce(0, 7), verifyGas: 90_000n, deadline,
  calls: [{ to: BOB, value: 1n }], fees: { maxFeePerGas: 2_000_000_001n, maxPriorityFeePerGas: 1n }, signatures: placeholders(slots),
});

describe("grinding", () => {
  test("the cost model: (limit - base) / per step", () => {
    expect(maxStepsFor({ verifyGasLimit: 90_000n, baseGas: 36_000, gasPerStep: 80 })).toBe(675);
  });

  test("finds a deadline whose message fits a tight budget, and records every try", () => {
    const tight = { verifyGasLimit: 90_000n, baseGas: 90_000 - 470 * 80, gasPerStep: 80 }; // room for 470 steps, below the ~506 average
    const g = grind((i) => ({ value: 1_800_000_000 + i, tx: at(1_800_000_000 + i) }), tight);
    expect(g.maxSteps).toBe(470);
    expect(g.steps).toBeLessThanOrEqual(470);
    expect(g.steps).toBe(wotsVerifySteps(g.sigHash));
    expect(g.sigHash).toBe(computeSigHash(at(g.value)));
    expect(g.tries.at(-1)).toEqual({ value: g.value, steps: g.steps });
    expect(g.tries.slice(0, -1).every((t) => t.steps > 470)).toBe(true); // it stops at the first fit
  });

  test("never signs: only candidate hashes are computed, and the chosen one is what gets signed", async () => {
    signCalls = 0;
    const g = grind((i) => ({ value: 1_800_000_000 + i, tx: at(1_800_000_000 + i) }), { verifyGasLimit: 90_000n, baseGas: 52_400, gasPerStep: 80 });
    expect(signCalls).toBe(0);
    const { sigHash } = await signFrameTx(g.tx, slots);
    expect(signCalls).toBe(1);
    expect(sigHash).toBe(g.sigHash);
  });

  test("refuses a budget no message can fit, and gives up after maxTries", () => {
    expect(() => grind((i) => ({ value: i, tx: at(1_800_000_000 + i) }), { verifyGasLimit: 90_000n, baseGas: 89_000, gasPerStep: 80 })).toThrow("best message");
    expect(() => grind((i) => ({ value: i, tx: at(1_800_000_000 + i) }), { verifyGasLimit: 90_000n, baseGas: 90_000 - 60 * 80, gasPerStep: 80, maxTries: 3 })).toThrow("in 3 tries");
  });
});
