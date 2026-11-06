// The hot-and-cold screen in the Ledger direction: what the ticket prints (the next serial, its lane, the machine line,
// or why there is none), the exact count of hot leaves left to cut, and the page on the fake DOM: the register and the
// stub strip drawn from the wallet view's leaves; the four forms open on a laptop and folded on a phone; the ticket
// torn off exactly when the device spent one (Pay or the stuck payment answered or refused with its leaf burned, each
// hot payment of Play scene, the backend's own retry), never on a stalled chain or a cold transfer; the caps reprinted
// once a policy changes them. Last, against the backend's own fakes: the serial is the ticket the device signs next.
// Written with Claude Code (AI) for Vicky.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Harness, OTHER, requireCli } from "../../backend/test/helpers.ts";
import { ApiError, createApi, type Api, type TxRecord, type WalletView } from "../public/api.js";
import * as flows from "../public/flows.js";
import { FOLD_QUERY, laneOf, start, ticketFace, uncutOf } from "../public/hot-cold.js";
import { leafStates } from "../public/register.js";
import { FakeDocument, FakeEvent, FakeInput, installDom, parsePage, type FakeElement } from "./fake-dom.ts";
import { H, rec } from "./records.ts";

const PUBLIC = path.resolve(import.meta.dir, "../public");
const A = "0x00000000000000000000000000000000000ACC01";
const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
const STATUS = { chainId: 31337, head: 1002, headAgeSeconds: 4, stalled: false, fake: true };

/**
 * Height 5: cold leaves 0 to 15, the hot band 16 to 31. Ten tickets cut (16 to 25): 16 used on chain, 17 burned by the
 * signer, 18 in flight; cold leaf 1 in flight. The device signs 19 next.
 */
function view(over: Partial<WalletView> = {}): WalletView {
  return {
    address: A, root: H(7), treeSeed: H(8), height: 5, epoch: 0, leavesUsed: 12, leafCount: 32, lanesInFlight: 2, hybrid: false, locked: false,
    balanceWei: "1000000000000000000", hotStart: 16, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
    tickets: { exported: 10, used: 3, left: 7 }, rotationPending: false,
    leaves: { onChain: [16], burned: [17], inFlight: [1, 18], tickets: { from: 16, to: 25 } }, ...over,
  };
}

describe("what the ticket prints (pure)", () => {
  test("the next ticket: the lowest still on the phone, its lane, the chain and the wallet; the sentence a screen reader gets", () => {
    const w = view();
    expect(ticketFace(w, leafStates(w, []), null, 31337)).toEqual({
      serial: "19", empty: false, machine: { lane: "0x13", chainId: 31337, wallet: A },
      words: "This ticket pays on lane 0x13, chain 31337, from wallet 0x000000…CC01.",
    });
    // the lane board is fresher than the view: a lane it shows in flight is not the next ticket
    expect(ticketFace(w, leafStates(w, [rec({ leaf: 19, nonceKey: "0x13" })]), null, 31337).serial).toBe("20");
    // no chain known (GET /api/status not offered): the line names lane and wallet only
    expect(ticketFace(w, leafStates(w, []), null, null).words).toBe("This ticket pays on lane 0x13, from wallet 0x000000…CC01.");
  });

  test("no ticket: none cut yet, none left, or the device cannot sign; an older backend's view guesses no serial", () => {
    const fresh = view({ tickets: { exported: 0, used: 0, left: 0 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: null } });
    expect(ticketFace(fresh, leafStates(fresh, []), null, 1337)).toEqual({ serial: "none yet", empty: true, machine: null, words: "No ticket yet: cut some on the cold device." });
    const spent = view({ tickets: { exported: 2, used: 2, left: 0 }, leaves: { onChain: [16], burned: [17], inFlight: [], tickets: { from: 16, to: 17 } } });
    expect(ticketFace(spent, leafStates(spent, []), null, 1337)).toEqual({ serial: "none left", empty: true, machine: null, words: "No ticket left: cut some on the cold device." });
    const issue = { count: 3, text: flows.unjournaledText(3) };
    expect(ticketFace(view(), leafStates(view(), []), issue, 1337)).toMatchObject({ serial: "none", empty: true, machine: null });
    const { leaves: _, ...old } = view();
    expect(ticketFace(old, leafStates(old, []), null, 1337)).toEqual({ serial: "—", empty: false, machine: null, words: "This backend does not say which ticket is next." });
  });

  test("a lane is (epoch << 32) | leaf, in hex", () => {
    expect([laneOf(0, 19), laneOf(1, 5), laneOf(2, 1023)]).toEqual(["0x13", "0x100000005", "0x2000003ff"]);
  });

  test("hot leaves left to cut: untouched hot-band leaves after the device's band; an older view falls back to the totals", () => {
    const w = view();
    expect(uncutOf(w, leafStates(w, []))).toBe(6); // 26 to 31
    // hotStart lowered to 12 after the cut: 12 to 15 are hot but never cut (cuts go on from 26), so still 6
    const lowered = view({ hotStart: 12 });
    expect([uncutOf(lowered, leafStates(lowered, [])), flows.uncutHotLeaves(lowered)]).toEqual([6, 10]);
    const none = view({ tickets: { exported: 0, used: 0, left: 0 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: null } });
    expect(uncutOf(none, leafStates(none, []))).toBe(16);
    const { leaves: _, ...old } = view();
    expect(uncutOf(old, leafStates(old, []))).toBe(flows.uncutHotLeaves(old));
  });
});

