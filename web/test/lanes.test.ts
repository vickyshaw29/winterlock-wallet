// lanes.js: rows from the backend's transaction records, their order, the status timeline from the backend's own
// timeline lines, retry links between an expired lane and its retry, and the "set aside for pending" line.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import { amountMark, changes, epochRule, laneRows, refusalOf, setAside, setAsideText, splitAmount, stampOf, statusOf, stepOf, stepsOf, tiltOf } from "../src/domain/lanes.js";
import { H, at, rec, receipt } from "./records.ts";

describe("status and steps", () => {
  test("each status in the spec's words; an expired lane shows its leaf burned", () => {
    expect(statusOf(rec({ status: "Submitted" }))).toEqual({ key: "admitted", label: "admitted", final: false });
    expect(statusOf(rec({ status: "Submitted", lines: [["Submitted (the mempool's answer was lost: followed by its key)", 0]] })).label).toBe("sent, answer lost");
    expect(statusOf(rec({ status: "OnChain" })).label).toBe("included");
    expect(statusOf(rec({ status: "Reverted" })).label).toBe("included, a frame reverted");
    expect(statusOf(rec({ status: "Included" })).label).toBe("included, no receipt yet");
    expect(statusOf(rec({ status: "Expired" }))).toEqual({ key: "expired", label: "expired, leaf burned", final: true });
    expect(statusOf(rec({ status: "Refused" })).label).toBe("refused, leaf burned");
    expect(statusOf(rec({ status: "Unknown" }))).toEqual({ key: "unknown", label: "unknown, still in flight", final: false });
  });

  test("an included lane: the backend's lines become admitted, pending, key used, included, once each, with block", () => {
    const r = rec({
      status: "OnChain", receipt: receipt(1003),
      lines: [["Submitted", 0], ["sidecar: New", 900], ["sidecar: OnChain", 5_100], ["chain: key used by block 1003", 5_200], ["chain: OnChain in block 1003", 5_300], ["OnChain in block 1003", 5_350]],
    });
    expect(stepsOf(r)).toEqual([
      { key: "admitted", label: "admitted", at: 0, block: null },
      { key: "pending", label: "pending", at: 900, block: null },
      { key: "key", label: "key used", at: 5_200, block: 1003 },
      { key: "included", label: "included", at: 5_300, block: 1003 },
    ]);
  });

  test("an expired lane that was retried: expired, then retried; a refusal; restart lines; a script's lane with no timeline", () => {
    const expired = rec({ status: "Expired", lines: [["Submitted", 0], ["sidecar: New", 1_000], ["chain: Expired (block 1009 is past the deadline, key unused)", 31_000], ["Expired", 31_050], [`retried as ${H(2)}`, 34_000]] });
    expect(stepsOf(expired).map((s) => [s.key, s.at])).toEqual([["admitted", 0], ["pending", 1_000], ["expired", 31_000], ["retried", 34_000]]);
    expect(stepsOf(rec({ status: "Refused", lines: [["Refused by the node's dry run", 0]] })).map((s) => s.key)).toEqual(["refused"]);
    expect(stepOf("settled after a restart: OnChain")?.key).toBe("included");
    expect(stepOf("from the journal at start: Expired")?.key).toBe("expired");
    expect(stepOf("Unknown: no outcome in time; never paid again automatically")?.key).toBe("unknown");
    expect(stepOf("sidecar: Cancelled")).toBeNull(); // shown in the row's detail, not on the board
    const script = rec({ status: "Expired", kind: null, mempool: null, to: null, valueWei: null, lines: [], createdAt: at(0), updatedAt: at(0) });
    expect(stepsOf(script)).toEqual([{ key: "expired", label: "expired, leaf burned", at: 0, block: null }]);
    const reverted = rec({ status: "Reverted", receipt: receipt(7), lines: [["Submitted", 0], ["Reverted in block 7", 3_000]] });
    expect(stepsOf(reverted).at(-1)).toEqual({ key: "reverted", label: "included, reverted", at: 3_000, block: 7 });
  });
});

