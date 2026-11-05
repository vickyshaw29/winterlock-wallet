import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { EtherscanApi } from "../src/etherscan";
import { fetchProtocolArtifacts } from "../src/fetch";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { MemoryArtifacts, hash } from "./fakes";

const CONTRACT = "0x514910771AF9Ca656af840dff83E8264EcF986CA" as Address;
const ARGS = `0x${"00".repeat(31)}05` as Hex;
const RUNTIME = "0x6080604052" as Hex;

function fakeApi(overrides: Partial<EtherscanApi> = {}): EtherscanApi {
  return {
    getTransaction: async (h) => ({
      hash: h,
      from: "0xf55037738604FDdFC4043D12F25124E94D7D1780" as Address,
      to: null,
      input: `0x6001${ARGS.slice(2)}` as Hex,
      value: "0x0" as Hex,
      blockNumber: 42,
    }),
    getReceiptContractAddress: async () => CONTRACT,
    getSourceMeta: async () => ({ contractName: "LinkToken", compilerVersion: "v0.4.16", constructorArguments: ARGS }),
    getRuntimeCode: async () => RUNTIME,
    getContractCreation: async () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

const protocol = defineProtocol({
  name: "link",
  dependsOn: [],
  steps: [
    { id: "token", kind: "create", tx: hash(1), as: "LINK" },
    { id: "noop", kind: "custom", run: async () => {} },
  ],
  verify: async () => [],
});

describe("fetchProtocolArtifacts", () => {
  it("stores one artifact per create step and skips custom steps", async () => {
    const store = new MemoryArtifacts();
    const logs: string[] = [];

    await fetchProtocolArtifacts(protocol, fakeApi(), store, (m) => logs.push(m));

    const artifact = store.read("link", hash(1));
    expect(artifact).toMatchObject({
      hash: hash(1),
      to: null,
      blockNumber: 42,
      contractAddress: CONTRACT,
      constructorArgs: ARGS,
      contractName: "LinkToken",
      compiler: "v0.4.16",
      runtimeCodeHash: keccak256(RUNTIME),
    });
    expect(logs[0]).toMatch(/link\/token: fetched LinkToken/);
  });

  it("records a null runtime hash for a contract with no code", async () => {
    const store = new MemoryArtifacts();
    await fetchProtocolArtifacts(protocol, fakeApi({ getRuntimeCode: async () => "0x" }), store, () => {});
    expect(store.read("link", hash(1)).runtimeCodeHash).toBeNull();
  });

  it("rejects a transaction that is not a direct creation", async () => {
    const api = fakeApi({
      getTransaction: async (h) => ({
        hash: h,
        from: "0xf5" as Address,
        to: "0x48E516B34A1274f49457b9C6182097796D59E248" as Address,
        input: "0x",
        value: "0x0" as Hex,
        blockNumber: 1,
      }),
    });
    await expect(fetchProtocolArtifacts(protocol, api, new MemoryArtifacts(), () => {})).rejects.toThrow(
      /not a direct contract creation/
    );
  });

  it("treats an unverified contract's whole creation input as init code, no constructor arguments", async () => {
    const store = new MemoryArtifacts();
    const logs: string[] = [];
    const api = fakeApi({
      getSourceMeta: async (address) => {
        throw new Error(`Etherscan: source for ${address} is not verified`);
      },
    });

    await fetchProtocolArtifacts(protocol, api, store, (m) => logs.push(m));

    const artifact = store.read("link", hash(1));
    expect(artifact).toMatchObject({
      contractName: "(unverified)",
      compiler: "(unverified)",
      constructorArgs: "0x",
      input: `0x6001${ARGS.slice(2)}`, // unchanged: the whole tx input, none of it split off as args
    });
    expect(logs.some((l) => /warning: source is not verified/.test(l))).toBe(true);
  });

  it("still fails loudly on any other getSourceMeta error", async () => {
    const api = fakeApi({
      getSourceMeta: async () => {
        throw new Error("Etherscan error: Invalid API Key");
      },
    });
    await expect(fetchProtocolArtifacts(protocol, api, new MemoryArtifacts(), () => {})).rejects.toThrow(
      /Invalid API Key/
    );
  });

  it("rejects constructor arguments that are not a suffix of the input", async () => {
    const api = fakeApi({
      getSourceMeta: async () => ({ contractName: "X", compilerVersion: "v", constructorArguments: "0xff" as Hex }),
    });
    await expect(fetchProtocolArtifacts(protocol, api, new MemoryArtifacts(), () => {})).rejects.toThrow(/suffix/);
  });
});
