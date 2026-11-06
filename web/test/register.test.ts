// Pure key state, ticket counts and next-leaf invariants used by the React wallet.
import { describe, expect, test } from "bun:test";
import type { TxRecord, WalletView } from "../src/domain/api.js";
import { countStates, leafStates, nextTicket, stubsOf, type LeafState } from "../src/domain/register.js";


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