// ------------------------------------------------------------------ the page on the fake DOM

type Next = ((body: unknown) => unknown) | null;
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

/**
 * Opens hot-cold.html on the fake DOM with a fake API (no polling). `narrow` installs a matchMedia that says the
 * phone layout; `next` holds the next answers of send (null: admitted). The ticket gets animate and cloneNode, so the
 * tear can run, and `tears` counts each copy that tore off.
 */
async function open(w: WalletView, opts: { narrow?: boolean; status?: Record<string, unknown> | null; records?: TxRecord[] } = {}) {
  cleanup?.();
  const g = globalThis as Record<string, unknown>;
  const hadMatch = Object.getOwnPropertyDescriptor(g, "matchMedia");
  if (opts.narrow !== undefined) {
    g.matchMedia = (q: string) => ({ matches: q === FOLD_QUERY && opts.narrow === true, addEventListener() {} });
  }
  const doc: FakeDocument = parsePage(fs.readFileSync(path.join(PUBLIC, "hot-cold.html"), "utf8"));
  const restore = installDom(doc, `?wallet=${A}`);
  const state = { w, records: opts.records ?? [], next: [] as Next[], sends: [] as unknown[], tears: 0, leaf: 19 };
  const api = {
    base: "",
    listWallets: async () => [{ address: A, epoch: 0, height: 5, balanceWei: w.balanceWei }],
    wallet: async () => structuredClone(state.w),
    txs: async () => structuredClone(state.records),
    tx: async () => { throw new ApiError(404, "unknown_tx", "no such transaction", {}); },
    status: async () => (opts.status === undefined ? STATUS : opts.status),
    config: async () => ({ backendUrl: "http://127.0.0.1:8787" }),
    lanesPlan: async () => null,
    send: async (_a: string, body: unknown) => {
      state.sends.push(body);
      const answer = state.next.shift();
      if (answer) return answer(body);
      const l = state.leaf++;
      return { txHash: H(l), leaf: l, nonceKeys: [laneOf(0, l)], nonceSeq: "0x0", status: "Submitted" };
    },
    tickets: async (_a: string, b: { count: number }) => ({ from: 26, to: 25 + b.count, count: b.count }),
    hotPolicy: async () => ({ txHash: H(900), status: "Submitted" }),
    rotate: async () => ({ txHash: H(901), newRoot: H(902), epoch: 1 }),
  };
  const mounted = await start({ api: api as unknown as Api, poll: false });
  cleanup = () => {
    mounted?.stop();
    restore();
    if (hadMatch) Object.defineProperty(g, "matchMedia", hadMatch); else delete g.matchMedia;
  };
  if (!mounted) throw new Error("hot-cold did not mount");
  await doc.settle();
  const $ = (id: string): FakeElement => { const e = doc.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; };
  // what a browser gives the ticket, so register.js tearTicket can run: each clone it makes is one ticket torn off
  const done = () => ({ finished: Promise.resolve() });
  Object.assign($("ticket"), {
    animate: done,
    cloneNode: () => { state.tears++; return Object.assign(doc.createElement("div"), { style: {}, animate: done }); },
  });
  const click = async (e: FakeElement) => { e.click(); await doc.settle(); };
  const refresh = async () => { await mounted.screen.refresh(); await doc.settle(); };
  return { doc, state, $, click, refresh };
}

