// Tests of the parallel-lanes plan endpoint and of the maxCostWei and wire fields on every record, on the fake chain.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { frameTxHash, fromWire, laneCost, toWire } from "../../pipeline/src/index.ts";
import { MARKET, SIDECAR_RELAY } from "./fake-chain.ts";
import { Harness, OTHER, TARGET, requireCli, until } from "./helpers.ts";

let h: Harness;
let a: Address;
// height 5, hotStart 16: cold leaves 1 to 15, of which 11 are keyed lanes (the last 4 stay for admin calls)
beforeEach(async () => { h = await Harness.create(); a = await h.wallet({ height: 5, hotStart: 16 }); });
afterEach(async () => { await h.destroy(); });

const plan = (q: Record<string, string | number> = {}, who: string = a) =>
  h.req("GET", `/wallets/${who}/lanes/plan?${new URLSearchParams(Object.entries({ n: 8, ...q }).map(([k, v]) => [k, String(v)] as [string, string]))}`);
const send = (body: Record<string, unknown>) => h.req("POST", `/wallets/${a}/send`, body);
const tx = async (hash: string) => (await h.req("GET", `/tx/${hash}`)).body;
const zeroBytes = (hex: string) => { let n = 0; for (let i = 2; i < hex.length; i += 2) if (hex.slice(i, i + 2) === "00") n++; return n; };

