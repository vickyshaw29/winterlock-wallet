// board.js drawn on the fake DOM (test/fake-dom.ts): the empty line and a row's detail span all six columns; the
// backend's timeline steps keep their own words, with the row's status drawn apart; Enter or Space on a row's explorer
// link or retry button is left to that control instead of toggling the row; a refused row shows the account's words.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBoard } from "../public/board.js";
import { laneRows } from "../public/lanes.js";
import { FakeDocument, FakeElement, FakeEvent, installDom } from "./fake-dom.ts";
import { H, rec, receipt } from "./records.ts";

let doc: FakeDocument, root: FakeElement, restore: () => void;
beforeEach(() => {
  doc = new FakeDocument();
  restore = installDom(doc);
  root = doc.createElement("div");
  doc.body.append(root);
});
afterEach(() => restore());

const mount = () => createBoard(root as unknown as Parameters<typeof createBoard>[0], { empty: "No lanes yet." });
const rowOf = (hash: string) => root.querySelector(`tr[data-hash="${hash}"]`)!;
const steps = (hash: string) => rowOf(hash).querySelectorAll("li.step").map((li) => li.querySelector(".step-label")!.text);
const status = (hash: string) => rowOf(hash).querySelector(".row-status")!.text;

describe("columns", () => {
  test("six headers; the empty line and an opened row's detail span all six columns", () => {
    const board = mount();
    expect(root.querySelectorAll("th").map((th) => th.text)).toEqual(["Lane", "Leaf", "Action", "Amount", "Gas", "Status"]);
    board.render([]);
    const empty = root.querySelector("td.empty")!;
    expect([empty.text, empty.getAttribute("colspan")]).toEqual(["No lanes yet.", "6"]);
    board.render(laneRows([rec({ txHash: H(1) })]));
    expect(root.querySelector("tr.detail-row")).toBeNull();
    rowOf(H(1)).click();
    const detail = root.querySelector("tr.detail-row")!;
    expect(detail.children.map((td) => [td.localName, td.getAttribute("colspan")])).toEqual([["td", "6"]]);
    expect(rowOf(H(1)).getAttribute("aria-expanded")).toBe("true");
    expect(rowOf(H(1)).children).toHaveLength(6);
  });

  test("the lane column widens once a lane carries its epoch (after a rotation), and only then", () => {
    const board = mount();
    const table = () => root.querySelector("table")!;
    board.render(laneRows([rec({ txHash: H(1), leaf: 1023, nonceKey: "0x3ff" })]));
    expect(table().classList.contains("long-lanes")).toBe(false);
    board.render(laneRows([rec({ txHash: H(2), leaf: 1008, nonceKey: "0x1000003f0" }), rec({ txHash: H(1), leaf: 1023, nonceKey: "0x3ff" })]));
    expect([table().classList.contains("long-lanes"), rowOf(H(2)).querySelector(".sn")!.text]).toEqual([true, "0x1000003f0"]);
  });

  test("an opened row names the max cost the backend reports for it, and says nothing of one it does not report", () => {
    const board = mount();
    const facts = () => root.querySelector("tr.detail-row")!.querySelectorAll(".kv").map((kv) => [kv.querySelector("dt")!.text, kv.querySelector("dd")!.text]);
    board.render(laneRows([rec({ txHash: H(1), maxCostWei: "1500000000000000" }), rec({ txHash: H(2), createdAt: "2026-11-06T09:00:00.000Z" })]));
    rowOf(H(1)).click();
    expect(facts()).toContainEqual(["max cost (the backend's)", "0.0015 ETH"]);
    rowOf(H(2)).click();
    expect(facts().map(([k]) => k)).not.toContain("max cost (the backend's)");
  });
});

