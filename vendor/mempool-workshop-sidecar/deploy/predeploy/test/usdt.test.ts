import { describe, expect, it } from "vitest";
import { uintWord } from "../src/creation";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

describe("usdt", () => {
  it("replaces the initial supply (constructor word 0) with 1e15 and keeps the other words", async () => {
    const chain = new FakeChain();
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    const words = [
      "00".repeat(27) + "174876e800", // initialSupply 1e11, as on mainnet
      "00".repeat(31) + "80",
      "00".repeat(31) + "c0",
      "00".repeat(31) + "06",
    ].join("");
    const step = registry.usdt.steps[0];
    if (step.kind !== "create") throw new Error("expected a create step");
    artifacts.write("usdt", makeArtifact({ hash: step.tx, input: `0x6080${words}`, constructorArgs: `0x${words}` }));

    await runProtocols(["usdt"], registry, { chain, artifacts, journal, log: () => {} });

    const sent = chain.sent[0].data;
    expect(sent.slice(0, 6)).toBe("0x6080");
    expect(sent.slice(6, 70)).toBe(uintWord(10n ** 15n).slice(2)); // word 0 replaced
    expect(sent.slice(70)).toBe(words.slice(64)); // words 1..3 untouched
  });

  const USDT = "0x0000000000000000000000000000000000000001" as Address;
  function deployedUsdt() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(USDT.toLowerCase(), "0x6001");
    journal.file.protocols.usdt = { stepsDone: ["token"], contracts: { USDT }, mainnetToDevnet: {} };
    chain.setRead(USDT, "name", "Tether USD");
    chain.setRead(USDT, "symbol", "USDT");
    chain.setRead(USDT, "decimals", 6n);
    chain.setRead(USDT, "totalSupply", 10n ** 15n);
    chain.setRead(USDT, "owner", DEPLOYER);
    chain.setRead(USDT, "balanceOf", 10n ** 15n);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("verify passes when the deployer owns the token", async () => {
    const [report] = await verifyProtocols(["usdt"], registry, deployedUsdt());
    expect(report.ok).toBe(true);
  });

  it("verify fails when someone else owns the token", async () => {
    const deps = deployedUsdt();
    deps.chain.setRead(USDT, "owner", "0x00000000000000000000000000000000000000ff");
    const [report] = await verifyProtocols(["usdt"], registry, deps);
    expect(report.checks.find((c) => c.name === "owner is the deployer")?.ok).toBe(false);
  });
});