describe("the page: the register, the stubs and the ticket from the wallet view's leaves", () => {
  test("a cell per leaf in its state; the stubs of the band cut; the next serial, its machine line; the count in two spans", async () => {
    const s = await open(view());
    const cells = s.$("register").querySelector(".register")!.children;
    expect(cells).toHaveLength(32);
    expect([0, 1, 16, 17, 18, 19, 26].map((i) => cells[i]!.className)).toEqual([
      "leaf-cell is-unused", "leaf-cell is-flight", "leaf-cell is-onchain", "leaf-cell is-burned", "leaf-cell is-flight", "leaf-cell is-phone", "leaf-cell is-hot",
    ]);
    expect(s.$("stubs").hidden).toBe(false);
    expect(s.$("stubs").children.slice(0, 5).map((li) => li.text)).toEqual([
      "16, used on chain", "17, burned by the signer", "18, in flight", "19, next ticket", "20, on the phone",
    ]);
    expect([s.$("ticket-count").text, s.$("count-n").text, s.$("count-of").text]).toEqual(["7 of 10", "7", "of 10"]);
    expect([s.$("ticket-serial").text, s.$("ticket").classList.contains("empty")]).toEqual(["19", false]);
    const machine = s.$("machine");
    expect(machine.children.map((c) => c.text)).toEqual(["0x13", "31337", "0x000000…CC01", "This ticket pays on lane 0x13, chain 31337, from wallet 0x000000…CC01."]);
    expect(machine.children.slice(0, 3).map((c) => c.getAttribute("aria-hidden"))).toEqual(["true", "true", "true"]); // the sentence is what is read
    expect(machine.querySelectorAll("svg")).toHaveLength(5); // ⑈lane⑈ ⑆chain⑆ wallet⑈
    expect(s.$("cut-left").text).toBe("6 hot leaves not cut yet; 10 cut this epoch. Each ticket is one leaf's secrets and path, no seed.");
  });

  test("no ticket cut yet: the serial and the machine line say so in Print; no stubs", async () => {
    const s = await open(view({ tickets: { exported: 0, used: 0, left: 0 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: null } }));
    expect([s.$("ticket-serial").text, s.$("ticket").classList.contains("empty"), s.$("machine").text, s.$("stubs").hidden])
      .toEqual(["none yet", true, "No ticket yet: cut some on the cold device.", true]);
    expect(s.$("ticket-count").text).toBe("0 of 0");
  });
});