describe("the plan", () => {
  test("eight keyed lanes on a new wallet: affordable, two passes, the defaults assumed; nothing reserved, signed or sent", async () => {
    const r = await plan({ valueWei: "1000" });
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p).toMatchObject({
      wallet: a, n: 8, mode: "keyed", to: TARGET, valueWei: "1000", expirySeconds: 90, affordable: true, shortfallWei: "0", passes: 2, etaSeconds: 38,
      pendingLanes: 0, pendingCostWei: "0", unpricedLanes: 0, balanceWei: "20000000000000000", lanesLeft: 11,
    });
    // the fake sidecar answers no skandha_config by default: the sidecar's defaults, said so
    expect(p.relay).toMatchObject({ bundleSize: 4, bundleIntervalSeconds: 10, maxSubmitAttempts: 3, useropsTTLSeconds: 300, bundlingMode: null, assumed: true });
    expect(p.warnings).toEqual([expect.stringMatching(/^the sidecar's relay settings were not read \(skandha_config: no response: .+\): assumed its defaults, 4 lanes per pass every 10 s$/)]);
    expect(BigInt(p.setAsideWei)).toBe(8n * BigInt(p.perLaneCostWei));
    expect(p.perLane.maxFeePerGasWei).toBe((MARKET.maxFeePerGas + 4_096n).toString()); // the market's fee plus what grinding can add
    expect(BigInt(p.perLaneCostWei)).toBe(BigInt(p.perLane.gasLimit) * BigInt(p.perLane.maxFeePerGasWei) + 1_000n);
    expect(p.perLane.valueWei).toBe("1000");
    expect(h.coldJournal(a).leaves).toEqual({});
    expect([h.chain.sent.length, h.chain.calls.simulate, h.chain.calls.alt.length]).toEqual([0, 0, 0]);
  });

  test("an upper bound on a lane sent like it: the same gas but the signature's zero bytes, the fee above the ground one", async () => {
    const p = (await plan({ n: 1, valueWei: "1000" })).body;
    const r = await send({ to: TARGET, valueWei: "1000" });
    const rec = await h.settle(r.body.txHash);
    const sent = laneCost(fromWire(rec.wire));
    // the plan priced the placeholder entry as non-zero bytes: 12 gas more for each zero byte the real signature has
    expect(BigInt(p.perLane.gasLimit) - sent.gasLimit).toBe(12n * BigInt(zeroBytes(rec.wire.signatures[0].signature)));
    expect(BigInt(p.perLane.maxFeePerGasWei) >= sent.maxFeePerGas).toBe(true);
    expect(BigInt(p.perLaneCostWei) >= sent.totalWei).toBe(true);
    // the record's set-aside, the dry run's maxCost plus the value, is the sent lane's exactly
    expect(BigInt(rec.maxCostWei) + BigInt(rec.valueWei)).toBe(sent.totalWei);
  });

  test("relay settings answered: read, not assumed; manual mode warns; testing mode is one pass of 10; a pass after the deadline warns", async () => {
    h.cfg.relayCacheMs = 0; // every plan reads the relay again, so each change shows (the one-minute cache is tested below)
    h.chain.relay = { ...SIDECAR_RELAY };
    let p = (await plan()).body;
    expect(p.relay).toEqual({ bundleSize: 4, bundleIntervalSeconds: 10, maxSubmitAttempts: 3, useropsTTLSeconds: 300, bundlingMode: "auto", testingMode: false, assumed: false, notes: [] });
    expect([p.passes, p.etaSeconds, p.warnings]).toEqual([2, 38, []]);
    h.chain.relay = { ...SIDECAR_RELAY, bundlingMode: "manual" };
    expect((await plan()).body.warnings).toEqual([expect.stringMatching(/^the sidecar's bundling mode is manual: it relays nothing by itself/)]);
    h.chain.relay = { ...SIDECAR_RELAY, testingMode: true, bundlingMode: "auto" };
    p = (await plan()).body;
    expect([p.relay.bundleSize, p.passes, p.etaSeconds]).toEqual([10, 1, 28]);
    h.chain.relay = { ...SIDECAR_RELAY };
    p = (await plan({ n: 11, expirySeconds: 30 })).body;
    expect(p.warnings).toEqual([expect.stringMatching(/^the last of 3 relay passes is due about 48 s after the send \(an estimate\), past the 30 s deadline/)]);
  });

  test("the relay settings are read once a minute, not per plan: plans at once share one read, later ones reuse it until it is old", async () => {
    expect(h.cfg.relayCacheMs).toBe(60_000); // as loadConfig sets it
    h.chain.relay = { ...SIDECAR_RELAY };
    const once = await Promise.all([plan(), plan(), plan()]); // asked at once, before any read: one read shared
    expect(once.map((r) => [r.status, r.body.relay.assumed])).toEqual([[200, false], [200, false], [200, false]]);
    expect(h.chain.calls.relay).toBe(2); // skandha_config and skandha_explorer_info, once each
    h.chain.relay = { ...SIDECAR_RELAY, bundleSize: 2 };
    for (let i = 0; i < 10; i++) expect((await plan()).body.relay.bundleSize).toBe(4); // a screen asking again and again: the read of a moment ago
    expect(h.chain.calls.relay).toBe(2);
    h.cfg.relayCacheMs = 50; // the read is older than the cache keeps one: read again
    await Bun.sleep(60);
    const fresh = (await plan()).body;
    expect([fresh.relay.bundleSize, fresh.passes, h.chain.calls.relay]).toEqual([2, 4, 4]);
    // a sidecar that cannot be asked is kept just as long, assumed, so it is not asked again on every plan
    h.cfg.relayCacheMs = 60_000;
    await h.close();
    h.chain.relay = null;
    h.open();
    const assumed = [(await plan()).body, (await plan()).body];
    expect(assumed.map((p) => p.relay.assumed)).toEqual([true, true]);
    expect(assumed[1]!.warnings).toEqual(assumed[0]!.warnings); // both say the settings were not read
    expect(h.chain.calls.relay).toBe(6);
  });

  test("pending lanes hold maxCostWei + valueWei each, and the new lanes go on top; once they land nothing is pending", async () => {
    h.chain.autoInclude = false; // the lanes stay pending
    const sent = [await send({ to: TARGET, valueWei: "7" }), await send({ to: TARGET, valueWei: "9" })];
    const recs = await Promise.all(sent.map((r) => tx(r.body.txHash)));
    const held = recs.reduce((s, t) => s + BigInt(t.maxCostWei) + BigInt(t.valueWei), 0n);
    expect(held).toBeGreaterThan(16n);
    const p = (await plan({ n: 3 })).body;
    expect([p.pendingLanes, p.pendingCostWei, p.unpricedLanes, p.lanesLeft]).toEqual([2, held.toString(), 0, 9]);
    expect(BigInt(p.setAsideWei)).toBe(held + 3n * BigInt(p.perLaneCostWei));
    h.chain.mine();
    for (const r of sent) await h.settle(r.body.txHash, "OnChain");
    expect((await plan({ n: 3 })).body).toMatchObject({ pendingLanes: 0, pendingCostWei: "0" });
  });

  test("not affordable: the shortfall is what the balance lacks", async () => {
    const p = (await plan({ valueWei: (3n * 10n ** 15n).toString() })).body; // 8 x 0.003 ETH and gas, against 0.02 ETH
    expect(p.affordable).toBe(false);
    expect(BigInt(p.shortfallWei)).toBe(BigInt(p.setAsideWei) - BigInt(p.balanceWei));
    expect(BigInt(p.shortfallWei)).toBeGreaterThan(0n);
  });

  test("hot lanes: tickets left, and the account's own refusals said before anything is signed", async () => {
    const hot = await h.wallet({ height: 5, hotStart: 16, hotFeeCapWei: "1000" }); // a fee cap no lane can fit
    const p = (await plan({ mode: "hot", valueWei: (2n * 10n ** 16n).toString(), to: OTHER }, hot)).body; // above the 0.01 ETH value cap
    expect([p.mode, p.lanesLeft]).toEqual(["hot", 0]);
    expect(p.warnings).toEqual(expect.arrayContaining([
      `only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${hot}/tickets`,
      `each lane's value, 20000000000000000 wei, is above the hot value cap of 10000000000000000 wei: the account refuses it ("hot: value cap")`,
      `hot lanes may pay only the allowed target ${TARGET}: the account refuses ${OTHER} ("hot: frame target")`,
      expect.stringMatching(/^each lane's maximum cost, \d+ wei, is above the hot fee cap of 1000 wei: the account refuses it \("hot: fee cap"\)$/),
    ]));
    expect((await plan({ mode: "hot" }, hot)).body.to).toBe(TARGET); // a plan's default target is the allowed one
    const killed = await h.wallet({ height: 5, hotStart: 16, spendLimitWei: "0" });
    expect((await plan({ mode: "hot" }, killed)).body.warnings).toContain(`the hot value cap is 0, the kill switch: the account refuses every hot lane ("hot: disabled")`);
  });

  test("hot lanes count the device's tickets; a lost device journal is said as such, and a keyed plan does not mind it", async () => {
    requireCli(); // the cut runs the real Rust CLI, as the ticket tests do
    expect((await h.req("POST", `/wallets/${a}/tickets`, { count: 3 })).body).toEqual({ from: 16, to: 18, count: 3 });
    let p = (await plan({ mode: "hot", valueWei: "1000" })).body;
    expect([p.lanesLeft, p.to]).toEqual([3, TARGET]);
    expect(p.warnings).toContain("only 3 ticket(s) are left on the ticket device: the burst would stop after 3");
    await h.close();
    fs.rmSync(path.join(h.deviceDir(a), "journal-epoch0.json"));
    h.open();
    p = (await plan({ mode: "hot", valueWei: "1000" })).body;
    expect(p.lanesLeft).toBe(0);
    expect(p.warnings).toContainEqual(expect.stringMatching(/^no ticket can sign: 3 ticket\(s\) of epoch 0 were cut for .+ recover .+journal-epoch0\.json; a new journal would re-sign used tickets \(hot sends and cuts are 409 device_unusable until then\)$/));
    const keyed = await plan();
    expect([keyed.status, keyed.body.lanesLeft]).toEqual([200, 11]);
  });

  test("a stalled chain is a warning in the plan, not a refusal", async () => {
    h.chain.halted = true;
    const r = await plan();
    expect(r.status).toBe(200);
    expect(r.body.warnings).toContainEqual(expect.stringMatching(/^the chain looks stalled \(the latest block's timestamp \d+ is \d+ s from the host clock .+\): every send is refused \(503\) until it moves$/));
  });

  test("a lane in flight with no recorded cost (as one recorded before Nov 6): counted as a lane, left out of the sum, said so", async () => {
    h.chain.autoInclude = false;
    const r = await send({ to: TARGET, valueWei: "1" });
    h.app.backend.store.update(r.body.txHash, { maxCostWei: null });
    const p = (await plan({ n: 1 })).body;
    expect([p.pendingLanes, p.unpricedLanes, p.pendingCostWei]).toEqual([1, 1, "0"]);
    expect(p.warnings).toContain("1 lane(s) in flight have no recorded maximum cost (still being sent, sent by a script, or recorded before Nov 6): the set-aside leaves them out");
    h.chain.mine();
    await h.settle(r.body.txHash, "OnChain");
  });

  test("a store written before Nov 6 loads with maxCostWei and wire null", async () => {
    const r = await send({ to: TARGET, valueWei: "1" });
    await h.settle(r.body.txHash, "OnChain");
    await h.close();
    const file = path.join(h.dirs.backendDir, "txs.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const t of data.txs) { delete t.maxCostWei; delete t.wire; }
    fs.writeFileSync(file, JSON.stringify(data));
    h.open();
    const rec = await tx(r.body.txHash);
    expect([rec.status, rec.maxCostWei, rec.wire]).toEqual(["OnChain", null, null]);
    expect((await h.req("GET", `/wallets/${a}/txs`)).body[0].maxCostWei).toBeNull();
  });

  test("every bad parameter is a 400, an unknown wallet a 404, another method a 405", async () => {
    const cases: [string, RegExp][] = [
      ["", /n, the number of lanes, is required/],
      ["n=0", /n must be a whole number from 1 to 64/],
      ["n=65", /n must be a whole number from 1 to 64/],
      ["n=8.5", /n must be a whole number/],
      ["n=abc", /n must be a whole number/],
      ["n=8&mode=warm", /mode must be one of "keyed", "hot"/],
      ["n=8&valueWei=-1", /valueWei must be a decimal string of wei/],
      ["n=8&valueWei=1.5", /valueWei must be a decimal string of wei/],
      ["n=8&to=0x12", /to must be an address/],
      ["n=8&expirySeconds=0", /expirySeconds must be a whole number from 1 to 86400/],
      ["n=8&mempool=alt", /unknown parameter mempool; allowed: n, mode, valueWei, to, expirySeconds/],
      ["n=8&n=9", /n is given more than once/],
    ];
    for (const [q, why] of cases) {
      const r = await h.req("GET", `/wallets/${a}/lanes/plan${q ? `?${q}` : ""}`);
      expect([q, r.status, r.body.error]).toEqual([q, 400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    expect((await plan({}, "0x000000000000000000000000000000000000dEaD")).body.error).toBe("unknown_wallet");
    expect((await h.req("GET", "/wallets/0x12/lanes/plan?n=1")).status).toBe(400);
    expect((await h.req("POST", `/wallets/${a}/lanes/plan?n=1`, {})).status).toBe(405);
    expect((await h.req("GET", `/wallets/${a}/lanes`)).status).toBe(404);
    expect((await h.req("GET", `/wallets/${a}/lanes/plan/more?n=1`)).status).toBe(404);
  });
});

describe("maxCostWei and wire on every record", () => {
  test("a landed lane: maxCostWei is the dry run's maxCost, wire the exact JSON sent; the txs list carries maxCostWei, no wire", async () => {
    const r = await send({ to: TARGET, valueWei: "1000" });
    const rec = await h.settle(r.body.txHash);
    const sent = h.chain.sent[0]!;
    expect(rec.wire).toEqual(toWire(sent) as unknown);
    expect(frameTxHash(fromWire(rec.wire))).toBe(r.body.txHash);
    expect(rec.maxCostWei).toBe(h.chain.maxCost(sent).toString()); // the fake's dry run answers maxCost this way
    const list = (await h.req("GET", `/wallets/${a}/txs`)).body;
    expect(list[0].maxCostWei).toBe(rec.maxCostWei);
    expect("wire" in list[0]).toBe(false);
    const stored = JSON.parse(fs.readFileSync(path.join(h.dirs.backendDir, "txs.json"), "utf8")).txs[0];
    expect([stored.maxCostWei, stored.wire]).toEqual([rec.maxCostWei, rec.wire]);
  });

  test("refused by the dry run: nothing was sent (wire null), maxCostWei from the dry run; refused at submission: the JSON was sent", async () => {
    const dry = await send({ to: TARGET, valueWei: (10n ** 30n).toString() }); // more than the wallet holds
    expect(dry.status).toBe(422);
    const dryRec = await tx(dry.body.txHash);
    expect([dryRec.status, dryRec.wire]).toEqual(["Refused", null]);
    expect(BigInt(dryRec.maxCostWei)).toBeGreaterThan(0n);
    h.chain.altRefusal = `Frame transaction nonce key 0x2 is already held by pending transaction 0x${"ab".repeat(32)}`;
    const sub = await send({ to: TARGET, valueWei: "1" });
    expect(sub.status).toBe(422);
    const subRec = await tx(sub.body.txHash);
    expect(subRec.status).toBe("Refused");
    expect(frameTxHash(fromWire(subRec.wire))).toBe(sub.body.txHash);
    expect(subRec.maxCostWei).toBe(laneCost(fromWire(subRec.wire)).gasCostWei.toString());
  });

  test("a retry: each attempt's record keeps its own JSON; the plan then says the expired one may still be counted", async () => {
    const r = await send({ to: TARGET, valueWei: "7", maxFeePerGasWei: "1", retries: 1, expirySeconds: 1 }); // below the fake's base fee
    const first = await h.settle(r.body.txHash, "Expired");
    await until(async () => !!(await tx(r.body.txHash)).retriedAs, 5_000, "the retry");
    const second = await h.settle((await tx(r.body.txHash)).retriedAs, "OnChain");
    const firstRec = await tx(first.txHash);
    expect(frameTxHash(fromWire(firstRec.wire))).toBe(firstRec.txHash);
    expect(frameTxHash(fromWire(second.wire))).toBe(second.txHash);
    expect(firstRec.wire.nonceKeys).not.toEqual(second.wire.nonceKeys);
    expect([firstRec.wire.fees.maxFeePerGas, firstRec.maxCostWei === second.maxCostWei]).toEqual(["0x1", false]);
    expect((await plan({ n: 1 })).body.warnings).toContain("1 lane(s) expired in the last 40 s: the sidecar may still count them against the balance until it drops them");
  });
});
