// The backend after a stop (I10): the transaction store read back at startup, settleSubmitted following the lanes a
// previous process left in flight and writing their outcomes into the store, and leaves left reserved burned.
// A "stop" here is close() then open() on the same directories; the follow that would outlive it is made to give up
// first by a node that goes dark, so the next process inherits a lane whose outcome it must find itself.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { LeafJournal, node } from "../../pipeline/src/index.ts";
import { lost } from "./fake-chain.ts";
import { Harness, TARGET } from "./helpers.ts";

let h: Harness;
let a: Address;
beforeEach(async () => { h = await Harness.create(); a = await h.wallet(); });
afterEach(async () => { await h.destroy(); });

const send = (body: Record<string, unknown> = { to: TARGET, valueWei: "1" }) => h.req("POST", `/wallets/${a}/send`, body);
const leaf = (n: number) => h.coldJournal(a).leaves[n];

/** A lane whose follow gave up (Unknown) while the chain did or did not include it; then a stop. */
async function inheritedLane(land: boolean) {
  h.chain.autoInclude = false;
  const r = await send({ to: TARGET, valueWei: "7", expirySeconds: 2 });
  expect(r.status).toBe(200);
  const fakeStorageAt = node.storageAt; // the fake chain's, installed by the harness
  node.storageAt = async () => { throw lost("eth_getStorageAt"); };
  try {
    if (land) expect(h.chain.mine()).toEqual([r.body.txHash]);
    expect((await h.settle(r.body.txHash, "Unknown", 10_000)).status).toBe("Unknown");
    expect(leaf(r.body.leaf).status).toBe("submitted"); // still in flight: never burned, never re-sent
    await h.close();
  } finally {
    node.storageAt = fakeStorageAt;
  }
  return r.body as { txHash: string; leaf: number };
}

describe("after a stop", () => {
  test("the transaction store is read back: every record as it was", async () => {
    const r = await send();
    const before = await h.settle(r.body.txHash);
    const board = (await h.req("GET", `/wallets/${a}/txs`)).body;
    await h.close();
    h.open();
    expect((await h.req("GET", `/tx/${r.body.txHash}`)).body).toEqual(before);
    expect((await h.req("GET", `/wallets/${a}/txs`)).body).toEqual(board);
  });

  test("settleSubmitted finishes a lane the last process left in flight: OnChain, journal and store", async () => {
    const lane = await inheritedLane(true);
    h.open();
    const tx = await h.settle(lane.txHash, "OnChain", 10_000);
    expect(tx).toMatchObject({ status: "OnChain", to: TARGET, valueWei: "7", mode: "keyed", mempool: "alt" }); // the stored fields survive
    expect(tx.receipt.blockNumber).toMatch(/^0x/);
    expect(tx.timeline.map((t: any) => t.status)).toContain("settled after a restart: OnChain");
    expect([leaf(lane.leaf).status, leaf(lane.leaf).note]).toEqual(["onchain", expect.stringContaining("settled: OnChain")]);
    expect(h.chain.balance(TARGET)).toBe(7n);
    expect(h.chain.sent.length).toBe(1); // followed, never sent again
  }, 20_000);

  test("a lane that never landed is settled Expired at the next start, its leaf burned, nothing paid again (I7)", async () => {
    const lane = await inheritedLane(false);
    h.open();
    const tx = await h.settle(lane.txHash, "Expired", 10_000);
    expect(tx.timeline.map((t: any) => t.status)).toContain("settled after a restart: Expired");
    expect(leaf(lane.leaf).status).toBe("burned");
    await h.app.backend.idle();
    expect([h.chain.sent.length, h.chain.balance(TARGET)]).toEqual([1, 0n]);
    expect((await h.req("GET", `/wallets/${a}`)).body.lanesInFlight).toBe(0);
  }, 20_000);

  test("a leaf left reserved by a process that ended is burned when the journal opens, and never signs", async () => {
    await h.close();
    const rec = h.record(a);
    const j = LeafJournal.open(`${rec.tree.seedFile}.journal-epoch0.json`, { wallet: a, chainId: 1337n, epoch: 0, height: 4, treeSeed: rec.tree.treeSeed });
    j.reserveNext({ from: 0, to: 12 }); // leaf 1, reserved and never submitted: the process stopped
    j.close();
    h.open();
    await h.app.backend.idle();
    expect((await h.req("GET", `/wallets/${a}`)).body.lanesInFlight).toBe(0);
    expect([leaf(1).status, leaf(1).note]).toEqual(["burned", expect.stringContaining("reserved by a process that ended")]);
    const r = await send();
    expect(r.body.leaf).toBe(2);
    expect(h.logs.some((l) => l.includes("burned 1 stale reservation(s): 1"))).toBe(true);
  });

  test("a store record left Submitted after its journal leaf ended is reconciled from the journal at start", async () => {
    const r = await send();
    await h.settle(r.body.txHash, "OnChain");
    await h.close();
    // a stop between the journal's write and the store's: the store still says Submitted
    const file = path.join(h.dirs.backendDir, "txs.json");
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    store.txs[0].status = "Submitted";
    fs.writeFileSync(file, JSON.stringify(store));
    h.open();
    await h.app.backend.idle();
    const tx = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
    expect(tx.status).toBe("OnChain");
    expect(tx.timeline.at(-1).status).toBe("from the journal at start: OnChain");
  });
});
