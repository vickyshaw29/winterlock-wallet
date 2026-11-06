// The agent screen in the Ledger direction (.claude/briefs/ui-directions/1-ledger.md): the day book's serials, the
// allowance's count, the stub strip of the agent's tickets from real data, Max loss as a ledger total ruled again after
// Server compromised (and only then), the stubs Fire lifts (skipped where it cannot run), the sparkline's hatched band
// and its readout. The page runs on a fake document parsed from agent.html, against a small fake API.
// Written with Claude Code (AI) for Vicky.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { READOUT, allowanceCount, dayBookParts, liftStubs, nextStubs, start } from "../public/agent.js";
import { ApiError, type Api, type TxRecord, type WalletView } from "../public/api.js";
import * as flows from "../public/flows.js";
import { FakeEvent, installDom, parsePage, type FakeElement } from "./fake-dom.ts";
import { H, rec } from "./records.ts";

const PUBLIC = path.resolve(import.meta.dir, "../public");
const A = "0x00000000000000000000000000000000000ACC01";
const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
const STATUS = { chainId: 31337, head: 1002, headAgeSeconds: 4, stalled: false, fake: true };
type Strip = Parameters<typeof nextStubs>[0];

/** A wallet of height 5 (hot band 16 to 31) with six tickets cut, 16 to 21, none used. */
function view(over: Partial<WalletView> = {}): WalletView {
  return {
    address: A, root: H(7), treeSeed: H(8), height: 5, epoch: 0, leavesUsed: 6, leafCount: 32, lanesInFlight: 0, hybrid: false, locked: false,
    balanceWei: "1000000000000000000", hotStart: 16, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
    tickets: { exported: 6, used: 0, left: 6 }, rotationPending: false,
    leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 21 } }, ...over,
  };
}

/** the backend's 422 for a hot payment the account refuses, its ticket burned */
const refused = (reason: string, leaf: number) => new ApiError(422, "refused", "preflight refused: the account's verify frame reverted", {
  txHash: H(500 + leaf), leaf, simulation: { verifyGas: null, violations: ["VERIFY frame 1 reverted", `account: ${reason}`] },
});

/**
 * The API the page calls. A send uses the device's lowest unused ticket, as the backend does (LeafJournal.peekNext),
 * and the view shows it at once: admitted (in flight), or, when `refuse` holds a reason for it, refused and burned.
 */
