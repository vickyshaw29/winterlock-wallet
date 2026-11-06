// The screens against the real backend: the backend app in process on its own fake chain and test fakes
// (backend/test/helpers.ts, fake-chain.ts), listening on a random loopback port, with web/serve.ts in front of it on
// another, driven over real HTTP by the same API client and flow functions the pages import. Checks the shapes the
// pages read. Uses the real Rust CLI for tickets, as the backend's own ticket tests do. The stuck payment runs its
// real 4-second first deadline, which missShortDeadlines makes miss its block, as the devnet's 6-second blocks usually
// do.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "bun";
import { MARKET } from "../../backend/test/fake-chain.ts";
import { ETH, Harness, OTHER, TARGET, missShortDeadlines, requireCli } from "../../backend/test/helpers.ts";
import { ApiError, createApi, type Api } from "../public/api.js";
import * as flows from "../public/flows.js";
import { formatWei } from "../public/format.js";
import { laneRows, setAside, setAsideText } from "../public/lanes.js";
import * as scenes from "../public/scenes.js";
import { startWebServer, type WebServer } from "../serve.ts";

const loopbackFetch = globalThis.fetch; // the fake chain replaces globalThis.fetch while it is installed
setDefaultTimeout(30_000);
beforeAll(requireCli);

let h: Harness;
let backend: Server<undefined>;
let web: WebServer;
let api: Api;
const proxied: string[] = [];

/** serve.ts in front of the backend's current port, and the client the pages use through it */
function front() {
  web = startWebServer({ port: 0, backendUrl: `http://127.0.0.1:${backend.port}`, fetch: loopbackFetch, log: (l) => proxied.push(l) });
  api = createApi({ base: web.url, fetch: loopbackFetch });
}

beforeEach(async () => {
  h = await Harness.create({ config: { port: 0 } });
  backend = h.app.listen();
  proxied.length = 0;
  front();
});
afterEach(async () => {
  web.stop();
  await h.destroy();
});

/** POST /api/wallets as the start page sends it: height 5 has 16 cold leaves (0 to 15) and a hot band of 16 (16 to 31). */
async function wallet(form: Partial<Parameters<typeof flows.createWalletBody>[0]> = {}) {
  const created = await api.createWallet(flows.createWalletBody({ height: "5", valueCap: "0.01", allowedTarget: TARGET, ...form }));
  return created.address;
}

/** Polls GET /api/wallets/:address/txs through the proxy, as the lane board does, until pred holds. */
async function board(address: string, pred: (rows: ReturnType<typeof laneRows>) => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const rows = laneRows(await api.txs(address));
    if (pred(rows)) return rows;
    if (Date.now() > end) throw new Error(`the lane board never got there: ${JSON.stringify(rows.map((r) => [r.leaf, r.record.status]))}`);
    await Bun.sleep(10);
  }
}

const byHash = (rows: ReturnType<typeof laneRows>, hash: string) => {
  const r = rows.find((x) => x.hash === hash.toLowerCase());
  if (!r) throw new Error(`no row ${hash}`);
  return r;
};

/** The client a scene gets, recording each call it makes: the method, then a POST's body; and when it was made. */
function recording(inner: Api) {
  const calls: unknown[][] = [];
  const times: number[] = [];
  const api = new Proxy(inner, {
    get(t, k) {
      const f = (t as Record<string | symbol, unknown>)[k];
      if (typeof f !== "function") return f;
      return (...args: unknown[]) => { calls.push([k, ...args.slice(1)]); times.push(Date.now()); return f(...args); };
    },
  });
  return { api, calls, times };
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { if (e instanceof ApiError) return e; throw e; }
  throw new Error("expected the call to fail");
}

