// POST /wallets/:address/send and the transaction reads (GET /tx/:hash, GET /wallets/:address/txs) against the fake
// chain: keyed lanes, every error status, the public mempool's refusal rule, retries after expiry, and nothing
// reserved when a check fails. Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { DEFAULTS, LeafJournal, frameGasModel, fromWire, gateway, node, nonceKeyFor } from "../../pipeline/src/index.ts";
import { MARKET, answered, lost } from "./fake-chain.ts";
import { Harness, OTHER, TARGET, missShortDeadlines, until } from "./helpers.ts";

let h: Harness;
let a: Address;
beforeEach(async () => { h = await Harness.create(); a = await h.wallet(); });
afterEach(async () => { await h.destroy(); });

const send = (body: Record<string, unknown>, who: string = a) => h.req("POST", `/wallets/${who}/send`, body);
const journalLeaves = () => Object.values(h.coldJournal(a).leaves) as any[];

describe("keyed sends", () => {
  test("submitted, then followed to OnChain; GET /tx/:hash has the whole record", async () => {
    const r = await send({ to: TARGET, valueWei: "1000" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ txHash: r.body.txHash, leaf: 1, nonceKeys: ["0x1"], nonceSeq: "0x0", status: "Submitted" });
    const tx = await h.settle(r.body.txHash);
    expect(tx).toMatchObject({
      txHash: r.body.txHash, status: "OnChain", wallet: a, kind: "send", leaf: 1, nonceKey: "0x1", nonceSeq: "0x0", mode: "keyed", mempool: "alt",
      to: TARGET, valueWei: "1000", retryOf: null, retriedAs: null, explorerUrl: `https://explorer.altmempool.wtf/tx/${r.body.txHash}`,
      simulation: { verifyGas: "60000", violations: [] },
    });
    expect(tx.receipt.blockNumber).toMatch(/^0x/);
    expect(tx.admission.summary).toBe("included: 2 of 2 rules passed");
    expect(tx.deadline).toBeGreaterThan(Date.now() / 1000);
    expect(tx.timeline.map((t: any) => t.status)[0]).toBe("Submitted");
    expect(tx.timeline.at(-1).status).toMatch(/^OnChain in block \d+$/);
    expect(h.chain.balance(TARGET)).toBe(1000n);
    expect(journalLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "onchain"]]);
    expect(h.chain.sent[0]!.frames[1]!.limits.execution).toBe(90_000n); // the declared verify limit (spec: at most 90k)
  });

  test("the gas columns and the grinding (Nov 6, Vicky): on GET /tx/:hash and on the lane board", async () => {
    const r = await send({ to: TARGET, valueWei: "1000" });
    const tx = await h.settle(r.body.txHash);
    const m = frameGasModel(fromWire(tx.wire));
    expect(tx.gas).toEqual({
      declaredVerifyGas: "90000", verifyGas: tx.simulation.verifyGas, intrinsicGas: m.intrinsic.toString(),
      floorGas: (m.mandatory + m.floor).toString(), billedBytes: Number(m.bytes), gasUsed: BigInt(tx.receipt.gasUsed).toString(),
    });
    expect(Number(tx.gas.floorGas)).toBeGreaterThan(Number(tx.gas.intrinsicGas)); // the 2,000-byte signature entry sets the floor
    expect(tx.grind.field).toBe("maxFeePerGas");
    expect(tx.grind.steps).toBeLessThanOrEqual(tx.grind.maxSteps);
    expect(tx.grind.tries.at(-1)).toBe(tx.grind.steps);
    expect(tx.grind.tries.slice(0, -1).every((s: number) => s > tx.grind.maxSteps)).toBe(true);
    const [row] = (await h.req("GET", `/wallets/${a}/txs`)).body;
    expect([row.txHash, row.wire, row.gas, row.grind]).toEqual([tx.txHash, undefined, tx.gas, tx.grind]);
  });

  test("lanes in parallel: four sends at once take four leaves and four keys, and all land", async () => {
    const rs = await Promise.all([1, 2, 3, 4].map((i) => send({ to: TARGET, valueWei: String(i) })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.leaf)).size).toBe(4);
    expect(new Set(rs.map((r) => r.body.nonceKeys[0])).size).toBe(4);
    for (const r of rs) expect((await h.settle(r.body.txHash)).status).toBe("OnChain");
    expect(h.chain.balance(TARGET)).toBe(10n);
  });

  test("a transfer that creates its target declares 183,600 state gas; one to an existing account declares none", async () => {
    await h.settle((await send({ to: OTHER, valueWei: "5" })).body.txHash);
    await h.settle((await send({ to: OTHER, valueWei: "5" })).body.txHash);
    expect(h.chain.sent.map((t) => t.frames[2]!.limits.state)).toEqual([183_600n, 0n]);
  });

  test("a call with data gets its limits from estimateCalls, which burns one leaf of its own", async () => {
    const r = await send({ to: OTHER, data: "0x12345678" });
    expect([r.status, r.body.leaf]).toEqual([200, 2]);
    await h.settle(r.body.txHash);
    expect(journalLeaves().map((l) => [l.leaf, l.status, l.note ?? ""])).toEqual([[1, "burned", "estimate only: signed once, never sent"], [2, "onchain", ""]]);
    expect(h.chain.calls.estimate).toBe(1);
    expect(h.chain.sent[0]!.frames[2]!.limits.execution).toBe(100n + 10n + 2_500n); // used + 10 % + 2,500
  });

  test("a store that cannot be written when the send is submitted: still answered, followed and journaled (P1)", async () => {
    const store = h.app.backend.store;
    const realPut = store.put.bind(store);
    store.put = () => { throw new Error("disk full"); };
    try {
      const r = await send({ to: TARGET, valueWei: "3" });
      expect([r.status, r.body.status]).toEqual([200, "Submitted"]);
      await until(() => journalLeaves()[0]?.status === "onchain", 5_000, "the lane to land");
      expect(h.chain.balance(TARGET)).toBe(3n);
      expect(h.logs.some((l) => l.includes("store: submitted: disk full"))).toBe(true);
      expect((await h.req("GET", `/tx/${r.body.txHash}`)).body.status).toBe("OnChain"); // from the journal
    } finally {
      store.put = realPut;
    }
  });

  test("every bad field is a 400 before anything is reserved", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /to is required/],
      [{ to: "0x12" }, /to must be an address/],
      [{ to: TARGET, valueWei: "-1" }, /valueWei must be/],
      [{ to: TARGET, valueWei: 1 }, /valueWei must be/],
      [{ to: TARGET, data: "0x123" }, /data must be 0x-prefixed hex bytes/],
      [{ to: TARGET, mode: "warm" }, /mode must be one of/],
      [{ to: TARGET, expirySeconds: 0 }, /expirySeconds must be a whole number from 1 to 86400/],
      [{ to: TARGET, expirySeconds: 1.5 }, /expirySeconds/],
      [{ to: TARGET, expirySeconds: 86_401 }, /expirySeconds/],
      [{ to: TARGET, firstAttemptExpirySeconds: 0 }, /firstAttemptExpirySeconds must be a whole number from 1 to 86400/],
      [{ to: TARGET, firstAttemptExpirySeconds: 4.5 }, /firstAttemptExpirySeconds must be/],
      [{ to: TARGET, firstAttemptExpirySeconds: 86_401 }, /firstAttemptExpirySeconds must be/],
      [{ to: TARGET, firstAttemptExpirySeconds: "4" }, /firstAttemptExpirySeconds must be/],
      [{ to: TARGET, mempool: "private" }, /mempool must be one of/],
      [{ to: TARGET, maxFeePerGasWei: "0" }, /above 0/],
      [{ to: TARGET, retries: 4 }, /retries must be a whole number from 0 to 3/],
      [{ to: TARGET, value: "1" }, /unknown field value/],
      [{ to: a, data: "0x6c6f2d65" }, /go through \/rotate and \/hot-policy/],
    ];
    for (const [body, why] of cases) {
      const r = await send(body);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    expect(journalLeaves()).toEqual([]);
  });

  test("404 for an unknown wallet", async () => {
    const r = await send({ to: TARGET }, "0x000000000000000000000000000000000000dEaD");
    expect([r.status, r.body.error]).toEqual([404, "unknown_wallet"]);
  });

  test("the last 4 cold leaves are kept for admin calls: keyed sends stop short of them; the kill switch and a rotation both fit (C)", async () => {
    const small = await h.wallet({ hotStart: 8 }); // cold leaves 1 to 7 (leaf 0 cannot sign at epoch 0)
    const leaves = () => Object.values(h.coldJournal(small).leaves).map((l: any) => [l.leaf, l.status]);
    const kept = /the last 4 cold leaves are kept for the kill switch and a rotation \(2 each\)/;
    await h.settle((await send({ to: OTHER, data: "0x12345678" }, small)).body.txHash); // leaf 1 its estimate, leaf 2 the call
    // a call with data needs 2 leaves, which would leave 3: refused before its estimate
    const call = await send({ to: OTHER, data: "0x12345678" }, small);
    expect([call.status, call.body.error, h.chain.calls.estimate]).toEqual([409, "leaves_exhausted", 1]);
    expect(call.body.detail).toMatch(kept);
    await h.settle((await send({ to: TARGET, valueWei: "1" }, small)).body.txHash); // leaf 3: leaves 4 to 7 are left
    const r = await send({ to: TARGET, valueWei: "1" }, small);
    expect([r.status, r.body.error]).toEqual([409, "leaves_exhausted"]);
    expect(r.body.detail).toMatch(kept);
    expect(leaves()).toEqual([[1, "burned"], [2, "onchain"], [3, "onchain"]]);
    // the kill switch goes out on two of the kept leaves...
    const kill = await h.req("POST", `/wallets/${small}/hot-policy`, { hotStart: 8, valueCapWei: "0", feeCapWei: "1", allowedTarget: TARGET });
    expect(kill.status).toBe(200);
    expect((await h.settle(kill.body.txHash)).status).toBe("OnChain");
    expect(leaves().slice(3)).toEqual([[4, "burned"], [5, "onchain"]]);
    // ...and a rotation still fits on the last two
    const rot = await h.req("POST", `/wallets/${small}/rotate`, { height: 4 });
    expect(rot.status).toBe(200);
    expect((await h.settle(rot.body.txHash)).status).toBe("OnChain");
    expect(leaves().slice(5)).toEqual([[6, "burned"], [7, "onchain"]]);
    await until(() => h.record(small).tree.generation === 1 && !h.record(small).rotation, 5_000, "the switch to epoch 1");
  });

  test("422 when the node's dry run refuses: the leaf is burned and the refusal is in the store", async () => {
    const r = await send({ to: TARGET, valueWei: (10n ** 30n).toString() }); // more than the wallet holds: the transfer frame reverts
    expect([r.status, r.body.error, r.body.leaf]).toEqual([422, "refused", 1]);
    expect(r.body.simulation).toEqual({ verifyGas: "60000", violations: ["frame 2 reverted", "account: out of funds"] });
    expect(journalLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"]]);
    const refused = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    expect(refused).toMatchObject({ status: "Refused", leaf: 1, mode: "keyed", detail: expect.stringContaining("preflight refused") });
    // it was ground before the dry run refused it; nothing was sent, so no JSON to price and no receipt
    expect(refused.grind.steps).toBeLessThanOrEqual(refused.grind.maxSteps);
    expect(refused.gas).toEqual({ declaredVerifyGas: null, verifyGas: "60000", intrinsicGas: null, floorGas: null, billedBytes: null, gasUsed: null });
    expect(h.chain.sent.length).toBe(0);
  });

  test("422 when the sidecar refuses at submission, with its admission report", async () => {
    h.chain.altRefusal = "validation prefix execution gas sum 120000 exceeds MAX_VERIFY_GAS 100000";
    const r = await send({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([422, "refused"]);
    expect(r.body.admission.outcome).toBe("rejected");
    // the admission report's failed rule, and the JSON-RPC error the refusal came as
    expect(r.body.simulation.violations).toEqual([`BUDGET-001: ${h.chain.altRefusal}`, `eth_sendFrameTransaction: ${h.chain.altRefusal} (-32602)`]);
    expect(journalLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"]]);
    const tx = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    expect([tx.status, tx.simulation.violations]).toEqual(["Refused", r.body.simulation.violations]);
  });

  test("502 when the node cannot be read, with nothing reserved", async () => {
    const realPrice = gateway.gasPrice;
    gateway.gasPrice = async () => { throw lost("skandha_getGasPrice"); };
    const r = await send({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    gateway.gasPrice = realPrice;
    expect(journalLeaves()).toEqual([]);
  });

  test("503 when the chain is stalled, with nothing reserved", async () => {
    h.chain.halted = true;
    const r = await send({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([503, "chain_stalled"]);
    expect(journalLeaves()).toEqual([]);
  });

  test("409 tree_mismatch when the chain's tree is not the record's (I9); no leaf spent", async () => {
    h.chain.account(a)!.root = `0x${"77".repeat(32)}`;
    const r = await send({ to: TARGET, valueWei: "1" });
    expect([r.status, r.body.error]).toEqual([409, "tree_mismatch"]);
    expect(r.body.detail).toContain("no leaf was spent");
    expect(journalLeaves()).toEqual([]);
  });

  test("409 journal_busy when a script holds the journal; the backend never steals it", async () => {
    await h.close();
    const rec = h.record(a);
    const holder = Bun.spawn([process.execPath, "-e", `
      import { LeafJournal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../pipeline/src/leaves.ts"))};
      LeafJournal.open(${JSON.stringify(`${rec.tree.seedFile}.journal-epoch0.json`)}, { wallet: "${a}", chainId: 1337n, epoch: 0, height: 4, treeSeed: "${rec.tree.treeSeed}" });
      console.log("ready");
      await Bun.sleep(60_000);`], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      h.open();
      const r = await send({ to: TARGET, valueWei: "1" });
      expect([r.status, r.body.error]).toEqual([409, "journal_busy"]);
      expect(r.body.detail).toContain("in use by another process");
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});

describe("the public mempool", () => {
  test("mempool public goes to the node's pool, never the sidecar; followed to OnChain, no admission report", async () => {
    const r = await send({ to: TARGET, valueWei: "1", mempool: "public" });
    expect(r.status).toBe(200);
    const tx = await h.settle(r.body.txHash);
    expect([tx.status, tx.mempool, tx.admission]).toEqual(["OnChain", "public", null]);
    expect([h.chain.calls.public.length, h.chain.calls.alt.length]).toEqual([1, 0]);
  });

  test("a second lane while one is pending: refused and not held, so 422 and its leaf burned", async () => {
    h.chain.autoInclude = false;
    const first = await send({ to: TARGET, valueWei: "1", mempool: "public" });
    expect(first.status).toBe(200);
    const second = await send({ to: TARGET, valueWei: "2", mempool: "public" });
    expect([second.status, second.body.error, second.body.admission]).toEqual([422, "refused", null]);
    expect(second.body.detail).toContain("one pending frame transaction per sender");
    // no admission report from the public pool: the JSON-RPC error is the violation shown
    expect(second.body.simulation.violations).toEqual(["eth_sendRawTransaction: txpool: one pending frame transaction per sender (-32000)"]);
    expect(h.coldJournal(a).leaves[second.body.leaf].status).toBe("burned");
    h.chain.mine();
    expect((await h.settle(first.body.txHash)).status).toBe("OnChain");
  });

  test("a refusal for a transaction the node does hold is followed, not burned", async () => {
    const realPublic = node.sendRawPublic;
    node.sendRawPublic = async (tx) => { await realPublic(tx); throw answered("eth_sendRawTransaction", -32000, "late failure"); };
    const r = await send({ to: TARGET, valueWei: "1", mempool: "public" });
    expect(r.status).toBe(200);
    expect((await h.settle(r.body.txHash)).status).toBe("OnChain");
    node.sendRawPublic = realPublic;
  });

  test("the alt mempool is the default and is used exactly as before", async () => {
    await h.settle((await send({ to: TARGET, valueWei: "1" })).body.txHash);
    expect([h.chain.calls.alt.length, h.chain.calls.public.length]).toEqual([1, 0]);
  });
});

describe("expiry and retries (I7)", () => {
  // A fee the caller fixes is sent exactly (the grinder moves the last frame's limit instead), so "1 wei" stays below
  // the fake's base fee of 7 wei and the low-fee attempt can never land.
  test("a fee below the base fee expires; retries: 1 sends once more on a fresh leaf and key, linked both ways", async () => {
    const r = await send({ to: TARGET, valueWei: "7", maxFeePerGasWei: "1", retries: 1, expirySeconds: 1 });
    expect(r.status).toBe(200);
    const first = await h.settle(r.body.txHash, "Expired");
    expect(first.retriedAs).toMatch(/^0x[0-9a-f]{64}$/);
    const second = await h.settle(first.retriedAs, "OnChain");
    expect(second.retryOf).toBe(r.body.txHash);
    expect([first.leaf, second.leaf]).toEqual([1, 2]);
    expect(second.nonceKey).not.toBe(first.nonceKey);
    // the first attempt offered exactly the low fee, with the priority fee capped by it; the retry the market's (ground)
    const [low, market] = h.chain.sent.map((t) => t.fees);
    expect([low!.maxFeePerGas, low!.maxPriorityFeePerGas]).toEqual([1n, 1n]);
    expect(market!.maxFeePerGas - MARKET.maxFeePerGas).toBeLessThan(4_096n);
    expect(market!.maxFeePerGas >= MARKET.maxFeePerGas).toBe(true);
    expect(market!.maxPriorityFeePerGas).toBe(MARKET.maxPriorityFeePerGas);
    expect(h.chain.balance(TARGET)).toBe(7n); // paid once
    expect(journalLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"], [2, "onchain"]]);
  });

  test("the demo's stuck payment: a 4-second first deadline misses its block, its leaf burned; the retry lands on a fresh leaf with the normal deadline", async () => {
    missShortDeadlines(h.chain);
    const t0 = Math.floor(Date.now() / 1000);
    const r = await send({ to: TARGET, valueWei: "7", firstAttemptExpirySeconds: 4, retries: 1 });
    expect([r.status, r.body.leaf]).toEqual([200, 1]);
    await h.settle(r.body.txHash, "Expired", 10_000);
    await until(async () => !!(await h.req("GET", `/tx/${r.body.txHash}`)).body.retriedAs, 10_000, "the retry to be submitted");
    const first = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    const second = await h.settle(first.retriedAs, "OnChain", 10_000);
    expect([first.leaf, second.leaf, second.retryOf]).toEqual([1, 2, r.body.txHash]);
    // the first attempt's deadline was 4 s out; the retry's is expirySeconds (default 90) from its own send
    expect(first.deadline - t0).toBeGreaterThanOrEqual(4);
    expect(first.deadline - t0).toBeLessThanOrEqual(5);
    expect(second.deadline - first.deadline).toBeGreaterThanOrEqual(DEFAULTS.expirySeconds);
    expect(h.chain.sent.map((t) => BigInt(t.frames[0]!.data))).toEqual([BigInt(first.deadline), BigInt(second.deadline)]);
    expect(h.chain.balance(TARGET)).toBe(7n); // paid once
    expect(journalLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"], [2, "onchain"]]);
  }, 20_000);

  test("without retries, firstAttemptExpirySeconds is the one attempt's deadline", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const r = await send({ to: TARGET, valueWei: "1", firstAttemptExpirySeconds: 30, expirySeconds: 600 });
    const tx = await h.settle(r.body.txHash, "OnChain");
    expect(tx.deadline - t0).toBeGreaterThanOrEqual(30);
    expect(tx.deadline - t0).toBeLessThanOrEqual(31);
    expect(BigInt(h.chain.sent[0]!.frames[0]!.data)).toBe(BigInt(tx.deadline));
  });

  test("without retries an expired send stays expired: nothing is paid again", async () => {
    const r = await send({ to: TARGET, valueWei: "7", maxFeePerGasWei: "1", expirySeconds: 1 });
    await h.settle(r.body.txHash, "Expired");
    await h.app.backend.idle();
    expect(h.chain.sent.length).toBe(1);
    expect(h.chain.sent[0]!.fees.maxFeePerGas).toBe(1n); // exactly the fee asked for
    expect(h.chain.balance(TARGET)).toBe(0n);
  });

  test("no outcome before the follow gives up: Unknown, the lane stays in flight, nothing more is sent", async () => {
    h.chain.autoInclude = false;
    const r = await send({ to: TARGET, valueWei: "1", expirySeconds: 1 });
    // never included and never past what the fake can prove? It expires: the chain proves it. Make the node go dark instead.
    const realStorageAt = node.storageAt;
    node.storageAt = async () => { throw lost("eth_getStorageAt"); };
    const tx = await h.settle(r.body.txHash, "Unknown", 8_000);
    expect(tx.detail).toContain("no outcome");
    expect((await h.req("GET", `/wallets/${a}`)).body.lanesInFlight).toBe(1);
    expect(h.chain.sent.length).toBe(1);
    node.storageAt = realStorageAt;
  });
});

describe("reading transactions", () => {
  test("GET /wallets/:address/txs is the lane board, newest first, refusals included", async () => {
    const one = await send({ to: TARGET, valueWei: "1" });
    await h.settle(one.body.txHash);
    const refused = await send({ to: TARGET, valueWei: (10n ** 30n).toString() });
    const r = await h.req("GET", `/wallets/${a}/txs`);
    expect(r.status).toBe(200);
    expect(r.body.map((t: any) => [t.txHash, t.status])).toEqual([[refused.body.txHash, "Refused"], [one.body.txHash, "OnChain"]]);
    expect((await h.req("GET", "/wallets/0x000000000000000000000000000000000000dEaD/txs")).status).toBe(404);
  });

  test("GET /tx/:hash falls back to the journals (a lane sent by a script), with the receipt read live", async () => {
    await h.close();
    const rec = h.record(a);
    const j = LeafJournal.open(`${rec.tree.seedFile}.journal-epoch0.json`, { wallet: a, chainId: 1337n, epoch: 0, height: 4, treeSeed: rec.tree.treeSeed });
    const hash = `0x${"5a".repeat(32)}` as Hex;
    j.reserveNext({ from: 0, to: 12 });
    j.mark(1, "submitted", { txHash: hash, deadline: 1 });
    j.mark(1, "burned", { note: "expired: key unused at block 1009, past the deadline" });
    j.close();
    h.open();
    const r = await h.req("GET", `/tx/${hash}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ txHash: hash, status: "Expired", leaf: 1, nonceKey: `0x${nonceKeyFor(0, 1).toString(16)}`, mode: "keyed", mempool: null, to: null, valueWei: null });
    expect((await h.req("GET", `/wallets/${a}/txs`)).body.map((t: any) => t.txHash)).toEqual([hash]);
  });

  test("404 for an unknown hash, 400 for a malformed one", async () => {
    const missing = await h.req("GET", `/tx/0x${"00".repeat(32)}`);
    expect([missing.status, missing.body.error]).toEqual([404, "unknown_tx"]);
    expect((await h.req("GET", "/tx/0x1234")).status).toBe(400);
  });
});

test("the files the store keeps are JSON with decimal amounts and hex keys", async () => {
  await h.settle((await send({ to: TARGET, valueWei: "1000" })).body.txHash);
  const store = JSON.parse(fs.readFileSync(path.join(h.dirs.backendDir, "txs.json"), "utf8"));
  expect(store.version).toBe(1);
  expect(store.txs[0]).toMatchObject({ valueWei: "1000", nonceKey: "0x1", nonceSeq: "0x0", status: "OnChain" });
  expect(fs.statSync(path.join(h.dirs.backendDir, "txs.json")).mode & 0o777).toBe(0o600);
});
