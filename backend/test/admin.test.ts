// The two admin calls against the fake chain: POST /wallets/:address/rotate (I8, I9) and POST /wallets/:address/hot-policy.
// Rotation waits for every lane, refuses every send, cut and policy change while it is pending, creates the new epoch's
// journal before the rotate call leaves, and switches only once the chain shows the new epoch and root.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, decodeFunctionData, getAddress, hexToBytes, zeroAddress, type Address, type Hex } from "viem";
import { DEFAULTS, LeafJournal, gateway, node, nonceKeyFor, type FrameTransaction } from "../../pipeline/src/index.ts";
import { Keyring } from "../../pipeline/src/hashsig/keyring.ts";
import { ACCOUNT_ABI } from "../src/chain.ts";
import { FACTORY, IMPLEMENTATION, lost } from "./fake-chain.ts";
import { Harness, OTHER, TARGET, requireCli, until } from "./helpers.ts";

let h: Harness;
let a: Address;
beforeEach(async () => { h = await Harness.create(); a = await h.wallet(); }); // height 4, hotStart 12
afterEach(async () => { await h.destroy(); });

const rotate = (body: unknown = { height: 4 }, who: string = a) => h.req("POST", `/wallets/${who}/rotate`, body);
const policy = (over: Record<string, unknown> = {}, who: string = a) => h.req("POST", `/wallets/${who}/hot-policy`, {
  hotStart: 10, valueCapWei: "5000", feeCapWei: "1000000000000000", allowedTarget: OTHER, ...over,
});
const send = (body: Record<string, unknown> = { to: TARGET, valueWei: "1" }) => h.req("POST", `/wallets/${a}/send`, body);
const coldLeaves = (epoch = 0) => Object.values(h.coldJournal(a, epoch).leaves) as any[];
const journalFile = (epoch: number) => `${h.record(a).tree.seedFile}.journal-epoch${epoch}.json`;
const isRotate = (tx: FrameTransaction) => tx.frames[2]?.data.startsWith("0x6c6f2d65") ?? false;
const switched = () => until(() => h.record(a).tree.generation === 1 && !h.record(a).rotation, 5_000, "the switch to epoch 1");

