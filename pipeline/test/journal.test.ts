// MemoryJournal (the journal a browser or a Snap keeps) and pipelines of their own (createPipeline): the same rules
// as the file journal, the waits for an async store, and no state shared between pipelines.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import { hexToBytes, type Address } from "viem";
import { DEVNET } from "../src/config.ts";
import { ALLOWED_MOVES, MemoryJournal, type JournalSnapshot } from "../src/journal.ts";
import { createNetwork, defaultNetwork } from "../src/network.ts";
import { createPipeline } from "../src/pipeline.ts";
import { SendError, checkSystemContracts, forgetSystemCheck, settleSubmitted } from "../src/submit.ts";
import { estimateCalls } from "../src/estimate.ts";
import { gateway, node } from "../src/rpc.ts";
import { GRIND } from "../src/config.ts";
import { Keyring, keyringSigner } from "../src/hashsig/keyring-core.ts";
import type { SignatureSlot } from "../src/signer.ts";
import { fakeChain } from "./fixtures/sandbox-scenario.ts";

const WALLET: Address = "0x00000000000000000000000000000000000acc01";
const ID = { wallet: WALLET, chainId: 1337n, epoch: 0, height: 4, treeSeed: "0x" + "ab".repeat(32) as `0x${string}` };
const BAND = { from: 1, to: 16 };

describe("MemoryJournal keeps the journal's rules", () => {
  test("hands out each leaf once, never leaf 0 at epoch 0, statuses only forward", () => {
    const j = MemoryJournal.open(null, ID, { create: true, ephemeral: true });
    expect(j.peekNext(BAND).leaf).toBe(1);
    expect(j.reserveNext(BAND)).toEqual({ leaf: 1, nonceKey: 1n });
    expect(j.reserveNext(BAND).leaf).toBe(2);
    j.mark(1, "burned", { note: "x" });
    expect(j.reserveNext(BAND).leaf).toBe(3); // a burned leaf is never handed out again
    expect(() => j.mark(1, "onchain")).toThrow("burned -> onchain is not allowed");
    j.mark(2, "submitted", { txHash: "0x12", deadline: 5 });
    expect(() => j.mark(2, "reserved")).toThrow("not allowed");
    j.markExported(4, 8);
    expect(j.reserveNext(BAND).leaf).toBe(8);
    expect(() => j.markExported(7, 9)).toThrow("already exported");
    expect(j.get(2)).toMatchObject({ status: "submitted", txHash: "0x12", deadline: 5 });
    expect(() => j.reserveNext({ from: 0, to: 17 })).toThrow("bad band");
    expect(j.wallet).toBe(WALLET);
  });

  test("a used-up band throws the message the send path maps to LeavesExhausted", () => {
    const j = MemoryJournal.open(null, ID, { create: true, ephemeral: true });
    j.reserveNext({ from: 1, to: 2 });
    expect(() => j.reserveNext({ from: 1, to: 2 })).toThrow("no unused leaf left in [1, 2)");
  });

  test("a missing journal is never recreated empty, and a stored one must match", () => {
    expect(() => MemoryJournal.open(null, ID, { ephemeral: true })).toThrow("must not come back empty");
    const a = MemoryJournal.open(null, ID, { create: true, ephemeral: true });
    a.reserveNext(BAND);
    const snap = a.snapshot();
    const b = MemoryJournal.open(snap, ID, { ephemeral: true });
    expect(b.reserveNext(BAND).leaf).toBe(2); // leaf 1 stays used after a restore
    expect(MemoryJournal.open(snap, ID, { create: true, ephemeral: true }).get(1)?.status).toBe("reserved"); // create opens what exists
    expect(() => MemoryJournal.open(snap, { ...ID, epoch: 1 }, { ephemeral: true })).toThrow("belongs to");
    expect(() => MemoryJournal.open(snap, { ...ID, chainId: 1n }, { ephemeral: true })).toThrow("belongs to");
    expect(() => MemoryJournal.open(snap, { ...ID, treeSeed: `0x${"cd".repeat(32)}` }, { ephemeral: true })).toThrow("tree seed");
  });

  test("saves every change in order through the store; durable() waits for them", async () => {
    const saved: JournalSnapshot[] = [];
    const store = { save: (s: JournalSnapshot) => new Promise<void>((r) => setTimeout(() => { saved.push(s); r(); }, 2)) };
    const j = MemoryJournal.open(null, ID, { create: true, store });
    j.reserveNext(BAND);
    j.mark(1, "submitted", { txHash: "0x34", deadline: 9 });
    expect(saved.length).toBe(0);
    await j.durable();
    expect(saved.map((s) => s.leaves[1]?.status ?? "none")).toEqual(["none", "reserved", "submitted"]);
    saved[2]!.leaves[1]!.status = "burned"; // the store got a copy, not the journal's own data
    expect(j.get(1)?.status).toBe("submitted");
  });

  test("after a failed save: no more leaves, and durable() keeps rejecting", async () => {
    let fail = false;
    const j = MemoryJournal.open(null, ID, { create: true, store: { save: async () => { if (fail) throw new Error("quota"); } } });
    j.reserveNext(BAND);
    await j.durable();
    fail = true;
    j.reserveNext(BAND);
    await expect(j.durable()).rejects.toThrow("could not be stored: quota");
    expect(() => j.reserveNext(BAND)).toThrow("hands out no more leaves");
    expect(() => j.peekNext(BAND)).toThrow("hands out no more leaves");
    j.mark(2, "burned"); // still recorded in memory, so the leaf is never used here
    fail = false;
    await expect(j.durable()).rejects.toThrow("quota");
  });
});

