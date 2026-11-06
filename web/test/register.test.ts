// register.js: every leaf's state from the wallet view's leaves and the lane board's records (pure), the counts, the
// next ticket (the lowest still on the phone, as the device signs), the stub strip, and the moments on the fake DOM:
// nothing on the first draw of a book, then once per changed cell or new stub; the tear skipped where it cannot run.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TxRecord, WalletView } from "../public/api.js";
import { LEAF_WORDS, countStates, createRegister, createStubStrip, leafStates, nextTicket, reducedMotion, rollNumber, stubsOf, tearTicket, type LeafState } from "../public/register.js";
import { FakeDocument, FakeElement, FakeEvent, installDom } from "./fake-dom.ts";

type RegRoot = Parameters<typeof createRegister>[0];
type StripList = Parameters<typeof createStubStrip>[0];
type Ticket = Parameters<typeof tearTicket>[0];

/** A wallet view of height 5 (32 leaves, hot band 16 to 31) with the backend's leaves field. */
function view(over: Partial<WalletView> = {}): Pick<WalletView, "leafCount" | "hotStart" | "epoch" | "tickets" | "leaves"> {
  return {
    leafCount: 32, hotStart: 16, epoch: 0, tickets: { exported: 0, used: 0, left: 0 },
    leaves: { onChain: [], burned: [], inFlight: [], tickets: null }, ...over,
  };
}
/** A lane record: just what the register reads. */
const lane = (leaf: number, status: TxRecord["status"], epoch = 0) => ({ leaf, status, nonceKey: `0x${((BigInt(epoch) << 32n) | BigInt(leaf)).toString(16)}` });
const at = (states: LeafState[], ...leaves: number[]) => leaves.map((l) => states[l]);

describe("leafStates (pure)", () => {
  test("a new wallet: cold leaves unused, the hot band from hotStart not cut", () => {
    const s = leafStates(view(), []);
    expect(s).toHaveLength(32);
    expect(countStates(s)).toEqual({ onchain: 0, burned: 0, flight: 0, phone: 0, hot: 16, unused: 16 });
    expect(at(s, 0, 15, 16, 31)).toEqual(["unused", "unused", "hot", "hot"]);
  });

  test("the view's lists: on chain, burned by the signer (an estimate's leaf has no record), in flight, tickets on the phone", () => {
    const v = view({ tickets: { exported: 4, used: 2, left: 2 }, leaves: { onChain: [1, 3, 16], burned: [2, 17], inFlight: [4], tickets: { from: 16, to: 19 } } });
    const s = leafStates(v, []);
    expect(at(s, 1, 2, 3, 4, 5)).toEqual(["onchain", "burned", "onchain", "flight", "unused"]);
    expect(at(s, 16, 17, 18, 19, 20)).toEqual(["onchain", "burned", "phone", "phone", "hot"]);
    expect(countStates(s)).toEqual({ onchain: 3, burned: 2, flight: 1, phone: 2, hot: 12, unused: 12 });
  });

  test("records are fresher than the view: a lane just sent is in flight, one just landed is on chain; a leaf never moves back", () => {
    const v = view({ leaves: { onChain: [1], burned: [], inFlight: [2], tickets: { from: 16, to: 19 } } });
    const s = leafStates(v, [lane(16, "Submitted"), lane(2, "OnChain"), lane(17, "Refused"), lane(18, "Expired"), lane(5, "Unknown"), lane(1, "Submitted")]);
    expect(at(s, 16, 2, 17, 18, 5)).toEqual(["flight", "onchain", "burned", "burned", "flight"]);
    expect(s[1]).toBe("onchain"); // the view already saw leaf 1 land; an older record cannot pull it back to in flight
    // Reverted and Included used the key too
    expect(at(leafStates(view(), [lane(6, "Reverted"), lane(7, "Included")]), 6, 7)).toEqual(["onchain", "onchain"]);
  });

  test("only this epoch's lanes; leaves outside the tree are ignored; a backend without the field falls back to the records", () => {
    const s = leafStates(view({ epoch: 1 }), [lane(3, "OnChain", 0), lane(4, "OnChain", 1), lane(99, "OnChain", 1)]);
    expect(at(s, 3, 4)).toEqual(["unused", "onchain"]);
    expect(s).toHaveLength(32);
    const { leaves: _, ...old } = view();
    expect(at(leafStates(old, [lane(16, "OnChain")]), 16, 17)).toEqual(["onchain", "hot"]);
  });
});

