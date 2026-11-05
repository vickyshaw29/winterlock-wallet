import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { buildStakeTx } from "../../src/lib/frameTx/build.js";
import { FRAME_MODE } from "../../src/lib/frameTx/types.js";

const REGISTRY = "0x00000000000000000000000000000000000000c2";
const wallet = "0x00000000000000000000000000000000000000b1";
const owner = "0x00000000000000000000000000000000000000a1";

describe("buildStakeTx", () => {
  const tx = buildStakeTx({ registry: REGISTRY, wallet, owner, amount: 12_000_000_000_000_000n, unstakeDelaySec: 86400, nonce: 3n, chainId: 1337, maxFeePerGas: 2_000_000_000n });

  it("the SENDER frame calls the registry's addStake(86400) with the stake as value, so the wallet is the staker", () => {
    const sender = tx.frames[1];
    expect(sender.mode).toBe(FRAME_MODE.SENDER);
    expect(sender.target).toBe(REGISTRY);
    expect(sender.value).toBe(12_000_000_000_000_000n);
    expect(sender.data).toBe(encodeFunctionData({ abi: [{ type: "function", name: "addStake", stateMutability: "payable", inputs: [{ type: "uint32" }], outputs: [] }], functionName: "addStake", args: [86400] }));
    expect(sender.limits).toEqual({ execution: 150_000n, state: 300_000n });
  });

  it("the VERIFY frame is the clean path: empty data, so the wallet is admissible before it is staked", () => {
    expect(tx.frames[0]).toMatchObject({ mode: FRAME_MODE.VERIFY, data: "0x" });
    expect(tx.signatures[0].signer).toBe(owner);
  });
});