describe("MemoryJournal refuses unsafe setups (review, Nov 6)", () => {
  test("a save that rejects without a reason still counts as not stored", async () => {
    for (const reason of [undefined, null, ""]) {
      let fail = false;
      const j = MemoryJournal.open(null, ID, { create: true, store: { save: () => (fail ? Promise.reject(reason) : undefined) } });
      await j.durable();
      fail = true;
      j.reserveNext(BAND);
      await expect(j.durable()).rejects.toThrow("the store rejected without a reason");
      expect(() => j.reserveNext(BAND)).toThrow("hands out no more leaves");
    }
  });

  test("needs a store unless ephemeral, and a new journal must name its tree", () => {
    expect(() => MemoryJournal.open(null, ID, { create: true })).toThrow("no store");
    const { treeSeed: _, ...noTree } = ID;
    expect(() => MemoryJournal.open(null, noTree, { create: true, ephemeral: true })).toThrow("must name its tree");
  });

  test("a snapshot stored in another letter case opens lowercase, so the send path's checks still match", () => {
    const a = MemoryJournal.open(null, ID, { create: true, ephemeral: true }).snapshot();
    const upper = { ...a, wallet: a.wallet.toUpperCase().replace("0X", "0x") as Address, treeSeed: a.treeSeed!.toUpperCase().replace("0X", "0x") as `0x${string}` };
    const b = MemoryJournal.open(upper, ID, { ephemeral: true });
    expect([b.wallet, b.treeSeed]).toEqual([WALLET, ID.treeSeed]);
  });

  test("numbers its snapshots, and the move table cannot be changed", async () => {
    const saved: JournalSnapshot[] = [];
    const j = MemoryJournal.open(null, ID, { create: true, store: { save: (s) => { saved.push(s); } } });
    j.reserveNext(BAND);
    j.mark(1, "burned");
    await j.durable();
    expect(saved.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(ALLOWED_MOVES) && Object.isFrozen(ALLOWED_MOVES.burned)).toBe(true);
    expect(() => { (ALLOWED_MOVES.burned as string[]).push("reserved"); }).toThrow();
  });
});

