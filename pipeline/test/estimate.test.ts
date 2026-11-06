import { describe, expect, test } from "bun:test";
import { concat, toHex, type Address, type Hex } from "viem";
import { buildFrameTx, keyedNonce } from "../src/builder.ts";
import { frameGasModel, inferStateGas, withEstimates } from "../src/estimate.ts";
import { SIG_SCHEME, type SignatureEntry } from "../src/codec/FrameTx.ts";

// Shape of the research's measured estimates (Nov 6): account, key (0 << 32) | 700, expiry + self_verify + one
// 1-wei SENDER frame, one 2,594-byte placeholder entry (0x01, 0x00, a 32-byte hash, zeros).
const ACCOUNT: Address = "0x107445c26594fdb3eb62803a8e79b9d7732148c3";
const entry = concat(["0x0100", `0x${"ab".repeat(32)}`, toHex(new Uint8Array(2_594 - 34))]) as Hex;
const sig: SignatureEntry = { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: entry };
const transferTo = (to: Address) => buildFrameTx({
  chainId: 1337n, sender: ACCOUNT, nonce: keyedNonce(0, 700), verifyGas: 94_900n, deadline: 1_800_000_000,
  calls: [{ to, value: 1n }], fees: { maxFeePerGas: 14n, maxPriorityFeePerGas: 1n }, signatures: [sig],
});

describe("ethrex gas model", () => {
  test("the measured transfer: 2,607 billed bytes, mandatory 19,525, floor 166,848", () => {
    const m = frameGasModel(transferTo("0x5544596212F91984C986A919C8026DF0576816f9"));
    expect(m.bytes).toBe(2_607n); // 2,594 entry + 8 expiry bytes + 5 bytes of RLP nonce fields
    expect(m.mandatory).toBe(19_525n); // 12,000 + 3 x 475 + 100 (ARBITRARY) + 6,000 (one value frame)
    expect(m.floor).toBe(166_848n);
  });

  test("state gas from the measured cumulativeGasUsed: 0 to an existing account, 183,600 to a fresh one", () => {
    // frames used 3,051 (expiry) / 30,677 (verify) / 100 or 3,000 (transfer); the calldata floor binds in both
    expect(inferStateGas(transferTo("0x5544596212F91984C986A919C8026DF0576816f9"), 186_373n, [3_051n, 30_677n, 100n])).toBe(0n);
    expect(inferStateGas(transferTo("0x00000000000000000000000000000000c0ffee02"), 369_973n, [3_051n, 30_677n, 3_000n])).toBe(183_600n);
  });

  test("a frame without value adds no 6,000", () => {
    const tx = buildFrameTx({
      chainId: 1337n, sender: ACCOUNT, nonce: keyedNonce(0, 701), verifyGas: 94_900n, deadline: 1_800_000_000,
      calls: [{ to: ACCOUNT, data: "0x58aaa077" }], fees: { maxFeePerGas: 14n, maxPriorityFeePerGas: 1n }, signatures: [sig],
    });
    expect(frameGasModel(tx).mandatory).toBe(13_525n); // the research's setHotPolicy case
  });

  test("limits are filled into the calls", () => {
    const calls = withEstimates([{ to: ACCOUNT, value: 1n }], [{ used: 100n, execution: 2_610n, state: 183_600n, leaf: 5 }]);
    expect(calls[0]).toEqual({ to: ACCOUNT, value: 1n, gas: 2_610n, stateGas: 183_600n });
  });
});