function fakeApi(w: WalletView, records: TxRecord[]) {
  const sends: unknown[] = [];
  const refuse: string[] = [];
  const api = {
    base: "",
    listWallets: async () => [{ address: w.address, epoch: w.epoch, height: w.height, balanceWei: w.balanceWei }],
    wallet: async () => structuredClone(w),
    lanesPlan: async () => null,
    txs: async () => structuredClone(records),
    tx: async () => { throw new ApiError(404, "unknown_tx", "no such transaction", {}); },
    status: async () => STATUS,
    config: async () => ({ backendUrl: "http://127.0.0.1:8787" }),
    send: async (_a: string, body: unknown) => {
      sends.push(body);
      const l = w.leaves!;
      const used = new Set([...l.onChain, ...l.burned, ...l.inFlight]);
      let leaf = l.tickets!.from;
      while (used.has(leaf)) leaf++;
      w.tickets = { ...w.tickets, used: w.tickets.used + 1, left: w.tickets.left - 1 };
      const reason = refuse.shift();
      if (reason) { l.burned.push(leaf); throw refused(reason, leaf); }
      l.inFlight.push(leaf);
      return { txHash: H(leaf), leaf, nonceKeys: [`0x${leaf.toString(16)}`], nonceSeq: "0x0", status: "Submitted" };
    },
    tickets: async () => { throw new Error("not in these tests"); },
  };
  return { api: api as unknown as Api, sends, refuse };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

/** Opens agent.html as the browser does, with ?wallet= and the fake API; no polling. */
async function open(w = view(), records: TxRecord[] = []) {
  cleanup?.();
  const doc = parsePage(fs.readFileSync(path.join(PUBLIC, "agent.html"), "utf8"));
  const restore = installDom(doc, `?wallet=${A}`);
  const fake = fakeApi(w, records);
  const mounted = await start({ api: fake.api, poll: false });
  cleanup = () => { mounted?.stop(); restore(); };
  if (!mounted) throw new Error("agent did not mount");
  await doc.settle();
  const $ = (id: string): FakeElement => { const e = doc.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; };
  const click = async (e: FakeElement) => { e.click(); await doc.settle(); };
  const refresh = async () => { await mounted.screen.refresh(); await doc.settle(); };
  const stubs = () => $("stubs").children.map((li) => [li.className, li.text]);
  return { doc, w, $, click, refresh, stubs, ...fake };
}

describe("the day book (pure)", () => {
  const serials = (text: string) => dayBookParts(text).filter((p) => p.serial).map((p) => p.text);

  test("lane and ticket numbers are serials, in Serial red; joined, the parts are the text unchanged", () => {
    const text = "Tranche 1: ticket 16 on lane 0x10, admitted.";
    expect(dayBookParts(text)).toEqual([
      { text: "Tranche 1: ticket ", serial: false }, { text: "16", serial: true }, { text: " on lane ", serial: false },
      { text: "0x10", serial: true }, { text: ", admitted.", serial: false },
    ]);
    expect(serials("Lane 0x3fa (ticket 1018): included in block 120.")).toEqual(["0x3fa", "1018"]);
    expect(serials("Scene: 4 parallel lanes pending at once: 0x3f0, 0x3f1, 0x3f2, 0x3f3")).toEqual(["0x3f0", "0x3f1", "0x3f2", "0x3f3"]);
    for (const t of [text, "Scene: 4 parallel lanes pending at once: 0x3f0, 0x3f1"]) expect(dayBookParts(t).map((p) => p.text).join("")).toBe(t);
  });

  test("never an address, an amount, a block, a count or an error code", () => {
    expect(serials("Compromised payment of 0.001 ETH to 0x1ff8…0ca9, a new address: refused by the account; ticket 17 burned.")).toEqual(["17"]);
    expect(serials(`Compromised payment of 0.1 ETH to ${TARGET}: admitted.`)).toEqual([]);
    expect(serials("Tranche 4: tickets_exhausted (409): no unused leaf left in [1008, 1024): no leaf left to sign with")).toEqual([]);
    expect(serials("Fired 4 tranches of 0.01 ETH at once as parallel lanes (alt mempool).")).toEqual([]);
    expect(serials("Scene: the wallet cuts 16 tickets for the agent")).toEqual([]);
    expect(dayBookParts("")).toEqual([]);
  });
});

describe("the allowance's count (pure)", () => {
  test("tickets left of those cut, the backend's numbers; a note, none while the device cannot sign", () => {
    expect(allowanceCount({ tickets: { exported: 16, used: 6, left: 10 } }, false)).toEqual({ n: "10", of: " of 16", note: "tickets left of those cut; 6 used or burned" });
    expect(allowanceCount({ tickets: { exported: 0, used: 0, left: 0 } }, false).note).toBe("No tickets cut yet: the cold device cuts them, and Play scene does so first.");
    expect(allowanceCount({ tickets: { exported: 3, used: 0, left: 0, unjournaled: 3 } }, true)).toEqual({ n: "0", of: " of 3", note: null });
  });
});

describe("the agent screen, on the fake DOM", () => {
  test("the allowance: the count, the stub strip from the view's leaves and the fresher records, the caps, Max loss as a ledger total", async () => {
    const w = view({ tickets: { exported: 6, used: 3, left: 3 }, leaves: { onChain: [16], burned: [17], inFlight: [], tickets: { from: 16, to: 21 } } });
    const s = await open(w, [rec({ txHash: H(18), leaf: 18, nonceKey: "0x12", status: "Submitted" })]);
    expect([s.$("agent-count-n").textContent, s.$("agent-count-of").textContent, s.$("agent-count-note").text]).toEqual(["3", " of 6", "tickets left of those cut; 3 used or burned"]);
    // leaf 18 is only in the lane board's records: they are fresher than the view, so it is in flight; nothing moved on load
    expect(s.stubs()).toEqual([
      ["stub is-onchain", "16, used on chain"], ["stub is-burned", "17, burned by the signer"], ["stub is-flight", "18, in flight"],
      ["stub is-phone next", "19, next ticket"], ["stub is-phone", "20, on the phone"], ["stub is-phone", "21, on the phone"],
    ]);
    expect([s.$("stubs").hidden, s.$("stubs").getAttribute("aria-label")]).toEqual([false, "The agent's tickets"]);
    expect(s.$("allowance").children.map((kv) => [kv.children[0]!.text, kv.children[1]!.text])).toEqual([["value cap", "0.01 ETH"], ["fee cap", "0.002 ETH"], ["target", "0x554459…16f9"]]);
    // 3 tickets left at the value cap plus the fee cap: 3 x 0.012 ETH
    expect([s.$("max-loss-fig").text, s.$("max-loss").getAttribute("title"), s.$("max-loss").className]).toEqual(["0.036 ETH", "exact: 0.036 ETH", "total"]);
    expect(s.$("max-loss-note").text).toBe("to 0x5544…16f9 only: tickets left times value cap plus fee cap");
  });

  test("no ticket cut: the strip is hidden, the count says how tickets come", async () => {
    const s = await open(view({ tickets: { exported: 0, used: 0, left: 0 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: null } }));
    expect([s.$("stubs").hidden, s.stubs(), s.$("agent-count-n").textContent, s.$("agent-count-of").textContent]).toEqual([true, [], "0", " of 0"]);
    expect([s.$("agent-count-note").hidden, s.$("max-loss-fig").text]).toEqual([false, "0 ETH"]);
  });

  test("Server compromised rules the Max loss total again once the view shows the burned tickets, once; a poll or Fire never does", async () => {
    const s = await open();
    s.refuse.push("hot: value cap", "hot: frame target");
    await s.click(s.$("compromised"));
    expect(s.sends).toHaveLength(2);
    // four tickets left: 4 x 0.012 ETH, and the total ruled again; its tickets 16 and 17 stamped burned by the signer
    expect([s.$("max-loss-fig").text, s.$("max-loss").className]).toEqual(["0.048 ETH", "total m-rule"]);
    expect(s.stubs().slice(0, 3)).toEqual([["stub is-burned m-stamped", "16, burned by the signer"], ["stub is-burned m-stamped", "17, burned by the signer"], ["stub is-phone next", "18, next ticket"]]);
    expect(s.$("agent-count-n").textContent).toBe("4");
    s.$("max-loss").dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    expect(s.$("max-loss").className).toBe("total"); // the moment class goes when its animation ends
    await s.refresh();
    expect(s.$("max-loss").className).toBe("total"); // a poll that changes nothing plays nothing
    await s.click(s.$("fire"));
    expect([s.sends.length, s.$("max-loss-fig").text, s.$("max-loss").className]).toEqual([6, "0 ETH", "total"]); // Fire moves it, unruled
  });

  test("Fire: the stubs it lifts are the lowest on the phone, the ones the device signs next; the lift is skipped where it cannot run, and Fire still sends", async () => {
    const s = await open(view({ tickets: { exported: 6, used: 2, left: 4 }, leaves: { onChain: [16], burned: [], inFlight: [17], tickets: { from: 16, to: 21 } } }));
    const strip = s.$("stubs") as unknown as Strip;
    expect(nextStubs(strip, 4).map((li) => li.textContent)).toEqual(["18, next ticket", "19, on the phone", "20, on the phone", "21, on the phone"]);
    expect(liftStubs(strip, 4)).toBe(false); // the fake DOM has no element.animate
    s.doc.documentElement.classList.add("reduce-motion"); // ?motion=reduce, as prefers-reduced-motion
    (strip as unknown as { animate: () => void }).animate = () => { throw new Error("must not animate under reduced motion"); };
    expect(liftStubs(strip, 4)).toBe(false);
    await s.click(s.$("fire"));
    const tranche = flows.payBody({ wallet: s.w, valueWei: flows.trancheWei(view())!, mempool: "alt" });
    expect(s.sends).toEqual(Array(4).fill(tranche));
    expect([s.doc.querySelectorAll(".lift").length, s.stubs().map(([c]) => c)]).toEqual([0, ["stub is-onchain", ...Array(5).fill("stub is-flight")]]);
    expect(nextStubs(strip, 4)).toEqual([]); // none left on the phone: nothing to lift
  });

  test("the day book: clock time in Print, the entry, lane and ticket numbers in Serial; the empty line until the first entry; no motion", async () => {
    const s = await open();
    expect([s.$("log").children.length, s.$("log-empty").hidden]).toEqual([0, false]);
    await s.click(s.$("drop"));
    expect(s.$("log-empty").hidden).toBe(true);
    const first = s.$("log").children[0]!;
    expect([first.children[0]!.className, /^\d\d:\d\d:\d\d$/.test(first.children[0]!.text), first.children[1]!.text]).toEqual(["when num", true, "Mock price dropped 3 %."]);
    await s.click(s.$("fire"));
    const tranche1 = s.$("log").children.find((li) => li.text.includes("Tranche 1:"))!;
    expect(tranche1.children[1]!.text).toBe("Tranche 1: ticket 16 on lane 0x10, admitted.");
    expect(tranche1.querySelectorAll(".sn").map((e) => e.text)).toEqual(["16", "0x10"]);
    expect(s.$("log").querySelectorAll("li").every((li) => !/\bm-/.test(li.className))).toBe(true);
  });

  test("the sparkline: an Ink line on stock, the last 30 s under a hatched band (a pattern, not a gradient), focusable, its readout on focus", async () => {
    const s = await open();
    const spark = s.$("spark");
    expect([spark.getAttribute("tabindex"), spark.getAttribute("role"), spark.getAttribute("aria-describedby")]).toEqual(["0", "img", "spark-readout"]);
    expect(spark.querySelector("pattern")?.id).toBe("spark-hatch");
    expect(spark.querySelector("rect.spark-window")?.getAttribute("fill")).toBe("url(#spark-hatch)");
    expect([spark.querySelector("text.spark-label")?.text, spark.querySelectorAll("polyline.spark-line").length]).toEqual(["last 30 s", 1]);
    expect(spark.getAttribute("aria-label")).toMatch(/^Mock ETH price over the last 60 s: /);
    expect(s.$("spark-readout").text).toBe(READOUT);
    spark.focus();
    expect(s.$("spark-readout").text).toMatch(/^\d+\.\d\d at \d\d:\d\d:\d\d \(mock\)$/);
    expect(spark.querySelectorAll("circle.spark-hover")).toHaveLength(1);
    spark.dispatchEvent(new FakeEvent("keydown", { key: "ArrowLeft" }));
    expect(s.$("spark-readout").text).toMatch(/\(mock\)$/);
    spark.dispatchEvent(new FakeEvent("blur", { bubbles: false }));
    expect([s.$("spark-readout").text, spark.querySelectorAll("circle.spark-hover").length]).toEqual([READOUT, 0]);
  });
});