describe("pages and wallets", () => {
  test("every page is served with its CSP; a wallet created through the proxy has every field the pages read", async () => {
    for (const page of ["/", "/hot-cold.html", "/agent.html", "/session.html"]) {
      const res = await loopbackFetch(`${web.url}${page}`);
      expect([page, res.status, res.headers.get("content-type")]).toEqual([page, 200, "text/html; charset=utf-8"]);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = await res.text();
      for (const src of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
        expect([src[1], (await loopbackFetch(`${web.url}/${src[1]}`)).status]).toEqual([src[1], 200]);
      }
    }
    expect(await api.config()).toEqual({ backendUrl: `http://127.0.0.1:${backend.port}` });
    expect(await api.listWallets()).toEqual([]);

    const created = await api.createWallet(flows.createWalletBody({ height: "5", valueCap: "0.01", allowedTarget: TARGET }));
    expect(created).toEqual({ address: created.address, root: created.root, epoch: 0, funded: true });
    expect(await api.listWallets()).toEqual([{ address: created.address, epoch: 0, height: 5, balanceWei: "20000000000000000" }]);
    const w = await api.wallet(created.address);
    expect(w).toEqual({
      address: created.address, root: created.root, treeSeed: expect.stringMatching(/^0x[0-9a-f]{64}$/), height: 5, epoch: 0,
      leavesUsed: 0, leafCount: 32, lanesInFlight: 0, hybrid: false, locked: false, balanceWei: "20000000000000000",
      hotStart: 16, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
      tickets: { exported: 0, used: 0, left: 0 }, rotationPending: false,
      leaves: { onChain: [], burned: [], inFlight: [], tickets: null },
    });
    expect(flows.uncutHotLeaves(w)).toBe(16);
    expect(await api.txs(created.address)).toEqual([]);
    expect(proxied.some((l) => /^POST \/api\/wallets 200 \d+ ms$/.test(l))).toBe(true); // the proxy logs no body
    // GET /api/status in the backend's shape (the fake chain here answers as chain 1337, so fake is false)
    expect(await api.status()).toEqual({ chainId: 1337, head: expect.any(Number), headAgeSeconds: expect.any(Number), stalled: false, fake: false });
  });

  test("GET /api/status through the proxy: the status line's words, and stalled once the latest block is old", async () => {
    const s = (await api.status())!;
    const c = flows.readStatus(s)!;
    expect(c).toEqual({ chainId: 1337, head: s.head, ageSeconds: s.headAgeSeconds, stalled: false, fake: false });
    expect(flows.statusWords(c)).toEqual(["chain 1337", `latest block ${s.head}, ${s.headAgeSeconds} s ago`]);
    expect(flows.statusBanner(c)).toBeNull();
    h.chain.times.set(h.chain.head, BigInt(Math.floor(Date.now() / 1000)) - 125n); // the head is now two minutes old
    const old = flows.readStatus(await api.status())!;
    expect([old.head, old.stalled, old.ageSeconds! >= 125]).toEqual([s.head, true, true]);
    expect(flows.statusBanner(old)).toBe(`The chain looks stalled: latest block ${s.head}, 2 min ago. The backend refuses to sign until it moves, so sending is off.`);
  });

  test("the backend's errors arrive with their shape: 404 unknown wallet, 400 bad field", async () => {
    const missing = await rejection(api.wallet("0x000000000000000000000000000000000000dEaD"));
    expect([missing.status, missing.code]).toEqual([404, "unknown_wallet"]);
    const bad = await rejection(api.createWallet({ height: 99, spendLimitWei: "1" }));
    expect([bad.status, bad.code, bad.detail]).toEqual([400, "bad_request", "height must be a whole number from 2 to 12"]);
  });
});