describe("rotation", () => {
  test("refused while a lane is in flight; allowed once it has landed", async () => {
    h.chain.autoInclude = false;
    const lane = await send();
    expect(lane.status).toBe(200);
    const r = await rotate();
    expect([r.status, r.body.error]).toEqual([409, "lanes_in_flight"]);
    expect(r.body.detail).toContain("1 lane(s)");
    expect([h.record(a).rotation, fs.existsSync(journalFile(1))]).toEqual([undefined, false]);
    h.chain.mine();
    await h.settle(lane.body.txHash, "OnChain");
    h.chain.autoInclude = true;
    expect((await rotate()).status).toBe(200);
    await switched();
  });

  test("refused while a hot lane is in flight on the ticket device", async () => {
    requireCli();
    expect((await h.req("POST", `/wallets/${a}/tickets`, { count: 1 })).status).toBe(200);
    h.chain.autoInclude = false;
    expect((await send({ to: TARGET, valueWei: "1", mode: "hot" })).status).toBe(200);
    const r = await rotate();
    expect([r.status, r.body.error]).toEqual([409, "lanes_in_flight"]);
    h.chain.mine();
  });

  test("refused while a send has started but not yet reserved its leaf (I8: the busy count)", async () => {
    const gate = Promise.withResolvers<void>();
    const realPrice = gateway.gasPrice;
    let waiting = false;
    gateway.gasPrice = async () => { waiting = true; await gate.promise; return realPrice(); }; // sendKeyed reads fees before it reserves
    try {
      const started = send();
      await until(() => waiting, 5_000, "the send to reach its fee read");
      expect(coldLeaves()).toEqual([]); // no leaf reserved yet: only the busy count stands between it and a rotation
      const r = await rotate();
      expect([r.status, r.body.error]).toEqual([409, "lanes_in_flight"]);
      expect(r.body.detail).toContain("1 request(s)");
      expect([h.record(a).rotation, fs.existsSync(journalFile(1))]).toEqual([undefined, false]);
      gateway.gasPrice = realPrice;
      gate.resolve();
      const s = await started;
      expect((await h.settle(s.body.txHash)).status).toBe("OnChain");
      expect((await rotate()).status).toBe(200);
      await switched();
    } finally {
      gateway.gasPrice = realPrice;
      gate.resolve();
    }
  });

  test("a hybrid account: keyed sends and admin calls are 409 hybrid_unsupported before anything is spent; hot sends go", async () => {
    requireCli();
    expect((await h.req("POST", `/wallets/${a}/tickets`, { count: 1 })).status).toBe(200); // a cut signs nothing
    h.chain.account(a)!.hybrid = true;
    for (const [p, body] of [
      ["send", { to: TARGET, valueWei: "1" }], ["send", { to: OTHER, data: "0x12345678" }],
      ["hot-policy", { hotStart: 12, valueCapWei: "1", feeCapWei: "1", allowedTarget: TARGET }], ["rotate", { height: 4 }],
    ] as const) {
      const r = await h.req("POST", `/wallets/${a}/${p}`, body);
      expect([r.status, r.body.error]).toEqual([409, "hybrid_unsupported"]);
    }
    expect([coldLeaves().filter((l) => l.status !== "exported"), h.chain.calls.estimate, h.chain.calls.simulate]).toEqual([[], 0, 0]);
    expect([h.record(a).rotation, fs.existsSync(journalFile(1))]).toEqual([undefined, false]);
    const hot = await send({ to: TARGET, valueWei: "1", mode: "hot" }); // a hot leaf needs no co-signature
    expect((await h.settle(hot.body.txHash)).status).toBe("OnChain");
  });

  test("pending: every send, cut, policy change and second rotation is refused; the switch waits for the chain", async () => {
    h.chain.autoInclude = false;
    const seen: { journalAtSend: boolean | null } = { journalAtSend: null };
    const realSend = gateway.send;
    gateway.send = async (tx) => { if (isRotate(tx)) seen.journalAtSend = fs.existsSync(journalFile(1)); return realSend(tx); };
    const r = await rotate();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["epoch", "newRoot", "txHash"]);
    expect(r.body.epoch).toBe(1);
    // the new epoch's journal existed before the rotate call left (I8), with the new tree's identity
    expect(seen.journalAtSend).toBe(true);
    const fresh = JSON.parse(fs.readFileSync(journalFile(1), "utf8"));
    expect([fresh.epoch, fresh.height, fresh.leaves]).toEqual([1, 4, {}]);
    const call = decodeFunctionData({ abi: ACCOUNT_ABI, data: h.chain.sent.find(isRotate)!.frames[2]!.data });
    expect(call.args).toEqual([r.body.newRoot, fresh.treeSeed, 4]);

    // while it is pending: the wallet stays on epoch 0, and nothing that may sign starts
    const before = coldLeaves().length;
    for (const res of [await send(), await h.req("POST", `/wallets/${a}/tickets`, { count: 1 }), await policy(), await rotate()]) {
      expect([res.status, res.body.error]).toEqual([409, "rotation_pending"]);
    }
    expect(coldLeaves().length).toBe(before);
    const view = (await h.req("GET", `/wallets/${a}`)).body;
    expect([view.epoch, view.rotationPending, h.record(a).tree.generation]).toEqual([0, true, 0]);

    // the chain shows the new tree: then, and only then, the wallet switches
    h.chain.mine();
    await switched();
    const after = (await h.req("GET", `/wallets/${a}`)).body;
    expect([after.epoch, after.root, after.rotationPending, after.leavesUsed]).toEqual([1, r.body.newRoot, false, 0]);
    expect(h.record(a).epochs.map((e: any) => e.epoch)).toEqual([0, 1]);
    h.chain.autoInclude = true;
    // leaf 0 signs at epoch 1 (its key is 1 << 32, not the legacy nonce); the old epoch's journal is left alone
    const next = await send();
    expect([next.status, next.body.leaf, next.body.nonceKeys]).toEqual([200, 0, [`0x${nonceKeyFor(1, 0).toString(16)}`]]);
    expect((await h.settle(next.body.txHash)).status).toBe("OnChain");
    expect(coldLeaves(0).length).toBe(before);
    gateway.send = realSend;
  });

  test("a rotate that lands but leaves the chain on the old tree (its frame reverted) is dropped: no switch", async () => {
    const realAdmin = h.chain.admin.bind(h.chain);
    // the dry run passes, the frame reverts in the block: the chain never shows the new tree
    h.chain.admin = (acc, data, apply) => (apply && data.startsWith("0x6c6f2d65") ? "out of gas" : realAdmin(acc, data, apply));
    const r = await rotate();
    expect(r.status).toBe(200);
    expect((await h.settle(r.body.txHash)).status).toBe("Reverted");
    await until(() => !h.record(a).rotation, 5_000, "the rotation to be dropped");
    expect(h.record(a).tree.generation).toBe(0);
    const view = (await h.req("GET", `/wallets/${a}`)).body;
    expect([view.epoch, view.rotationPending]).toEqual([0, false]);
    expect(h.logs.some((l) => l.includes("dropped: the chain does not show the new tree"))).toBe(true);
    // the wallet goes on with its old tree
    const next = await send();
    expect([next.status, next.body.nonceKeys[0]]).toEqual([200, `0x${nonceKeyFor(0, next.body.leaf).toString(16)}`]);
  });

  test("a rotate refused by the dry run: 422, the rotation dropped at once, sends work again", async () => {
    const realAdmin = h.chain.admin.bind(h.chain);
    h.chain.admin = (acc, data, apply) => (data.startsWith("0x6c6f2d65") ? "rotate: same tree" : realAdmin(acc, data, apply));
    const r = await rotate();
    expect([r.status, r.body.error]).toEqual([422, "refused"]);
    expect(r.body.simulation.violations).toContain("account: rotate: same tree");
    expect([h.record(a).rotation, h.record(a).tree.generation]).toEqual([undefined, 0]);
    expect((await send()).status).toBe(200);
  });

  test("after a dropped rotation the next epoch keeps its height: another height is 409, the same one rotates", async () => {
    const realAdmin = h.chain.admin.bind(h.chain);
    h.chain.admin = (acc, data, apply) => (data.startsWith("0x6c6f2d65") ? "rotate: same tree" : realAdmin(acc, data, apply));
    expect((await rotate({ height: 4 })).status).toBe(422); // dropped; the epoch 1 journal (height 4) stays
    h.chain.admin = realAdmin;
    const other = await rotate({ height: 5 });
    expect([other.status, other.body.error]).toEqual([409, "cannot_rotate"]);
    expect(other.body.detail).toContain("used height 4");
    expect(h.record(a).rotation).toBeUndefined();
    const same = await rotate({ height: 4 });
    expect(same.status).toBe(200);
    await switched();
    expect(JSON.parse(fs.readFileSync(journalFile(1), "utf8")).height).toBe(4);
  });

  test("400 for a bad height or field, 404 for an unknown wallet; nothing spent", async () => {
    for (const [body, why] of [
      [{}, /height is required/], [{ height: 1 }, /from 2 to 12/], [{ height: 13 }, /from 2 to 12/], [{ height: "4" }, /height must be/],
      [{ height: 4, root: "0x" }, /unknown field root/],
    ] as const) {
      const r = await rotate(body);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    expect((await rotate({ height: 4 }, "0x000000000000000000000000000000000000dEaD")).status).toBe(404);
    expect(coldLeaves()).toEqual([]);
    expect(fs.existsSync(journalFile(1))).toBe(false);
  });

  test("409 tree_mismatch (I9), 502 when the node cannot be read, 503 when the chain is stalled; nothing spent", async () => {
    const root = h.chain.account(a)!.root;
    h.chain.account(a)!.root = `0x${"77".repeat(32)}` as Hex;
    let r = await rotate();
    expect([r.status, r.body.error]).toEqual([409, "tree_mismatch"]);
    h.chain.account(a)!.root = root;
    const realCall = node.call;
    node.call = async () => { throw lost("eth_call"); };
    r = await rotate();
    expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    node.call = realCall;
    h.chain.halted = true;
    r = await rotate();
    expect([r.status, r.body.error]).toEqual([503, "chain_stalled"]);
    expect(coldLeaves()).toEqual([]);
    expect([h.record(a).rotation, fs.existsSync(journalFile(1))]).toEqual([undefined, false]);
    h.chain.halted = false;
    expect((await rotate()).status).toBe(200); // nothing was left pending by the refusals
    await switched();
  });

  test("a pending rotation whose outcome was unknown is decided from the chain at the next start", async () => {
    const saved = DEFAULTS.expirySeconds;
    (DEFAULTS as { expirySeconds: number }).expirySeconds = 2; // the rotate call takes the default expiry
    const realStorageAt = node.storageAt;
    try {
      h.chain.autoInclude = false;
      const r = await rotate();
      expect(r.status).toBe(200);
      node.storageAt = async () => { throw lost("eth_getStorageAt"); }; // the node goes dark for the follow...
      h.chain.mine(); // ...while the rotate lands
      expect((await h.settle(r.body.txHash, "Unknown", 10_000)).detail).toContain("no outcome");
      await h.app.backend.idle();
      expect([h.record(a).rotation?.txHash, h.record(a).tree.generation]).toEqual([r.body.txHash, 0]); // still pending
      await h.close();
      node.storageAt = realStorageAt;
      h.open(); // the next start settles the lane, then decides the rotation from the chain
      await switched();
      expect((await h.req("GET", `/tx/${r.body.txHash}`)).body.status).toBe("OnChain");
    } finally {
      (DEFAULTS as { expirySeconds: number }).expirySeconds = saved;
      node.storageAt = realStorageAt;
    }
  }, 20_000);

  test("a rotation left Unknown is looked at again in-process until the chain decides it: no restart (F, default 7)", async () => {
    const saved = DEFAULTS.expirySeconds;
    (DEFAULTS as { expirySeconds: number }).expirySeconds = 2;
    const realStorageAt = node.storageAt;
    try {
      h.chain.autoInclude = false;
      const r = await rotate();
      expect(r.status).toBe(200);
      node.storageAt = async () => { throw lost("eth_getStorageAt"); }; // dark for the whole follow, and after it
      h.chain.mine();
      expect((await h.settle(r.body.txHash, "Unknown", 10_000)).detail).toContain("no outcome");
      await Bun.sleep(100); // several looks while the node is dark: still pending, sends still refused
      expect([h.record(a).rotation?.txHash, h.record(a).tree.generation]).toEqual([r.body.txHash, 0]);
      expect((await send()).body.error).toBe("rotation_pending");
      node.storageAt = realStorageAt; // the node answers again: the next look decides it, in this process
      await switched();
      const tx = (await h.req("GET", `/tx/${r.body.txHash}`)).body;
      expect([tx.status, tx.timeline.at(-1).status]).toEqual(["OnChain", "settled when re-checked: OnChain"]);
      expect((await send()).status).toBe(200);
    } finally {
      (DEFAULTS as { expirySeconds: number }).expirySeconds = saved;
      node.storageAt = realStorageAt;
    }
  }, 20_000);

  test("a plain error after the rotate call left keeps the rotation pending until the chain decides it (not dropped)", async () => {
    const realSend = gateway.send;
    const realNote = LeafJournal.prototype.note;
    // the rotate call is held and lands, but its answer is lost, and noting that on the leaf fails: a plain Error
    gateway.send = async (tx) => { const hash = await realSend(tx); if (isRotate(tx)) throw lost("eth_sendFrameTransaction"); return hash; };
    LeafJournal.prototype.note = function (leaf: number, text: string) {
      if (text.startsWith("send outcome unknown")) throw new Error("disk full");
      return realNote.call(this, leaf, text);
    };
    try {
      const r = await rotate();
      expect([r.status, r.body.error]).toEqual([500, "internal"]);
      expect(h.record(a).rotation).toBeDefined(); // not dropped: the transaction may have left, and here it landed
      LeafJournal.prototype.note = realNote;
      await switched(); // decided from the chain: the key was used, the chain shows the new tree
      expect(h.chain.account(a)!.epoch).toBe(1);
    } finally {
      gateway.send = realSend;
      LeafJournal.prototype.note = realNote;
    }
  });

  test("a pipeline wallet's rotation never writes over a newer deployment record: it goes to the archive name (E)", async () => {
    // a pipeline account served from deployment-1337.json, with its seed and journal where deploy-account.ts puts them
    const seedFile = path.join(h.dirs.root, "pipeline-account.seed");
    const seedHex: Hex = `0x${"5c".repeat(32)}`;
    fs.writeFileSync(seedFile, `${seedHex}\n`, { mode: 0o600 });
    const k = new Keyring({ seed: hexToBytes(seedHex), generation: 0, height: 4, chains: [1337n] });
    const account = getAddress("0x00000000000000000000000000000000000ac002");
    const root = bytesToHex(k.root()), treeSeed = bytesToHex(k.treeSeed);
    h.chain.addAccount(account, { root, treeSeed, height: 4, epoch: 0, hotStart: 12, hotValueCap: 1n, hotFeeCap: 1n, allowedTarget: TARGET, owner: zeroAddress, hybrid: false });
    const record = { chainId: "1337", verifier: "hashsig", implementation: IMPLEMENTATION, factory: FACTORY, account, params: { root, treeSeed, height: 4, hotStart: 12 }, tree: { seedFile, generation: 0, height: 4, chains: ["1337"] } };
    const current = path.join(h.dirs.dataDir, "deployment-1337.json");
    fs.writeFileSync(current, JSON.stringify(record));
    LeafJournal.open(`${seedFile}.journal-epoch0.json`, { wallet: account, chainId: 1337n, epoch: 0, height: 4, treeSeed }, { create: true }).close();
    expect((await h.req("GET", `/wallets/${account}`)).status).toBe(200);
    // deploy-account.ts then makes another account: the current record now names it
    const other = getAddress("0x00000000000000000000000000000000000ac003");
    const newer = JSON.stringify({ ...record, account: other, tree: { ...record.tree, seedFile: path.join(h.dirs.root, "other.seed") } });
    fs.writeFileSync(current, newer);
    expect((await h.req("POST", `/wallets/${account}/rotate`, { height: 4 })).status).toBe(200);
    const archive = path.join(h.dirs.dataDir, `deployment-1337.${account.toLowerCase()}.json`);
    const archived = () => (fs.existsSync(archive) ? JSON.parse(fs.readFileSync(archive, "utf8")) : null);
    await until(() => archived()?.tree.generation === 1 && !archived()?.rotation, 5_000, "the switch, written to the archive");
    expect(fs.readFileSync(current, "utf8")).toBe(newer); // never written over
    expect([archived().account, archived().epochs.map((e: any) => e.epoch)]).toEqual([account, [0, 1]]);
    expect(h.logs.some((l) => l.includes(`deployment-1337.json now names ${other.toLowerCase()}`))).toBe(true);
  });
});

