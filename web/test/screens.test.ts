// The three page scripts run for real on a fake document parsed from their own HTML (test/fake-dom.ts), against a
// fake API that records every call that sends: each button sends exactly what flows.js builds from what the page
// shows; a 503 from any send (Pay, Fire, Server compromised, a move) raises the stalled banner and turns every sending
// fieldset off, after which a click sends nothing; the status line reads GET /api/status; Play scene runs its scene;
// tickets cut but missing from the device journal (tickets.unjournaled, 409 device_unusable) are on every card and
// no cut is offered; the parallel-lanes plan shows before Fire and Grant; the lane limits are in the spec's words.
// Written with Claude Code (AI) for Vicky.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { start as startAgent } from "../public/agent.js";
import { ApiError, type Api, type SendBody, type WalletView } from "../public/api.js";
import * as flows from "../public/flows.js";
import { start as startHotCold } from "../public/hot-cold.js";
import { start as startSession } from "../public/session.js";
import { PLAN_EVERY_MS, applyReviewAids } from "../public/ui.js";
import { FakeButton, FakeDocument, FakeEvent, FakeFieldSet, FakeInput, installDom, parsePage, type FakeElement } from "./fake-dom.ts";
import { H } from "./records.ts";

const PUBLIC = path.resolve(import.meta.dir, "../public");
const A = "0x00000000000000000000000000000000000ACC01";
const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
const OTHER = "0x00000000000000000000000000000000000B0B00";
const FAKE_STATUS = { chainId: 31337, head: 1002, headAgeSeconds: 4, stalled: false, fake: true };
const stalled = () => new ApiError(503, "chain_stalled", "the latest block's timestamp 1762400000 is 120 s from the host clock", {});
const refused = (reason: string, leaf: number) => new ApiError(422, "refused", "preflight refused: the account's verify frame reverted", {
  txHash: H(500 + leaf), leaf, simulation: { verifyGas: null, violations: ["VERIFY frame 1 reverted", `account: ${reason}`] },
});
/** the backend's 409 for tickets cut whose device journal is missing (backend.ts, unjournaled) */
const lostJournal = (n: number) => new ApiError(409, "device_unusable", `${n} ticket(s) of epoch 0 were cut for ${A} (${n} exported in the cold journal, ` +
  `1 ticket file(s) in /tmp/wl/devices/${A.toLowerCase()}/tickets), but the device journal is missing: recover /tmp/wl/devices/${A.toLowerCase()}/journal-epoch0.json; a new journal would re-sign used tickets`, {});
const LOST3 = "3 tickets were cut but are missing from the device journal: recover it";
const UNJOURNALED = { exported: 3, used: 0, left: 0, unjournaled: 3 };
/** a warning as the backend writes it (pipeline lanes.ts planLanes), and as the screens say it */
const UNREAD = "the sidecar's relay settings were not read (skandha_config: no response: connection refused): assumed its defaults, 4 lanes per pass every 10 s";
const UNREAD_WORDS = "The mempool's relay settings could not be read, so the plan assumes its defaults: 4 lanes per relay pass, one pass every 10 s.";
const PLAN = { affordable: true, setAsideWei: "48000000000000000", shortfallWei: "0", passes: 1, etaSeconds: 28, warnings: [UNREAD] };

function view(over: Partial<WalletView> = {}): WalletView {
  return {
    address: A, root: H(7), treeSeed: H(8), height: 5, epoch: 0, leavesUsed: 1, leafCount: 32, lanesInFlight: 0, hybrid: false, locked: false,
    balanceWei: "1000000000000000000", hotStart: 16, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
    tickets: { exported: 0, used: 0, left: 0 }, rotationPending: false, ...over,
  };
}

/**
 * The API the pages call, recording what sends; `next` holds the next answers of send, in order (null: admitted), and
 * `cutNext` those of a cut; `plans` what GET .../lanes/plan answers (default null: a backend without the route) and the
 * queries it was asked; `walletFault.error` makes GET /wallets/:address fail with it, and `walletFault.gate` holds its
 * answer back until the promise settles.
 */