describe("status and timeline", () => {
  test("a pending lane: steps admitted, pending in their own words; the status admitted beside them, once", () => {
    const board = mount();
    board.render(laneRows([rec({ txHash: H(1), lines: [["Submitted", 0], ["sidecar: New", 900]] })]));
    expect(steps(H(1))).toEqual(["admitted", "pending"]);
    expect(status(H(1))).toBe("admitted");
    expect(rowOf(H(1)).querySelector("li.current")!.querySelector(".step-label")!.text).toBe("pending");
  });

  test("an included lane: no separate key-used tick (the stamp names the block); a lane the chain only shows as key used keeps it", () => {
    const board = mount();
    board.render(laneRows([
      rec({ txHash: H(1), status: "OnChain", receipt: receipt(1003), lines: [["Submitted", 0], ["sidecar: New", 900], ["chain: key used by block 1003", 5_200], ["OnChain in block 1003", 5_300]] }),
      rec({ txHash: H(2), status: "Unknown", createdAt: "2026-11-06T09:00:00.000Z", lines: [["Submitted", 0], ["chain: key used by block 1004", 6_000], ["Unknown: no outcome in time; never paid again automatically", 9_000]] }),
    ]));
    expect(steps(H(1))).toEqual(["admitted", "pending", "included"]);
    expect(rowOf(H(1)).querySelector("li.step-included")!.title).toBe("block 1003");
    expect(steps(H(2))).toEqual(["admitted", "key used", "unknown"]);
  });

  test("an expired lane that was retried keeps its retried step; the status says expired, leaf burned", () => {
    const board = mount();
    const expired = rec({
      txHash: H(1), status: "Expired", retriedAs: H(2),
      lines: [["Submitted", 0], ["sidecar: New", 1_000], ["chain: Expired (block 1009 is past the deadline, key unused)", 31_000], ["Expired", 31_050], [`retried as ${H(2)}`, 34_000]],
    });
    board.render(laneRows([expired, rec({ txHash: H(2), nonceKey: "0x11", leaf: 17, retryOf: H(1), createdAt: expired.updatedAt })]));
    expect(steps(H(1))).toEqual(["admitted", "pending", "expired, leaf burned", "retried on a fresh lane"]);
    expect(status(H(1))).toBe("expired, leaf burned");
    expect(rowOf(H(1)).querySelector("button.link")!.text).toBe("retried as lane 0x11");
    expect(rowOf(H(2)).querySelector("button.link")!.text).toBe("retry of lane 0x10");
  });

  test("a refusal by the account: its words and its reason on the row; the exact amount in the cell's title", () => {
    const board = mount();
    board.render(laneRows([
      rec({ txHash: H(1), status: "Refused", valueWei: "100000000000000000", lines: [["Refused by the node's dry run", 0]], simulation: { verifyGas: null, violations: ["VERIFY frame 1 reverted", "account: hot: value cap"] } }),
      rec({ txHash: H(2), status: "Refused", lines: [["Refused by the node's dry run", 0]], simulation: { verifyGas: null, violations: ["account: hot: frame target"] } }),
      rec({ txHash: H(3), status: "OnChain", valueWei: "2968364197253086", lines: [["Submitted", 0], ["OnChain in block 7", 3_000]] }),
    ]));
    expect(status(H(1))).toBe("refused, leaf burned");
    expect(rowOf(H(1)).querySelector(".refusal")!.text).toBe("exceeds value cap (account: hot: value cap)");
    expect(rowOf(H(2)).querySelector(".refusal")!.text).toBe("target not allowed (account: hot: frame target)");
    expect(rowOf(H(3)).querySelector(".refusal")).toBeNull();
    const amount = rowOf(H(3)).querySelector('td[data-label="Amount"]')!;
    expect([amount.text, amount.title]).toEqual(["0.00296836 ETH", "0.002968364197253086 ETH"]);
  });
});

