import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import verificationKeys from "../src/protocols/railgun-verification-keys.json";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

// Devnet addresses follow real creation order: proxy, poseidon-t3, poseidon-t4, implementation.
const PROXY = "0x0000000000000000000000000000000000000001" as Address;
const POSEIDON_T3 = "0x0000000000000000000000000000000000000002" as Address;
const POSEIDON_T4 = "0x0000000000000000000000000000000000000003" as Address;
const IMPLEMENTATION = "0x0000000000000000000000000000000000000004" as Address;
const MAINNET_POSEIDON_T3 = "0xF5fE83643dd42d408c19B938866fA441C6c52563" as Address;
const MAINNET_POSEIDON_T4 = "0xafd3Fc0396f793B35E433Bbe0e1160329bF0ABd3" as Address;

const abi = parseAbi([
  "function upgrade(address)",
  "function initializeRailgunLogic(address,uint120,uint120,uint256,address)",
  "function unpause()",
  "function setVerificationKey(uint256,uint256,(string,(uint256,uint256),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256[2],uint256[2]),(uint256,uint256)[]))",
]);

const REAL_MAINNET_ADMIN = "0x000000000000000000000000000000000000dEaD" as Address; // stand-in
const bare = (address: Address): string => address.slice(2).toLowerCase();

function setupRailgun() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  for (const step of registry.railgun.steps) {
    if (step.kind !== "create") continue;
    if (step.id === "proxy") {
      // The proxy's stub artifact needs a real 32-byte constructor-argument slot (the admin
      // address, argWords-overridden by the manifest) so applying that override does not fall
      // outside a zero-length args blob the way the default stub artifact would leave it.
      const args = `0x${"0".repeat(24)}${bare(REAL_MAINNET_ADMIN)}` as const;
      artifacts.write("railgun", makeArtifact({ hash: step.tx, input: `0x6001${args.slice(2)}`, constructorArgs: args }));
    } else if (step.id === "poseidon-t3") {
      artifacts.write("railgun", makeArtifact({ hash: step.tx, input: "0x6002", contractAddress: MAINNET_POSEIDON_T3 }));
    } else if (step.id === "poseidon-t4") {
      artifacts.write("railgun", makeArtifact({ hash: step.tx, input: "0x6004", contractAddress: MAINNET_POSEIDON_T4 }));
    } else if (step.id === "implementation") {
      // Each literal library address, once - matching each patch's declared count.
      artifacts.write(
        "railgun",
        makeArtifact({ hash: step.tx, input: `0xdead${bare(MAINNET_POSEIDON_T3)}beef${bare(MAINNET_POSEIDON_T4)}cafe` })
      );
    } else {
      artifacts.write("railgun", makeArtifact({ hash: step.tx }));
    }
  }
  return { chain, artifacts, journal, log: () => {} };
}

describe("railgun manifest shape", () => {
  it("has one step per real verification key, plus the 7 setup steps", () => {
    expect(registry.railgun.steps).toHaveLength(7 + 91);
    expect(verificationKeys).toHaveLength(91);
    const ids = registry.railgun.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate step ids
    for (const { nullifiers, commitments } of verificationKeys) {
      expect(ids).toContain(`vk-${nullifiers}-${commitments}`);
    }
  });
});