describe("the next ticket and the stubs", () => {
  test("the next ticket is the lowest still on the phone, as the device signs its lowest unused ticket", () => {
    const v = view({ tickets: { exported: 4, used: 1, left: 3 }, leaves: { onChain: [16], burned: [], inFlight: [], tickets: { from: 16, to: 19 } } });
    const s = leafStates(v, [lane(17, "Submitted")]);
    expect(nextTicket(v, s)).toBe(18);
    expect(stubsOf(v, s)).toEqual([
      { leaf: 16, state: "onchain", next: false }, { leaf: 17, state: "flight", next: false },
      { leaf: 18, state: "phone", next: true }, { leaf: 19, state: "phone", next: false },
    ]);
  });

  test("no next ticket when none is left, none was cut, or the device journal is lost", () => {
    const used = view({ leaves: { onChain: [16, 17], burned: [], inFlight: [], tickets: { from: 16, to: 17 } } });
    expect(nextTicket(used, leafStates(used, []))).toBeNull();
    expect([nextTicket(view(), leafStates(view(), [])), stubsOf(view(), leafStates(view(), []))]).toEqual([null, []]);
    const lost = view({ tickets: { exported: 3, used: 0, left: 0, unjournaled: 3 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 18 } } });
    expect(nextTicket(lost, leafStates(lost, []))).toBeNull();
    expect(stubsOf(lost, leafStates(lost, [])).map((x) => [x.leaf, x.state, x.next])).toEqual([[16, "phone", false], [17, "phone", false], [18, "phone", false]]);
  });
});

