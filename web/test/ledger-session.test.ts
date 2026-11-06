// The session screen and the start page in the Ledger direction, on the fake DOM: the board's punch positions under
// printed heads; a move punched at once, its ticket printed under the hole, the count rolled; the chain's marks (a violet
// ring when included, a slash when refused or expired) once each and never on load or on a later poll; a replayed
// cell's old lane never overwriting its new move; the stub strip from the wallet view's leaves; the start page's account
// lines, their links, and the create form sending what createWalletBody builds.
// Written with Claude Code (AI) for Vicky.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ApiError, type Api, type TxRecord, type WalletView } from "../public/api.js";
import * as flows from "../public/flows.js";
import { start as startIndex, walletLine } from "../public/index.js";
import { cellState, start as startSession } from "../public/session.js";
import { FakeButton, FakeEvent, FakeInput, installDom, parsePage, type FakeDocument, type FakeElement } from "./fake-dom.ts";
import { H, rec, receipt } from "./records.ts";

const PUBLIC = path.resolve(import.meta.dir, "../public");
const A = "0x00000000000000000000000000000000000ACC01";
const B = "0x00000000000000000000000000000000000ACC02";
const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
const FAKE_STATUS = { chainId: 31337, head: 1002, headAgeSeconds: 4, stalled: false, fake: true };

/** A wallet of height 5 (hot band 16 to 31) holding four tickets, 16 to 19, none used. */
function view(over: Partial<WalletView> = {}): WalletView {
  return {
    address: A, root: H(7), treeSeed: H(8), height: 5, epoch: 0, leavesUsed: 4, leafCount: 32, lanesInFlight: 0, hybrid: false, locked: false,
    balanceWei: "1000000000000000000", hotStart: 16, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
    tickets: { exported: 4, used: 0, left: 4 }, rotationPending: false,
    leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 19 } }, ...over,
  };
}

/**
 * The API the session page calls: send answers in order from `answers` (default: admitted on the device's next ticket,
 * which the view then counts used); `gate` holds the next send back until it settles; `records` is the lane board.
 */