describe("hot and cold", () => {
  test("cold: transfer on a keyed lane, set the hot policy, cut tickets; phone: pay on hot lanes within the cap", async () => {
    const a = await wallet();
    // Transfer from the cold device: a keyed lane on the first cold leaf (leaf 0 never signs at epoch 0)
    const keyed = await flows.send(api, a, flows.coldTransferBody({ to: OTHER, valueWei: 5_000n, mempool: "alt" }));
    expect(keyed).toEqual({ txHash: keyed.txHash, leaf: 1, nonceKeys: ["0x1"], nonceSeq: "0x0", status: "Submitted" });
    // Set policy, as the form sends it (ETH as typed)
    const policy = await flows.setPolicy(api, a, { hotStart: "16", valueCap: "0.005", feeCap: "0.002", allowedTarget: TARGET });
    expect(policy).toEqual({ txHash: policy.txHash, status: "Submitted" });
    let rows = await board(a, (rs) => rs.length === 2 && rs.every((r) => r.status.key === "included"));
    expect(byHash(rows, keyed.txHash)).toMatchObject({ lane: "0x1", leaf: 1, mode: "keyed", action: `pay 0x0000…0b00`, amount: "5,000 wei", gas: "60,000", mempool: "alt" });
    expect(byHash(rows, policy.txHash)).toMatchObject({ action: "set hot policy", mode: "keyed" });
    // the fake includes at once, so the sidecar never reports it pending: admitted, key used, included
    expect(byHash(rows, keyed.txHash).steps.map((s) => s.key)).toEqual(["admitted", "key", "included"]);
    expect(byHash(rows, keyed.txHash).record.admission?.summary).toBe("included: 2 of 2 rules passed");
    let w = await api.wallet(a);
    expect(w.hotValueCapWei).toBe("5000000000000000");

    // Cut tickets
    const cut = await flows.cutTickets(api, a, 3);
    expect(cut).toEqual({ from: 16, to: 18, count: 3 });
    w = await api.wallet(a);
    expect([w.tickets, flows.uncutHotLeaves(w)]).toEqual([{ exported: 3, used: 0, left: 3 }, 13]);

    // Pay: the cap is checked inline first, as the form does
    expect(flows.checkHotAmount("0.006", w)).toEqual({ ok: false, error: "above the hot value cap of 0.005 ETH; the account refuses it too" });
    const amount = flows.checkHotAmount("0.001", w);
    if (!amount.ok) throw new Error(amount.error);
    const pays = await Promise.all([1, 2].map(() => flows.send(api, a, flows.payBody({ wallet: w, valueWei: amount.wei, mempool: "alt" }))));
    expect(pays.map((p) => p.leaf).sort()).toEqual([16, 17]);
    expect(new Set(pays.map((p) => p.nonceKeys[0])).size).toBe(2); // two lanes, both pending at once
    rows = await board(a, (rs) => pays.every((p) => byHash(rs, p.txHash).status.key === "included"));
    for (const p of pays) {
      expect(byHash(rows, p.txHash)).toMatchObject({ mode: "hot", action: "hot ticket to 0x5544…16f9", amount: "0.001 ETH", pending: false, retryOf: null, retriedAs: null });
    }
    w = await api.wallet(a);
    expect([w.tickets, w.lanesInFlight]).toEqual([{ exported: 3, used: 2, left: 1 }, 0]);
    expect(h.chain.balance(TARGET)).toBe(2n * 10n ** 15n);
  });

  test("the stuck payment: its 4-second first deadline misses its block, its ticket is burned, and the retry lands on a fresh lane, linked both ways", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 2);
    const w = await api.wallet(a);
    missShortDeadlines(h.chain); // a deadline 6 s or less away misses its 6-second block, as it usually does on the devnet
    const body = flows.stuckBody({ wallet: w, valueWei: 7_000n, mempool: "alt" });
    expect(body).toEqual({ to: TARGET, valueWei: "7000", mode: "hot", mempool: "alt", firstAttemptExpirySeconds: 4, retries: 1 });
    const t0 = Math.floor(Date.now() / 1000);
    const sent = await flows.send(api, a, body); // exactly what the button sends
    expect(sent.leaf).toBe(16);
    let rows = await board(a, (rs) => rs.length === 2 && rs.some((r) => r.status.key === "included"), 20_000);
    const first = byHash(rows, sent.txHash);
    const retry = rows.find((r) => r.hash !== first.hash)!;
    expect(first).toMatchObject({ status: { key: "expired", label: "expired, leaf burned" }, leaf: 16, pending: false, retriedAs: retry.hash, retriedAsLane: retry.lane, retryOf: null });
    expect(retry).toMatchObject({ status: { key: "included" }, leaf: 17, retryOf: first.hash, retryOfLane: first.lane, retriedAs: null });
    expect(retry.lane).not.toBe(first.lane);
    expect(first.steps.map((s) => s.key)).toContain("expired");
    expect(first.steps.at(-1)?.key).toBe("retried");
    expect(first.reasons.join(" ")).toMatch(/expired/);
    expect(rows.indexOf(retry)).toBeLessThan(rows.indexOf(first)); // newest first
    // the first deadline 4 s out; the retry's the backend's normal 90 s from its own send; both at the market's fee
    expect(first.record.deadline! - t0).toBeGreaterThanOrEqual(4);
    expect(first.record.deadline! - t0).toBeLessThanOrEqual(5);
    expect(retry.record.deadline! - first.record.deadline!).toBeGreaterThanOrEqual(90);
    expect(h.chain.sent.map((t) => t.fees.maxFeePerGas >= MARKET.maxFeePerGas)).toEqual([true, true]); // never a low fee
    // GET /api/tx/:hash (the row's detail) agrees with the board
    expect(await api.tx(sent.txHash)).toMatchObject({ status: "Expired", retriedAs: retry.hash, mode: "hot", leaf: 16 });
    const after = await api.wallet(a);
    expect(after.tickets).toEqual({ exported: 2, used: 2, left: 0 });
    expect(h.chain.balance(TARGET)).toBe(7_000n); // paid once: the expired one never landed
    rows = laneRows(await api.txs(a));
    expect(setAside(await api.txs(a), after).lanes).toBe(0);
  });

  test("public mempool: one pending per sender, so the second payment is refused and its ticket burned", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 3);
    const w = await api.wallet(a);
    h.chain.autoInclude = false; // hold the first payment pending
    const one = await flows.send(api, a, flows.payBody({ wallet: w, valueWei: 1_000n, mempool: "public" }));
    let rows = laneRows(await api.txs(a));
    expect(byHash(rows, one.txHash)).toMatchObject({ status: { key: "admitted", label: "admitted" }, pending: true, mempool: "public" });
    // the set-aside line: the value plus the maximum cost the backend reports for the lane (maxCostWei, added to the
    // backend on Nov 6), else the hot fee cap for the pending ticket, an exact bound from the account's rules
    const records = await api.txs(a);
    const pending = setAside(records, w);
    const reported = records.find((r) => r.txHash === one.txHash.toLowerCase())?.maxCostWei;
    if (typeof reported === "string") {
      const cost = BigInt(reported);
      expect(pending).toEqual({ lanes: 1, valuesWei: 1_000n, reported: 1, maxCostWei: cost, feeBoundWei: 0n, totalWei: cost + 1_000n, unbounded: 0 });
      expect(setAsideText(pending)).toBe(`set aside for pending: ${formatWei(cost + 1_000n)} on 1 lane (its value plus the maximum cost the backend reports: what the sidecar sets aside)`);
    } else {
      expect(pending).toEqual({ lanes: 1, valuesWei: 1_000n, reported: 0, maxCostWei: 0n, feeBoundWei: 2n * 10n ** 15n, totalWei: 2n * 10n ** 15n + 1_000n, unbounded: 0 });
      expect(setAsideText(pending)).toBe("set aside for pending: 0.002 ETH on 1 lane (values, plus the hot fee cap for the ticket: an upper bound)"); // exact in the title
    }
    const two = await rejection(flows.send(api, a, flows.payBody({ wallet: w, valueWei: 1_000n, mempool: "public" })));
    expect([two.status, two.code]).toEqual([422, "refused"]);
    expect(flows.errorText(two)).toContain("one pending frame transaction per sender");
    rows = laneRows(await api.txs(a));
    const refused = byHash(rows, two.body.txHash);
    expect(refused).toMatchObject({ status: { key: "refused", label: "refused, leaf burned" }, leaf: 17, mempool: "public" });
    expect(refused.reasons.join(" ")).toContain("one pending frame transaction per sender");
    h.chain.mine();
    rows = await board(a, (rs) => byHash(rs, one.txHash).status.key === "included");
    expect((await api.wallet(a)).tickets).toEqual({ exported: 3, used: 2, left: 1 });
  });
});

