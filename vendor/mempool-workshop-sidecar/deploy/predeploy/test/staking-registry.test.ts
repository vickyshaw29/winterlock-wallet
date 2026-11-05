import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const abi = parseAbi([
  "function addStake(uint32 unstakeDelaySec) payable",
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
]);

const SMOKE_TEST_STAKE = 10n ** 15n;
const SMOKE_TEST_UNSTAKE_DELAY = 86_400;

describe("staking-registry deploy", () => {
  it("deploys via a plain CREATE, records the address, and stakes the deployer as a smoke test", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();

    await runProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
      log: () => {},
    });

    expect(chain.sent).toHaveLength(2);
    // First send: the plain CREATE.
    expect(chain.sent[0].to).toBeNull();
    expect(chain.sent[0].value).toBe(0n);
    const deployedAddress = journal.file.protocols["staking-registry"].contracts.StakingRegistry;
    expect(deployedAddress).toBeDefined();
    // Second send: the deploy-time addStake smoke test, against the address just deployed.
    expect(chain.sent[1].to).toBe(deployedAddress);
    expect(chain.sent[1].value).toBe(SMOKE_TEST_STAKE);
    expect(chain.sent[1].data).toBe(
      encodeFunctionData({ abi, functionName: "addStake", args: [SMOKE_TEST_UNSTAKE_DELAY] })
    );
  });
});

describe("staking-registry verify", () => {
  it("passes when getDepositInfo reflects the deploy-time smoke stake", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const address = "0x0000000000000000000000000000000000000001" as const;
    chain.codes.set(address, "0x6001");
    journal.file.protocols["staking-registry"] = {
      stepsDone: ["deploy"],
      contracts: { StakingRegistry: address },
      mainnetToDevnet: {},
    };
    chain.setRead(address, "getDepositInfo", [SMOKE_TEST_STAKE, SMOKE_TEST_UNSTAKE_DELAY, 0n]);

    const [report] = await verifyProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
    });

    expect(report.ok).toBe(true);
  });

  it("fails when the deployer's recorded stake doesn't match the smoke-test amount", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const address = "0x0000000000000000000000000000000000000001" as const;
    chain.codes.set(address, "0x6001");
    journal.file.protocols["staking-registry"] = {
      stepsDone: ["deploy"],
      contracts: { StakingRegistry: address },
      mainnetToDevnet: {},
    };
    chain.setRead(address, "getDepositInfo", [0n, 0, 0n]);

    const [report] = await verifyProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
    });

    expect(report.ok).toBe(false);
  });
});