describe("the page: the four cold forms", () => {
  test("on a laptop they are open and stay open: their headings are out of the tab order and a click does nothing", async () => {
    const s = await open(view(), { narrow: false });
    const folds = s.doc.querySelectorAll("details.fold");
    expect(folds.map((d) => d.id)).toEqual(["fold-transfer", "fold-policy", "fold-cut", "fold-rotate"]);
    expect(folds.map((d) => [d.hasAttribute("open"), d.querySelector("summary")!.getAttribute("tabindex")])).toEqual(Array(4).fill([true, "-1"]));
    const ev = new FakeEvent("click");
    folds[0]!.querySelector("summary")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("on a phone they start closed and open and close as sections; every form and control is still there", async () => {
    const s = await open(view(), { narrow: true });
    const folds = s.doc.querySelectorAll("details.fold");
    expect(folds.map((d) => [d.hasAttribute("open"), d.querySelector("summary")!.getAttribute("tabindex")])).toEqual(Array(4).fill([false, "0"]));
    const ev = new FakeEvent("click");
    folds[2]!.querySelector("summary")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // the browser toggles it
    expect(folds.map((d) => d.querySelector("form")!.id)).toEqual(["transfer-form", "policy-form", "cut-form", "rotate-form"]);
  });

  test("without matchMedia (an old browser, these tests) the laptop layout holds: all open", async () => {
    const s = await open(view());
    expect(s.doc.querySelectorAll("details.fold").map((d) => d.hasAttribute("open"))).toEqual([true, true, true, true]);
  });
});

describe("the page: the ticket tears off exactly when the device spent one", () => {
  test("Pay admitted tears it; the next serial comes with the redraw", async () => {
    const s = await open(view());
    s.state.next.push(() => {
      s.state.w = view({ tickets: { exported: 10, used: 4, left: 6 }, leaves: { onChain: [16], burned: [17], inFlight: [1, 18, 19], tickets: { from: 16, to: 25 } } });
      return { txHash: H(19), leaf: 19, nonceKeys: ["0x13"], nonceSeq: "0x0", status: "Submitted" };
    });
    await s.click(s.$("pay"));
    expect([s.state.tears, s.$("ticket-serial").text, s.$("ticket-count").text]).toEqual([1, "20", "6 of 10"]);
    expect(s.$("notice").text).toContain("Paid 0.001 ETH with ticket 19 on lane 0x13: admitted.");
  });

  test("a refusal (422) burned the ticket, so it tears; a stalled chain (503) or no ticket (409) spent none, so it stays", async () => {
    const s = await open(view());
    s.state.next.push(() => { throw new ApiError(422, "refused", "preflight refused", { leaf: 19, simulation: { violations: ["account: hot: frame target"] } }); });
    await s.click(s.$("pay"));
    expect(s.state.tears).toBe(1);
    expect(s.$("notice").text).toContain("refused (422): preflight refused: account: hot: frame target");
    s.state.next.push(() => { throw new ApiError(409, "tickets_exhausted", "no ticket left", {}); });
    await s.click(s.$("stuck"));
    expect(s.state.tears).toBe(1);
    s.state.next.push(() => { throw new ApiError(503, "chain_stalled", "the latest block is 120 s old", {}); });
    await s.click(s.$("pay"));
    expect([s.state.tears, s.$("banner").hidden]).toEqual([1, false]);
  });

  test("the stuck payment tears its ticket; a cold transfer is signed from the seed and tears nothing", async () => {
    const s = await open(view());
    await s.click(s.$("stuck"));
    expect(s.state.tears).toBe(1);
    (s.$("transfer-to") as FakeInput).enter(OTHER);
    (s.$("transfer-amount") as FakeInput).enter("0.5");
    await s.click(s.$("transfer"));
    expect([s.state.sends.length, s.state.tears]).toEqual([2, 1]);
  });

  test("the backend's own retry after an expiry tears the next ticket by itself; nothing on the first records or for a cold lane", async () => {
    const first = rec({ txHash: H(1), leaf: 18, nonceKey: "0x12", status: "Expired", retriedAs: H(2) });
    const oldRetry = rec({ txHash: H(3), leaf: 1, nonceKey: "0x1", mode: "keyed", retryOf: H(4) });
    const s = await open(view(), { records: [first, oldRetry] });
    expect(s.state.tears).toBe(0); // the page's starting state
    s.state.records = [rec({ txHash: H(5), leaf: 2, nonceKey: "0x2", mode: "keyed", retryOf: H(6) }), first, oldRetry];
    await s.refresh();
    expect(s.state.tears).toBe(0);
    s.state.records = [rec({ txHash: H(2), leaf: 19, nonceKey: "0x13", retryOf: H(1) }), ...s.state.records];
    await s.refresh();
    expect(s.state.tears).toBe(1);
    await s.refresh(); // seen: once only
    expect(s.state.tears).toBe(1);
  });

  test("Play scene: each hot payment it sends tears a ticket, the two public refusals too", async () => {
    const s = await open(view());
    const refused = () => { throw new ApiError(422, "refused", "one pending frame transaction per sender", {}); };
    s.state.next.push(null, null, null, null, refused, refused);
    await s.click(s.$("play"));
    expect([s.state.sends.length, s.state.tears]).toEqual([6, 6]);
    expect(s.$("notice").text).toContain("Scene: done. Public mempool: payment 1 admitted, payment 2 refused, payment 3 refused.");
  });
});

describe("the page: the caps printed on the ticket", () => {
  test("reprinted once an included policy changes them, never on the first draw or an unchanged poll", async () => {
    const s = await open(view());
    const cap = s.$("pay-cap");
    expect([cap.text, cap.classList.contains("m-reprint")]).toEqual(["Hot value cap 0.01 ETH per payment, fee cap 0.002 ETH.", false]);
    await s.refresh();
    expect(cap.classList.contains("m-reprint")).toBe(false);
    s.state.w = view({ hotValueCapWei: "20000000000000000" });
    await s.refresh();
    expect([cap.text, cap.classList.contains("m-reprint")]).toEqual(["Hot value cap 0.02 ETH per payment, fee cap 0.002 ETH.", true]);
    cap.dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    expect(cap.classList.contains("m-reprint")).toBe(false);
  });
});

describe("against the backend's own fakes", () => {
  test("the serial is the ticket the device signs next: its lowest still on the phone, past a burned one, until none is left", async () => {
    requireCli();
    const h = await Harness.create();
    try {
      // the backend in process, no port: the client the pages use, over the app's own fetch
      const api = createApi({ base: "http://127.0.0.1:8787", fetch: (input, init) => h.app.fetch(new Request(input, init)) });
      const a = await h.wallet(); // height 4: hot leaves 12 to 15
      expect(await flows.cutTickets(api, a, 4)).toEqual({ from: 12, to: 15, count: 4 });
      const face = async () => { const w = await api.wallet(a); return ticketFace(w, leafStates(w, await api.txs(a)), null, 1337); };
      const pay = async (to?: string) => {
        const body = flows.payBody({ wallet: await api.wallet(a), valueWei: 1_000n, mempool: "alt" });
        return flows.send(api, a, to ? { ...body, to } : body).then((r) => r.leaf, (e: ApiError) => e.body.leaf as number);
      };
      expect(await face()).toMatchObject({ serial: "12", machine: { lane: "0xc", chainId: 1337 } });
      expect(await pay()).toBe(12);
      expect((await face()).serial).toBe("13");
      expect(await pay(OTHER)).toBe(13); // refused (target not allowed): the ticket is burned
      const next = await face();
      expect(next.serial).toBe("14");
      expect(String(await pay())).toBe(next.serial);
      expect(await pay()).toBe(15);
      expect(await face()).toMatchObject({ serial: "none left", empty: true, machine: null });
    } finally {
      await h.destroy();
    }
  }, 30_000);
});