describe("agent", () => {
  test("Fire: four tranches at once on four lanes, each at the value cap read from the wallet; all included", async () => {
    const a = await wallet();
    h.chain.credit(a, 1n * ETH);
    await flows.cutTickets(api, a, 6);
    const w = await api.wallet(a);
    const tranche = flows.trancheWei(w);
    expect(tranche).toBe(BigInt(w.hotValueCapWei));
    const results = await flows.fireTranches(api, w, { tranche: tranche!, mempool: "alt" });
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    const sent = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<Api["send"]>>>).value);
    expect(new Set(sent.map((s) => s.nonceKeys[0])).size).toBe(4);
    expect(sent.map((s) => s.leaf).sort((x, y) => x - y)).toEqual([16, 17, 18, 19]);
    const rows = await board(a, (rs) => rs.length === 4 && rs.every((r) => r.status.key === "included"));
    expect(rows.every((r) => r.amount === "0.01 ETH" && r.mode === "hot")).toBe(true);
    expect(h.chain.balance(TARGET)).toBe(4n * BigInt(w.hotValueCapWei));
    const after = await api.wallet(a);
    expect(flows.maxLossWei(after)).toBe(2n * (10n ** 16n + 2n * 10n ** 15n)); // 2 tickets left at cap plus fee cap
  });

  test("the tranche shrinks to what the balance covers, and is null when it covers none", () => {
    const w = { hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", balanceWei: "20000000000000000" };
    expect(flows.trancheWei(w)).toBe(3n * 10n ** 15n); // 0.02 / 4 - 0.002
    expect(flows.trancheWei({ ...w, balanceWei: "8000000000000000" })).toBeNull();
  });

  test("Server compromised: two payments outside the policy, both refused by the account: exceeds value cap, target not allowed", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 3);
    const w = await api.wallet(a);
    const sent = await flows.compromisedPayments(api, w, "alt");
    expect(sent.map((s) => [s.body.to.toLowerCase() === TARGET.toLowerCase(), s.body.valueWei])).toEqual([[true, "100000000000000000"], [false, "1000000000000000"]]);
    const errors = sent.map((s) => (s.result as PromiseRejectedResult).reason as ApiError);
    expect(errors.map((e) => [e.status, e.code])).toEqual([[422, "refused"], [422, "refused"]]);
    expect(errors[0]!.body.simulation.violations).toContain("account: hot: value cap");
    expect(errors[1]!.body.simulation.violations).toContain("account: hot: frame target");
    // the lane board: two refused rows, in the account's words, its reasons beside them
    const rows = laneRows(await api.txs(a));
    expect(rows.map((r) => [r.status.key, r.refusal?.words, r.refusal?.reason, r.amount]).sort()).toEqual([
      ["refused", "exceeds value cap", "account: hot: value cap", "0.1 ETH"],
      ["refused", "target not allowed", "account: hot: frame target", "0.001 ETH"],
    ]);
    expect(rows.map((r) => r.leaf).sort()).toEqual([16, 17]); // each burned its own ticket
    expect(h.chain.sent).toHaveLength(0); // refused in the dry run: nothing reached a mempool
    expect((await api.wallet(a)).tickets).toEqual({ exported: 3, used: 2, left: 1 });
  });

  test("the allowance's stub strip from the real view: the tranches used on chain, the compromised tickets burned, and the next ticket is the one the device signs next", async () => {
    const { allowanceCount } = await import("../public/agent.js");
    const { leafStates, nextTicket, stubsOf } = await import("../public/register.js");
    const a = await wallet();
    h.chain.credit(a, 1n * ETH);
    await flows.cutTickets(api, a, 8);
    let w = await api.wallet(a);
    await flows.fireTranches(api, w, { tranche: flows.trancheWei(w)!, mempool: "alt" });
    await flows.compromisedPayments(api, w, "alt");
    await board(a, (rs) => rs.length === 6 && rs.filter((r) => r.status.key === "included").length === 4);
    w = await api.wallet(a);
    const states = leafStates(w, await api.txs(a));
    expect(stubsOf(w, states).map((s) => [s.leaf, s.state, s.next])).toEqual([
      [16, "onchain", false], [17, "onchain", false], [18, "onchain", false], [19, "onchain", false],
      [20, "burned", false], [21, "burned", false], [22, "phone", true], [23, "phone", false],
    ]);
    expect(allowanceCount(w, false)).toEqual({ n: "2", of: " of 8", note: "tickets left of those cut; 6 used or burned" });
    // the serial the screen shows as next is the real one: the ticket device signs exactly that leaf
    const next = await flows.send(api, a, flows.payBody({ wallet: w, valueWei: 1000n, mempool: "alt" }));
    expect(next.leaf).toBe(nextTicket(w, states)!);
  });
});