function fakeApi(w: WalletView, status: Record<string, unknown> | null) {
  const calls: [string, ...unknown[]][] = [];
  const times: number[] = [];
  const next: (((body: unknown) => unknown) | null)[] = [];
  const cutNext: ((body: unknown) => unknown)[] = [];
  const plans = { answer: (): unknown => null, asked: [] as unknown[] };
  const walletFault = { error: null as ApiError | null, gate: null as Promise<void> | null };
  let leaf = 16;
  const record = (...c: [string, ...unknown[]]) => { calls.push(c); times.push(Date.now()); };
  const api = {
    base: "",
    listWallets: async () => [{ address: w.address, epoch: w.epoch, height: w.height, balanceWei: w.balanceWei }],
    wallet: async () => {
      if (walletFault.gate) await walletFault.gate;
      if (walletFault.error) throw walletFault.error;
      return structuredClone(w);
    },
    lanesPlan: async (_a: string, q: unknown) => { plans.asked.push(q); return plans.answer(); },
    txs: async () => [],
    tx: async () => { throw new ApiError(404, "unknown_tx", "no such transaction", {}); },
    status: async () => status,
    config: async () => ({ backendUrl: "http://127.0.0.1:8787" }),
    createWallet: async (b: unknown) => { record("createWallet", b); throw new Error("not in these tests"); },
    send: async (a: string, body: unknown) => {
      record("send", a, body);
      const answer = next.shift();
      if (answer) return answer(body);
      const l = leaf++;
      return { txHash: H(l), leaf: l, nonceKeys: [`0x${l.toString(16)}`], nonceSeq: "0x0", status: "Submitted" };
    },
    tickets: async (a: string, b: { count: number }) => {
      record("tickets", a, b);
      const answer = cutNext.shift();
      if (answer) return answer(b);
      const from = w.hotStart + w.tickets.exported;
      w.tickets = { exported: w.tickets.exported + b.count, used: w.tickets.used, left: w.tickets.left + b.count };
      return { from, to: from + b.count - 1, count: b.count };
    },
    hotPolicy: async (a: string, b: unknown) => { record("hotPolicy", a, b); return { txHash: H(900), status: "Submitted" }; },
    rotate: async (a: string, b: unknown) => { record("rotate", a, b); return { txHash: H(901), newRoot: H(902), epoch: 1 }; },
  };
  return { api: api as unknown as Api, calls, times, next, cutNext, plans, walletFault };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; setSystemTime(); }); // a test may move the clock (the plan's 30 s)

const STARTS = { "hot-cold": startHotCold, agent: startAgent, session: startSession };

/**
 * Opens a screen as the browser does, on its own HTML, with ?wallet= and the fake API; no polling. `setup` sets the
 * fake up before the page mounts (say, what the plan answers).
 */
async function open(page: keyof typeof STARTS, w = view(), status: Record<string, unknown> | null = FAKE_STATUS, setup?: (f: ReturnType<typeof fakeApi>) => void) {
  cleanup?.();
  const doc: FakeDocument = parsePage(fs.readFileSync(path.join(PUBLIC, `${page}.html`), "utf8"));
  const restore = installDom(doc, `?wallet=${A}`);
  const fake = fakeApi(w, status);
  setup?.(fake);
  const mounted = await STARTS[page]({ api: fake.api, poll: false });
  cleanup = () => { mounted?.stop(); restore(); };
  if (!mounted) throw new Error(`${page} did not mount`);
  await doc.settle();
  const $ = (id: string): FakeElement => { const e = doc.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; };
  const btn = (id: string) => $(id) as FakeButton;
  const field = (id: string) => $(id) as FakeInput;
  /** a click and everything it started */
  const click = async (e: FakeElement) => { e.click(); await doc.settle(); };
  const sendingOff = () => doc.querySelectorAll("fieldset[data-sends]").map((f) => (f as FakeFieldSet).disabled);
  /** a poll: the wallet view and the lane board read again, and everything that follows */
  const refresh = async () => { await mounted.screen.refresh(); await doc.settle(); };
  return { doc, ...fake, w, $, btn, field, click, refresh, sendingOff, sends: () => fake.calls.filter((c) => c[0] === "send").map((c) => c[2]) };
}