describe("keys", () => {
  test("Enter or Space on the explorer link or the retry button goes to that control; on the row it toggles", () => {
    const board = mount();
    board.render(laneRows([rec({ txHash: H(2), status: "OnChain", retryOf: H(1), nonceKey: "0x11" }), rec({ txHash: H(1), status: "Expired", retriedAs: H(2) })]));
    const row = rowOf(H(2));
    for (const [control, key] of [[row.querySelector("a.explorer")!, "Enter"], [row.querySelector("a.explorer")!, " "], [row.querySelector("button.link")!, "Enter"], [row.querySelector("button.link")!, " "]] as const) {
      const ev = new FakeEvent("keydown", { key });
      control.dispatchEvent(ev);
      expect([control.localName, key, ev.defaultPrevented, board.selected]).toEqual([control.localName, key, false, null]);
    }
    expect(root.querySelector("tr.detail-row")).toBeNull();
    const own = new FakeEvent("keydown", { key: "Enter" });
    row.dispatchEvent(own);
    expect([own.defaultPrevented, board.selected]).toEqual([true, H(2)]);
    expect(root.querySelector("tr.detail-row")).not.toBeNull();
    row.dispatchEvent(new FakeEvent("keydown", { key: " " }));
    expect(board.selected).toBeNull();
  });

  test("a click on the explorer link does not toggle the row; a click on the retry button opens the other lane", () => {
    const board = mount();
    board.render(laneRows([rec({ txHash: H(2), status: "OnChain", retryOf: H(1), nonceKey: "0x11" }), rec({ txHash: H(1), status: "Expired", retriedAs: H(2) })]));
    rowOf(H(2)).querySelector("a.explorer")!.click();
    expect(board.selected).toBeNull();
    rowOf(H(2)).querySelector("button.link")!.click();
    expect(board.selected).toBe(H(1));
  });
});