describe("session", () => {
  test("Grant N tickets cuts what the hot band has; moves of 0 wei land on their own lanes until tickets_exhausted", async () => {
    const a = await wallet({ height: "4", hotStart: "12" }); // a hot band of 4: fewer than the 20 the dapp asks for
    let w = await api.wallet(a);
    const n = flows.grantCount(w);
    expect(n).toBe(4);
    expect(await flows.cutTickets(api, a, n)).toEqual({ from: 12, to: 15, count: 4 });
    w = await api.wallet(a);
    expect(flows.grantCount(w)).toBe(0);
    const moves = await Promise.all([1, 2, 3, 4].map(() => flows.send(api, a, flows.moveBody(w, "alt"))));
    expect(new Set(moves.map((m) => m.nonceKeys[0])).size).toBe(4);
    const rows = await board(a, (rs) => rs.length === 4 && rs.every((r) => r.status.key === "included"));
    expect(rows.every((r) => r.amount === "0 ETH" && r.action === "hot ticket to 0x5544…16f9")).toBe(true);
    expect(h.chain.sent.every((t) => t.frames.slice(2).every((f) => f.data === "0x" && f.value === 0n))).toBe(true);
    const fifth = await rejection(flows.send(api, a, flows.moveBody(w, "alt")));
    expect([fifth.status, fifth.code]).toEqual([409, "tickets_exhausted"]);
    expect((await api.wallet(a)).tickets).toEqual({ exported: 4, used: 4, left: 0 });
  });

  test("a move before any grant is 409 no_tickets", async () => {
    const a = await wallet();
    const e = await rejection(flows.send(api, a, flows.moveBody(await api.wallet(a), "alt")));
    expect([e.status, e.code]).toEqual([409, "no_tickets"]);
  });
});

