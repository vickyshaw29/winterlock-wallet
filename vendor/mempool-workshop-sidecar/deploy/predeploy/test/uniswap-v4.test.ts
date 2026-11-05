import { decodeFunctionData, keccak256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { POOL_MANAGER_INIT_CODE } from "../src/protocols/pool-manager-deployment";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

const DEPLOYER_COMPETITION = "0x0000000000000000000000000000000000000001" as Address;
const ZERO_SALT = `0x${"0".repeat(64)}` as const;
const MAINNET_POOL_MANAGER_OWNER = "0x1a9C8182C09F50C8318d769245beA52c32BE35BC" as Address;

function setup() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  const step = registry["uniswap-v4"].steps[0];
  if (step.kind !== "create") throw new Error("expected a create step");
  artifacts.write("uniswap-v4", makeArtifact({ hash: step.tx, input: "0x6001" }));
  return { chain, artifacts, journal, log: () => {} };
}

describe("uniswap-v4 deploy", () => {
  it("deploys the competition, then calls deploy(bytecode) on it and records the CREATE2 address", async () => {
    const deps = setup();

    await runProtocols(["uniswap-v4"], registry, deps);

    expect(deps.chain.sent).toHaveLength(2);
    expect(deps.chain.sent[0].to).toBeNull(); // the competition's own creation
    expect(deps.chain.sent[1].to).toBe(DEPLOYER_COMPETITION);
    const decoded = decodeFunctionData({
      abi: parseAbi(["function deploy(bytes bytecode)"]),
      data: deps.chain.sent[1].data,
    });
    expect(decoded).toMatchObject({ functionName: "deploy", args: [POOL_MANAGER_INIT_CODE] });

    const recorded = deps.journal.file.protocols["uniswap-v4"].contracts.POOL_MANAGER;
    expect(recorded).toBeDefined();
    // A CREATE2 address with a zero salt, computed from the competition's own devnet address -
    // deterministic, so this is not a guess: re-derive it the same way the manifest does.
    const { getContractAddress } = await import("viem");
    expect(recorded).toBe(
      getContractAddress({ from: DEPLOYER_COMPETITION, opcode: "CREATE2", salt: ZERO_SALT, bytecode: POOL_MANAGER_INIT_CODE })
    );
  });
});

describe("uniswap-v4 verify", () => {
  function deployed() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address;
    chain.codes.set(DEPLOYER_COMPETITION.toLowerCase(), "0x6001");
    chain.codes.set(POOL_MANAGER.toLowerCase(), "0x6001");
    journal.file.protocols["uniswap-v4"] = {
      stepsDone: ["deployer-competition", "deploy-pool-manager"],
      contracts: { DEPLOYER_COMPETITION, POOL_MANAGER },
      mainnetToDevnet: {},
    };
    chain.setRead(DEPLOYER_COMPETITION, "initCodeHash", keccak256(POOL_MANAGER_INIT_CODE));
    chain.setRead(DEPLOYER_COMPETITION, "bestAddressSalt", ZERO_SALT);
    chain.setRead(POOL_MANAGER, "owner", MAINNET_POOL_MANAGER_OWNER);
    chain.setRead(POOL_MANAGER, "extsload", `0x${"0".repeat(24)}${MAINNET_POOL_MANAGER_OWNER.slice(2).toLowerCase()}`);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes when the bytecode hash, salt, and owner all check out", async () => {
    const [report] = await verifyProtocols(["uniswap-v4"], registry, deployed());
    expect(report.ok).toBe(true);
  });

  it("fails if the factory's initCodeHash somehow does not match our constant", async () => {
    const deps = deployed();
    deps.chain.setRead(DEPLOYER_COMPETITION, "initCodeHash", `0x${"ab".repeat(32)}`);
    const [report] = await verifyProtocols(["uniswap-v4"], registry, deps);
    expect(report.checks.find((c) => c.name === "bytecode hash matches the factory's own initCodeHash")?.ok).toBe(
      false
    );
  });

  it("fails if extsload of slot 0 does not match owner (storage layout assumption broken)", async () => {
    const deps = deployed();
    deps.chain.setRead(
      "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address,
      "extsload",
      `0x${"0".repeat(64)}`
    );
    const [report] = await verifyProtocols(["uniswap-v4"], registry, deps);
    expect(report.checks.find((c) => c.name === "extsload of slot 0 matches owner()")?.ok).toBe(false);
  });
});