describe("the ledger (design note 1-ledger.md, sections 4 and 5)", () => {
  const amount = (hash: string) => rowOf(hash).querySelector('td[data-label="Amount"]')!.querySelector(".amt")!;
  const stamp = (hash: string) => rowOf(hash).querySelector(".stamp");
  const included = (n: number, block: number, over = {}) => rec({ txHash: H(n), status: "OnChain", receipt: receipt(block), lines: [["Submitted", 0], [`OnChain in block ${block}`, 5_000]], ...over });

  test("the stamp on every final line: the chain's block, or by the signer; none while pending; at a fixed angle", () => {
    const board = mount();
    board.render(laneRows([
      included(1, 408_215, { leaf: 1014, createdAt: "2026-11-06T10:00:03.000Z" }),
      rec({ txHash: H(2), status: "Refused", createdAt: "2026-11-06T10:00:02.000Z", lines: [["Refused by the node's dry run", 0]] }),
      rec({ txHash: H(3), status: "Expired", createdAt: "2026-11-06T10:00:01.000Z", lines: [["Submitted", 0], ["Expired", 31_000]] }),
      rec({ txHash: H(4) }),
    ]));
    expect([stamp(H(1))!.text, stamp(H(2))!.text, stamp(H(3))!.text, stamp(H(4))]).toEqual(["burned in block 408,215", "burned by the signer", "burned by the signer", null]);
    expect(stamp(H(1))!.className).toBe(`stamp tilt-${(1014 * 37) % 7}`); // settled: no landing on the first draw
  });

  test("amounts: a double rule when included, a strike when no money moved, none while pending; decimal points lined up", () => {
    const board = mount();
    board.render(laneRows([
      included(1, 7, { valueWei: "10000000000000000", createdAt: "2026-11-06T10:00:03.000Z" }), // 0.01 ETH
      rec({ txHash: H(2), status: "Expired", valueWei: "1000000000000000", createdAt: "2026-11-06T10:00:02.000Z" }), // 0.001 ETH
      rec({ txHash: H(3), valueWei: "250000000000000000", createdAt: "2026-11-06T10:00:01.000Z" }), // 0.25 ETH
      rec({ txHash: H(4), status: "Included", valueWei: "0", createdAt: "2026-11-06T10:00:00.000Z" }),
    ]));
    expect([H(1), H(2), H(3), H(4)].map((h) => amount(h).className)).toEqual(["amt final", "amt void", "amt", "amt single"]);
    // each figure padded with hidden zeros to the longest fraction, three decimals here
    expect([H(1), H(2), H(3), H(4)].map((h) => [amount(h).querySelector(".fig")!.text, amount(h).querySelector(".pad")?.text ?? ""]))
      .toEqual([["0.01", "0"], ["0.001", ""], ["0.25", "0"], ["0", ".000"]]);
    expect(amount(H(1)).querySelector(".pad")!.getAttribute("aria-hidden")).toBe("true");
    expect(amount(H(1)).getAttribute("aria-label")).toBe("0.01 ETH, included: the money moved");
  });

  test("the moments, each once per lane and never on load: a new lane is written; a lane that becomes final is stamped and ruled", () => {
    const board = mount();
    const pending = rec({ txHash: H(1), createdAt: "2026-11-06T10:00:00.000Z" });
    board.render(laneRows([included(9, 3, { createdAt: "2026-11-06T09:00:00.000Z" })])); // on load: nothing moves
    expect([rowOf(H(9)).className.includes("m-writing"), stamp(H(9))!.className.includes("m-landing")]).toEqual([false, false]);
    board.render(laneRows([pending, included(9, 3, { createdAt: "2026-11-06T09:00:00.000Z" })]));
    expect([rowOf(H(1)).className.includes("m-writing"), rowOf(H(9)).className.includes("m-writing")]).toEqual([true, false]);
    const landed = included(1, 1003, { createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:06.000Z" });
    board.render(laneRows([landed, included(9, 3, { createdAt: "2026-11-06T09:00:00.000Z" })]));
    expect([rowOf(H(1)).className.includes("m-writing"), stamp(H(1))!.className.includes("m-landing"), amount(H(1)).className]).toEqual([false, true, "amt final m-draw"]);
    expect(stamp(H(1))!.text).toBe("burned in block 1,003");
    rowOf(H(1)).click(); // a redraw (the voucher opens) replays nothing
    expect([stamp(H(1))!.className.includes("m-landing"), amount(H(1)).className]).toEqual([false, "amt final"]);
    // a lane refused at once (the public mempool's second lane) is written and stamped in the same draw
    board.render(laneRows([rec({ txHash: H(2), status: "Refused", createdAt: "2026-11-06T10:01:00.000Z" }), landed, included(9, 3, { createdAt: "2026-11-06T09:00:00.000Z" })]));
    expect([rowOf(H(2)).className.includes("m-writing"), stamp(H(2))!.className, stamp(H(2))!.text]).toEqual([true, `stamp tilt-${(16 * 37) % 7} m-landing`, "burned by the signer"]);
  });

  test("a rotation rules the ledger off between epochs: a full-width line naming the closed epoch and the rotation's block", () => {
    const board = mount();
    board.render(laneRows([
      rec({ txHash: H(3), nonceKey: "0x100000001", leaf: 1, createdAt: "2026-11-06T10:00:03.000Z" }),
      rec({ txHash: H(2), nonceKey: "0x5", leaf: 5, kind: "rotate", mode: "keyed", status: "OnChain", receipt: receipt(1200), createdAt: "2026-11-06T10:00:02.000Z" }),
    ]));
    const rows = root.querySelector("tbody")!.children;
    expect(rows.map((tr) => tr.className.split(" ")[0])).toEqual(["lane-row", "ruled", "lane-row"]);
    expect([rows[1]!.text, rows[1]!.children[0]!.getAttribute("colspan")]).toEqual(["Epoch 0 closed by the rotation in block 1,200. Lanes below this line belong to the old tree.", "6"]);
  });

  test("a pending lane's live expiry is a ring in its timeline, not a step; past the deadline it says so", () => {
    const board = mount();
    const soon = Math.floor(Date.now() / 1000) + 84;
    board.render(laneRows([rec({ txHash: H(1), deadline: soon, lines: [["Submitted", 0], ["sidecar: New", 900]] }), rec({ txHash: H(2), status: "OnChain", deadline: soon, createdAt: "2026-11-06T09:00:00.000Z" })]));
    const ring = rowOf(H(1)).querySelector("li.wait")!;
    expect(ring.text).toMatch(/^expiry in (84|83) s$/);
    expect(steps(H(1))).toEqual(["admitted", "pending"]); // the ring is not a step
    expect(rowOf(H(2)).querySelector("li.wait")).toBeNull(); // only while pending
    board.stop();
    board.render(laneRows([rec({ txHash: H(1), deadline: 1_762_423_290, updatedAt: "2026-11-06T10:00:09.000Z" })]));
    expect(rowOf(H(1)).querySelector("li.wait")!.text).toBe("expiry passed");
  });
});