describe("scenes (Play scene), through the proxy against the backend's fakes", () => {
  const at = { wallet: { allowedTarget: TARGET }, valueWei: 10n ** 15n };

  test("hot and cold: ten tickets, three alt payments (the stuck one's 4-second deadline misses its block, its retry lands on a fresh lane), three public", async () => {
    const a = await wallet();
    missShortDeadlines(h.chain); // the stuck payment's 4-second first deadline misses its block, as it usually does on the devnet
    h.chain.autoInclude = false; // the lanes stay pending, so the public pool's one-per-sender rule shows
    const { api: rec, calls } = recording(api);
    const steps: string[] = [], mempools: string[] = [], offline: boolean[] = [];
    const out = await scenes.hotColdScene(rec, a, {
      step: (t) => steps.push(t), offline: (on) => offline.push(on), mempool: (m) => mempools.push(m), sleep: async () => {},
    });
    expect(calls).toEqual([
      ["wallet"], ["tickets", { count: 10 }], ["wallet"],
      ["send", flows.payBody({ ...at, mempool: "alt" })], ["send", flows.payBody({ ...at, mempool: "alt" })],
      ["send", { to: TARGET, valueWei: "1000000000000000", mode: "hot", mempool: "alt", firstAttemptExpirySeconds: 4, retries: 1 }],
      ["send", flows.payBody({ ...at, mempool: "public" })], ["send", flows.payBody({ ...at, mempool: "public" })], ["send", flows.payBody({ ...at, mempool: "public" })],
    ]);
    expect(steps).toContain("the mempool switches to public (one pending per sender: not yet confirmed on the devnet); the phone pays three more times");
    expect(steps.find((t) => t.startsWith("3 parallel lanes pending at once: "))).toContain("the stuck one's first deadline is 4 s, shorter than one 6 s block");
    expect([offline, mempools]).toEqual([[false, true], ["alt", "public"]]); // online to cut, then offline to pay
    expect(out.alt.every((o) => o.answer !== null)).toBe(true);
    expect(out.public.map((o) => (o.answer ? "admitted" : (o.error as ApiError).status))).toEqual(["admitted", 422, 422]);
    expect(flows.errorText(out.public[1]!.error)).toContain("one pending frame transaction per sender");
    expect(steps.at(-1)).toBe("done. Public mempool: payment 1 admitted, payment 2 refused, payment 3 refused. The stuck lane's expiry and its retry show on the board.");
    // the chain moves on: the held lanes are included; the stuck lane expires and its retry lands on a fresh lane
    h.chain.autoInclude = true;
    h.chain.mine();
    const rows = await board(a, (rs) => rs.length === 7 && rs.filter((r) => r.status.key === "included").length === 4, 20_000);
    const stuck = rows.find((r) => r.retriedAs !== null)!;
    const retry = byHash(rows, stuck.retriedAs!);
    expect([stuck.status.key, stuck.mempool, retry.retryOf, retry.status.key]).toEqual(["expired", "alt", stuck.hash, "included"]);
    expect(retry.lane).not.toBe(stuck.lane);
    expect(rows.filter((r) => r.mempool === "public").map((r) => r.status.key).sort()).toEqual(["included", "refused", "refused"]);
    expect((await api.wallet(a)).tickets).toEqual({ exported: 10, used: 7, left: 3 });
  });

  test("agent: tickets, the rule's four tranches on four lanes, then the compromised server's two payments, refused", async () => {
    const a = await wallet();
    h.chain.credit(a, 1n * ETH); // so the tranches are the value cap
    const { api: rec, calls } = recording(api);
    const steps: string[] = [];
    let triggered = 0;
    const out = await scenes.agentScene(rec, a, { step: (t) => steps.push(t), trigger: () => { triggered++; }, sleep: async () => {} });
    const w = await api.wallet(a);
    const tranche = flows.payBody({ wallet: w, valueWei: BigInt(w.hotValueCapWei), mempool: "alt" });
    expect(calls.slice(0, 7)).toEqual([["wallet"], ["tickets", { count: 16 }], ["wallet"], ["send", tranche], ["send", tranche], ["send", tranche], ["send", tranche]]);
    expect(calls.slice(7)).toEqual([["send", flows.compromisedBodies(w, "alt")[0]], ["send", { ...flows.compromisedBodies(w, "alt")[1], to: (calls[8]![1] as { to: string }).to }]]);
    expect(triggered).toBe(1);
    expect(new Set(out.fired.map((r) => (r as PromiseFulfilledResult<{ nonceKeys: string[] }>).value.nonceKeys[0])).size).toBe(4);
    const rows = await board(a, (rs) => rs.length === 6 && rs.filter((r) => r.status.key === "included").length === 4);
    expect(rows.filter((r) => r.status.key === "refused").map((r) => r.refusal?.words).sort()).toEqual(["exceeds value cap", "target not allowed"]);
    expect(steps.at(-1)).toBe("done: the account refused 2 of the 2 compromised payments; a thief can spend only the tickets left, within the caps, to the allowed target");
    expect(w.tickets).toEqual({ exported: 16, used: 6, left: 10 });
  });

  test("session: a grant, then eight moves within two seconds, each its own lane, all included", async () => {
    const a = await wallet();
    const { api: rec, calls, times } = recording(api);
    const moved: number[] = [];
    const out = await scenes.sessionScene(rec, a, { mempool: "alt", step: () => {}, moved: (k) => { moved.push(k); } });
    expect(calls).toEqual([["wallet"], ["tickets", { count: 16 }], ["wallet"], ...Array(8).fill(["send", flows.moveBody({ allowedTarget: TARGET }, "alt")])]);
    const sends = times.slice(3);
    expect(sends.at(-1)! - sends[0]!).toBeLessThan(2_000);
    expect(sends.at(-1)! - sends[0]!).toBeGreaterThanOrEqual(7 * 240);
    expect([out.moves.every((o) => o.answer !== null), moved.sort((x, y) => x - y)]).toEqual([true, [0, 1, 2, 3, 4, 5, 6, 7]]);
    const rows = await board(a, (rs) => rs.length === 8 && rs.every((r) => r.status.key === "included"));
    expect(new Set(rows.map((r) => r.lane)).size).toBe(8);
  });

  test("session on the public mempool: one move pending, seven refused; that is what the scene shows, not a stop", async () => {
    const a = await wallet();
    h.chain.autoInclude = false;
    const out = await scenes.sessionScene(api, a, { mempool: "public", step: () => {}, sleep: async () => {} });
    expect(out.moves.map((o) => (o.answer ? "admitted" : (o.error as ApiError).status)).sort()).toEqual(["admitted", ...Array(7).fill(422)].sort());
    h.chain.mine();
    const rows = await board(a, (rs) => rs.length === 8 && rs.some((r) => r.status.key === "included"));
    expect(rows.filter((r) => r.status.key === "refused")).toHaveLength(7);
  });

  test("a scene stops cleanly: tickets_exhausted (409) ends the moves; a stalled chain (503) before anything is signed", async () => {
    const a = await wallet({ height: "4", hotStart: "12" }); // a hot band of 4 tickets
    let stopAt: number | null = null;
    const { api: rec, calls, times } = recording(api);
    const e = await rejection(scenes.sessionScene(rec, a, { mempool: "alt", step: () => {}, moved: (_k, o) => { if (o.error) stopAt ??= Date.now(); } }));
    expect([e.status, e.code]).toEqual([409, "tickets_exhausted"]);
    const sendTimes = times.filter((_t, i) => calls[i]![0] === "send");
    expect(sendTimes.length).toBeGreaterThanOrEqual(5);
    expect(sendTimes.every((t) => t <= stopAt!)).toBe(true); // no move started after the refusal came back
    expect((await api.wallet(a)).tickets).toEqual({ exported: 4, used: 4, left: 0 });

    const b = await wallet();
    const sentBefore = h.chain.sent.length;
    h.chain.halted = true;
    const stalled = await rejection(scenes.agentScene(api, b, { step: () => {}, sleep: async () => {} }));
    expect([stalled.status, stalled.code]).toEqual([503, "chain_stalled"]);
    expect(flows.stalledBanner(stalled)).toContain("Nothing was spent");
    expect(h.chain.sent).toHaveLength(sentBefore);
    expect((await api.wallet(b)).tickets.used).toBe(0);
  });
});

