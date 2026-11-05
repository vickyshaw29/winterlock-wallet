import { describe, expect, it } from "vitest";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const LINK = "0x0000000000000000000000000000000000000001" as Address;

function deployedLink() {
  const chain = new FakeChain();
  const journal = new MemoryJournal();
  chain.codes.set(LINK.toLowerCase(), "0x6001");
  journal.file.protocols.link = { stepsDone: ["token"], contracts: { LINK }, mainnetToDevnet: {} };
  chain.setRead(LINK, "name", "ChainLink Token");
  chain.setRead(LINK, "symbol", "LINK");
  chain.setRead(LINK, "decimals", 18);
  chain.setRead(LINK, "totalSupply", 10n ** 27n);
  chain.setRead(LINK, "balanceOf", 10n ** 27n);
  return { chain, journal, artifacts: new MemoryArtifacts() };
}

describe("link", () => {
  it("verify passes for the mainnet values", async () => {
    const [report] = await verifyProtocols(["link"], registry, deployedLink());
    expect(report.ok).toBe(true);
  });

  it("verify fails for a wrong supply", async () => {
    const deps = deployedLink();
    deps.chain.setRead(LINK, "totalSupply", 1n);
    const [report] = await verifyProtocols(["link"], registry, deps);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "totalSupply")?.ok).toBe(false);
  });
});
