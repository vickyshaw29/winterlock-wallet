// POST /wallets/:address/tickets and hot sends against the fake chain, with the real Rust CLI (export-leaves and
// sign --ticket-file) on the wallet's own throwaway seed at height 4: the cut's off-by-one, contiguous cuts, the ticket
// directory and its modes, a hot send end to end, tickets_exhausted, and the account's hot refusals as 422s.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import {
  DEFAULTS, GRIND, computeSigHash, maxStepsFor, node, nonceKeyFor, wotsVerifySteps, type FrameTransaction,
} from "../../pipeline/src/index.ts";
import { MARKET, lost } from "./fake-chain.ts";
import { BIN, Harness, OTHER, TARGET, missShortDeadlines, requireCli, until } from "./helpers.ts";

beforeAll(requireCli);

let h: Harness;
let a: Address;
beforeEach(async () => { h = await Harness.create(); a = await h.wallet(); }); // height 4: cold leaves 1..11, hot 12..15
afterEach(async () => { await h.destroy(); });

const cut = (count: unknown, who: string = a) => h.req("POST", `/wallets/${who}/tickets`, { count });
const hot = (body: Record<string, unknown>) => h.req("POST", `/wallets/${a}/send`, { mode: "hot", ...body });
const cold = () => Object.values(h.coldJournal(a).leaves) as any[];
const exported = () => cold().filter((l) => l.status === "exported").map((l) => l.leaf);
const ticketsDir = () => path.join(h.deviceDir(a), "tickets");
const ticketFile = (name: string) => JSON.parse(fs.readFileSync(path.join(ticketsDir(), name), "utf8"));
const device = () => JSON.parse(fs.readFileSync(path.join(h.deviceDir(a), "journal-epoch0.json"), "utf8"));
const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe("cutting tickets (I3, I4)", () => {
  test("a cut of 3 is exactly 3 leaves: 3 exported in the cold journal, 3 in the file, the range inclusive", async () => {
    const r = await cut(3);
    expect([r.status, r.body]).toEqual([200, { from: 12, to: 14, count: 3 }]);
    expect(exported()).toEqual([12, 13, 14]);
    expect(cold().length).toBe(3);
    const file = ticketFile("epoch0-12-14.json");
    expect(file.leaves.map((l: any) => l.leaf)).toEqual([12, 13, 14]);
    expect([file.treeSeed, file.root, file.height, file.generation, file.chainId]).toEqual([h.record(a).tree.treeSeed, h.record(a).tree.root, 4, 0, 1337]);
  });

  test("the next cut starts where the device's band ends, in its own file; the band shows in the wallet", async () => {
    await cut(2);
    const r = await cut(1);
    expect(r.body).toEqual({ from: 14, to: 14, count: 1 });
    expect(exported()).toEqual([12, 13, 14]);
    expect(fs.readdirSync(ticketsDir()).sort()).toEqual(["epoch0-12-13.json", "epoch0-14-14.json"]);
    expect((await h.req("GET", `/wallets/${a}`)).body.tickets).toEqual({ exported: 3, used: 0, left: 3 });
  });

  test("ticket files live in <device>/tickets/, mode 0600, apart from every journal", async () => {
    await cut(2);
    const dev = h.deviceDir(a);
    expect(mode(ticketsDir())).toBe(0o700);
    expect(mode(path.join(ticketsDir(), "epoch0-12-13.json"))).toBe(0o600);
    // the device's own directory: its journal and the tickets directory, no ticket file beside the journal
    expect(fs.readdirSync(dev).sort()).toEqual(["journal-epoch0.json", "journal-epoch0.json.lock", "tickets"]);
    // the cold journal's directory (the seeds) holds no ticket file either
    const seeds = path.dirname(h.record(a).tree.seedFile);
    expect(fs.readdirSync(seeds).filter((n) => /^epoch\d+-/.test(n))).toEqual([]);
    // and the device journal opens again after a restart: nothing beside it names its tree
    await h.close();
    h.open();
    expect((await h.req("GET", `/wallets/${a}`)).body.tickets).toEqual({ exported: 2, used: 0, left: 2 });
  });

  test("the hot band runs out: a cut past the tree's last leaf is 409, and nothing is exported", async () => {
    await cut(3);
    const r = await cut(2); // 15 and 16: there is no leaf 16 at height 4
    expect([r.status, r.body.error]).toEqual([409, "leaves_exhausted"]);
    expect(r.body.detail).toContain("1 uncut leaf(s) left from leaf 15");
    expect(exported()).toEqual([12, 13, 14]);
    expect((await cut(1)).body).toEqual({ from: 15, to: 15, count: 1 });
  });

  test("400 for a bad count, 404 for an unknown wallet; nothing cut", async () => {
    for (const [count, why] of [[0, /count must be a whole number from 1 to 64/], [65, /from 1 to 64/], [1.5, /count/], ["3", /count/]] as const) {
      const r = await cut(count);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    expect((await h.req("POST", `/wallets/${a}/tickets`, {})).body.detail).toBe("count is required");
    expect((await h.req("POST", `/wallets/${a}/tickets`, { count: 1, from: 3 })).body.detail).toMatch(/unknown field from/);
    expect((await cut(1, "0x000000000000000000000000000000000000dEaD")).status).toBe(404);
    expect(exported()).toEqual([]);
    expect(fs.existsSync(ticketsDir())).toBe(false);
  });

  /** With the backend stopped, a script's journal entry: `leaf` signed and landed, or reserved and burned. */
  async function usedByScript(who: Address, height: number, leaf: number, status: "onchain" | "burned") {
    await h.close();
    const rec = h.record(who);
    const { LeafJournal } = await import("../../pipeline/src/index.ts");
    const j = LeafJournal.open(`${rec.tree.seedFile}.journal-epoch0.json`, { wallet: who, chainId: 1337n, epoch: 0, height, treeSeed: rec.tree.treeSeed });
    j.reserveNext({ from: leaf, to: leaf + 1 });
    if (status === "onchain") {
      j.mark(leaf, "submitted", { txHash: `0x${"ee".repeat(32)}`, deadline: 1_800_000_000 });
      j.mark(leaf, "onchain");
    } else {
      j.mark(leaf, "burned", { note: "test: used elsewhere" });
    }
    j.close();
    h.open();
  }

  test("409 when a leaf of the cut is already in the cold journal: every leaf of a cut must be free, none is cut", async () => {
    await usedByScript(a, 4, 13, "burned"); // a script (or a lowered hotStart) used leaf 13 as a cold leaf
    const r = await cut(2); // 12 is free, so the first cut starts there, and 13 is not
    expect([r.status, r.body.error]).toEqual([409, "cannot_cut"]);
    expect(r.body.detail).toContain("leaf 13 is already burned");
    expect(exported()).toEqual([]);
  });

  test("the first cut starts at the lowest free hot leaf: hot leaf 1008 on chain, the first cut of 3 is 1009 to 1011, the next 1012 on", async () => {
    // height 10, hotStart 1008: the devnet account's shape, whose leaf 1008 pipeline/scripts/hashsig-devnet.ts signed directly
    const w = await h.wallet({ height: 10, hotStart: 1008 });
    await usedByScript(w, 10, 1008, "onchain");
    expect((await cut(3, w)).body).toEqual({ from: 1009, to: 1011, count: 3 });
    expect((await cut(2, w)).body).toEqual({ from: 1012, to: 1013, count: 2 }); // contiguous with the device's band
    const leaves = (Object.values(h.coldJournal(w).leaves) as any[]).map((l) => [l.leaf, l.status]);
    expect(leaves).toEqual([[1008, "onchain"], ...[1009, 1010, 1011, 1012, 1013].map((l) => [l, "exported"])]);
    expect(fs.readdirSync(path.join(h.deviceDir(w), "tickets")).sort()).toEqual(["epoch0-1009-1011.json", "epoch0-1012-1013.json"]);
    expect((await h.req("GET", `/wallets/${w}`)).body.tickets).toEqual({ exported: 5, used: 0, left: 5 });
    // a later cut never skips: a used leaf where the band ends refuses the cut
    await usedByScript(w, 10, 1014, "onchain");
    const r = await cut(1, w);
    expect([r.status, r.body.error]).toEqual([409, "cannot_cut"]);
    expect(r.body.detail).toContain("leaf 1014 is already onchain");
  }, 30_000);

  test("502 when the node cannot be read; nothing cut", async () => {
    const realCall = node.call;
    node.call = async () => { throw lost("eth_call"); };
    try {
      const r = await cut(1);
      expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    } finally {
      node.call = realCall;
    }
    expect(exported()).toEqual([]);
  });

  test("a CLI that fails after the mark: 500, the leaves stay exported (wasted, never reused), no file", async () => {
    fs.writeFileSync(h.record(a).tree.seedFile, "0x1234\n"); // the CLI refuses it: bad_seed
    const r = await cut(2);
    expect([r.status, r.body.error]).toEqual([500, "cut_failed"]);
    expect(r.body.detail).toContain("they are wasted, never reused");
    expect(exported()).toEqual([12, 13]);
    expect(fs.readdirSync(ticketsDir())).toEqual([]);
  });

  test("a lost device journal is never recreated: the next cut is 409 and ticket 12 never signs twice (A)", async () => {
    await cut(3);
    const simulated: bigint[] = []; // every hot signature is dry-run on the node before it can go anywhere
    const realSimulate = node.simulate;
    node.simulate = async (tx) => { simulated.push(tx.nonceKeys[0]!); return realSimulate(tx); };
    try {
      const refused = await hot({ to: OTHER, valueWei: "1" }); // ticket 12 signs; the account refuses the target
      expect([refused.status, refused.body.leaf]).toEqual([422, 12]);
      await h.close();
      const journal = path.join(h.deviceDir(a), "journal-epoch0.json");
      fs.rmSync(journal); // only the device journal is lost: the ticket file and the cold journal stay
      h.open();
      const r = await cut(1);
      expect([r.status, r.body.error]).toEqual([409, "device_unusable"]);
      expect(r.body.detail).toContain(`recover ${journal}; a new journal would re-sign used tickets`);
      expect([fs.existsSync(journal), exported(), fs.readdirSync(ticketsDir())]).toEqual([false, [12, 13, 14], ["epoch0-12-14.json"]]);
      // a hot send is 409 device_unusable too, as the cut is, never an invitation to cut; the wallet shows the tickets
      // as cut but unjournaled
      const again = await hot({ to: TARGET, valueWei: "1" });
      expect([again.status, again.body.error]).toEqual([409, "device_unusable"]);
      expect(again.body.detail).toContain(`recover ${journal}; a new journal would re-sign used tickets`);
      expect(again.body.detail).not.toContain("cut some");
      expect((await h.req("GET", `/wallets/${a}`)).body.tickets).toEqual({ exported: 3, used: 0, left: 0, unjournaled: 3 });
      expect(h.logs.some((l) => l.startsWith("start: 3 ticket(s) of epoch 0 were cut"))).toBe(true);
      // with the files gone too, the cold journal still knows the cut
      fs.rmSync(ticketsDir(), { recursive: true });
      expect((await cut(1)).body.error).toBe("device_unusable");
      expect(fs.existsSync(journal)).toBe(false);
      expect(simulated).toEqual([nonceKeyFor(0, 12)]); // ticket 12 signed exactly once
    } finally {
      node.simulate = realSimulate;
    }
  });
});

describe("hot sends", () => {
  test("409 no_tickets before the first cut", async () => {
    const r = await hot({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([409, "no_tickets"]);
  });

  test("end to end: signed from the ticket file, one leaf per ticket, then tickets_exhausted", async () => {
    await cut(2);
    const one = await hot({ to: TARGET, valueWei: "1000" });
    expect([one.status, one.body.leaf, one.body.nonceKeys]).toEqual([200, 12, [`0x${nonceKeyFor(0, 12).toString(16)}`]]);
    const tx = await h.settle(one.body.txHash);
    expect(tx).toMatchObject({ status: "OnChain", mode: "hot", leaf: 12, to: TARGET, valueWei: "1000" });
    expect(h.chain.sent[0]!.signatures.length).toBe(1); // a hot ticket carries no classical key
    const two = await hot({ to: TARGET, valueWei: "2000" });
    expect(two.body.leaf).toBe(13);
    await h.settle(two.body.txHash);
    expect(h.chain.balance(TARGET)).toBe(3000n);
    // the device's journal holds the hot leaves; the cold journal only ever saw them exported
    expect(Object.values(device().leaves).map((l: any) => [l.leaf, l.status])).toEqual([[12, "onchain"], [13, "onchain"]]);
    expect(cold().map((l) => [l.leaf, l.status])).toEqual([[12, "exported"], [13, "exported"]]);
    const three = await hot({ to: TARGET, valueWei: "1" });
    expect([three.status, three.body.error]).toEqual([409, "tickets_exhausted"]);
    expect((await h.req("GET", `/wallets/${a}`)).body.tickets).toEqual({ exported: 2, used: 2, left: 0 });
    // a keyed send is unaffected: the cold band never reaches the hot leaves
    const keyed = await h.req("POST", `/wallets/${a}/send`, { to: TARGET, valueWei: "1" });
    expect([keyed.status, keyed.body.leaf]).toEqual([200, 1]);
    await h.settle(keyed.body.txHash);
  });

  test("the account's hot rules refuse in the dry run: 422, the ticket burned, nothing sent", async () => {
    await cut(4);
    const cases: [Record<string, unknown>, string][] = [
      [{ to: TARGET, valueWei: "10000000000000001" }, "account: hot: value cap"], // the cap is 0.01 ETH
      [{ to: OTHER, valueWei: "1" }, "account: hot: frame target"],
      [{ to: TARGET, valueWei: "0", data: "0x12345678" }, "account: hot: frame data"], // sent as it is, never estimated
    ];
    for (const [i, [body, why]] of cases.entries()) {
      const r = await hot(body);
      expect([r.status, r.body.error, r.body.leaf]).toEqual([422, "refused", 12 + i]);
      expect(r.body.simulation.violations).toContain(why);
      expect((await h.req("GET", `/tx/${r.body.txHash}`)).body).toMatchObject({ status: "Refused", mode: "hot", leaf: 12 + i });
    }
    expect(Object.values(device().leaves).map((l: any) => l.status)).toEqual(["burned", "burned", "burned"]);
    expect(h.chain.sent.length).toBe(0);
    expect(h.chain.calls.estimate).toBe(0); // a hot call with data is not estimated: no cold leaf burned for it
    expect(cold().filter((l) => l.status !== "exported")).toEqual([]);
    expect((await h.req("GET", `/wallets/${a}`)).body.tickets).toEqual({ exported: 4, used: 3, left: 1 });
  });

  test("409 tree_mismatch when the chain's tree is not the tickets' (I9); no ticket used", async () => {
    await cut(2);
    h.chain.account(a)!.root = `0x${"77".repeat(32)}`;
    const r = await hot({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([409, "tree_mismatch"]);
    expect(r.body.detail).toContain("Tickets:");
    expect(Object.keys(device().leaves)).toEqual([]);
    expect(h.chain.calls.simulate).toBe(0);
  });

  test("the demo's stuck payment: a 4-second first deadline misses its block, its ticket burned; the retry lands on a fresh ticket with the normal deadline", async () => {
    await cut(2);
    missShortDeadlines(h.chain);
    const t0 = Math.floor(Date.now() / 1000);
    const r = await hot({ to: TARGET, valueWei: "5", firstAttemptExpirySeconds: 4, retries: 1 });
    expect([r.status, r.body.leaf]).toEqual([200, 12]);
    await h.settle(r.body.txHash, "Expired", 10_000);
    await until(async () => !!(await h.req("GET", `/tx/${r.body.txHash}`)).body.retriedAs, 10_000, "the retry to be submitted");
    const first = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    const second = await h.settle(first.retriedAs, "OnChain", 10_000);
    expect([first.leaf, second.leaf, second.mode, second.retryOf]).toEqual([12, 13, "hot", r.body.txHash]);
    // the first attempt's deadline was 4 s out; the retry's is expirySeconds (default 90) from its own send
    expect(first.deadline - t0).toBeGreaterThanOrEqual(4);
    expect(first.deadline - t0).toBeLessThanOrEqual(5);
    expect(second.deadline - first.deadline).toBeGreaterThanOrEqual(DEFAULTS.expirySeconds);
    expect(h.chain.sent.map((t) => BigInt(t.frames[0]!.data))).toEqual([BigInt(first.deadline), BigInt(second.deadline)]);
    expect(h.chain.balance(TARGET)).toBe(5n); // paid once
    expect(Object.values(device().leaves).map((l: any) => [l.leaf, l.status])).toEqual([[12, "burned"], [13, "onchain"]]);
  }, 20_000);

  test("a stuck payment stays stuck: fee 1 is sent as exactly 1, expires, and the retry lands on a fresh ticket (B)", async () => {
    await cut(2);
    const r = await hot({ to: TARGET, valueWei: "5", maxFeePerGasWei: "1", retries: 1, expirySeconds: 1 });
    expect([r.status, r.body.leaf]).toEqual([200, 12]);
    await h.settle(r.body.txHash, "Expired"); // the fake's base fee is 7 wei: a fee of 1 never lands
    await until(async () => !!(await h.req("GET", `/tx/${r.body.txHash}`)).body.retriedAs, 10_000, "the retry to be submitted");
    const first = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    const second = await h.settle(first.retriedAs, "OnChain");
    expect([first.leaf, second.leaf, second.mode]).toEqual([12, 13, "hot"]);
    expect(h.chain.balance(TARGET)).toBe(5n); // paid once
    expect(Object.values(device().leaves).map((l: any) => [l.leaf, l.status])).toEqual([[12, "burned"], [13, "onchain"]]);
    // Which field each attempt ground, read from what was sent: the first value of the field that fits, every earlier one not.
    const maxSteps = maxStepsFor({ ...GRIND.hot, verifyGasLimit: 90_000n });
    const fits = (t: FrameTransaction) => wotsVerifySteps(computeSigHash(t)) <= maxSteps;
    const withFee = (t: FrameTransaction, fee: bigint) => ({ ...t, fees: { ...t.fees, maxFeePerGas: fee } });
    const withGas = (t: FrameTransaction, gas: bigint) => ({ ...t, frames: t.frames.map((f, i) => (i === 2 ? { ...f, limits: { ...f.limits, execution: gas } } : f)) });
    const [stuck, retry] = h.chain.sent as [FrameTransaction, FrameTransaction];
    // the fixed fee is exact; its last frame's limit moved, one gas per try
    expect([stuck.fees.maxFeePerGas, stuck.fees.maxPriorityFeePerGas]).toEqual([1n, 1n]);
    const gas = stuck.frames[2]!.limits.execution;
    expect(fits(stuck)).toBe(true);
    for (let g = DEFAULTS.transferGas; g < gas; g++) expect(fits(withGas(stuck, g))).toBe(false);
    // the retry runs at the market's fee, ground as before: its fee moved, one wei per try, its limit stayed exact
    expect(retry.frames[2]!.limits.execution).toBe(DEFAULTS.transferGas);
    expect(fits(retry)).toBe(true);
    for (let fee = MARKET.maxFeePerGas; fee < retry.fees.maxFeePerGas; fee++) expect(fits(withFee(retry, fee))).toBe(false);
  }, 20_000);

  test("a signer CLI that is missing or does not run: 500 signer_unavailable, no ticket reserved, burned or cut", async () => {
    await cut(1);
    const broken = path.join(h.dirs.root, "broken-signer");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    for (const bin of [path.join(h.dirs.root, "no-such-signer"), broken]) {
      h.cfg.signerBin = bin;
      const send = await hot({ to: TARGET, valueWei: "1" });
      expect([send.status, send.body.error]).toEqual([500, "signer_unavailable"]);
      expect(send.body.detail).toContain("no ticket was reserved, cut or burned");
      const more = await cut(1);
      expect([more.status, more.body.error]).toEqual([500, "signer_unavailable"]);
    }
    expect([Object.keys(device().leaves), exported(), h.chain.calls.simulate]).toEqual([[], [12], 0]);
    h.cfg.signerBin = BIN; // the CLI is back: the ticket that was never touched signs
    const r = await hot({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.leaf]).toEqual([200, 12]);
    await h.settle(r.body.txHash);
  });

  test("the fee cap: a hot send whose maximum cost is above hotFeeCap is refused", async () => {
    await cut(1);
    const r = await hot({ to: TARGET, valueWei: "1", maxFeePerGasWei: "100000000000" }); // 100 gwei: about 0.02 ETH of maximum cost
    expect([r.status, r.body.error]).toEqual([422, "refused"]);
    expect(r.body.simulation.violations).toContain("account: hot: fee cap");
  });
});