describe("the ticket device's journal lost", () => {
  test("after a restart without it: the view counts the tickets unjournaled, a hot send and a cut are both 409 device_unusable in the cards' words, no scene cuts", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 3);
    // the backend stops, the device journal goes, the backend starts again (and serve.ts in front of its new port)
    const journal = path.join(h.deviceDir(a), "journal-epoch0.json");
    await h.close();
    fs.rmSync(journal);
    h.open();
    backend = h.app.listen();
    web.stop();
    front();
    const w = await api.wallet(a);
    expect(w.tickets).toEqual({ exported: 3, used: 0, left: 0, unjournaled: 3 });
    const words = "3 tickets were cut but are missing from the device journal: recover it";
    expect(flows.deviceIssue(w)).toEqual({ count: 3, text: words });
    const pay = await rejection(flows.send(api, a, flows.payBody({ wallet: w, valueWei: 1_000n, mempool: "alt" })));
    expect([pay.status, pay.code, flows.deviceIssueOf(pay)]).toEqual([409, "device_unusable", { count: 3, text: words }]);
    expect(pay.detail).toContain(`recover ${journal}`);
    const cut = await rejection(flows.cutTickets(api, a, 1));
    expect([cut.status, cut.code, flows.deviceIssueOf(cut)]).toEqual([409, "device_unusable", { count: 3, text: words }]);
    // each Play scene stops on the view, before it cuts, sends or grants
    const quiet = { step: () => {}, sleep: async () => {} };
    for (const play of [
      (x: Api) => scenes.hotColdScene(x, a, quiet), (x: Api) => scenes.agentScene(x, a, quiet), (x: Api) => scenes.sessionScene(x, a, { ...quiet, mempool: "alt" }),
    ]) {
      const { api: rec, calls } = recording(api);
      const e = await play(rec).then(() => null, (x: unknown) => x);
      expect([e instanceof Error ? e.message : e, calls]).toEqual([words, [["wallet"]]]);
    }
    expect([fs.existsSync(journal), h.chain.sent.length]).toEqual([false, 0]); // never recreated; nothing signed
  });
});

