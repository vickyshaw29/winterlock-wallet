// board.js drawn on the fake DOM (test/fake-dom.ts): the empty line and a row's detail span all six columns; the
// backend's timeline steps keep their own words, with the row's status drawn apart; Enter or Space on a row's explorer
// link or retry button is left to that control instead of toggling the row; a refused row shows the account's words.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBoard } from "../public/board.js";
import { laneRows } from "../public/lanes.js";
import { FakeDocument, FakeElement, FakeEvent, installDom } from "./fake-dom.ts";
import { H, rec } from "./records.ts";

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
