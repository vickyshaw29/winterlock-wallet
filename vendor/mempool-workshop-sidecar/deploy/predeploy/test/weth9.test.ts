import { describe, expect, it } from "vitest";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const WETH9 = "0x0000000000000000000000000000000000000001" as Address;

function deployedWeth9() {
  const chain = new FakeChain();
  const journal = new MemoryJournal();
  chain.codes.set(WETH9.toLowerCase(), "0x6001");
  journal.file.protocols.weth9 = { stepsDone: ["token"], contracts: { WETH9 }, mainnetToDevnet: {} };
  chain.setRead(WETH9, "name", "Wrapped Ether");
  chain.setRead(WETH9, "symbol", "WETH");
  chain.setRead(WETH9, "decimals", 18);
  chain.setRead(WETH9, "totalSupply", 0n);
  return { chain, journal, artifacts: new MemoryArtifacts() };
}

describe("weth9", () => {
  it("verify passes for the real mainnet values with no premint", async () => {
    const [report] = await verifyProtocols(["weth9"], registry, deployedWeth9());
    expect(report.ok).toBe(true);
  });

  it("verify fails if there somehow was a premint", async () => {
    const deps = deployedWeth9();
    deps.chain.setRead(WETH9, "totalSupply", 1n);
    const [report] = await verifyProtocols(["weth9"], registry, deps);
    expect(report.checks.find((c) => c.name === "totalSupply (no premint)")?.ok).toBe(false);
  });
});