describe("rows", () => {
  test("newest first by when the lane was signed, ties by hash; retries linked to their expired lane both ways", () => {
    const first = rec({ txHash: H(10), nonceKey: "0x10", leaf: 16, status: "Expired", retriedAs: H(11), createdAt: at(0), detail: "expired: key unused at block 1009, past the deadline" });
    const retry = rec({ txHash: H(11), nonceKey: "0x11", leaf: 17, status: "OnChain", retryOf: H(10), createdAt: at(34_000), simulation: { verifyGas: "60000", violations: [] } });
    const tieA = rec({ txHash: H(3), nonceKey: "0x3", leaf: 3, mode: "keyed", createdAt: at(5_000) });
    const tieB = rec({ txHash: H(4), nonceKey: "0x4", leaf: 4, mode: "keyed", createdAt: at(5_000) });
    const rows = laneRows([first, tieB, retry, tieA]);
    expect(rows.map((r) => r.hash)).toEqual([H(11), H(3), H(4), H(10)]);
    const [r0, , , r3] = rows;
    expect(r3).toMatchObject({ status: { label: "expired, leaf burned" }, retriedAs: H(11), retriedAsLane: "0x11", retryOf: null, pending: false });
    expect(r3!.reasons).toEqual(["expired: key unused at block 1009, past the deadline"]);
    expect(r0).toMatchObject({ retryOf: H(10), retryOfLane: "0x10", gas: "60,000", amount: "1,000 wei", action: "hot ticket to 0x5544…16f9", epoch: 0, leaf: 17 });
    expect(laneRows([tieA, tieB]).map((r) => r.hash)).toEqual(laneRows([tieB, tieA]).map((r) => r.hash));
  });

  test("actions, unknown fields of a script's lane, and refusal reasons without repeats", () => {
    const rows = laneRows([
      rec({ txHash: H(1), kind: "rotate", mode: "keyed", createdAt: at(3) }),
      rec({ txHash: H(2), kind: "hot-policy", mode: "keyed", createdAt: at(2) }),
      rec({ txHash: H(3), kind: null, mempool: null, to: null, valueWei: null, createdAt: at(1) }),
      rec({ txHash: H(4), mode: "keyed", status: "Refused", detail: "preflight refused", simulation: { verifyGas: null, violations: ["account: hot: value cap", "account: hot: value cap"] }, createdAt: at(0) }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(["rotate root", "set hot policy", "lane from a script", "pay 0x5544…16f9"]);
    expect(rows[2]).toMatchObject({ amount: "—", gas: "—", mempool: null, refusal: null });
    expect(rows[3]!.reasons).toEqual(["preflight refused", "account: hot: value cap"]);
    expect(rows[3]!.refusal).toEqual({ words: "exceeds value cap", reason: "account: hot: value cap" });
  });

  test("the account's refusals in the screens' words; other reasons are not renamed", () => {
    expect(refusalOf(["VERIFY frame 1 reverted", "frame 1 reverted", "account: hot: value cap"])).toEqual({ words: "exceeds value cap", reason: "account: hot: value cap" });
    expect(refusalOf(["account: hot: frame target"])?.words).toBe("target not allowed");
    expect(refusalOf(["account: hot: fee cap"])?.words).toBe("exceeds fee cap");
    expect(refusalOf(["account: sig: hash-based check"])).toBeNull();
    expect(refusalOf(["txpool: one pending frame transaction per sender"])).toBeNull();
    expect(refusalOf(undefined)).toBeNull();
    // only a refused row carries one
    expect(laneRows([rec({ status: "OnChain", simulation: { verifyGas: null, violations: ["account: hot: value cap"] } })])[0]!.refusal).toBeNull();
  });

  test("amounts at a glance, the exact value kept for the title", () => {
    const [row] = laneRows([rec({ valueWei: "2968364197253086" })]);
    expect([row!.amount, row!.amountExact]).toEqual(["0.00296836 ETH", "0.002968364197253086 ETH"]);
  });
});

describe("set aside for pending", () => {
  const wallet = { hotFeeCapWei: "2000000000000000" };

  test("hot lanes: their values plus the hot fee cap each; keyed lanes counted apart; final lanes not at all", () => {
    const records = [
      rec({ txHash: H(1), status: "Submitted", mode: "hot", valueWei: "1000" }),
      rec({ txHash: H(2), status: "Unknown", mode: "hot", valueWei: "2000" }),
      rec({ txHash: H(3), status: "Submitted", mode: "keyed", valueWei: "5" }),
      rec({ txHash: H(4), status: "OnChain", mode: "hot", valueWei: "9999" }),
      rec({ txHash: H(5), status: "Expired", mode: "hot", valueWei: "9999" }),
    ];
    const s = setAside(records, wallet);
    expect(s).toEqual({ lanes: 3, valuesWei: 3_005n, reported: 0, maxCostWei: 0n, feeBoundWei: 4n * 10n ** 15n, totalWei: 4n * 10n ** 15n + 3_005n, unbounded: 1 });
    expect(setAsideText(s)).toBe("set aside for pending: 0.004 ETH on 3 lanes (values, plus the hot fee cap for each of 2 tickets: an upper bound) plus the fees of 1 keyed lane, which the API does not report");
    expect(setAsideText(setAside([], wallet))).toBe("set aside for pending: nothing, no lane in flight");
    expect(setAsideText(setAside([records[2]!], wallet))).toBe("set aside for pending: 5 wei on 1 lane (values only) plus the fees of 1 keyed lane, which the API does not report");
  });

  test("maxCostWei on every pending lane: each lane's value plus the maximum cost the backend reports, and the line says so", () => {
    const records = [
      rec({ txHash: H(1), status: "Submitted", mode: "hot", valueWei: "1000", maxCostWei: "1500000000000000" }),
      rec({ txHash: H(2), status: "Submitted", mode: "keyed", valueWei: "5", maxCostWei: "1600000000000000" }),
      rec({ txHash: H(3), status: "OnChain", mode: "hot", valueWei: "9999", maxCostWei: "9999" }), // final: nothing set aside
    ];
    const s = setAside(records, wallet);
    expect(s).toEqual({ lanes: 2, valuesWei: 1_005n, reported: 2, maxCostWei: 31n * 10n ** 14n, feeBoundWei: 0n, totalWei: 31n * 10n ** 14n + 1_005n, unbounded: 0 });
    expect(setAsideText(s)).toBe("set aside for pending: 0.0031 ETH on 2 lanes (each lane's value plus the maximum cost the backend reports: what the sidecar sets aside)");
    expect(setAsideText(setAside([records[0]!], wallet))).toBe("set aside for pending: 0.0015 ETH on 1 lane (its value plus the maximum cost the backend reports: what the sidecar sets aside)");
  });

  test("some lanes with maxCostWei, some without: each counted its own way and named; a malformed one is not used", () => {
    const records = [
      rec({ txHash: H(1), status: "Submitted", mode: "hot", valueWei: "1000", maxCostWei: "1500000000000000" }),
      rec({ txHash: H(2), status: "Submitted", mode: "hot", valueWei: "2000", maxCostWei: null }),
      rec({ txHash: H(3), status: "Unknown", mode: "hot", valueWei: "3000", maxCostWei: "0x10" }), // not decimal wei: the hot fee cap instead
      rec({ txHash: H(4), status: "Submitted", mode: "keyed", valueWei: "5" }),
    ];
    const s = setAside(records, wallet);
    expect(s).toEqual({ lanes: 4, valuesWei: 6_005n, reported: 1, maxCostWei: 15n * 10n ** 14n, feeBoundWei: 4n * 10n ** 15n, totalWei: 55n * 10n ** 14n + 6_005n, unbounded: 1 });
    expect(setAsideText(s)).toBe("set aside for pending: 0.0055 ETH on 4 lanes (1 at value plus the maximum cost the backend reports, what the sidecar sets aside; 2 tickets at value plus the hot fee cap, an upper bound) plus the fees of 1 keyed lane, which the API does not report");
  });
});

test("changes between polls: new lanes and changed statuses, each once", () => {
  const seen = new Map();
  expect(changes(seen, [rec({ txHash: H(1) })]).map((c) => [c.rec.txHash, c.from])).toEqual([[H(1), null]]);
  expect(changes(seen, [rec({ txHash: H(1) })])).toEqual([]);
  expect(changes(seen, [rec({ txHash: H(1), status: "OnChain" })]).map((c) => [c.rec.status, c.from])).toEqual([["OnChain", "Submitted"]]);
});

describe("the ledger's marks (design note 1-ledger.md, section 4)", () => {
  test("the amount's rule by status: a double rule when the money moved, a single while no receipt says so, a strike when none moved", () => {
    const marks = (["Submitted", "Unknown", "OnChain", "Included", "Reverted", "Expired", "Refused"] as const).map((status) => [status, amountMark(rec({ status }))]);
    expect(marks).toEqual([["Submitted", null], ["Unknown", null], ["OnChain", "final"], ["Included", "single"], ["Reverted", "void"], ["Expired", "void"], ["Refused", "void"]]);
  });

  test("the stamp: the chain's block from the timeline or the receipt; by the signer for an expiry or a refusal; none while pending", () => {
    const [onChain] = laneRows([rec({ status: "OnChain", lines: [["Submitted", 0], ["chain: key used by block 408215", 5_000], ["chain: OnChain in block 408215", 5_100]] })]);
    expect(stampOf(onChain!)).toEqual({ by: "chain", block: 408_215, words: "in block 408,215" });
    const [fromReceipt] = laneRows([rec({ status: "OnChain", receipt: receipt(1003), lines: [["Submitted", 0]] })]);
    expect(stampOf(fromReceipt!)?.words).toBe("in block 1,003");
    const [keyOnly] = laneRows([rec({ status: "Included", lines: [["Submitted", 0], ["chain: key used by block 77", 6_000], ["Included by block 77", 6_100]] })]);
    expect(stampOf(keyOnly!)).toEqual({ by: "chain", block: 77, words: "in block 77" });
    const [reverted] = laneRows([rec({ status: "Reverted", receipt: receipt(9), lines: [["Submitted", 0], ["Reverted in block 9", 3_000]] })]);
    expect(stampOf(reverted!)?.words).toBe("in block 9"); // the key was used even though a frame reverted
    const [unknownBlock] = laneRows([rec({ status: "Included", lines: [["Submitted", 0]] })]);
    expect(stampOf(unknownBlock!)).toEqual({ by: "chain", block: null, words: "on chain" });
    for (const status of ["Expired", "Refused"] as const) expect(stampOf(laneRows([rec({ status })])[0]!)).toEqual({ by: "signer", block: null, words: "by the signer" });
    for (const status of ["Submitted", "Unknown"] as const) expect(stampOf(laneRows([rec({ status })])[0]!)).toBeNull();
  });

  test("the stamp's angle is fixed by the leaf, one of seven, never random", () => {
    expect([0, 1, 2, 1014, 1015].map(tiltOf)).toEqual([0, 2, 4, (1014 * 37) % 7, (1015 * 37) % 7]);
    expect(new Set(Array.from({ length: 70 }, (_, i) => tiltOf(i)))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
  });

  test("an amount split into figure and unit, with its decimals, so the board lines decimal points up", () => {
    expect(splitAmount("0.00296836 ETH")).toEqual({ fig: "0.00296836", unit: "ETH", decimals: 8 });
    expect(splitAmount("0 ETH")).toEqual({ fig: "0", unit: "ETH", decimals: 0 });
    expect(splitAmount("1,000 wei")).toEqual({ fig: "1,000", unit: "wei", decimals: 0 });
    expect(splitAmount("—")).toEqual({ fig: "—", unit: "", decimals: 0 });
  });

  test("a rotation rules the ledger off above the first lane of the older epoch, naming the rotation's block", () => {
    const rows = laneRows([
      rec({ txHash: H(3), nonceKey: "0x100000001", leaf: 1, createdAt: at(30_000) }),
      rec({ txHash: H(2), nonceKey: "0x5", leaf: 5, kind: "rotate", mode: "keyed", status: "OnChain", receipt: receipt(408_300), createdAt: at(20_000) }),
      rec({ txHash: H(1), nonceKey: "0x4", leaf: 4, createdAt: at(10_000) }),
    ]);
    expect(rows.map((_, i) => epochRule(rows, i))).toEqual([null, "Epoch 0 closed by the rotation in block 408,300. Lanes below this line belong to the old tree.", null]);
    const bare = laneRows([rec({ txHash: H(3), nonceKey: "0x100000001", leaf: 1, createdAt: at(30_000) }), rec({ txHash: H(1), nonceKey: "0x4", leaf: 4, createdAt: at(10_000) })]);
    expect(epochRule(bare, 1)).toBe("Epoch 0 closed by a rotation. Lanes below this line belong to the old tree.");
  });
});