describe("hot policy", () => {
  test("setHotPolicy by a cold leaf: lands, and the chain's caps, band and target follow", async () => {
    const r = await policy();
    expect([r.status, r.body.status]).toEqual([200, "Submitted"]);
    expect(Object.keys(r.body).sort()).toEqual(["status", "txHash"]);
    const tx = await h.settle(r.body.txHash);
    expect(tx).toMatchObject({ status: "OnChain", kind: "hot-policy", mode: "keyed", to: a, valueWei: "0" });
    const view = (await h.req("GET", `/wallets/${a}`)).body;
    expect([view.hotStart, view.hotValueCapWei, view.hotFeeCapWei, view.allowedTarget]).toEqual([10, "5000", "1000000000000000", OTHER]);
    // estimateCalls burned one cold leaf for the limits; the call itself used the next one
    expect(coldLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"], [2, "onchain"]]);
    const sent = h.chain.sent.at(-1)!;
    expect(sent.frames[2]!.target).toBe(a);
    expect(decodeFunctionData({ abi: ACCOUNT_ABI, data: sent.frames[2]!.data }).args).toEqual([10, 5000n, 1_000_000_000_000_000n, OTHER]);
  });

  test("the kill switch: a value cap of 0 refuses every hot ticket", async () => {
    requireCli();
    expect((await h.req("POST", `/wallets/${a}/tickets`, { count: 1 })).status).toBe(200);
    await h.settle((await policy({ hotStart: 12, valueCapWei: "0", allowedTarget: TARGET })).body.txHash);
    const r = await send({ to: TARGET, valueWei: "1", mode: "hot" });
    expect([r.status, r.body.error]).toEqual([422, "refused"]);
    expect(r.body.simulation.violations).toContain("account: hot: disabled");
  });

  test("Account.yul's refusals are 400s before any leaf is spent; so is every bad field", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ hotStart: 13 }, /above the account's 12/], // the band never shrinks within an epoch
      [{ hotStart: 0 }, /leaves no cold leaf/],
      [{ hotStart: 1 }, /leaves no cold leaf for admin calls at epoch 0/],
      [{ hotStart: -1 }, /hotStart must be a whole number/],
      [{ valueCapWei: "1e18" }, /valueCapWei must be a decimal string of wei/],
      [{ feeCapWei: 5 }, /feeCapWei must be a decimal string of wei/],
      [{ allowedTarget: "0x00000000000000000000000000000000000B0B00" }, /allowedTarget must be an address/],
      [{ hotStart: 10, extra: true }, /unknown field extra/],
    ];
    for (const [over, why] of cases) {
      const r = await policy(over);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    const missing = await h.req("POST", `/wallets/${a}/hot-policy`, { hotStart: 10, valueCapWei: "1", feeCapWei: "1" });
    expect([missing.status, missing.body.detail]).toEqual([400, "allowedTarget is required"]);
    expect(coldLeaves()).toEqual([]);
    expect(h.chain.calls.estimate).toBe(0);
  });

  test("404 for an unknown wallet; 422 when the sidecar refuses, both leaves burned; 502; 503", async () => {
    expect((await policy({}, "0x000000000000000000000000000000000000dEaD")).status).toBe(404);
    h.chain.altRefusal = "validation prefix execution gas sum exceeds MAX_VERIFY_GAS";
    let r = await policy();
    expect([r.status, r.body.error, r.body.admission?.outcome]).toEqual([422, "refused", "rejected"]);
    expect(coldLeaves().map((l) => l.status)).toEqual(["burned", "burned"]); // the estimate's and the call's
    expect((await h.req("GET", `/tx/${r.body.txHash}`)).body).toMatchObject({ status: "Refused", kind: "hot-policy" });
    h.chain.altRefusal = null;
    const realCall = node.call;
    node.call = async () => { throw lost("eth_call"); };
    r = await policy();
    expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    node.call = realCall;
    h.chain.halted = true;
    r = await policy();
    expect([r.status, r.body.error]).toEqual([503, "chain_stalled"]);
    expect(coldLeaves().length).toBe(2);
  });

  test("two policy calls at once with one call's 2 cold leaves left: one lands, the other is 409 and spends nothing (I11)", async () => {
    const small = await h.wallet({ hotStart: 6 }); // cold leaves 1 to 5
    const leaves = () => Object.values(h.coldJournal(small).leaves).map((l: any) => [l.leaf, l.status]);
    const at = (over: Record<string, unknown>) => policy({ hotStart: 6, allowedTarget: TARGET, ...over }, small);
    await h.settle((await h.req("POST", `/wallets/${small}/send`, { to: TARGET, valueWei: "1" })).body.txHash); // leaf 1
    await h.settle((await at({ valueCapWei: "0" })).body.txHash); // the kill switch: leaves 2 and 3
    expect(leaves()).toEqual([[1, "onchain"], [2, "burned"], [3, "onchain"]]); // 4 and 5 left: one admin call's worth
    const estimates = h.chain.calls.estimate;
    // An estimate reads the head before it takes its leaf: the first call waits there for the second (at most 100 ms),
    // so without the lock both would pass the leaf check before either took a leaf.
    const fakeFetch = globalThis.fetch;
    let arrived = 0;
    const both = Promise.withResolvers<void>();
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (JSON.parse(String(init?.body ?? "{}")).method === "eth_getBlockByNumber") {
        if (++arrived === 2) both.resolve();
        await Promise.race([both.promise, Bun.sleep(100)]);
      }
      return fakeFetch(url, init);
    }) as typeof fetch;
    const rs = await Promise.all([at({ valueCapWei: "5" }), at({ valueCapWei: "6" })]).finally(() => { globalThis.fetch = fakeFetch; });
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = rs.find((r) => r.status === 200)!, loser = rs.find((r) => r.status === 409)!;
    expect([loser.body.error, loser.body.detail]).toEqual(["leaves_exhausted", "0 unused cold leaf(s): an admin call needs 2, one for its estimate and one for the call; nothing was spent"]);
    expect((await h.settle(winner.body.txHash)).status).toBe("OnChain");
    // no extra leaf: the winner's estimate and call, and the loser never reached an estimate
    expect(leaves()).toEqual([[1, "onchain"], [2, "burned"], [3, "onchain"], [4, "burned"], [5, "onchain"]]);
    expect([h.chain.calls.estimate - estimates, arrived]).toEqual([1, 1]);
    // with no cold leaf left a rotation is refused the same way, before anything is spent
    const rot = await rotate({ height: 4 }, small);
    expect([rot.status, rot.body.error]).toEqual([409, "leaves_exhausted"]);
    expect(rot.body.detail).toContain("an admin call needs 2");
    expect([h.chain.calls.estimate - estimates, fs.existsSync(`${h.record(small).tree.seedFile}.journal-epoch1.json`)]).toEqual([1, false]);
  });

  test("a policy that lowers hotStart must leave 4 cold leaves below it after its own 2: 409 before anything is spent", async () => {
    const low = await policy({ hotStart: 6 }); // leaves 1 to 5 below it: this call would take 2 and leave 3
    expect([low.status, low.body.error]).toEqual([409, "leaves_exhausted"]);
    expect(low.body.detail).toBe("the new hotStart would leave too few cold leaves for rotation and the kill switch: 5 unused cold leaf(s) below 6, this call spends 2 and 4 must stay; nothing was spent");
    expect([coldLeaves(), h.chain.calls.estimate, h.chain.account(a)!.hotStart]).toEqual([[], 0, 12]);
    // hotStart 7 leaves exactly 4 (3 to 6): it lands, keyed sends stop, and the kill switch and a rotation still fit
    expect((await h.settle((await policy({ hotStart: 7, allowedTarget: TARGET })).body.txHash)).status).toBe("OnChain");
    expect([h.chain.account(a)!.hotStart, coldLeaves().map((l) => [l.leaf, l.status])]).toEqual([7, [[1, "burned"], [2, "onchain"]]]);
    expect((await send()).body.error).toBe("leaves_exhausted");
    expect((await h.settle((await policy({ hotStart: 7, valueCapWei: "0", allowedTarget: TARGET })).body.txHash)).status).toBe("OnChain");
    expect((await rotate()).status).toBe(200);
    await switched();
    expect(coldLeaves().map((l) => [l.leaf, l.status])).toEqual([[1, "burned"], [2, "onchain"], [3, "burned"], [4, "onchain"], [5, "burned"], [6, "onchain"]]);
  });
});
