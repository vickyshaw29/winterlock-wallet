import { describe, expect, it } from "vitest";
import { resolveOrder, runProtocols, type Registry } from "../src/engine";
import { uintWord } from "../src/creation";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { FakeChain, MemoryArtifacts, MemoryJournal, hash, makeArtifact } from "./fakes";

const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const MAINNET_OTHER = "0x00000000000000000000000000000000000000ee" as Address;
const MAINNET_TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const word = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const noop = async () => [];
function create(name: string, txs: Array<{ tx: Hex; as: string }>, dependsOn: string[] = []) {
  return defineProtocol({
    name,
    dependsOn,
    steps: txs.map((t, i) => ({ id: `s${i}`, kind: "create" as const, tx: t.tx, as: t.as })),
    verify: noop,
  });
}

function setup(registry: Registry) {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  const logs: string[] = [];
  const deps = { chain, artifacts, journal, log: (m: string) => logs.push(m) };
  return { chain, artifacts, journal, logs, deps, registry };
}

describe("resolveOrder", () => {
  const registry: Registry = {
    a: create("a", []),
    b: create("b", [], ["a"]),
    c: create("c", [], ["a", "b"]),
  };

  it("puts dependencies first and lists each protocol once", () => {
    expect(resolveOrder(["c", "b"], registry)).toEqual(["a", "b", "c"]);
  });

  it("rejects unknown protocols", () => {
    expect(() => resolveOrder(["nope"], registry)).toThrow(/unknown protocol "nope"/);
  });

  it("rejects dependency cycles", () => {
    const cyclic: Registry = { x: create("x", [], ["y"]), y: create("y", [], ["x"]) };
    expect(() => resolveOrder(["x"], cyclic)).toThrow(/dependency cycle: x -> y -> x/);
  });
});