function fakeApi(w: WalletView) {
  const sent: unknown[] = [];
  const answers: ((body: unknown) => unknown)[] = [];
  const state = { records: [] as TxRecord[], gate: null as Promise<void> | null, next: w.leaves?.tickets?.from ?? 16 };
  const api = {
    base: "",
    listWallets: async () => [{ address: w.address, epoch: w.epoch, height: w.height, balanceWei: w.balanceWei }],
    wallet: async () => structuredClone(w),
    lanesPlan: async () => null,
    txs: async () => structuredClone(state.records),
    tx: async () => { throw new ApiError(404, "unknown_tx", "no such transaction", {}); },
    status: async () => FAKE_STATUS,
    config: async () => ({ backendUrl: "http://127.0.0.1:8787" }),
    send: async (_a: string, body: unknown) => {
      sent.push(body);
      if (state.gate) { const g = state.gate; state.gate = null; await g; }
      const answer = answers.shift();
      if (answer) return answer(body);
      const leaf = state.next++;
      w.tickets = { ...w.tickets, used: w.tickets.used + 1, left: w.tickets.left - 1 };
      return { txHash: H(leaf), leaf, nonceKeys: [`0x${leaf.toString(16)}`], nonceSeq: "0x0", status: "Submitted" };
    },
  };
  return { api: api as unknown as Api, sent, answers, state };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

async function openSession(w = view()) {
  const doc: FakeDocument = parsePage(fs.readFileSync(path.join(PUBLIC, "session.html"), "utf8"));
  const restore = installDom(doc, `?wallet=${A}`);
  const fake = fakeApi(w);
  const mounted = await startSession({ api: fake.api, poll: false });
  cleanup = () => { mounted?.stop(); restore(); };
  if (!mounted) throw new Error("session did not mount");
  await doc.settle();
  const $ = (id: string): FakeElement => { const e = doc.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; };
  const cells = () => doc.querySelectorAll("button.cell") as FakeButton[];
  const hole = (i: number) => cells()[i]!.children[0]!;
  const ticket = (i: number) => cells()[i]!.children[1]!;
  const click = async (i: number) => { cells()[i]!.click(); await doc.settle(); };
  /** a poll: the wallet view and the lane board read again, and everything that follows */
  const refresh = async () => { await mounted.screen.refresh(); await doc.settle(); };
  /** a poll alone, while a click's send is still held back (settle would wait for it) */
  const poll = () => mounted.screen.refresh();
  /** every moment class anywhere in the board */
  const moments = () => [...$("grid").descendants()].flatMap((e) => e.className.split(/\s+/).filter((c) => c.startsWith("m-")));
  return { doc, w, ...fake, $, cells, hole, ticket, click, refresh, poll, moments };
}

describe("session: the board of punch positions", () => {
  test("36 positions under printed heads, each a button named for its move; the heads are hidden from a screen reader; nothing moves on load", async () => {
    const s = await openSession();
    const parts = s.$("grid").children;
    expect(parts).toHaveLength(7 + 6 + 36); // the corner and A to F, a number per row, the positions
    const heads = parts.filter((p) => p.localName === "span");
    expect(heads.map((h) => h.text)).toEqual(["", "A", "B", "C", "D", "E", "F", "1", "2", "3", "4", "5", "6"]);
    expect(heads.every((h) => h.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(s.cells().map((c) => c.getAttribute("aria-label"))).toEqual(
      ["1", "2", "3", "4", "5", "6"].flatMap((r) => [..."ABCDEF"].map((c) => `move ${c}${r}`)));
    expect(s.cells().every((c) => c.getAttribute("type") === "button" && c.getAttribute("data-state") === null && c.text === "")).toBe(true);
    expect(s.moments()).toEqual([]);
  });

  test("a click punches the hole; the answer prints its ticket under it, rolls the count, and the notice names the cell", async () => {
    const s = await openSession();
    expect(s.$("left").text).toBe("4 of 4");
    await s.click(0);
    expect(s.sent).toEqual([flows.moveBody(s.w, "alt")]);
    expect([s.cells()[0]!.getAttribute("data-state"), s.hole(0).className, s.ticket(0).text, s.ticket(0).className]).toEqual(["admitted", "hole m-punch", "16", "punch-sn m-print"]);
    expect(s.$("notice").text).toContain("Move A1: ticket 16 on lane 0x10, admitted.");
    expect([s.$("left").text, s.$("left-n").text, s.cells()[0]!.disabled]).toEqual(["3 of 4", "3", true]);
    // the moment ends with its animation, and a poll that changes nothing plays nothing
    s.hole(0).dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    s.ticket(0).dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    await s.refresh();
    expect(s.moments()).toEqual([]);
  });

  test("the chain's marks, once each: a violet ring when included, a slash when expired; a lane still in flight keeps its hole", async () => {
    const s = await openSession();
    for (const i of [0, 1, 2]) await s.click(i);
    for (const i of [0, 1, 2]) for (const p of [s.hole(i), s.ticket(i)]) p.dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    s.state.records = [
      rec({ txHash: H(16), leaf: 16, nonceKey: "0x10", status: "OnChain", receipt: receipt(1002), lines: [["Submitted", 0], ["chain: OnChain in block 1002", 6_000]] }),
      rec({ txHash: H(17), leaf: 17, nonceKey: "0x11", status: "Expired", lines: [["Submitted", 0], ["Expired", 90_000]] }),
      rec({ txHash: H(18), leaf: 18, nonceKey: "0x12", status: "Submitted" }),
    ];
    await s.refresh();
    expect(s.cells().slice(0, 3).map((c) => c.getAttribute("data-state"))).toEqual(["included", "expired", "admitted"]);
    expect([s.hole(0).className, s.hole(1).className, s.hole(2).className]).toEqual(["hole m-ring", "hole m-void", "hole"]);
    expect([s.$("moves").text, s.$("moves-in").text, s.$("moves-out").text]).toEqual(["3", "1", "1"]);
    expect([s.cells()[0]!.disabled, s.cells()[1]!.disabled]).toEqual([true, false]); // an expired move's cell can be played again
    expect(s.cells()[1]!.title).toBe("lane 0x11, ticket 17: expired, leaf burned");
    for (const i of [0, 1]) s.hole(i).dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    await s.refresh(); // the same records again: no mark lands twice
    expect(s.moments()).toEqual([]);
  });

  test("refused at once (422): punched and voided together, the burned ticket printed; the cell can be played again", async () => {
    const s = await openSession();
    s.answers.push(() => {
      throw new ApiError(422, "refused", "the public mempool holds one pending frame transaction per sender", { txHash: H(520), leaf: 20, simulation: { verifyGas: null, violations: [] } });
    });
    await s.click(4);
    expect([s.cells()[4]!.getAttribute("data-state"), s.hole(4).className, s.ticket(4).text, s.cells()[4]!.disabled]).toEqual(["refused", "hole m-punch m-void", "20", false]);
    expect(s.$("notice").text).toContain("Move E1: refused (422)");
  });

  test("a replayed cell's old lane never speaks for its new move while that move is on its way", async () => {
    const s = await openSession();
    s.answers.push(() => { throw new ApiError(422, "refused", "refused", { txHash: H(520), leaf: 20 }); });
    await s.click(0);
    s.state.records = [rec({ txHash: H(520), leaf: 20, nonceKey: "0x14", status: "Refused", lines: [["Refused", 0]] })];
    let release = () => {};
    s.state.gate = new Promise<void>((r) => { release = r; });
    s.cells()[0]!.click(); // played again: its move waits for its answer
    await s.poll();
    expect([s.cells()[0]!.getAttribute("data-state"), s.ticket(0).text, s.cells()[0]!.disabled]).toEqual(["sending", "", true]);
    release();
    await s.doc.settle();
    expect([s.cells()[0]!.getAttribute("data-state"), s.ticket(0).text]).toEqual(["admitted", "16"]);
  });

  test("a reverted move used its ticket on chain (included); an unknown one is still in flight", () => {
    const states = (["OnChain", "Reverted", "Included", "Expired", "Refused", "Submitted", "Unknown"] as const).map((status) => cellState(rec({ status })));
    expect(states).toEqual(["included", "included", "included", "expired", "refused", "admitted", "admitted"]);
  });
});

describe("session: the card's stub strip", () => {
  test("the tickets cut this epoch, each with its state, the lowest still on the phone ringed as the next", async () => {
    const s = await openSession(view({ tickets: { exported: 4, used: 3, left: 1 }, leaves: { onChain: [16], burned: [17], inFlight: [18], tickets: { from: 16, to: 19 } } }));
    const stubs = s.$("stubs").children;
    expect(s.$("stubs").hidden).toBe(false);
    expect(stubs.map((li) => [li.className, li.text])).toEqual([
      ["stub is-onchain", "16, used on chain"], ["stub is-burned", "17, burned by the signer"], ["stub is-flight", "18, in flight"], ["stub is-phone next", "19, next ticket"],
    ]);
  });

  test("no strip before a grant, and none while the ticket device cannot sign (no stub's state is known)", async () => {
    const none = await openSession(view({ tickets: { exported: 0, used: 0, left: 0 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: null } }));
    expect([none.$("stubs").hidden, none.$("stubs").children.length]).toEqual([true, 0]);
    const lost = await openSession(view({ tickets: { exported: 3, used: 0, left: 0, unjournaled: 3 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 18 } } }));
    expect([lost.$("stubs").hidden, lost.$("stubs").children.length, lost.$("device-issue").hidden]).toEqual([true, 0, false]);
  });
});

describe("start page", () => {
  const W1 = { address: A, epoch: 0, height: 10, balanceWei: "9998196000000000000" };
  const W2 = { address: B, epoch: 1, height: 5, balanceWei: "1000000000000000000" };

  async function openIndex(last: string | null) {
    const doc: FakeDocument = parsePage(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"));
    const restore = installDom(doc, "");
    const g = globalThis as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(g, "localStorage");
    const stored = new Map<string, string>(last ? [["winterlock.wallet", last]] : []);
    Object.defineProperty(g, "localStorage", { value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) }, configurable: true, writable: true });
    const created: unknown[] = [];
    const api = {
      listWallets: async () => [W1, W2], status: async () => FAKE_STATUS, config: async () => ({ backendUrl: "http://127.0.0.1:8787" }),
      createWallet: async (b: unknown) => { created.push(b); return { address: B, root: H(1), epoch: 0, funded: true }; },
    } as unknown as Api;
    cleanup = () => { restore(); if (had) Object.defineProperty(g, "localStorage", had); else delete g.localStorage; };
    await startIndex({ api });
    await doc.settle();
    const $ = (id: string): FakeElement => { const e = doc.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; };
    return { doc, $, created, stored };
  }

  test("each wallet is an account line: its facts as label and value, never a middle-dot string, and a link to each screen", async () => {
    const s = await openIndex(B);
    const lines = s.$("wallets").children;
    expect(lines.map((li) => li.className)).toEqual(["", "picked"]);
    const facts = (li: FakeElement) => li.querySelectorAll("div").map((kv) => [kv.children[0]!.text, kv.children[1]!.text]);
    expect(facts(lines[0]!)).toEqual([["wallet", A], ["balance", "9.998196 ETH"], ["epoch", "0"], ["height", "10"]]);
    expect(facts(lines[1]!)[0]).toEqual(["wallet, picked last", B]);
    expect(lines.some((li) => li.text.includes("·"))).toBe(false);
    const links = lines[0]!.querySelectorAll("a");
    expect(links.map((a) => [a.text, a.getAttribute("href"), a.getAttribute("aria-label")])).toEqual([
      ["Hot and cold", `hot-cold.html?wallet=${A}`, "Hot and cold, wallet 0x000000…CC01"],
      ["Agent", `agent.html?wallet=${A}`, "Agent, wallet 0x000000…CC01"],
      ["Session", `session.html?wallet=${A}`, "Session, wallet 0x000000…CC01"],
    ]);
    // the masthead opens the screens on the wallet picked last
    expect(s.doc.querySelectorAll("a[data-keep-wallet]").map((a) => a.getAttribute("href"))).toEqual([
      `hot-cold.html?wallet=${B}`, `agent.html?wallet=${B}`, `session.html?wallet=${B}`]);
    // following a line's link picks its wallet
    links[2]!.click();
    expect(s.stored.get("winterlock.wallet")).toBe(A);
  });

  test("the create form sends what createWalletBody builds from its fields, and the new wallet becomes the picked one", async () => {
    const s = await openIndex(null);
    (s.$("c-height") as FakeInput).value = "6";
    (s.$("c-cap") as FakeInput).value = "0.02";
    s.$("create-form").dispatchEvent(new FakeEvent("submit"));
    await s.doc.settle();
    expect(s.created).toEqual([flows.createWalletBody({ height: "6", valueCap: "0.02", feeCap: "", allowedTarget: "", hotStart: "" })]);
    expect(s.$("notice").text).toContain(`Created ${B} at epoch 0, funded.`);
    expect(s.$("wallets").children.map((li) => li.className)).toEqual(["", "picked"]);
  });

  test("walletLine on its own: the picked line is named so", () => {
    const doc = parsePage("<html><body></body></html>");
    const restore = installDom(doc, "");
    try {
      const li = walletLine(W2, true, () => {}) as unknown as FakeElement;
      expect([li.className, li.querySelector("dt")?.text, li.querySelectorAll("a").length]).toEqual(["picked", "wallet, picked last", 3]);
    } finally { restore(); }
  });
});
