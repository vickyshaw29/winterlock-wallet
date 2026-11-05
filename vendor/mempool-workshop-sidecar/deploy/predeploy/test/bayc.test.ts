import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

// The first creation on a FakeChain gets this address.
const BAYC = "0x0000000000000000000000000000000000000001" as Address;

describe("bayc open-sale step", () => {
  const setup = (saleActive: boolean) => {
    const chain = new FakeChain();
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    const step = registry.bayc.steps[0];
    if (step.kind !== "create") throw new Error("expected a create step");
    artifacts.write("bayc", makeArtifact({ hash: step.tx }));
    chain.setRead(BAYC, "saleIsActive", saleActive);
    return { chain, artifacts, journal, log: () => {} };
  };

  it("opens the sale when it is closed", async () => {
    const deps = setup(false);
    await runProtocols(["bayc"], registry, deps);
    expect(deps.chain.sent).toHaveLength(2);
    expect(deps.chain.sent[1].to).toBe(BAYC);
    expect(deps.chain.sent[1].data).toMatch(/^0x[0-9a-f]{8}$/); // flipSaleState() selector, no arguments
  });

  it("does not flip the sale shut when it is already open", async () => {
    const deps = setup(true);
    await runProtocols(["bayc"], registry, deps);
    expect(deps.chain.sent).toHaveLength(1); // creation only
  });
});

describe("bayc verify", () => {
  function deployedBayc() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(BAYC.toLowerCase(), "0x6001");
    journal.file.protocols.bayc = {
      stepsDone: ["collection", "open-sale"],
      contracts: { BAYC },
      mainnetToDevnet: {},
    };
    chain.setRead(BAYC, "name", "BoredApeYachtClub");
    chain.setRead(BAYC, "symbol", "BAYC");
    chain.setRead(BAYC, "MAX_APES", 10_000n);
    chain.setRead(BAYC, "apePrice", 80_000_000_000_000_000n);
    chain.setRead(BAYC, "owner", DEPLOYER);
    chain.setRead(BAYC, "saleIsActive", true);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes for the mainnet values with the sale open", async () => {
    const [report] = await verifyProtocols(["bayc"], registry, deployedBayc());
    expect(report.ok).toBe(true);
  });

  it("fails when the sale is closed", async () => {
    const deps = deployedBayc();
    deps.chain.setRead(BAYC, "saleIsActive", false);
    const [report] = await verifyProtocols(["bayc"], registry, deps);
    expect(report.checks.find((c) => c.name === "sale is open")?.ok).toBe(false);
  });
});