describe("hot and cold", () => {
  test("Pay, the stuck payment, the cold transfer, Set policy, Cut tickets and Rotate send what flows.js builds", async () => {
    const w = view({ tickets: { exported: 10, used: 0, left: 10 } });
    const s = await open("hot-cold", w);
    expect([s.$("ticket-count").text, s.field("pay-to").value, s.field("pay-amount").value]).toEqual(["10 of 10", TARGET, "0.001"]);
    await s.click(s.btn("pay"));
    expect(s.calls).toEqual([["send", A, flows.payBody({ wallet: w, valueWei: 10n ** 15n, mempool: "alt" })]]);

    // the cap inline: over it, Pay and the stuck payment are off and the page says why
    s.field("pay-amount").enter("0.02");
    expect([s.btn("pay").disabled, s.btn("stuck").disabled, s.$("pay-problem").text]).toEqual([true, true, "above the hot value cap of 0.01 ETH; the account refuses it too"]);
    await s.click(s.btn("pay"));
    expect(s.calls).toHaveLength(1);

    // the Mempool switch goes into the body; the stuck payment is a 4-second first deadline and one retry, no fee field
    s.field("pay-amount").enter("0.005");
    await s.click(s.doc.querySelector('input[name="mempool"][value="public"]')!);
    await s.click(s.btn("stuck"));
    expect(s.calls.at(-1)).toEqual(["send", A, { to: TARGET, valueWei: "5000000000000000", mode: "hot", mempool: "public", firstAttemptExpirySeconds: 4, retries: 1 }]);
    expect(s.calls.at(-1)).toEqual(["send", A, flows.stuckBody({ wallet: w, valueWei: 5n * 10n ** 15n, mempool: "public" })]);
    expect(s.$("notice").text).toContain("Stuck payment on lane 0x11 (ticket 17): its first deadline is 4 s, shorter than one 6 s block, so it should miss its block and expire, its ticket burned; then one retry goes out on a fresh lane with the normal deadline.");

    s.field("transfer-to").enter(OTHER);
    s.field("transfer-amount").enter("1.5");
    await s.click(s.btn("transfer"));
    expect(s.calls.at(-1)).toEqual(["send", A, flows.coldTransferBody({ to: OTHER, valueWei: 15n * 10n ** 17n, mempool: "public" })]);

    // Set policy: the form starts from the wallet's policy
    expect([s.field("policy-value").value, s.field("policy-fee").value, s.field("policy-target").value, s.field("policy-start").value]).toEqual(["0.01", "0.002", TARGET, "16"]);
    s.field("policy-value").enter("0.02");
    await s.click(s.btn("policy-set"));
    expect(s.calls.at(-1)).toEqual(["hotPolicy", A, { hotStart: 16, valueCapWei: "20000000000000000", feeCapWei: "2000000000000000", allowedTarget: TARGET }]);

    // Cut tickets: the count starts at what the hot band has uncut (32 - 16 - 10 = 6)
    expect([s.field("cut-count").value, s.$("cut-left").text]).toEqual(["6", "6 hot leaves not cut yet; 10 cut this epoch. Each ticket is one leaf's secrets and path, no seed."]);
    await s.click(s.btn("cut"));
    expect(s.calls.at(-1)).toEqual(["tickets", A, { count: 6 }]);

    // Rotate root: the first click arms it, under the warning; the second sends
    const before = s.calls.length;
    await s.click(s.btn("rotate"));
    expect([s.calls.length, s.btn("rotate").text]).toEqual([before, "Confirm: rotate root"]);
    await s.click(s.btn("rotate"));
    expect(s.calls.at(-1)).toEqual(["rotate", A, { height: 5 }]);
  });

  test("Offline greys the cold pane and turns its controls off; the phone still pays", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    await s.click(s.field("offline"));
    expect([(s.$("cold-fields") as FakeFieldSet).disabled, s.$("cold-pane").classList.contains("offline")]).toEqual([true, true]);
    await s.click(s.btn("cut"));
    await s.click(s.btn("policy-set"));
    expect(s.calls).toEqual([]);
    await s.click(s.btn("pay"));
    expect(s.calls.map((c) => c[0])).toEqual(["send"]);
  });

  test("a 503 raises the stalled banner and turns every sending fieldset off; then nothing is sent; Try again clears it", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    expect([s.$("banner").hidden, s.sendingOff()]).toEqual([true, [false, false, false]]);
    s.next.push(() => { throw stalled(); });
    await s.click(s.btn("pay"));
    expect(s.$("banner").hidden).toBe(false);
    expect(s.$("banner-text").text).toBe("The chain looks stalled: the backend refuses to sign (the latest block's timestamp 1762400000 is 120 s from the host clock). Nothing was spent. Sending is off until the chain moves.");
    expect(s.sendingOff()).toEqual([true, true, true]);
    const n = s.calls.length;
    for (const id of ["pay", "stuck", "play", "cut", "transfer"]) await s.click(s.btn(id));
    expect(s.calls).toHaveLength(n);
    await s.click(s.btn("banner-retry"));
    expect([s.$("banner").hidden, s.sendingOff()]).toEqual([true, [false, false, false]]);
  });

  test("Play scene: cuts ten tickets, goes offline, pays three times on alt (the third stuck), then three times on public", async () => {
    const w = view();
    const s = await open("hot-cold", w);
    s.next.push(null, null, null, null, () => { throw refused("public", 0); }, () => { throw refused("public", 0); });
    await s.click(s.btn("play"));
    const at = { wallet: { allowedTarget: TARGET }, valueWei: 10n ** 15n };
    expect(s.calls).toEqual([
      ["tickets", A, { count: 10 }],
      ["send", A, flows.payBody({ ...at, mempool: "alt" })], ["send", A, flows.payBody({ ...at, mempool: "alt" })], ["send", A, flows.stuckBody({ ...at, mempool: "alt" })],
      ["send", A, flows.payBody({ ...at, mempool: "public" })], ["send", A, flows.payBody({ ...at, mempool: "public" })], ["send", A, flows.payBody({ ...at, mempool: "public" })],
    ]);
    expect([s.field("offline").checked, (s.$("cold-fields") as FakeFieldSet).disabled]).toEqual([true, true]);
    expect((s.doc.querySelector('input[name="mempool"][value="public"]') as FakeInput).checked).toBe(true);
    expect(s.$("notice").text).toContain("Scene: done. Public mempool: payment 1 admitted, payment 2 refused, payment 3 refused.");
  });

  test("Play scene stops cleanly at an answer it does not expect: a 422 on the alt mempool sends nothing more", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    s.next.push(() => { throw refused("hot: value cap", 16); });
    await s.click(s.btn("play"));
    expect(s.sends()).toHaveLength(3);
    expect(s.$("notice").text).toContain("Scene stopped: refused (422): preflight refused: the account's verify frame reverted: VERIFY frame 1 reverted; account: hot: value cap");
  });

  test("Play scene stops cleanly at a 409 and says where", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    s.next.push(null, () => { throw new ApiError(409, "tickets_exhausted", "no ticket left", {}); });
    await s.click(s.btn("play"));
    expect(s.sends()).toHaveLength(3); // the three alt payments went out together; nothing after the stop
    expect(s.$("notice").text).toContain("Scene stopped: tickets_exhausted (409): no ticket left");
    expect(s.$("banner").hidden).toBe(true);
  });

  test("the status line: chain, latest block N, X s ago, the Fake chain band; a stalled status raises the banner; a 404 says so", async () => {
    let s = await open("hot-cold");
    const parts = () => s.$("status").children.map((c) => c.text);
    expect(parts()).toEqual(["backend http://127.0.0.1:8787", "chain 31337", "latest block 1002, 4 s ago", "Fake chain"]);
    expect(s.$("status").querySelector("strong.badge-fake")!.text).toBe("Fake chain");
    s = await open("hot-cold", view(), { chainId: 1337, head: 408_262, headAgeSeconds: 120, stalled: true, fake: false });
    expect(parts()).toEqual(["backend http://127.0.0.1:8787", "chain 1337", "latest block 408262, 2 min ago"]);
    expect([s.$("banner").hidden, s.$("banner-text").text]).toEqual([false, "The chain looks stalled: latest block 408262, 2 min ago. The backend refuses to sign until it moves, so sending is off."]);
    expect(s.sendingOff()).toEqual([true, true, true]);
    s = await open("hot-cold", view(), null);
    expect(parts()).toEqual(["backend http://127.0.0.1:8787", "chain status: not offered by this backend"]); // no API path on screen
  });
});

