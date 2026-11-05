import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

// FakeChain's sequential create addresses, matching the manifest's own step order.
const IMPLEMENTATION_V1 = "0x0000000000000000000000000000000000000001" as Address;
const PROXY = "0x0000000000000000000000000000000000000002" as Address;
const IMPLEMENTATION = "0x0000000000000000000000000000000000000003" as Address;

const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

const abi = parseAbi([
  "function upgradeTo(address newImplementation)",
  "function changeAdmin(address newAdmin)",
  "function initialize(string,string,string,uint8,address,address,address,address)",
  "function initializeV2(string)",
  "function initializeV2_1(address)",
  "function initializeV2_2(address[],string)",
  "function configureMinter(address,uint256)",
  "function mint(address,uint256)",
]);

function setupUsdc() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  for (const step of registry.usdc.steps) {
    if (step.kind === "create") artifacts.write("usdc", makeArtifact({ hash: step.tx }));
  }
  return { chain, artifacts, journal, log: () => {} };
}

describe("usdc deploy", () => {
  it("sends the three creations, then upgrades, initializes, and mints, all against the proxy", async () => {
    const deps = setupUsdc();

    await runProtocols(["usdc"], registry, deps);

    // 3 creates + upgrade + renounce-admin + initialize + initializeV2 + initializeV2_1 +
    // initializeV2_2 + configureMinter + mint.
    expect(deps.chain.sent).toHaveLength(11);
    const calls = deps.chain.sent.slice(3); // everything after the three creations
    for (const tx of calls) expect(tx.to).toBe(PROXY);

    const decoded = calls.map((tx) => decodeFunctionData({ abi, data: tx.data }));
    expect(decoded[0]).toMatchObject({ functionName: "upgradeTo", args: [IMPLEMENTATION] });
    // Admin gives up admin before any FiatToken function is called through the proxy - the real
    // contract rejects a call to its own logic from the current admin (confirmed live).
    expect(decoded[1]).toMatchObject({ functionName: "changeAdmin", args: [BURN_ADDRESS] });
    expect(decoded[2]).toMatchObject({
      functionName: "initialize",
      args: ["USD Coin", "USDC", "USD", 6, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER],
    });
    expect(decoded[3]).toMatchObject({ functionName: "initializeV2", args: ["USD Coin"] });
    expect(decoded[4]).toMatchObject({ functionName: "initializeV2_1", args: [DEPLOYER] });
    expect(decoded[5]).toMatchObject({ functionName: "initializeV2_2", args: [[], "USDC"] });
    expect(decoded[6]).toMatchObject({ functionName: "configureMinter", args: [DEPLOYER, 2n ** 256n - 1n] });
    expect(decoded[7]).toMatchObject({ functionName: "mint", args: [DEPLOYER, 10n ** 15n] });
  });

  it("resumes after the creations if the process died before any initializer call", async () => {
    const deps = setupUsdc();
    deps.chain.codes.set(IMPLEMENTATION_V1.toLowerCase(), "0x6001");
    deps.chain.codes.set(PROXY.toLowerCase(), "0x6001");
    deps.chain.codes.set(IMPLEMENTATION.toLowerCase(), "0x6001");
    deps.journal.file.protocols.usdc = {
      stepsDone: ["implementation-v1", "proxy", "implementation"],
      contracts: { IMPLEMENTATION_V1, PROXY, IMPLEMENTATION },
      mainnetToDevnet: {},
    };
    deps.journal.file.deployerNonce = 3;
    deps.chain.extraNonce = 3;

    await runProtocols(["usdc"], registry, deps);

    expect(deps.chain.sent).toHaveLength(8); // no re-creations, just the eight calls
    expect(deps.chain.sent[0].to).toBe(PROXY);
  });
});

describe("usdc verify", () => {
  function deployedUsdc() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    for (const address of [IMPLEMENTATION_V1, PROXY, IMPLEMENTATION]) chain.codes.set(address.toLowerCase(), "0x6001");
    journal.file.protocols.usdc = {
      stepsDone: registry.usdc.steps.map((s) => s.id),
      contracts: { IMPLEMENTATION_V1, PROXY, IMPLEMENTATION },
      mainnetToDevnet: {},
    };
    chain.setRead(PROXY, "name", "USD Coin");
    chain.setRead(PROXY, "symbol", "USDC");
    chain.setRead(PROXY, "currency", "USD");
    chain.setRead(PROXY, "decimals", 6);
    chain.setRead(PROXY, "masterMinter", DEPLOYER);
    chain.setRead(PROXY, "pauser", DEPLOYER);
    chain.setRead(PROXY, "blacklister", DEPLOYER);
    chain.setRead(PROXY, "owner", DEPLOYER);
    chain.setRead(PROXY, "version", "2");
    chain.setRead(PROXY, "totalSupply", 10n ** 15n);
    chain.setRead(PROXY, "balanceOf", 10n ** 15n);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes when every role points at the deployer and version proves V2+ is running", async () => {
    const [report] = await verifyProtocols(["usdc"], registry, deployedUsdc());
    expect(report.ok).toBe(true);
  });

  it("fails when version reports something other than 2 (the upgrade did not really land)", async () => {
    const deps = deployedUsdc();
    deps.chain.setRead(PROXY, "version", "1");
    const [report] = await verifyProtocols(["usdc"], registry, deps);
    expect(report.checks.find((c) => c.name === "version (proves V2+ code is running)")?.ok).toBe(false);
  });

  it("fails when a role was left at some other address", async () => {
    const deps = deployedUsdc();
    deps.chain.setRead(PROXY, "masterMinter", "0x00000000000000000000000000000000000000ff");
    const [report] = await verifyProtocols(["usdc"], registry, deps);
    expect(report.checks.find((c) => c.name === "masterMinter is the deployer")?.ok).toBe(false);
  });
});