describe("the send path with a journal that stores later", () => {
  const keyring = new Keyring({ seed: hexToBytes(`0x${"5a".repeat(32)}`), generation: 0, height: 4, chains: [1337n] });
  const signer = keyringSigner(keyring);
  const id = { ...ID, treeSeed: signer.treeSeed };
  const send = (j: MemoryJournal, p = createPipeline({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: fakeChain().fetch })) =>
    p.sendKeyed({
      journal: j, band: BAND, sender: WALLET, calls: [{ to: "0x000000000000000000000000000000000000bEEF", value: 1n }], verifyGas: 90_000n,
      signatures: (leaf): SignatureSlot[] => [{ kind: "hash", signer, leaf }], grind: GRIND.cold, pollMs: 5,
    });

  test("refuses to sign when the reservation cannot be stored, and burns the leaf", async () => {
    const j = MemoryJournal.open(null, id, { create: true, store: { save: async (s) => { if (s.leaves[1]) throw new Error("disk full"); } } });
    const e = await send(j).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect([e.stage, e.leaf, e.txHash]).toEqual(["prepare", 1, null]);
    expect(e.message).toContain("nothing was signed");
    expect(j.get(1)?.status).toBe("burned");
  });

  test("refuses to send when the transaction's hash cannot be stored", async () => {
    const events: string[] = [];
    const chain = fakeChain(events);
    const p = createPipeline({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: chain.fetch });
    const j = MemoryJournal.open(null, id, { create: true, store: { save: async (s) => { if (s.leaves[1]?.status === "submitted") throw new Error("disk full"); } } });
    const e = await send(j, p).catch((x) => x);
    expect([e.stage, e.leaf]).toEqual(["submit", 1]);
    expect(e.message).toContain("nothing was sent");
    expect(chain.calls).not.toContain("eth_sendFrameTransaction");
    expect(j.get(1)?.status).toBe("burned");
  });

  test("a journal of another chain is refused before any leaf is reserved", async () => {
    const j = MemoryJournal.open(null, { ...id, chainId: 1n }, { create: true, ephemeral: true });
    const e = await send(j).catch((x) => x);
    expect([e.stage, e.leaf]).toEqual(["check", null]);
    expect(j.all()).toEqual([]);
  });

  test("estimateCalls refuses a journal of another chain or wallet before any leaf is reserved (review, Nov 6)", async () => {
    const chain = fakeChain();
    const p = createPipeline({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: chain.fetch });
    const call = { to: "0x000000000000000000000000000000000000bEEF" as Address, value: 1n };
    const signatures = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
    for (const [j, sender, why] of [
      [MemoryJournal.open(null, { ...id, chainId: 31337n }, { create: true, ephemeral: true }), WALLET, "is for chain 31337"],
      [MemoryJournal.open(null, id, { create: true, ephemeral: true }), "0x00000000000000000000000000000000000acc02", "belongs to"],
    ] as const) {
      const e = await p.estimateCalls({ journal: j, band: BAND, sender, calls: [call], signatures }).catch((x) => x);
      expect(e).toBeInstanceOf(SendError);
      expect([e.stage, e.message.includes(why)]).toEqual(["check", true]);
      expect(j.all()).toEqual([]);
    }
    expect(chain.calls).toEqual([]);
  });

  test("estimateCalls signs no leaf whose signer is for another leaf or tree, and burns it as never signed", async () => {
    const p = createPipeline({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: fakeChain().fetch });
    const j = MemoryJournal.open(null, id, { create: true, ephemeral: true });
    const e = await p.estimateCalls({ journal: j, band: BAND, sender: WALLET, calls: [{ to: WALLET, value: 1n }], signatures: () => [{ kind: "hash", signer, leaf: 7 }] }).catch((x) => x);
    expect([e.stage, e.leaf]).toEqual(["check", 1]);
    expect(j.get(1)).toMatchObject({ status: "burned", note: expect.stringContaining("never signed") });
  });

  test("estimateCalls stops before signing when the reservation cannot be stored", async () => {
    const p = createPipeline({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: fakeChain().fetch });
    const j = MemoryJournal.open(null, id, { create: true, store: { save: async (s) => { if (s.leaves[1]) throw new Error("disk full"); } } });
    const e = await p.estimateCalls({ journal: j, band: BAND, sender: WALLET, calls: [{ to: WALLET, value: 1n }], signatures: (leaf) => [{ kind: "hash", signer, leaf }] }).catch((x) => x);
    expect([e instanceof SendError, e.stage, e.leaf]).toEqual([true, "prepare", 1]);
    expect(j.get(1)).toMatchObject({ status: "burned", note: expect.stringContaining("never signed") });
  });

  test("settleSubmitted refuses a journal of another chain: its lanes would look unused and be called Expired", async () => {
    const j = MemoryJournal.open(null, id, { create: true, ephemeral: true });
    j.reserveNext(BAND);
    j.mark(1, "submitted", { txHash: "0x12", deadline: 1 });
    const other = createPipeline({ chainId: 31337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: fakeChain([], 31337n).fetch });
    await expect(other.settleSubmitted(j)).rejects.toThrow("is for chain 1337, this pipeline follows chain 31337");
    await expect(settleSubmitted(j, { network: other.network })).rejects.toThrow("follows chain 31337");
    expect(j.get(1)?.status).toBe("submitted");
  });
});