describe("agent", () => {
  test("Fire sends the four tranches trancheWei gives; Server compromised sends the two payments and logs the account's words", async () => {
    const w = view({ tickets: { exported: 10, used: 0, left: 10 } });
    const s = await open("agent", w);
    await s.click(s.btn("fire"));
    const tranche = flows.payBody({ wallet: w, valueWei: flows.trancheWei(w)!, mempool: "alt" });
    expect(s.calls).toEqual([["send", A, tranche], ["send", A, tranche], ["send", A, tranche], ["send", A, tranche]]);

    s.next.push(() => { throw refused("hot: value cap", 20); }, () => { throw refused("hot: frame target", 21); });
    await s.click(s.btn("compromised"));
    const [over, elsewhere] = s.sends().slice(4) as SendBody[];
    expect(over).toEqual(flows.compromisedBodies(w, "alt")[0]);
    expect(elsewhere).toEqual({ ...flows.compromisedBodies(w, "alt", elsewhere!.to)[1], to: elsewhere!.to });
    expect(elsewhere!.to.toLowerCase()).not.toBe(TARGET.toLowerCase());
    const log = s.$("log").text;
    expect(log).toContain("Compromised payment of 0.1 ETH to the allowed target: refused by the account, exceeds value cap (account: hot: value cap); ticket 20 burned.");
    expect(log).toContain("a new address: refused by the account, target not allowed (account: hot: frame target); ticket 21 burned.");
    expect(s.$("notice").text).toContain("Server compromised: exceeds value cap; target not allowed.");
  });

  test("the armed rule fires the four tranches once the mock price drops 3 %, through the same path as Fire", async () => {
    const w = view({ tickets: { exported: 10, used: 0, left: 10 } });
    const s = await open("agent", w);
    await s.click(s.field("armed"));
    await s.click(s.btn("drop"));
    await Bun.sleep(700); // the mock market ticks every 500 ms; the rule is checked on each tick
    await s.doc.settle();
    expect(s.sends()).toEqual(Array(4).fill(flows.payBody({ wallet: w, valueWei: flows.trancheWei(w)!, mempool: "alt" })));
    expect([s.field("armed").checked, s.$("log").text]).toEqual([false, expect.stringContaining("Rule fired: the mock price fell more than 2 % in 30 s.")]);
  });

  test("a 503 among the tranches or the compromised payments raises the banner; then Fire sends nothing", async () => {
    const s = await open("agent", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    s.next.push(null, () => { throw stalled(); }, null, null);
    await s.click(s.btn("fire"));
    expect([s.$("banner").hidden, s.sendingOff()]).toEqual([false, [true, true, true]]);
    await s.click(s.btn("fire"));
    await s.click(s.btn("compromised"));
    expect(s.sends()).toHaveLength(4);

    const t = await open("agent", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    t.next.push(() => { throw refused("hot: value cap", 16); }, () => { throw stalled(); });
    await t.click(t.btn("compromised"));
    expect([t.$("banner").hidden, t.sendingOff()]).toEqual([false, [true, true, true]]);
  });

  test("Play scene: tickets for the agent, the rule fires four tranches, then the server is compromised", async () => {
    const w = view();
    const s = await open("agent", w);
    s.next.push(null, null, null, null, () => { throw refused("hot: value cap", 20); }, () => { throw refused("hot: frame target", 21); });
    await s.click(s.btn("play"));
    const funded = { ...w, tickets: { exported: 16, used: 0, left: 16 } };
    const tranche = flows.payBody({ wallet: funded, valueWei: flows.trancheWei(funded)!, mempool: "alt" });
    expect(s.calls.slice(0, 5)).toEqual([["tickets", A, { count: 16 }], ["send", A, tranche], ["send", A, tranche], ["send", A, tranche], ["send", A, tranche]]);
    expect(s.sends().slice(4)).toMatchObject([flows.compromisedBodies(w, "alt")[0], { mode: "hot", mempool: "alt", valueWei: "1000000000000000" }]);
    expect(s.$("log").text).toContain("Rule fired: the mock price fell more than 2 % in 30 s.");
    expect(s.$("notice").text).toContain("Scene: done: the account refused 2 of the 2 compromised payments");
  });
});

describe("session", () => {
  test("Grant cuts what grantCount says; a cell sends moveBody; tickets running out is shown in plain words", async () => {
    const w = view();
    const s = await open("session", w);
    expect(s.btn("grant").text).toBe("Grant 16 tickets");
    await s.click(s.btn("grant"));
    expect(s.calls).toEqual([["tickets", A, { count: flows.grantCount(view()) }]]);
    const cells = s.doc.querySelectorAll("button.cell") as FakeButton[];
    await s.click(cells[0]!);
    expect(s.calls.at(-1)).toEqual(["send", A, flows.moveBody(w, "alt")]);
    expect([cells[0]!.getAttribute("data-state"), s.$("moves").text]).toEqual(["admitted", "1"]);
    s.next.push(() => { throw new ApiError(409, "tickets_exhausted", "no ticket left", {}); });
    await s.click(cells[1]!);
    expect(s.$("notice").text).toContain("Move B1 not sent: the session's tickets have run out.");
    expect(s.$("notice").text).not.toContain("tickets_exhausted"); // the code name is the API's, not the screen's
    expect(cells[1]!.getAttribute("data-state")).toBeNull();
  });

  test("Decline hides the request and cuts nothing", async () => {
    const s = await open("session");
    await s.click(s.btn("decline"));
    expect([s.$("sheet").hidden, s.calls]).toEqual([true, []]);
  });

  test("a 503 on a move raises the banner and turns the grid off", async () => {
    const s = await open("session", view({ tickets: { exported: 4, used: 0, left: 4 } }));
    const cells = s.doc.querySelectorAll("button.cell") as FakeButton[];
    s.next.push(() => { throw stalled(); });
    await s.click(cells[0]!);
    expect([s.$("banner").hidden, (s.$("grid-fields") as FakeFieldSet).disabled]).toEqual([false, true]);
    await s.click(cells[1]!);
    expect(s.sends()).toHaveLength(1);
  });

  test("Play scene: grants when no ticket is left, then eight moves within two seconds, each cell marked", async () => {
    const s = await open("session");
    await s.click(s.btn("play"));
    expect(s.calls[0]).toEqual(["tickets", A, { count: 16 }]);
    expect(s.sends()).toEqual(Array(8).fill(flows.moveBody(view(), "alt")));
    const sendTimes = s.times.slice(1);
    expect(sendTimes.at(-1)! - sendTimes[0]!).toBeLessThan(2_000);
    expect(sendTimes.at(-1)! - sendTimes[0]!).toBeGreaterThanOrEqual(7 * 240);
    const states = (s.doc.querySelectorAll("button.cell") as FakeButton[]).map((c) => c.getAttribute("data-state"));
    expect(states.slice(0, 9)).toEqual([...Array(8).fill("admitted"), null]);
    expect(s.$("notice").text).toContain("Scene: done: 8 of 8 moves admitted; the devnet's sidecar relays at most 4 per 10 s pass by default, so 8 parallel lanes land over two or more blocks");
  });
});

describe("tickets cut but missing from the device journal", () => {
  const card = (s: Awaited<ReturnType<typeof open>>) => [s.$("device-issue").hidden, s.$("device-issue").text];

  test("hot and cold: the phone card says so; the cold pane offers no cut, by button, by Enter or by Play scene", async () => {
    const s = await open("hot-cold", view({ tickets: UNJOURNALED }));
    expect(card(s)).toEqual([false, LOST3]);
    expect([s.$("ticket-count").text, s.$("ticket-note").hidden]).toEqual(["0 of 3", true]);
    expect(s.$("cut-left").text).toBe(`${LOST3}. Until then no cut: a new journal would re-sign used tickets.`);
    expect([s.btn("cut").disabled, s.field("cut-count").disabled]).toEqual([true, true]);
    await s.click(s.btn("cut"));
    s.$("cut-form").dispatchEvent(new FakeEvent("submit")); // Enter in the count field submits the form
    await s.doc.settle();
    expect(s.calls).toEqual([]);
    expect(s.$("notice").text).toContain(`${LOST3}. Until then no cut.`);
    await s.click(s.btn("play"));
    expect(s.calls).toEqual([]); // the scene stops before it cuts, sends or goes offline
    expect([s.$("notice").text, s.field("offline").checked]).toEqual([expect.stringContaining(`Scene stopped: ${LOST3}`), false]);
  });

  test("agent: the allowance card says so; the hint never says to cut more; no plan is asked; Play scene cuts nothing", async () => {
    const s = await open("agent", view({ tickets: UNJOURNALED }), FAKE_STATUS, (f) => { f.plans.answer = () => PLAN; });
    expect(card(s)).toEqual([false, LOST3]);
    expect(s.$("fire-hint").text).toBe(`No tranche can be signed: ${LOST3}.`);
    expect([s.$("fire-plan").hidden, s.plans.asked]).toEqual([true, []]);
    await s.click(s.btn("play"));
    expect(s.calls).toEqual([]);
    expect(s.$("notice").text).toContain(`Scene stopped: ${LOST3}`);
  });

  test("session: the session card says so; Grant is off and names no count; no plan; Play scene grants nothing", async () => {
    const s = await open("session", view({ tickets: UNJOURNALED }), FAKE_STATUS, (f) => { f.plans.answer = () => PLAN; });
    expect(card(s)).toEqual([false, LOST3]);
    expect([s.btn("grant").disabled, s.btn("grant").text, s.$("sheet").hidden, s.$("left-note").hidden]).toEqual([true, "Grant tickets", false, true]);
    expect(s.$("grant-note").text).toBe(`${LOST3}. Until then no grant: it would cut tickets, and a new journal would re-sign used ones.`);
    expect([s.$("grant-plan").hidden, s.plans.asked]).toEqual([true, []]);
    await s.click(s.btn("grant"));
    await s.click(s.btn("play"));
    expect(s.calls).toEqual([]);
    expect(s.$("notice").text).toContain(`Scene stopped: ${LOST3}`);
  });

  test("a 409 device_unusable from a send puts it on the card and turns the cut off; a view without it, once recovered, clears it", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    expect([card(s), s.btn("cut").disabled]).toEqual([[true, ""], false]);
    // the journal goes missing: the backend answers 409, and its next view reports the tickets unjournaled
    s.next.push(() => { s.w.tickets = { ...UNJOURNALED, exported: 10, unjournaled: 10 }; throw lostJournal(10); });
    await s.click(s.btn("pay"));
    expect(card(s)).toEqual([false, "10 tickets were cut but are missing from the device journal: recover it"]);
    expect(s.btn("cut").disabled).toBe(true);
    expect(s.$("notice").text).toContain(`device_unusable (409): 10 ticket(s) of epoch 0 were cut for ${A}`);
    // recovered: the view shows the device's own counts again
    s.w.tickets = { exported: 10, used: 1, left: 9 };
    await s.refresh();
    expect([card(s), s.btn("cut").disabled, s.$("ticket-note").hidden]).toEqual([[true, ""], false, false]);
  });

  test("the 409 itself puts it on the card, before the next view answers: a refused cut leaves Cut off; refused tranches tell the agent", async () => {
    const s = await open("hot-cold", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    let release = () => {};
    s.walletFault.gate = new Promise<void>((r) => { release = r; }); // the view after the failure is held back
    s.cutNext.push(() => { throw lostJournal(10); });
    await s.click(s.btn("cut"));
    expect(s.calls).toEqual([["tickets", A, { count: 6 }]]);
    expect(card(s)).toEqual([false, "10 tickets were cut but are missing from the device journal: recover it"]);
    expect([s.btn("cut").disabled, s.field("cut-count").disabled]).toEqual([true, true]); // not turned back on after the refusal
    // the view comes back without unjournaled (this fake's journal is fine again): the view decides, the cut is offered
    s.walletFault.gate = null;
    release();
    await s.doc.settle();
    expect([card(s), s.btn("cut").disabled]).toEqual([[true, ""], false]);

    const t = await open("agent", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    t.walletFault.gate = new Promise<void>(() => {}); // never answers: only the 409s can say it
    t.next.push(...Array(4).fill(() => { throw lostJournal(10); }));
    await t.click(t.btn("fire"));
    expect(card(t)).toEqual([false, "10 tickets were cut but are missing from the device journal: recover it"]);
    expect(t.$("fire-hint").text).toBe("No tranche can be signed: 10 tickets were cut but are missing from the device journal: recover it.");
  });

  test("a device the backend cannot open fails the view itself: the cards keep the backend's words and offer no cut", async () => {
    const s = await open("session", view({ tickets: { exported: 4, used: 4, left: 0 } }));
    const broken = new ApiError(409, "device_unusable", `the ticket device of ${A}: ticket file epoch0-16-19.json names another tree`, {});
    s.walletFault.error = broken;
    s.next.push(() => { throw broken; });
    await s.click((s.doc.querySelectorAll("button.cell") as FakeButton[])[0]!);
    expect(card(s)).toEqual([false, `The ticket device cannot be used: the ticket device of ${A}: ticket file epoch0-16-19.json names another tree`]);
    expect([s.btn("grant").disabled, s.btn("grant").text]).toEqual([true, "Grant tickets"]);
    await s.refresh(); // the view still fails with it: the card keeps it
    expect([card(s)[0], s.btn("grant").disabled]).toEqual([false, true]);
    s.walletFault.error = null;
    await s.refresh();
    expect([card(s), s.btn("grant").disabled, s.btn("grant").text]).toEqual([[true, ""], false, "Grant 12 tickets"]); // the device works again
  });
});

describe("the parallel-lanes plan before Fire and Grant", () => {
  /** the plan element's parts: its heading, its line, its warnings */
  const planOf = (s: Awaited<ReturnType<typeof open>>, id: string) => {
    const e = s.$(id);
    return { hidden: e.hidden, head: e.querySelector("h4")?.text ?? null, line: e.querySelector("p")?.text ?? null, warnings: e.querySelectorAll("li").map((li) => li.text) };
  };

  test("agent: the plan for the four tranches, its warnings in the screen's words; asked again only when its query changes or after 30 s", async () => {
    const s = await open("agent", view({ tickets: { exported: 10, used: 0, left: 10 } }), FAKE_STATUS, (f) => { f.plans.answer = () => PLAN; });
    const q = { n: 4, mode: "hot", valueWei: "10000000000000000", to: TARGET };
    expect(s.plans.asked).toEqual([q]);
    expect(planOf(s, "fire-plan")).toEqual({
      hidden: false, head: "Parallel-lanes plan", line: "4 lanes: 1 relay pass, about 28 s; set aside 0.048 ETH of balance 1 ETH", warnings: [UNREAD_WORDS],
    });
    // the wallet view comes every 6 s with the same query: no new ask within 30 s, and the plan drawn stays
    s.plans.answer = () => ({ ...PLAN, affordable: false, shortfallWei: "8000000000000000", warnings: [] });
    for (let i = 0; i < 4; i++) await s.refresh();
    expect(s.plans.asked).toEqual([q]);
    expect(planOf(s, "fire-plan").warnings).toEqual([UNREAD_WORDS]);
    // 30 s on, the same query is asked again
    setSystemTime(new Date(Date.now() + PLAN_EVERY_MS));
    await s.refresh();
    expect(s.plans.asked).toEqual([q, q]);
    expect(planOf(s, "fire-plan")).toMatchObject({ line: "4 lanes: 1 relay pass, about 28 s; set aside 0.048 ETH of balance 1 ETH; does not fit: short by 0.008 ETH", warnings: [] });
    // a query that changes is asked at once: a smaller balance makes smaller tranches
    s.w.balanceWei = "20000000000000000";
    await s.refresh();
    expect(s.plans.asked).toEqual([q, q, { ...q, valueWei: "3000000000000000" }]);
    expect(s.btn("fire").disabled).toBe(false);
  });

  test("agent: the tickets are part of the plan's query, so a cut changes its warnings at once, not 30 s later", async () => {
    const none = `only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${A}/tickets`;
    const s = await open("agent", view({ tickets: { exported: 0, used: 0, left: 0 } }), FAKE_STATUS, (f) => { f.plans.answer = () => ({ ...PLAN, warnings: [none] }); });
    expect(planOf(s, "fire-plan").warnings).toEqual(["No tickets left with the agent: cut some on the cold device."]);
    s.plans.answer = () => ({ ...PLAN, warnings: [] });
    await s.refresh(); // nothing changed: the answer it has
    expect([s.plans.asked.length, planOf(s, "fire-plan").warnings.length]).toEqual([1, 1]);
    s.w.tickets = { exported: 10, used: 0, left: 10 }; // the cold device cut ten tickets
    await s.refresh();
    expect([s.plans.asked.length, planOf(s, "fire-plan").warnings]).toEqual([2, []]);
  });

  test("agent: a backend without the route (404) says not offered; a failure says why in plain words, the backend's own in the tooltip; Fire still sends", async () => {
    const s = await open("agent", view({ tickets: { exported: 10, used: 0, left: 10 } }));
    expect(planOf(s, "fire-plan")).toEqual({ hidden: false, head: "Parallel-lanes plan", line: "not offered by this backend", warnings: [] });
    s.plans.answer = () => { throw new ApiError(502, "rpc_failed", "the sidecar cannot be read", {}); };
    setSystemTime(new Date(Date.now() + PLAN_EVERY_MS));
    await s.refresh();
    expect(planOf(s, "fire-plan").line).toBe("not read: the backend could not reach the chain or the mempool");
    expect(s.$("fire-plan").querySelector("p")!.getAttribute("title")).toBe("rpc_failed (502): the sidecar cannot be read");
    await s.click(s.btn("fire"));
    expect(s.sends()).toHaveLength(4);
  });

  test("the plan's warnings never show the API: no tickets left reads in each screen's words", async () => {
    const none = `only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${A}/tickets`;
    const agent = await open("agent", view({ tickets: { exported: 10, used: 10, left: 0 } }), FAKE_STATUS, (f) => { f.plans.answer = () => ({ ...PLAN, warnings: [none] }); });
    expect(planOf(agent, "fire-plan").warnings).toEqual(["No tickets left with the agent: cut some on the cold device."]);
    // the session's grant plan, before any grant: the backend says no ticket is left, the sheet says Grant cuts them
    const plan16 = { ...PLAN, setAsideWei: "32000000000000000", passes: 4, etaSeconds: 58, warnings: [none, UNREAD] };
    const session = await open("session", view(), FAKE_STATUS, (f) => { f.plans.answer = () => plan16; });
    expect(planOf(session, "grant-plan").warnings).toEqual(["No tickets in the session yet: Grant cuts them.", UNREAD_WORDS]);
    for (const text of [...planOf(agent, "fire-plan").warnings, ...planOf(session, "grant-plan").warnings]) {
      expect([text, /\/api\/|\b(?:GET|POST)\b|\(\d{3}\b|\b[a-z]+_[a-z_]+\b/.test(text)]).toEqual([text, false]);
    }
  });

  test("session: the plan for the grant, every granted ticket pending at once; gone once declined", async () => {
    const plan16 = { ...PLAN, setAsideWei: "32000000000000000", passes: 4, etaSeconds: 58, warnings: [] };
    const s = await open("session", view(), FAKE_STATUS, (f) => { f.plans.answer = () => plan16; });
    expect(s.plans.asked).toEqual([{ n: 16, mode: "hot", valueWei: "0", to: TARGET }]);
    expect(planOf(s, "grant-plan")).toEqual({ hidden: false, head: "Parallel-lanes plan", line: "16 lanes: 4 relay passes, about 58 s; set aside 0.032 ETH of balance 1 ETH", warnings: [] });
    await s.click(s.btn("decline"));
    expect([s.$("sheet").hidden, s.$("grant-plan").hidden]).toEqual([true, true]);
  });
});

describe("lane limits in the spec's words", () => {
  test("every screen shows the parallel lanes' limits; the Mempool switch says what each pool does", async () => {
    for (const page of ["hot-cold", "agent", "session"] as const) {
      const s = await open(page);
      expect([page, s.$("lane-limits").text]).toEqual([page, flows.LANE_LIMITS_TEXT]);
      await s.click(s.doc.querySelector('input[name="mempool"][value="public"]')!);
      expect(s.$("notice").text).toContain(flows.mempoolNotice("public"));
      await s.click(s.doc.querySelector('input[name="mempool"][value="alt"]')!);
      expect(s.$("notice").text).toContain(flows.mempoolNotice("alt"));
    }
  });
});

test("review aids in the URL: ?theme=dark or ?theme=light sets data-theme, ?motion=reduce makes the moments instant; nothing else does", () => {
  for (const [search, theme, reduce] of [["?theme=dark&motion=reduce", "dark", true], ["?theme=light", "light", false], ["?theme=neon", null, false], ["", null, false]] as const) {
    const doc = new FakeDocument();
    const restore = installDom(doc, search);
    try {
      applyReviewAids();
      expect([search, doc.documentElement.getAttribute("data-theme"), doc.documentElement.classList.contains("reduce-motion")]).toEqual([search, theme, reduce]);
    } finally {
      restore();
    }
  }
});
