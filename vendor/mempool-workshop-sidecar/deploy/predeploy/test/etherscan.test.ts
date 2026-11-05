import { describe, expect, it } from "vitest";
import { EtherscanClient } from "../src/etherscan";
import type { Address, Hex } from "../src/types";

interface Call {
  url: URL;
}

function harness(bodies: unknown[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetchFn = (async (input: string | URL) => {
    calls.push({ url: new URL(String(input)) });
    const body = bodies[calls.length - 1];
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  const client = new EtherscanClient("KEY123", {
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    minIntervalMs: 250,
  });
  return { client, calls, sleeps };
}

const ADDRESS = "0x514910771AF9Ca656af840dff83E8264EcF986CA" as Address;
const TX = ("0x" + "11".repeat(32)) as Hex;

describe("EtherscanClient", () => {
  it("calls the V2 API for mainnet with the key and parses source metadata", async () => {
    const { client, calls } = harness([
      {
        status: "1",
        message: "OK",
        result: [{ ContractName: "LinkToken", CompilerVersion: "v0.4.16", ConstructorArguments: "" }],
      },
    ]);

    const meta = await client.getSourceMeta(ADDRESS);

    expect(meta).toEqual({ contractName: "LinkToken", compilerVersion: "v0.4.16", constructorArguments: "0x" });
    const params = calls[0].url.searchParams;
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://api.etherscan.io/v2/api");
    expect(params.get("chainid")).toBe("1");
    expect(params.get("module")).toBe("contract");
    expect(params.get("action")).toBe("getsourcecode");
    expect(params.get("address")).toBe(ADDRESS);
    expect(params.get("apikey")).toBe("KEY123");
  });

  it("rejects unverified contracts", async () => {
    const { client } = harness([
      { status: "1", message: "OK", result: [{ ContractName: "", CompilerVersion: "", ConstructorArguments: "" }] },
    ]);
    await expect(client.getSourceMeta(ADDRESS)).rejects.toThrow(/not verified/);
  });

  it("retries after a rate-limit response, sleeping first", async () => {
    const { client, calls, sleeps } = harness([
      { status: "0", message: "NOTOK", result: "Max rate limit reached" },
      { jsonrpc: "2.0", id: 1, result: "0x6080" },
    ]);

    const code = await client.getRuntimeCode(ADDRESS);

    expect(code).toBe("0x6080");
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(1000);
  });

  it("spaces consecutive calls by the minimum interval", async () => {
    const { client, sleeps } = harness([
      { jsonrpc: "2.0", id: 1, result: "0x60" },
      { jsonrpc: "2.0", id: 1, result: "0x61" },
    ]);
    await client.getRuntimeCode(ADDRESS);
    await client.getRuntimeCode(ADDRESS);
    expect(sleeps).toEqual([250]);
  });

  it("fails on other API errors, with the reason", async () => {
    const { client } = harness([{ status: "0", message: "NOTOK", result: "Invalid API Key" }]);
    await expect(client.getRuntimeCode(ADDRESS)).rejects.toThrow(/Invalid API Key/);
  });

  it("parses a transaction, converting the block number", async () => {
    const { client } = harness([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { from: "0xf5", to: null, input: "0x6080", value: "0x0", blockNumber: "0x105b8b" },
      },
    ]);
    const tx = await client.getTransaction(TX);
    expect(tx).toMatchObject({ hash: TX, to: null, input: "0x6080", value: "0x0", blockNumber: 1072011 });
  });

  it("throws when a transaction is not found", async () => {
    const { client } = harness([{ jsonrpc: "2.0", id: 1, result: null }]);
    await expect(client.getTransaction(TX)).rejects.toThrow(/not found/);
  });

  it("parses a creation record, mapping an empty factory to null", async () => {
    const { client } = harness([
      {
        status: "1",
        message: "OK",
        result: [
          {
            contractAddress: ADDRESS,
            contractCreator: "0xf5",
            txHash: TX,
            blockNumber: "4281611",
            contractFactory: "",
          },
        ],
      },
    ]);
    const info = await client.getContractCreation(ADDRESS);
    expect(info).toMatchObject({ txHash: TX, blockNumber: 4281611, contractFactory: null });
  });
});
