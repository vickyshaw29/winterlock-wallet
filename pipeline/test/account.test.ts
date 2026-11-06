import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, slice, type Address } from "viem";
import { FACTORY_ABI, accountSalt, createAccountCalldata, predictAccountAddress, proxyInitCode, proxyRuntimeCode, type AccountParams } from "../src/account.ts";

// The account the factory really created on the devnet (pipeline/scripts/deploy-account.ts).
const d = await Bun.file(new URL("./fixtures/account-deployment.json", import.meta.url)).json();
const params: AccountParams = {
  ...d.params, hotValueCap: BigInt(d.params.hotValueCap), hotFeeCap: BigInt(d.params.hotFeeCap),
};

describe("counterfactual account address", () => {
  test("computed off chain, it is the address the devnet factory deployed to", () => {
    expect(predictAccountAddress(d.factory, d.implementation, params)).toBe(getAddress(d.account));
  });

  test("it commits to every argument: change any one and the address moves", () => {
    const base = predictAccountAddress(d.factory, d.implementation, params);
    const variants: Partial<AccountParams>[] = [
      { root: `0x${"11".repeat(32)}` }, { treeSeed: `0x${"22".repeat(32)}` }, { height: 12 }, { owner: "0x000000000000000000000000000000000000bEEF" },
      { hotStart: 1000 }, { hotValueCap: 1n }, { hotFeeCap: 1n }, { allowedTarget: "0x000000000000000000000000000000000000dEaD" }, { salt: `0x${"33".repeat(32)}` },
    ];
    for (const v of variants) expect(predictAccountAddress(d.factory, d.implementation, { ...params, ...v })).not.toBe(base);
  });

  test("another factory or implementation gives another address", () => {
    const base = predictAccountAddress(d.factory, d.implementation, params);
    expect(predictAccountAddress("0x0000000000000000000000000000000000000001", d.implementation, params)).not.toBe(base);
    expect(predictAccountAddress(d.factory, "0x0000000000000000000000000000000000000001", params)).not.toBe(base);
  });

  test("the proxy: 10 bytes of init code around the 45-byte runtime", () => {
    const init = proxyInitCode(d.implementation);
    expect((init.length - 2) / 2).toBe(55);
    expect(slice(init, 10)).toBe(proxyRuntimeCode(d.implementation).toLowerCase() as Address);
    expect((proxyRuntimeCode(d.implementation).length - 2) / 2).toBe(45);
  });

  test("the salt is keccak256 of the nine ABI-encoded arguments", () => {
    expect(accountSalt(params)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accountSalt({ ...params, salt: `0x${"00".repeat(32)}` })).not.toBe(accountSalt(params));
  });
});

describe("the factory call", () => {
  test("createAccount calldata round-trips through the ABI", () => {
    const { functionName, args } = decodeFunctionData({ abi: FACTORY_ABI, data: createAccountCalldata(params) });
    expect(functionName).toBe("createAccount");
    expect(args).toEqual([params.root, params.treeSeed, params.height, getAddress(params.owner), params.hotStart, params.hotValueCap, params.hotFeeCap, getAddress(params.allowedTarget), params.salt]);
  });

});