describe("pipelines of their own", () => {
  test("two pipelines on two chains share nothing, and the defaults stay on DEVNET", async () => {
    const a = fakeChain(), b = fakeChain([], 31337n);
    const pa = createPipeline({ chainId: 1337n, nodeUrl: "http://a.invalid", gatewayUrl: "http://a.invalid/rpc", fetch: a.fetch, explorerUrl: "https://ex.a/" });
    const pb = createPipeline({ chainId: 31337n, nodeUrl: "http://b.invalid", gatewayUrl: "http://b.invalid/rpc", fetch: b.fetch });
    expect(await pa.node.blockNumber()).toBe(100n);
    await pb.checkSystemContracts();
    expect(a.calls).toEqual(["eth_blockNumber"]);
    expect(b.calls).toEqual(["eth_chainId", "eth_getCode", "eth_getCode"]);
    expect([pa.chainId, pb.chainId, pa.explorerTxUrl("0x1"), pb.explorerTxUrl("0x1")]).toEqual([1337n, 31337n, "https://ex.a/tx/0x1", "https://explorer.altmempool.wtf/tx/0x1"]);
    expect(pa.buildFrameTx({ sender: WALLET, nonce: { keys: [1n], seq: 0n }, verifyGas: 1n, calls: [{ to: WALLET }], deadline: null, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, signatures: [] }).chainId).toBe(1337n);
    expect(defaultNetwork.gateway).toBe(gateway);
    expect(defaultNetwork.node).toBe(node);
    expect(defaultNetwork.chainId).toBe(DEVNET.chainId);
    expect(Object.isFrozen(pa) && Object.isFrozen(pa.network)).toBe(true);
  });

  test("the system-contract check is cached per network, and a failed one is retried", async () => {
    let fails = true;
    const chain = fakeChain();
    const fetch = ((url: string, init: RequestInit) => (fails ? Promise.reject(new Error("down")) : chain.fetch(url, init))) as unknown as typeof globalThis.fetch;
    const net = createNetwork({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch });
    await expect(checkSystemContracts(net)).rejects.toThrow("no response: down");
    fails = false;
    await checkSystemContracts(net);
    await checkSystemContracts(net);
    expect(chain.calls).toEqual(["eth_chainId", "eth_getCode", "eth_getCode"]); // once, then cached
    forgetSystemCheck(net);
    await checkSystemContracts(net);
    expect(chain.calls.length).toBe(6);
  });

  test("a network whose node is on another chain is refused before anything is sent", async () => {
    const net = createNetwork({ chainId: 1337n, nodeUrl: "http://n.invalid", gatewayUrl: "http://g.invalid", fetch: fakeChain([], 31337n).fetch });
    await expect(checkSystemContracts(net)).rejects.toThrow("the node of this network is on chain 31337, not chain 1337");
  });

  test("createNetwork refuses a bad chain id or URL", () => {
    const ok = { chainId: 1n, nodeUrl: "http://n", gatewayUrl: "https://g" };
    expect(() => createNetwork({ ...ok, chainId: 0n })).toThrow("chainId");
    expect(() => createNetwork({ ...ok, chainId: 1 as unknown as bigint })).toThrow("chainId");
    expect(() => createNetwork({ ...ok, nodeUrl: "altmempool.forshtat.com" })).toThrow("nodeUrl");
    expect(() => createNetwork({ ...ok, gatewayUrl: "file:///etc/passwd" })).toThrow("gatewayUrl");
    expect(() => createNetwork({ ...ok, explorerUrl: "nope" })).toThrow("explorerUrl");
    expect(() => createNetwork({ ...ok, explorerUrl: "https://ex/?q=1" })).toThrow("no query or fragment");
    expect(() => createNetwork({ ...ok, chainId: 1n << 256n })).toThrow("below 2^256");
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => createNetwork({ ...ok, timeoutMs: t })).toThrow("timeoutMs");
    expect(() => createNetwork({ ...ok, fetch: "x" as unknown as typeof fetch })).toThrow("fetch must be a function");
  });
});