describe("railgun deploy", () => {
  it("sends the 3 creations, patches the library into the implementation, then upgrade/unpause/initialize, then all 91 setVerificationKey calls", async () => {
    const deps = setupRailgun();

    await runProtocols(["railgun"], registry, deps);

    expect(deps.chain.sent).toHaveLength(4 + 3 + 91);
    // The proxy's constructor argument (its admin) is rewritten to our deployer, not left as
    // the real mainnet admin the stub artifact embeds.
    const deployerWord = `0x${"0".repeat(24)}${bare(DEPLOYER)}`;
    expect(deps.chain.sent[0].data.slice(-64)).toBe(deployerWord.slice(2));
    // The implementation's init code has both library literals patched to their devnet
    // addresses, not left as the real mainnet library addresses the stub artifact embeds.
    expect(deps.chain.sent[3].data).toBe(`0xdead${bare(POSEIDON_T3)}beef${bare(POSEIDON_T4)}cafe`);

    const calls = deps.chain.sent.slice(4);
    for (const tx of calls) expect(tx.to).toBe(PROXY);

    expect(decodeFunctionData({ abi, data: calls[0].data })).toMatchObject({
      functionName: "upgrade",
      args: [IMPLEMENTATION],
    });
    // unpause before initialize: every non-proxy-native call (including admin's) is gated
    // notPaused, so the implementation can't be reached at all until this runs.
    expect(decodeFunctionData({ abi, data: calls[1].data }).functionName).toBe("unpause");
    expect(decodeFunctionData({ abi, data: calls[2].data })).toMatchObject({
      functionName: "initializeRailgunLogic",
      args: [DEPLOYER, 25n, 25n, 25n, DEPLOYER],
    });

    // Spot-check the first, a middle, and the last setVerificationKey call.
    for (const index of [0, Math.floor(verificationKeys.length / 2), verificationKeys.length - 1]) {
      const entry = verificationKeys[index];
      const decoded = decodeFunctionData({ abi, data: calls[3 + index].data });
      expect(decoded.functionName).toBe("setVerificationKey");
      expect(decoded.args?.[0]).toBe(BigInt(entry.nullifiers));
      expect(decoded.args?.[1]).toBe(BigInt(entry.commitments));
      const verifyingKey = decoded.args?.[2] as unknown as [string];
      expect(verifyingKey[0]).toBe(entry.verifyingKey[0]); // artifactsIPFSHash
    }
  });

  it("resumes correctly if interrupted partway through the verification keys", async () => {
    const deps = setupRailgun();
    for (const address of [PROXY, POSEIDON_T3, POSEIDON_T4, IMPLEMENTATION]) deps.chain.codes.set(address.toLowerCase(), "0x6001");
    deps.journal.file.protocols.railgun = {
      stepsDone: ["proxy", "poseidon-t3", "poseidon-t4", "implementation", "upgrade", "unpause", "initialize", "vk-1-1", "vk-1-2"],
      contracts: { PROXY, POSEIDON_T3, POSEIDON_T4, IMPLEMENTATION },
      mainnetToDevnet: {},
    };
    deps.journal.file.deployerNonce = 7;
    deps.chain.extraNonce = 7;

    await runProtocols(["railgun"], registry, deps);

    // Only the remaining 89 verification-key calls are sent - nothing re-created, nothing
    // re-initialized.
    expect(deps.chain.sent).toHaveLength(89);
    expect(deps.journal.file.protocols.railgun.stepsDone).toHaveLength(7 + 91);
  });
});

describe("railgun verify", () => {
  function deployed() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    for (const address of [PROXY, POSEIDON_T3, POSEIDON_T4, IMPLEMENTATION]) chain.codes.set(address.toLowerCase(), "0x6001");
    journal.file.protocols.railgun = {
      stepsDone: registry.railgun.steps.map((s) => s.id),
      contracts: { PROXY, POSEIDON_T3, POSEIDON_T4, IMPLEMENTATION },
      mainnetToDevnet: {},
    };
    chain.setRead(PROXY, "owner", DEPLOYER);
    chain.setRead(PROXY, "treasury", DEPLOYER);
    chain.setRead(PROXY, "shieldFee", 25n);
    chain.setRead(PROXY, "unshieldFee", 25n);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes the role, fee and key-count checks with the real values", async () => {
    const deps = deployed();
    deps.chain.setRead(PROXY, "getVerificationKey", verificationKeys[0].verifyingKey);

    const [report] = await verifyProtocols(["railgun"], registry, deps);

    expect(report.checks.find((c) => c.name === "owner is the deployer")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "treasury is the deployer")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "shieldFee (0.25%)")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "unshieldFee (0.25%)")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "verification keys registered")?.ok).toBe(true);
  });

  it("fails when a role was left at some other address", async () => {
    const deps = deployed();
    deps.chain.setRead(PROXY, "owner", "0x00000000000000000000000000000000000000ff");
    deps.chain.setRead(PROXY, "getVerificationKey", verificationKeys[0].verifyingKey);
    const [report] = await verifyProtocols(["railgun"], registry, deps);
    expect(report.checks.find((c) => c.name === "owner is the deployer")?.ok).toBe(false);
  });

  it("fails a spot-checked key that reads back differently from what was deployed", async () => {
    const deps = deployed();
    // FakeChain.setRead is not arg-aware, so every getVerificationKey call sees this one
    // canned answer - correct for the first spot-checked shape (index 0), wrong for the
    // others. That is exactly the scenario this test is for: a shape whose on-chain key
    // does not match what the deploy is supposed to have set.
    deps.chain.setRead(PROXY, "getVerificationKey", verificationKeys[0].verifyingKey);
    const middle = verificationKeys[Math.floor(verificationKeys.length / 2)];

    const [report] = await verifyProtocols(["railgun"], registry, deps);

    const check = report.checks.find(
      (c) => c.name === `verifying key (${middle.nullifiers},${middle.commitments}) IPFS hash matches mainnet's`
    );
    expect(check?.ok).toBe(false);
  });
});
