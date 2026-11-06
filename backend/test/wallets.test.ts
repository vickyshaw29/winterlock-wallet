// POST /wallets, GET /wallets and GET /wallets/:address against the fake chain, on temporary directories.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, getAddress, hexToBytes, zeroAddress, type Address } from "viem";
import { LeafJournal, gateway, node } from "../../pipeline/src/index.ts";
import { Keyring } from "../../pipeline/src/hashsig/keyring.ts";
import { eth } from "../src/chain.ts";
import { FACTORY, IMPLEMENTATION, lost } from "./fake-chain.ts";
import { EOA, ETH, Harness, TARGET } from "./helpers.ts";

let h: Harness;
beforeEach(async () => { h = await Harness.create(); });
afterEach(async () => { await h.destroy(); });

const BODY = { height: 4, spendLimitWei: "10000000000000000", hotStart: 12 };
const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe("POST /wallets", () => {
  test("seed, genesis pin, journal, record, account; funded by the EOA when the faucet is dry", async () => {
    let journalAtCreate = false;
    const realSend = (await import("../src/chain.ts")).eth.sendRawTransaction;
    (await import("../src/chain.ts")).eth.sendRawTransaction = async (raw) => {
      // the journal is born before the account (I1): it exists when createAccount leaves
      journalAtCreate ||= fs.existsSync(path.join(h.dirs.backendDir, "seeds", "account-1.seed.journal-epoch0.json"));
      return realSend(raw);
    };
    const r = await h.req("POST", "/wallets", BODY);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["address", "epoch", "funded", "root"]);
    expect([r.body.epoch, r.body.funded]).toEqual([0, true]);
    expect(journalAtCreate).toBe(true);
    const a: Address = r.body.address;
    const acc = h.chain.account(a)!;
    // the owner is the EOA (Vicky's default 4): the co-signer, should hybrid ever be turned on; it stays off
    expect([acc.root, acc.height, acc.hotStart, acc.epoch, acc.owner, acc.hybrid]).toEqual([r.body.root, 4, 12, 0, EOA, false]);
    expect(h.record(a).params.owner).toBe(EOA);
    expect([acc.hotValueCap, acc.allowedTarget]).toEqual([10_000_000_000_000_000n, TARGET]);
    const seeds = path.join(h.dirs.backendDir, "seeds");
    expect(fs.readdirSync(seeds).sort()).toEqual(["account-1.seed", "account-1.seed.chain.json", "account-1.seed.journal-epoch0.json", "account-1.seed.journal-epoch0.json.lock"]);
    expect([mode(seeds), mode(path.join(seeds, "account-1.seed"))]).toEqual([0o700, 0o600]);
    const rec = h.record(a);
    expect(rec.tree).toMatchObject({ seedFile: path.join(seeds, "account-1.seed"), generation: 0, height: 4, chains: ["1337"], root: r.body.root });
    expect([rec.implementation, rec.factory, rec.createdBy]).toEqual([IMPLEMENTATION, FACTORY, "backend"]);
    expect(rec.createTx).toMatch(/^0x[0-9a-f]{64}$/);
    // the tree is the seed's: the TypeScript keyring rebuilds the same root
    const seed = hexToBytes(fs.readFileSync(path.join(seeds, "account-1.seed"), "utf8").trim() as `0x${string}`);
    expect(bytesToHex(new Keyring({ seed, generation: 0, height: 4, chains: [1337n] }).root())).toBe(r.body.root);
    expect(h.chain.balance(a)).toBe(20_000_000_000_000_000n);
    expect([h.chain.calls.faucet, h.chain.calls.eoa.length]).toEqual([1, 2]); // faucet tried first, then createAccount and the payment
    (await import("../src/chain.ts")).eth.sendRawTransaction = realSend;
  });

  test("the faucet first: when it pays, the EOA sends nothing more", async () => {
    h.chain.faucetDry = false;
    const a = await h.wallet();
    expect(h.chain.balance(a)).toBe(ETH);
    expect(h.chain.calls.eoa.length).toBe(1); // createAccount only
  });

  test("funding tops up to WL_FUND_WEI: a faucet that pays less is topped up to it, counted after its payment shows (F, default 5)", async () => {
    const FUND = 20_000_000_000_000_000n, FAUCET = 5_000_000_000_000_000n, EARLIER = 1_000_000_000_000_000n;
    const realFaucet = gateway.faucet, realSend = eth.sendRawTransaction;
    gateway.faucet = async (to) => { setTimeout(() => h.chain.credit(to, FAUCET), 15); return { txHash: `0x${"fa".repeat(32)}`, amount: FAUCET.toString() }; };
    try {
      const a = await h.wallet(); // nothing there before: the faucet's 0.005 ETH shows, the EOA adds 0.015
      expect([h.chain.balance(a), h.chain.calls.eoa.length]).toEqual([FUND, 2]);
      // a wallet that already holds something when it is funded: the faucet's late payment is still waited for
      let first = true;
      eth.sendRawTransaction = async (raw) => {
        const hash = await realSend(raw);
        if (first) { first = false; for (const [address, acc] of h.chain.accounts) if (acc.epoch === 0 && h.chain.balance(address) === 0n) h.chain.credit(address, EARLIER); }
        return hash;
      };
      const b = await h.wallet();
      await Bun.sleep(40); // any faucet payment still on its way has landed
      expect(h.chain.balance(b)).toBe(FUND); // topped up to exactly WL_FUND_WEI, not past it
    } finally {
      gateway.faucet = realFaucet;
      eth.sendRawTransaction = realSend;
    }
  });

  test("an EOA that cannot pay leaves the wallet created and unfunded", async () => {
    h.chain.balances.set(EOA.toLowerCase(), 10_000_000_000_000_000n);
    const r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.funded]).toEqual([200, false]);
  });

  test("defaults: chain list [1337], hotStart max(6, 2^h - 16), the hot fee cap and target of deploy-account.ts", async () => {
    const a = (await h.req("POST", "/wallets", { height: 5, spendLimitWei: "1" })).body.address;
    const acc = h.chain.account(a)!;
    expect([acc.hotStart, acc.hotFeeCap, acc.allowedTarget]).toEqual([16, 2_000_000_000_000_000n, TARGET]);
    const b = (await h.req("POST", "/wallets", { height: 3, spendLimitWei: "1" })).body.address;
    expect(h.chain.account(b)!.hotStart).toBe(6); // the least epoch 0 allows
    expect(h.record(b).tree.seedFile).toEndWith("account-2.seed"); // the next free number
    // height 2 has 4 leaves: too few at epoch 0, even by default
    const tiny = await h.req("POST", "/wallets", { height: 2, spendLimitWei: "1" });
    expect([tiny.status, tiny.body.error]).toEqual([400, "bad_request"]);
    expect(tiny.body.detail).toBe("hotStart 6 is above the tree's 4 leaves (the default at height 2; epoch 0 needs a hotStart of at least 6)");
  });

  test("hotStart is at least 6 at epoch 0: leaf 0 cannot sign, 4 cold leaves stay for admin calls, and one keyed send", async () => {
    const r = await h.req("POST", "/wallets", { ...BODY, hotStart: 5 });
    expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
    expect(r.body.detail).toBe("hotStart 5 leaves too few cold leaves at epoch 0: leaf 0 cannot sign, 4 stay for the kill switch and a rotation, and a keyed send needs one more, so hotStart must be at least 6");
    expect(fs.existsSync(path.join(h.dirs.backendDir, "seeds"))).toBe(false);
    const a = await h.wallet({ hotStart: 6 }); // cold leaves 1 to 5
    expect(h.chain.account(a)!.hotStart).toBe(6);
    const one = await h.req("POST", `/wallets/${a}/send`, { to: TARGET, valueWei: "1" });
    expect([one.status, one.body.leaf]).toEqual([200, 1]);
    expect((await h.settle(one.body.txHash)).status).toBe("OnChain");
    const two = await h.req("POST", `/wallets/${a}/send`, { to: TARGET, valueWei: "1" }); // leaves 2 to 5 are the reserve
    expect([two.status, two.body.error]).toEqual([409, "leaves_exhausted"]);
  });

  test("every bad field is a 400, and nothing is created", async () => {
    const cases: [unknown, RegExp][] = [
      [{ ...BODY, hybrid: true }, /hybrid co-signing stays off/],
      [{ ...BODY, hybrid: "no" }, /hybrid must be true or false/],
      [{ ...BODY, height: 1 }, /height must be a whole number from 2 to 12/],
      [{ ...BODY, height: 13 }, /height must be/],
      [{ ...BODY, height: "4" }, /height must be/],
      [{ ...BODY, chainIds: [1] }, /must include this devnet's chain id/],
      [{ ...BODY, chainIds: [1337, 1337] }, /twice/],
      [{ ...BODY, chainIds: Array.from({ length: 17 }, (_, i) => i + 1) }, /1 to 16/],
      [{ ...BODY, chainIds: [1337, -1] }, /positive chain id/],
      [{ ...BODY, hotStart: 1 }, /too few cold leaves at epoch 0: .* at least 6$/],
      [{ ...BODY, hotStart: 0 }, /at least 6$/],
      [{ ...BODY, hotStart: 17 }, /above the tree's 16 leaves/],
      [{ height: 4 }, /spendLimitWei .* is required/],
      [{ ...BODY, spendLimitWei: "1.5" }, /decimal string of wei/],
      [{ ...BODY, spendLimitWei: 1000 }, /decimal string of wei/],
      [{ ...BODY, hotFeeCapWei: "-1" }, /decimal string of wei/],
      [{ ...BODY, allowedTarget: "0x1234" }, /must be an address/],
      [{ ...BODY, allowedTarget: "0x5544596212f91984C986A919C8026DF0576816f9" }, /must be an address/], // bad checksum
      [{ ...BODY, speedLimitWei: "1" }, /unknown field speedLimitWei/],
      [[1, 2], /JSON object/],
    ];
    for (const [body, why] of cases) {
      const r = await h.req("POST", "/wallets", body);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
      expect(r.body.detail).toMatch(why);
    }
    expect((await h.req("POST", "/wallets", "{not json")).body.detail).toBe("the body is not JSON");
    expect((await h.req("POST", "/wallets", JSON.stringify(BODY), { "content-type": "text/plain" })).body.detail).toMatch(/content-type application\/json/);
    expect(fs.existsSync(path.join(h.dirs.backendDir, "seeds"))).toBe(false);
  });

  test("409: no deployment record, an unbound factory, a pending EOA transaction; nothing created", async () => {
    const recordFile = path.join(h.dirs.dataDir, "deployment-1337.json");
    const saved = fs.readFileSync(recordFile, "utf8");
    fs.rmSync(recordFile);
    let r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.error]).toEqual([409, "cannot_create"]);
    fs.writeFileSync(recordFile, saved.replace(IMPLEMENTATION, "0x00000000000000000000000000000000000B0B00"));
    const realCode = node.code;
    node.code = async (a) => (a.toLowerCase() === "0x00000000000000000000000000000000000b0b00" ? "0x60" : realCode(a));
    r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.error]).toEqual([409, "cannot_create"]);
    expect(r.body.detail).toContain("not bound to the implementation");
    node.code = realCode;
    fs.writeFileSync(recordFile, saved);
    h.chain.eoaPending = 1n;
    r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.error]).toEqual([409, "eoa_busy"]);
    expect(fs.existsSync(path.join(h.dirs.backendDir, "seeds"))).toBe(false);
  });

  test("502 when the node cannot be read; 503 when the chain is stalled; nothing created either way", async () => {
    const realCode = node.code;
    node.code = async () => { throw lost("eth_getCode"); };
    let r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    node.code = realCode;
    h.chain.halted = true;
    r = await h.req("POST", "/wallets", BODY);
    expect([r.status, r.body.error]).toEqual([503, "chain_stalled"]);
    expect(fs.existsSync(path.join(h.dirs.backendDir, "seeds"))).toBe(false);
  });
});