describe("the parallel-lanes plan", () => {
  test("GET /api/wallets/:address/lanes/plan through the proxy: null while the backend has no route, else the documented shape", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 4);
    const w = await api.wallet(a);
    const raw = await api.lanesPlan(a, { n: 4, mode: "hot", valueWei: String(flows.trancheWei(w) ?? 0n), to: w.allowedTarget });
    if (raw === null) {
      expect(flows.readPlan(raw)).toBeNull(); // the screens say: not offered by this backend
      expect(proxied.some((l) => /^GET \/api\/wallets\/0x[0-9a-fA-F]{40}\/lanes\/plan 404 \d+ ms$/.test(l))).toBe(true);
    } else {
      const p = flows.readPlan(raw)!; // first: bun's toMatchObject writes its matchers into the object it is given
      expect(structuredClone(raw)).toMatchObject({
        affordable: expect.any(Boolean), setAsideWei: expect.stringMatching(/^\d+$/), shortfallWei: expect.stringMatching(/^\d+$/),
        passes: expect.any(Number), etaSeconds: expect.any(Number), warnings: expect.any(Array),
      });
      expect([typeof p.affordable, typeof p.setAsideWei, typeof p.shortfallWei, typeof p.passes, typeof p.etaSeconds]).toEqual(["boolean", "bigint", "bigint", "number", "number"]);
      expect(p.warnings.every((x) => typeof x === "string")).toBe(true);
      expect(flows.planWords(p, 4, w.balanceWei).line).toMatch(/^4 lanes: \d+ relay pass(es)?, about \d+ s; set aside \S+ (ETH|wei) of balance \S+ (ETH|wei)/);
    }
  });

  test("the real backend's warnings, in the screens' words: no path, status or code reaches the screen", async () => {
    const a = await wallet();
    const w = await api.wallet(a);
    // before any cut, a hot plan of 4 lanes to another target, above the value cap: the backend's own warnings
    const raw = await api.lanesPlan(a, { n: 4, mode: "hot", valueWei: (2n * 10n ** 16n).toString(), to: OTHER });
    const backendWords = raw!.warnings as string[];
    expect(backendWords).toContain(`only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${a}/tickets`);
    const screen = flows.planWords(flows.readPlan(raw)!, 4, w.balanceWei).warnings;
    expect(screen).toEqual([
      "The mempool's relay settings could not be read, so the plan assumes its defaults: 4 lanes per relay pass, one pass every 10 s.",
      "No tickets left on the phone: cut some on the cold device.",
      "Each lane sends 0.02 ETH, above the hot value cap of 0.01 ETH: the account would refuse it.",
      `Tickets may pay only the allowed target 0x5544…16f9: the account would refuse ${OTHER.slice(0, 6)}…${OTHER.slice(-4)}.`,
    ]);
    for (const text of screen) expect([text, /\/api\/|\b(?:GET|POST)\b|\(\d{3}\b|\b[a-z]+_[a-z_]+\b|\("hot:/.test(text)]).toEqual([text, false]);
    // a keyed plan larger than the band: the cold leaves' warning, in words
    const keyed = flows.readPlan(await api.lanesPlan(a, { n: 64, mode: "keyed", valueWei: "1", to: TARGET }))!;
    expect(flows.planWords(keyed, 64, w.balanceWei).warnings).toContain("Only 11 cold leaves are left for lanes (4 more are kept for the kill switch and a rotation): only the first 11 lanes would be sent.");
  });
});

describe("the stalled chain and the proxy's guards", () => {
  test("503 chain_stalled raises the banner; nothing is spent; the board still reads", async () => {
    const a = await wallet();
    await flows.cutTickets(api, a, 2);
    const w = await api.wallet(a);
    h.chain.halted = true;
    const e = await rejection(flows.send(api, a, flows.payBody({ wallet: w, valueWei: 1n, mempool: "alt" })));
    expect([e.status, e.code]).toEqual([503, "chain_stalled"]);
    expect(flows.stalledBanner(e)).toMatch(/^The chain looks stalled: the backend refuses to sign \(the latest block's timestamp \d+ is \d+ s from the host clock/);
    expect(flows.stalledBanner(new ApiError(422, "refused", "x", {}))).toBeNull();
    const cold = await rejection(flows.setPolicy(api, a, { hotStart: "16", valueCap: "0", feeCap: "0.002", allowedTarget: TARGET }));
    expect(cold.status).toBe(503);
    expect((await api.wallet(a)).tickets).toEqual({ exported: 2, used: 0, left: 2 });
    expect(h.chain.sent).toHaveLength(0);
    expect(await api.txs(a)).toEqual([]);
  });

  test("a page on another origin cannot drive the backend through the proxy; the page's own origin can", async () => {
    const a = await wallet();
    const before = h.logs.filter((l) => l.startsWith("POST ")).length;
    const post = (origin: string) => loopbackFetch(`${web.url}/api/wallets/${a}/send`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ to: TARGET, valueWei: "1" }),
    });
    const cross = await post("https://attacker.example");
    expect([cross.status, ((await cross.json()) as { error: string }).error]).toEqual([403, "forbidden"]);
    expect(h.logs.filter((l) => l.startsWith("POST ")).length).toBe(before); // never reached the backend
    expect(h.chain.sent).toHaveLength(0);
    // the page's own origin: the proxy drops Origin, so the backend sees a local caller and sends
    const same = await post(web.url);
    expect(same.status).toBe(200);
    expect(((await same.json()) as { leaf: number }).leaf).toBe(1);
  });

  test("502 backend_unreachable when the backend is down, in the spec's error shape", async () => {
    const port = backend.port;
    await h.close();
    const e = await rejection(api.listWallets());
    expect([e.status, e.code]).toEqual([502, "backend_unreachable"]);
    expect(e.detail).toContain(`the backend at http://127.0.0.1:${port} did not answer`);
    h.open(); // destroy() closes it again
  });
});