describe("runProtocols", () => {
  it("replays a creation, records the address, and journals the step", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1), input: "0x6080", contractAddress: MAINNET_TOKEN }));

    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].to).toBeNull();
    expect(chain.sent[0].data).toBe("0x6080");
    const state = journal.file.protocols.token;
    expect(state.stepsDone).toEqual(["s0"]);
    expect(state.contracts.TOKEN).toBe("0x0000000000000000000000000000000000000001");
    expect(state.mainnetToDevnet[MAINNET_TOKEN.toLowerCase()]).toBe(state.contracts.TOKEN);
  });

  it("applies the gas margin and the doubled gas price", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    chain.estimate = 1_000_000n;
    chain.price = 1_000_007n;

    await runProtocols(["token"], registry, deps);

    expect(chain.sent[0].gas).toBe(1_200_000n);
    expect(chain.sent[0].gasPrice).toBe(2_000_014n);
  });

  it("rewrites a dependency's mainnet address inside constructor arguments", async () => {
    const registry: Registry = {
      weth: create("weth", [{ tx: hash(1), as: "WETH" }]),
      router: create("router", [{ tx: hash(2), as: "ROUTER" }], ["weth"]),
    };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("weth", makeArtifact({ hash: hash(1), input: "0x6001", contractAddress: MAINNET_WETH }));
    const args = `0x${word(MAINNET_WETH)}` as Hex;
    artifacts.write(
      "router",
      makeArtifact({
        hash: hash(2),
        input: `0x6002${args.slice(2)}` as Hex,
        constructorArgs: args,
        contractAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      })
    );

    await runProtocols(["router"], registry, deps);

    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1].data).toBe(`0x6002${word("0x0000000000000000000000000000000000000001")}`);
  });

  it("patches a mainnet address literal baked into the init code", async () => {
    const MAINNET_HASHER = "0x83584f83F26aF4EDDA9cBe8C730BC87C364b28fe" as Address;
    const bare = (address: Address): string => address.slice(2).toLowerCase();
    const registry: Registry = {
      pool: defineProtocol({
        name: "pool",
        dependsOn: [],
        steps: [
          { id: "hasher", kind: "create", tx: hash(1), as: "HASHER" },
          {
            id: "main",
            kind: "create",
            tx: hash(2),
            as: "POOL",
            patches: [{ find: MAINNET_HASHER, count: 2 }],
          },
        ],
        verify: noop,
      }),
    };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("pool", makeArtifact({ hash: hash(1), input: "0x6001", contractAddress: MAINNET_HASHER }));
    artifacts.write(
      "pool",
      makeArtifact({
        hash: hash(2),
        input: `0xdead${bare(MAINNET_HASHER)}beef${bare(MAINNET_HASHER)}cafe` as Hex,
        contractAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      })
    );

    await runProtocols(["pool"], registry, deps);

    expect(chain.sent).toHaveLength(2);
    // The first create lands at 0x...01 on FakeChain; both literal occurrences are replaced.
    expect(chain.sent[1].data).toBe(
      `0xdead${bare("0x0000000000000000000000000000000000000001" as Address)}beef${bare("0x0000000000000000000000000000000000000001" as Address)}cafe`
    );
  });

  it("fails a patch whose target was never deployed in an earlier step", async () => {
    const MAINNET_HASHER = "0x83584f83F26aF4EDDA9cBe8C730BC87C364b28fe" as Address;
    const registry: Registry = {
      pool: defineProtocol({
        name: "pool",
        dependsOn: [],
        steps: [
          {
            id: "main",
            kind: "create",
            tx: hash(1),
            as: "POOL",
            patches: [{ find: MAINNET_HASHER, count: 1 }],
          },
        ],
        verify: noop,
      }),
    };
    const { artifacts, deps } = setup(registry);
    artifacts.write("pool", makeArtifact({ hash: hash(1), input: `0x${MAINNET_HASHER.slice(2).toLowerCase()}` as Hex }));

    await expect(runProtocols(["pool"], registry, deps)).rejects.toThrow(/no devnet mapping/);
  });

  it("applies argWords overrides before rewriting", async () => {
    const registry: Registry = {
      token: defineProtocol({
        name: "token",
        dependsOn: [],
        steps: [{ id: "s0", kind: "create", tx: hash(1), as: "T", argWords: { 0: uintWord(99n) } }],
        verify: noop,
      }),
    };
    const { chain, artifacts, deps } = setup(registry);
    const args = `0x${word("0x05")}` as Hex;
    artifacts.write("token", makeArtifact({ hash: hash(1), input: `0x6080${args.slice(2)}` as Hex, constructorArgs: args }));

    await runProtocols(["token"], registry, deps);

    expect(chain.sent[0].data).toBe(`0x6080${word("0x63")}`);
  });

  it("does nothing for a protocol that is already deployed", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));

    await runProtocols(["token"], registry, deps);
    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
  });

  it("resumes at the first incomplete step", async () => {
    const registry: Registry = {
      pair: create("pair", [{ tx: hash(1), as: "A" }, { tx: hash(2), as: "B" }]),
    };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("pair", makeArtifact({ hash: hash(1), input: "0x6001" }));
    artifacts.write("pair", makeArtifact({ hash: hash(2), input: "0x6002" }));
    const first = "0x00000000000000000000000000000000000000aa" as Address;
    chain.codes.set(first, "0x6001");
    journal.file.protocols.pair = { stepsDone: ["s0"], contracts: { A: first }, mainnetToDevnet: {} };

    await runProtocols(["pair"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].data).toBe("0x6002");
    expect(journal.file.protocols.pair.stepsDone).toEqual(["s0", "s1"]);
  });

  it("runs a step whose id is not journaled even when the step count matches", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    registry.token.steps[0].id = "s1";
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    const old = "0x00000000000000000000000000000000000000aa" as Address;
    chain.codes.set(old, "0x6001");
    journal.file.protocols.token = { stepsDone: ["s0"], contracts: { OLD: old }, mainnetToDevnet: {} };

    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(journal.file.protocols.token.stepsDone).toEqual(["s0", "s1"]);
  });

  it("starts over when recorded contracts are missing from the chain", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, logs, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    journal.file.protocols.token = {
      stepsDone: ["s0"],
      contracts: { TOKEN: "0x00000000000000000000000000000000000000bb" },
      mainnetToDevnet: {},
    };

    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/token: recorded contracts are missing from this chain/);
  });

  it("--force redeploys the requested protocol but not its dependency", async () => {
    const registry: Registry = {
      weth: create("weth", [{ tx: hash(1), as: "WETH" }]),
      router: create("router", [{ tx: hash(2), as: "ROUTER" }], ["weth"]),
    };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("weth", makeArtifact({ hash: hash(1), contractAddress: MAINNET_WETH }));
    artifacts.write("router", makeArtifact({ hash: hash(2), contractAddress: MAINNET_TOKEN }));

    await runProtocols(["router"], registry, deps);
    await runProtocols(["router"], registry, deps, { force: true });

    expect(chain.sent).toHaveLength(3); // weth, router, router again
  });

  it("runs custom steps with a context that resolves addresses and sends through the same policy", async () => {
    let seen: { deployer?: Address; token?: Address } = {};
    const registry: Registry = {
      token: defineProtocol({
        name: "token",
        dependsOn: [],
        steps: [
          { id: "make", kind: "create", tx: hash(1), as: "TOKEN" },
          {
            id: "poke",
            kind: "custom",
            run: async (ctx) => {
              seen = { deployer: ctx.deployer, token: ctx.address("TOKEN") };
              await ctx.send({ to: ctx.address("TOKEN"), data: "0xdeadbeef", value: 0n });
            },
          },
        ],
        verify: noop,
      }),
    };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));

    await runProtocols(["token"], registry, deps);

    expect(seen.deployer).toBe(chain.account);
    expect(seen.token).toBe("0x0000000000000000000000000000000000000001");
    expect(chain.sent[1]).toMatchObject({ to: seen.token, data: "0xdeadbeef", gas: 120_000n });
    expect(journal.file.protocols.token.stepsDone).toEqual(["make", "poke"]);
  });

  it("ctx.record registers an address a custom step learned some other way, visible immediately", async () => {
    const COMPUTED = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
    let seenLater: Address | undefined;
    const registry: Registry = {
      factory: defineProtocol({
        name: "factory",
        dependsOn: [],
        steps: [
          {
            id: "deploy-via-factory",
            kind: "custom",
            run: async (ctx) => {
              await ctx.send({ to: ctx.deployer, data: "0x", value: 0n });
              ctx.record("WIDGET", COMPUTED);
            },
          },
          {
            id: "use-it",
            kind: "custom",
            run: async (ctx) => {
              seenLater = ctx.address("WIDGET");
            },
          },
        ],
        verify: noop,
      }),
    };
    const { journal, deps } = setup(registry);

    await runProtocols(["factory"], registry, deps);

    expect(journal.file.protocols.factory.contracts.WIDGET).toBe(COMPUTED);
    expect(seenLater).toBe(COMPUTED);
  });

  it("ctx.record's mainnetAddress makes a later create's rewrite resolve it", async () => {
    const MAINNET_WIDGET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
    const COMPUTED = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
    const registry: Registry = {
      factory: defineProtocol({
        name: "factory",
        dependsOn: [],
        steps: [
          {
            id: "deploy-via-factory",
            kind: "custom",
            run: async (ctx) => ctx.record("WIDGET", COMPUTED, MAINNET_WIDGET),
          },
          { id: "consumer", kind: "create", tx: hash(1), as: "CONSUMER" },
        ],
        verify: noop,
      }),
    };
    const { chain, artifacts, journal, deps } = setup(registry);
    const args = `0x${word(MAINNET_WIDGET)}` as Hex;
    artifacts.write("factory", makeArtifact({ hash: hash(1), input: `0x6002${args.slice(2)}` as Hex, constructorArgs: args }));

    await runProtocols(["factory"], registry, deps);

    // The custom step only records an address, sending nothing; the create is the sole send.
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].data).toBe(`0x6002${word(COMPUTED)}`);
    expect(journal.file.protocols.factory.mainnetToDevnet[MAINNET_WIDGET.toLowerCase()]).toBe(COMPUTED);
  });

  it("throws and does not journal a step whose transaction reverts", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    chain.revertNext = true;

    await expect(runProtocols(["token"], registry, deps)).rejects.toThrow(/token\/s0: transaction .* reverted/);
    expect(journal.file.protocols.token?.stepsDone ?? []).toEqual([]);
  });

  describe("custom step address lookup", () => {
    function routerRegistry(probe: (address: (name: string) => Address) => void): Registry {
      return {
        weth: create("weth", [{ tx: hash(1), as: "WETH" }]),
        other: create("other", [{ tx: hash(3), as: "OTHER" }]),
        router: defineProtocol({
          name: "router",
          dependsOn: ["weth"],
          steps: [
            { id: "make", kind: "create", tx: hash(2), as: "ROUTER" },
            { id: "probe", kind: "custom", run: async (ctx) => probe(ctx.address) },
          ],
          verify: noop,
        }),
      };
    }
    function seed(registry: Registry) {
      const ctx = setup(registry);
      ctx.artifacts.write("weth", makeArtifact({ hash: hash(1), contractAddress: MAINNET_WETH }));
      ctx.artifacts.write("router", makeArtifact({ hash: hash(2), contractAddress: MAINNET_TOKEN }));
      ctx.artifacts.write("other", makeArtifact({ hash: hash(3), contractAddress: MAINNET_OTHER }));
      return ctx;
    }

    it("resolves a contract of a dependency", async () => {
      let seen: Address | undefined;
      const registry = routerRegistry((address) => {
        seen = address("WETH");
      });
      const { deps } = seed(registry);

      await runProtocols(["router"], registry, deps);

      expect(seen).toBe("0x0000000000000000000000000000000000000001");
    });

    it("does not see a protocol that is not a dependency, even if deployed earlier", async () => {
      const registry = routerRegistry((address) => {
        address("OTHER");
      });
      const { deps } = seed(registry);

      await expect(runProtocols(["other", "router"], registry, deps)).rejects.toThrow(
        /router: no deployed contract named "OTHER"/
      );
    });
  });

  describe("deployer nonce guard", () => {
    const LIVE = "0x00000000000000000000000000000000000000aa" as Address;
    function tokenSetup() {
      const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
      const ctx = setup(registry);
      ctx.artifacts.write("token", makeArtifact({ hash: hash(1) }));
      return ctx;
    }

    it("records the deployer's transaction count after each step", async () => {
      const { registry, journal, deps } = tokenSetup();

      await runProtocols(["token"], registry, deps);

      expect(journal.file.deployerNonce).toBe(1);
    });

    it("refuses to continue when the deployer nonce drifted from the journal", async () => {
      const { registry, chain, journal, deps } = tokenSetup();
      chain.codes.set(LIVE, "0x6001");
      journal.file.protocols.token = { stepsDone: ["s0"], contracts: { TOKEN: LIVE }, mainnetToDevnet: {} };
      journal.file.deployerNonce = 0;
      chain.extraNonce = 1;

      await expect(runProtocols(["token"], registry, deps)).rejects.toThrow(
        /deployer nonce is 1 but the journal accounts for 0/
      );
      expect(chain.sent).toHaveLength(0);
    });

    it("--force bypasses the drift check", async () => {
      const { registry, chain, journal, logs, deps } = tokenSetup();
      chain.codes.set(LIVE, "0x6001");
      journal.file.protocols.token = { stepsDone: ["s0"], contracts: { TOKEN: LIVE }, mainnetToDevnet: {} };
      journal.file.deployerNonce = 0;
      chain.extraNonce = 1;

      await runProtocols(["token"], registry, deps, { force: true });

      expect(chain.sent).toHaveLength(1);
      expect(logs.join("\n")).toMatch(/warning: deployer nonce is 1 but the journal accounts for 0/);
    });

    it("does not throw on a restarted chain where no recorded contract has code", async () => {
      const { registry, chain, journal, deps } = tokenSetup();
      journal.file.protocols.token = { stepsDone: ["s0"], contracts: { TOKEN: LIVE }, mainnetToDevnet: {} };
      journal.file.deployerNonce = 4;

      await runProtocols(["token"], registry, deps);

      expect(chain.sent).toHaveLength(1);
      expect(journal.file.deployerNonce).toBe(1);
    });

    it("adopts the current count as the baseline when the journal has none", async () => {
      const { registry, chain, journal, deps } = tokenSetup();
      chain.codes.set(LIVE, "0x6001");
      journal.file.protocols.token = { stepsDone: ["s0"], contracts: { TOKEN: LIVE }, mainnetToDevnet: {} };
      chain.extraNonce = 3;

      await runProtocols(["token"], registry, deps);

      expect(chain.sent).toHaveLength(0);
      expect(journal.file.deployerNonce).toBe(3);
    });
  });

  it("rejects an artifact that is not a contract creation", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1), contractAddress: null }));

    await expect(runProtocols(["token"], registry, deps)).rejects.toThrow(/is not a contract creation/);
  });
});