describe("GET /wallets and GET /wallets/:address", () => {
  test("the list: address, epoch, height, balance", async () => {
    const a = await h.wallet();
    const r = await h.req("GET", "/wallets");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ address: a, epoch: 0, height: 4, balanceWei: "20000000000000000" }]);
  });

  test("the wallet: values from the chain, counts from the journals, no tickets yet", async () => {
    const a = await h.wallet();
    const r = await h.req("GET", `/wallets/${a.toLowerCase()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      address: a, root: h.chain.account(a)!.root, treeSeed: h.chain.account(a)!.treeSeed, height: 4, epoch: 0,
      leavesUsed: 0, leafCount: 16, lanesInFlight: 0, hybrid: false, locked: false, balanceWei: "20000000000000000",
      hotStart: 12, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000", allowedTarget: TARGET,
      tickets: { exported: 0, used: 0, left: 0 }, rotationPending: false,
    });
  });

  test("404 for an unknown wallet, 400 for a bad address, 502 when the node is down", async () => {
    const a = await h.wallet();
    expect((await h.req("GET", "/wallets/0x000000000000000000000000000000000000dEaD")).status).toBe(404);
    const bad = await h.req("GET", "/wallets/0x1234");
    expect([bad.status, bad.body.error]).toEqual([400, "bad_request"]);
    const realCall = node.call;
    node.call = async () => { throw lost("eth_call"); };
    const down = await h.req("GET", `/wallets/${a}`);
    expect([down.status, down.body.error]).toEqual([502, "rpc_failed"]);
    node.call = realCall;
  });

  test("pipeline records are served when their seed exists; placeholder records and missing seeds are not", async () => {
    const seedFile = path.join(h.dirs.root, "pipeline-account.seed");
    const seedHex = `0x${"5c".repeat(32)}` as const;
    fs.writeFileSync(seedFile, `${seedHex}\n`, { mode: 0o600 });
    const k = new Keyring({ seed: hexToBytes(seedHex), generation: 0, height: 4, chains: [1337n] });
    const account: Address = getAddress("0x00000000000000000000000000000000000ac002");
    const root = bytesToHex(k.root()), treeSeed = bytesToHex(k.treeSeed);
    h.chain.addAccount(account, { root, treeSeed, height: 4, epoch: 0, hotStart: 12, hotValueCap: 1n, hotFeeCap: 1n, allowedTarget: TARGET, owner: zeroAddress, hybrid: false });
    const record = { chainId: "1337", verifier: "hashsig", implementation: IMPLEMENTATION, factory: FACTORY, account, params: { root, treeSeed, height: 4, hotStart: 12 }, tree: { seedFile, generation: 0, height: 4, chains: ["1337"] } };
    fs.writeFileSync(path.join(h.dirs.dataDir, `deployment-1337.${account.toLowerCase()}.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(h.dirs.dataDir, "deployment-1337.placeholder.json"), JSON.stringify({ ...record, verifier: "placeholder", account: "0x00000000000000000000000000000000000AC003" }));
    // the current record names a seed that does not exist (helpers.ts)
    const list = (await h.req("GET", "/wallets")).body;
    expect(list.map((w: any) => w.address)).toEqual([account]);
    // a pipeline account's journal is created by deploy-account.ts or init-journal.ts, never here
    const missing = await h.req("GET", `/wallets/${account}`);
    expect([missing.status, missing.body.error]).toEqual([409, "journal_unusable"]);
    expect(missing.body.detail).toContain("no journal at");
    expect(fs.existsSync(`${seedFile}.journal-epoch0.json`)).toBe(false);
    LeafJournal.open(`${seedFile}.journal-epoch0.json`, { wallet: account, chainId: 1337n, epoch: 0, height: 4, treeSeed }, { create: true }).close();
    const view = await h.req("GET", `/wallets/${account}`);
    expect([view.status, view.body.root, view.body.leavesUsed]).toEqual([200, root, 0]);
  });
});