describe("drawing, on the fake DOM", () => {
  let doc: FakeDocument, root: FakeElement, restore: () => void;
  beforeEach(() => { doc = new FakeDocument(); restore = installDom(doc); root = doc.createElement("div"); doc.body.append(root); });
  afterEach(() => restore());
  const cells = () => root.querySelector(".register")!.children;
  const moments = () => cells().map((c, i) => [i, c.className] as const).filter(([, c]) => / m-/.test(c));

  test("the register: one cell per leaf, the legend in the spec's words, a summary for screen readers; nothing moves on the first draw", () => {
    const reg = createRegister(root as unknown as RegRoot);
    const v = view({ leaves: { onChain: [1], burned: [2], inFlight: [3], tickets: { from: 16, to: 17 } } });
    reg.draw(leafStates(v, []), "0");
    expect(cells()).toHaveLength(32);
    expect(cells().slice(0, 4).map((c) => c.className)).toEqual(["leaf-cell is-unused", "leaf-cell is-onchain", "leaf-cell is-burned", "leaf-cell is-flight"]);
    expect(cells()[16]!.className).toBe("leaf-cell is-phone");
    expect(moments()).toEqual([]);
    expect(root.querySelector(".legend")!.children.map((li) => li.text)).toEqual(Object.values(LEAF_WORDS));
    expect(root.querySelector(".register")!.getAttribute("aria-label")).toBe(
      "Key tree register, 32 leaves: 1 used on chain, 1 burned by the signer, 1 in flight, 2 on the phone, 14 hot band, not cut, 13 unused.");
  });

  test("a changed cell plays its moment once: a cut runs its perforation, anything else presses in; a new book plays nothing", () => {
    const reg = createRegister(root as unknown as RegRoot, { legend: false });
    reg.draw(leafStates(view(), []), "0");
    const cut = view({ leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 17 } } });
    reg.draw(leafStates(cut, [lane(1, "Submitted")]), "0");
    expect(moments()).toEqual([[1, "leaf-cell is-flight m-fill"], [16, "leaf-cell is-phone m-cut"], [17, "leaf-cell is-phone m-cut"]]);
    for (const c of cells()) c.dispatchEvent(new FakeEvent("animationend", { bubbles: false }));
    expect(moments()).toEqual([]); // each moment class goes when its animation ends
    reg.draw(leafStates(cut, [lane(1, "Submitted")]), "0");
    expect(moments()).toEqual([]); // unchanged: nothing replays
    reg.draw(leafStates(cut, [lane(1, "OnChain")]), "0");
    expect(moments()).toEqual([[1, "leaf-cell is-onchain m-fill"]]);
    reg.draw(leafStates(view({ epoch: 1 }), []), "1"); // a rotation: a fresh book
    expect([moments(), cells()[1]!.className]).toEqual([[], "leaf-cell is-unused"]);
  });

  test("the stub strip: hidden with no ticket; new stubs print in left to right; a stub that lands gets its frame stamped", () => {
    const list = doc.createElement("ol");
    root.append(list);
    const strip = createStubStrip(list as unknown as StripList);
    strip.draw([], "0");
    expect(list.hidden).toBe(true);
    const v = view({ tickets: { exported: 3, used: 0, left: 3 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 18 } } });
    strip.draw(stubsOf(v, leafStates(v, [])), "0");
    expect(list.hidden).toBe(false);
    expect(list.children.map((li) => [li.className, li.text])).toEqual([
      ["stub is-phone next m-fresh", "16, next ticket"], ["stub is-phone m-fresh", "17, on the phone"], ["stub is-phone m-fresh", "18, on the phone"],
    ]);
    strip.draw(stubsOf(v, leafStates(v, [lane(16, "OnChain"), lane(17, "Refused")])), "0");
    expect(list.children.map((li) => li.className)).toEqual(["stub is-onchain m-stamped", "stub is-burned m-stamped", "stub is-phone next"]);
    expect(list.children[1]!.text).toBe("17, burned by the signer");
  });

  test("the stub strip draws twice in a row (view, then records): the second draw keeps each stub and the moment it plays", () => {
    const list = doc.createElement("ol");
    root.append(list);
    const strip = createStubStrip(list as unknown as StripList);
    const v = view({ tickets: { exported: 2, used: 0, left: 2 }, leaves: { onChain: [], burned: [], inFlight: [], tickets: { from: 16, to: 17 } } });
    strip.draw(stubsOf(v, leafStates(v, [])), "0"); // the first draw of the book: no moment
    const landed = stubsOf(v, leafStates(v, [lane(16, "OnChain")]));
    strip.draw(landed, "0");
    const [first, second] = list.children;
    expect([first!.className, second!.className]).toEqual(["stub is-onchain m-stamped", "stub is-phone next"]);
    strip.draw(landed, "0"); // the same states again, before the stamp's animation ends
    expect(list.children[0]).toBe(first!); // the same element, its stamp still playing
    expect(list.children.map((li) => li.className)).toEqual(["stub is-onchain m-stamped", "stub is-phone next"]);
    // a cut adds stubs after the ones shown: those stay, the new ones print in
    const cut = view({ tickets: { exported: 4, used: 1, left: 3 }, leaves: { onChain: [16], burned: [], inFlight: [], tickets: { from: 16, to: 19 } } });
    strip.draw(stubsOf(cut, leafStates(cut, [])), "0");
    expect(list.children[1]).toBe(second!);
    expect(list.children.map((li) => li.className)).toEqual(["stub is-onchain m-stamped", "stub is-phone next", "stub is-phone m-fresh", "stub is-phone m-fresh"]);
  });

  test("the roll changes the number's text; without element.animate it is just the new text, with no leftover figure", () => {
    const count = doc.createElement("span");
    root.append(count);
    rollNumber(count as unknown as Ticket, "7");
    rollNumber(count as unknown as Ticket, "6");
    expect([count.text, count.children.length, count.getAttribute("data-v")]).toEqual(["6", 0, "6"]);
    rollNumber(count as unknown as Ticket, "6", true); // unchanged: nothing to roll
    expect(count.text).toBe("6");
  });

  test("the tear is skipped where it cannot run: no element.animate (the fake DOM, old browsers), or less motion asked", () => {
    const ticket = doc.createElement("div");
    root.append(ticket);
    expect(tearTicket(ticket as unknown as Ticket)).toBe(false);
    expect(reducedMotion()).toBe(false); // no matchMedia here, no ?motion=reduce
    doc.documentElement.classList.add("reduce-motion");
    expect(reducedMotion()).toBe(true);
    (ticket as unknown as { animate: () => void }).animate = () => { throw new Error("must not animate under reduced motion"); };
    expect(tearTicket(ticket as unknown as Ticket)).toBe(false);
  });
});
