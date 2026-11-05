import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address, Hex } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

const HASHER_MAINNET = "0x83584f83F26aF4EDDA9cBe8C730BC87C364b28fe" as Address;
const VERIFIER_MAINNET = "0x0db297c70758F31A63235eDFdeD040A04Ad3fd6c" as Address;
const bare = (address: Address): string => address.slice(2).toLowerCase();
const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");

function steps() {
  const [hasher, verifier, pool] = registry.tornado.steps;
  if (hasher.kind !== "create" || verifier.kind !== "create" || pool.kind !== "create") {
    throw new Error("expected three create steps");
  }
  return { hasher, verifier, pool };
}

describe("tornado", () => {
  it("patches the Hasher literal in the pool's init code and rewrites the verifier constructor word", async () => {
    const { hasher, verifier, pool } = steps();
    const chain = new FakeChain();
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    artifacts.write("tornado", makeArtifact({ hash: hasher.tx, input: "0x6001", contractAddress: HASHER_MAINNET }));
    artifacts.write("tornado", makeArtifact({ hash: verifier.tx, input: "0x6002", contractAddress: VERIFIER_MAINNET }));
    // Real layout: the Hasher literal appears 4 times in the init code; the verifier address is
    // the sole word of the constructor arguments (denomination/levels/operator omitted here -
    // they need no rewriting, so a shorter args blob than the real one is a faithful enough test).
    const initCode = `0xdead${bare(HASHER_MAINNET)}beef${bare(HASHER_MAINNET)}c0de${bare(HASHER_MAINNET)}f00d${bare(HASHER_MAINNET)}` as Hex;
    const args = `0x${word(VERIFIER_MAINNET)}` as Hex;
    artifacts.write(
      "tornado",
      makeArtifact({ hash: pool.tx, input: `${initCode}${args.slice(2)}` as Hex, constructorArgs: args })
    );

    await runProtocols(["tornado"], registry, { chain, artifacts, journal, log: () => {} });

    expect(chain.sent).toHaveLength(3);
    const hasherDevnet = "0x0000000000000000000000000000000000000001" as Address; // FakeChain's 1st create
    const verifierDevnet = "0x0000000000000000000000000000000000000002" as Address; // 2nd create
    const expectedInit = `0xdead${bare(hasherDevnet)}beef${bare(hasherDevnet)}c0de${bare(hasherDevnet)}f00d${bare(hasherDevnet)}`;
    const expectedArgs = word(verifierDevnet);
    expect(chain.sent[2].data).toBe(`${expectedInit}${expectedArgs}`);
  });

  const HASHER = "0x0000000000000000000000000000000000000001" as Address;
  const VERIFIER = "0x0000000000000000000000000000000000000002" as Address;
  const POOL = "0x0000000000000000000000000000000000000003" as Address;

  function deployedTornado() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    for (const address of [HASHER, VERIFIER, POOL]) chain.codes.set(address.toLowerCase(), "0x6001");
    journal.file.protocols.tornado = {
      stepsDone: ["hasher", "verifier", "pool"],
      contracts: { HASHER, VERIFIER, POOL },
      mainnetToDevnet: {},
    };
    chain.setRead(POOL, "denomination", 100_000_000_000_000_000n);
    chain.setRead(POOL, "levels", 20);
    chain.setRead(POOL, "verifier", VERIFIER);
    chain.setRead(POOL, "hashLeftRight", `0x${word("0x2a")}`);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("verify passes for the real mainnet values with the Hasher correctly wired", async () => {
    const [report] = await verifyProtocols(["tornado"], registry, deployedTornado());
    expect(report.ok).toBe(true);
  });

  it("verify fails when the pool's verifier does not point at our devnet deploy", async () => {
    const deps = deployedTornado();
    deps.chain.setRead(POOL, "verifier", DEPLOYER);
    const [report] = await verifyProtocols(["tornado"], registry, deps);
    expect(report.checks.find((c) => c.name === "verifier is the devnet deploy")?.ok).toBe(false);
  });

  it("verify fails (without crashing the other checks) when hashLeftRight reverts", async () => {
    const deps = deployedTornado();
    deps.chain.reads.delete(`${POOL.toLowerCase()}:hashLeftRight`);
    const [report] = await verifyProtocols(["tornado"], registry, deps);
    expect(report.ok).toBe(false);
    const failing = report.checks.find((c) => c.name === "hashLeftRight reaches the deployed Hasher");
    expect(failing?.ok).toBe(false);
    // The other checks still ran and passed - one bad read didn't crash the whole verify().
    expect(report.checks.find((c) => c.name === "levels")?.ok).toBe(true);
  });
});
