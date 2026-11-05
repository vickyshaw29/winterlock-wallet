import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Registry } from "../src/engine";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { equalCheck, formatReport, verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal, hash, makeArtifact } from "./fakes";

const TOKEN = "0x0000000000000000000000000000000000000001" as Address;

const protocol = defineProtocol({
  name: "token",
  dependsOn: [],
  steps: [{ id: "make", kind: "create", tx: hash(1), as: "TOKEN" }],
  verify: async (ctx) => [equalCheck("symbol", await ctx.read(ctx.address("TOKEN"), [], "symbol"), "TKN")],
});
const registry: Registry = { token: protocol };

function deployed() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  chain.codes.set(TOKEN.toLowerCase(), "0x6001");
  journal.file.protocols.token = { stepsDone: ["make"], contracts: { TOKEN }, mainnetToDevnet: {} };
  return { chain, artifacts, journal };
}

describe("equalCheck", () => {
  it("treats bigint, number and string forms as equal, and addresses case-insensitively", () => {
    expect(equalCheck("n", 6n, 6).ok).toBe(true);
    expect(equalCheck("a", "0xABC", "0xabc").ok).toBe(true);
  });
  it("rejects null and undefined instead of comparing their string forms", () => {
    expect(equalCheck("n", undefined, "undefined")).toEqual({ name: "n", ok: false, detail: "no value returned" });
    expect(equalCheck("n", null, "null")).toEqual({ name: "n", ok: false, detail: "no value returned" });
  });
  it("explains a mismatch", () => {
    expect(equalCheck("n", 5n, 6)).toEqual({ name: "n", ok: false, detail: "expected 6, got 5" });
  });
});

describe("verifyProtocols", () => {
  it("passes when contracts have code and the protocol's checks pass", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.setRead(TOKEN, "symbol", "TKN");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["TOKEN has code", "symbol"]);
  });

  it("fails when a protocol check fails", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.setRead(TOKEN, "symbol", "OOPS");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ name: "symbol", ok: false, detail: "expected TKN, got OOPS" });
  });

  it("turns a throwing check into a failed result instead of crashing", async () => {
    const { chain, artifacts, journal } = deployed(); // no canned read, so chain.read throws

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ name: "verify", ok: false });
    expect(report.checks.at(-1)?.detail).toMatch(/^threw: FakeChain: no canned read/);
  });

  it("reports a protocol that is not deployed", async () => {
    const chain = new FakeChain();

    const [report] = await verifyProtocols(["token"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal: new MemoryJournal(),
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toMatch(/run: bun run predeploy run token/);
  });

  it("fails when a recorded contract has no code", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.codes.clear();
    chain.setRead(TOKEN, "symbol", "TKN");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "TOKEN has code", ok: false });
  });

  it("reports runtime code identical to, different from, or unknown against mainnet, without failing", async () => {
    const same = deployed();
    same.chain.setRead(TOKEN, "symbol", "TKN");
    same.artifacts.write("token", makeArtifact({ hash: hash(1), runtimeCodeHash: keccak256("0x6001" as Hex) }));
    const differs = deployed();
    differs.chain.setRead(TOKEN, "symbol", "TKN");
    differs.artifacts.write("token", makeArtifact({ hash: hash(1), runtimeCodeHash: keccak256("0x6002" as Hex) }));
    const unknown = deployed();
    unknown.chain.setRead(TOKEN, "symbol", "TKN"); // no artifact stored

    const [a] = await verifyProtocols(["token"], registry, same);
    const [b] = await verifyProtocols(["token"], registry, differs);
    const [c] = await verifyProtocols(["token"], registry, unknown);

    expect(a.codeHashes).toEqual([{ contract: "TOKEN", status: "identical" }]);
    expect(b.codeHashes).toEqual([{ contract: "TOKEN", status: "differs" }]);
    expect(c.codeHashes).toEqual([{ contract: "TOKEN", status: "unknown" }]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
  });

  it("treats a protocol as not deployed when a step id is missing, even if the step count matches", async () => {
    const { chain, artifacts, journal } = deployed();
    journal.file.protocols.token.stepsDone = ["old-id"];
    chain.setRead(TOKEN, "symbol", "TKN");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: "deployed", ok: false });
    expect(report.checks[0].detail).toMatch(/bun run predeploy run token/);
  });

  describe("address lookup", () => {
    const DEP = "0x00000000000000000000000000000000000000d1" as Address;
    const OTHER = "0x00000000000000000000000000000000000000e1" as Address;
    function lookups() {
      const seen: { dep?: Address; other?: string } = {};
      const registry: Registry = {
        dep: defineProtocol({
          name: "dep",
          dependsOn: [],
          steps: [{ id: "make", kind: "create", tx: hash(2), as: "DEP" }],
          verify: async () => [],
        }),
        other: defineProtocol({
          name: "other",
          dependsOn: [],
          steps: [{ id: "make", kind: "create", tx: hash(3), as: "OTHER" }],
          verify: async () => [],
        }),
        token: defineProtocol({
          name: "token",
          dependsOn: ["dep"],
          steps: [{ id: "make", kind: "create", tx: hash(1), as: "TOKEN" }],
          verify: async (ctx) => {
            seen.dep = ctx.address("DEP");
            try {
              ctx.address("OTHER");
            } catch (error) {
              seen.other = (error as Error).message;
            }
            return [];
          },
        }),
      };
      const { chain, artifacts, journal } = deployed();
      journal.file.protocols.dep = { stepsDone: ["make"], contracts: { DEP }, mainnetToDevnet: {} };
      journal.file.protocols.other = { stepsDone: ["make"], contracts: { OTHER }, mainnetToDevnet: {} };
      return { seen, registry, chain, artifacts, journal };
    }

    it("resolves a dependency's contract", async () => {
      const { seen, registry, chain, artifacts, journal } = lookups();
      await verifyProtocols(["token"], registry, { chain, artifacts, journal });
      expect(seen.dep).toBe(DEP);
    });

    it("does not resolve a contract of an unrelated protocol", async () => {
      const { seen, registry, chain, artifacts, journal } = lookups();
      await verifyProtocols(["token"], registry, { chain, artifacts, journal });
      expect(seen.other).toBe('token: no deployed contract named "OTHER"');
    });
  });

  it("rejects unknown protocols", async () => {
    const { chain, artifacts, journal } = deployed();
    await expect(verifyProtocols(["nope"], registry, { chain, artifacts, journal })).rejects.toThrow(
      /unknown protocol "nope"/
    );
  });
});

describe("formatReport", () => {
  it("prints PASS/FAIL, each check, and code-hash info", () => {
    const text = formatReport({
      protocol: "token",
      ok: false,
      checks: [
        { name: "a", ok: true, detail: "1" },
        { name: "b", ok: false, detail: "expected 2, got 3" },
      ],
      codeHashes: [{ contract: "TOKEN", status: "differs" }],
    });
    expect(text).toContain("FAIL token");
    expect(text).toContain("ok   a: 1");
    expect(text).toContain("FAIL b: expected 2, got 3");
    expect(text).toContain("info TOKEN: runtime code differs from mainnet");
  });
});
