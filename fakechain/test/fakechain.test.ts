// The pipeline's real functions against the fake chain over HTTP on 127.0.0.1: every behaviour the brief lists.
// Written with Claude Code (AI) for Vicky.
// Refusals are checked with the account's own revert strings and the sidecar's own texts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bytesToHex, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEVNET, GRIND, NONCE_MANAGER, PreflightRefused, RpcError, SubmissionRefused, buildFrameTx, checkChainPin, currentChain, estimateCalls,
  frameGasModel, frameTxHash, fromWire, gateway, grind, node, nonceKeyFor, nonceManagerSlot, pinOrCheckChain, placeholders, rpc, sendKeyed,
  sendWithRetry, settleSubmitted, signFrameTx, toWire, waitForInclusion, withEstimates,
  type Call, type FrameTransaction, type HashSigner, type LeafJournal, type SendKeyedParams, type SignatureSlot,
} from "../../pipeline/src/index.ts";
import { Keyring, keyringSigner, loadOrCreateSeed } from "../../pipeline/src/hashsig/keyring.ts";
import { DATA_DIR, accountSigner, openJournal } from "../../pipeline/scripts/lib/wallet.ts";
import { decodeReason } from "../src/accountModel.ts";
import { COINBASE, ETH, FACTORY, GWEI, IMPLEMENTATION, SHOP } from "../src/constants.ts";
import { startWorld, type World } from "./world.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO, "pipeline/test/fixtures/admission-records.json"), "utf8"));
const REAL_DEVNET_GENESIS = "0x196a1589ac71e2f305b1fbc7bfd23e55367f9fd6eb9da97e2f572c2791e17bbc"; // spec, Day-0 (chain 1337)
const COLD = { from: 1, to: 1008 }, HOT = { from: 1008, to: 1024 };
const OTHER: Address = "0x000000000000000000000000000000000000dEaD";
const T = 90_000; // per-test timeout: each landed send waits for two confirmations
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACCOUNT_ABI = parseAbi([
  "function setHotPolicy(uint32 hotStart, uint256 valueCap, uint256 feeCap, address allowedTarget)", "function rotate(bytes32, bytes32, uint8)",
  "function root() view returns (bytes32)", "function treeSeed() view returns (bytes32)", "function epoch() view returns (uint32)", "function hotStart() view returns (uint32)",
  "function hotValueCap() view returns (uint256)", "function hotFeeCap() view returns (uint256)", "function allowedTarget() view returns (address)",
  "function owner() view returns (address)", "function hybridRequired() view returns (bool)", "function height() view returns (uint8)",
]);
const FACTORY_VIEWS = parseAbi(["function implementation() view returns (address)"]);

let w: World;
let journal: LeafJournal;
let signer: HashSigner;
let ACCOUNT: Address;
const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
const send = (calls: Call[], o: Partial<SendKeyedParams> = {}) => sendKeyed({
  journal, band: COLD, sender: ACCOUNT, calls, verifyGas: 90_000n, grind: GRIND.cold, preflight: true, signatures: slots, pollMs: 200, receiptWaitMs: 10_000, ...o,
});
const sendHot = (calls: Call[], o: Partial<SendKeyedParams> = {}) => send(calls, { band: HOT, grind: GRIND.hot, ...o });
const view = async (fn: "root" | "treeSeed" | "epoch" | "hotStart" | "hotValueCap" | "hotFeeCap" | "allowedTarget" | "owner" | "hybridRequired" | "height") =>
  BigInt(await rpc<Hex>(DEVNET.node, "eth_call", [{ to: ACCOUNT, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: fn }) }, "latest"]));
const hotPolicy = (hotStart: number, cap: bigint, feeCap = 2n * 10n ** 15n, target: Address = SHOP): Hex =>
  encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setHotPolicy", args: [hotStart, cap, feeCap, target] });
const balanceAt = async (a: Address, block: bigint) => BigInt(await rpc<Hex>(DEVNET.node, "eth_getBalance", [a, `0x${block.toString(16)}`]));
/** The account's reason inside the sidecar's "validation frame 1: reverted with data 0x…". */
const accountReason = (e: unknown) => {
  const m = String((e as Error)?.message).match(/with data (0x[0-9a-fA-F]{64})/);
  return m ? decodeReason(m[1] as Hex) : null;
};
const simulatedReason = async (tx: FrameTransaction) => {
  const sim: any = await node.simulate(tx, false);
  expect(sim.canonicalMempoolValid).toBe(false);
  expect(sim.frames).toBeNull(); // the devnet's node reports no frame gas for a refused verify frame
  return decodeReason(sim.revertData);
};

/** A transaction for `keyLeaf`'s key signed by `signLeaf`, ground to fit the verify limit; nothing is reserved here. */
async function signedFor(keyLeaf: number, signLeaf: number, o: { seq?: bigint; calls?: Call[]; epoch?: number; s?: HashSigner; fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } } = {}) {
  const sl: SignatureSlot[] = [{ kind: "hash", signer: o.s ?? signer, leaf: signLeaf }];
  const gp = await gateway.gasPrice();
  const fees = o.fees ?? { maxFeePerGas: BigInt(gp.maxFeePerGas), maxPriorityFeePerGas: BigInt(gp.maxPriorityFeePerGas) };
  const g = grind((i) => ({
    value: i,
    tx: buildFrameTx({
      chainId: DEVNET.chainId, sender: ACCOUNT, nonce: { keys: [nonceKeyFor(o.epoch ?? 0, keyLeaf)], seq: o.seq ?? 0n }, verifyGas: 90_000n,
      deadline: Math.floor(Date.now() / 1000) + 90, calls: o.calls ?? [{ to: SHOP, value: 1n }], fees: { ...fees, maxFeePerGas: fees.maxFeePerGas + BigInt(i) }, signatures: placeholders(sl),
    }),
  }), { ...GRIND.cold, verifyGasLimit: 90_000n });
  return (await signFrameTx(g.tx, sl)).tx;
}
/** A fresh leaf for a hand-built transaction, burned afterwards whatever happens. */
async function withLeaf<T>(note: string, fn: (leaf: number) => Promise<T>): Promise<T> {
  const { leaf } = journal.reserveNext(COLD, note);
  try { return await fn(leaf); } finally { journal.mark(leaf, "burned", { note: `test only: ${note}` }); }
}
const refusedAtSubmission = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(SubmissionRefused);
  return e as SubmissionRefused;
};

beforeAll(async () => {
  w = await startWorld();
  ACCOUNT = w.deployment.account;
  signer = await accountSigner(w.deployment);
  journal = openJournal(w.deployment);
}, 60_000);
afterAll(() => { journal?.close(); w?.stop(); });

describe("isolation", () => {
  test("chain 31337, the fake's client version, a fresh genesis, files in the OS temp dir", async () => {
    expect(DEVNET.chainId).toBe(31337n);
    expect(BigInt(await rpc<Hex>(DEVNET.node, "eth_chainId"))).toBe(31337n);
    expect(await rpc<string>(DEVNET.node, "web3_clientVersion")).toBe("fakechain/0.1.0 (local fake devnet, not ethrex)");
    const chain = await currentChain();
    expect(chain.genesisHash).toBe(w.chain.genesisHash);
    expect(chain.genesisHash).not.toBe(REAL_DEVNET_GENESIS);
    const dir = fs.realpathSync(w.dir);
    expect(dir.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(path.relative(REPO, dir).startsWith("..")).toBe(true);
    expect(dir.includes(`${path.sep}.winterlock`)).toBe(false);
    expect(fs.realpathSync(DATA_DIR).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    for (const url of [DEVNET.node, DEVNET.gateway, DEVNET.explorer]) expect(url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("the fetch guard: nothing leaves this machine (reserved, unroutable test addresses only)", async () => {
    await expect(fetch("http://192.0.2.1:9/")).rejects.toThrow("fakechain fetch guard");
    const e = await rpc("https://example.invalid/rpc", "eth_chainId").catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).failure).toBe("transport");
    expect((e as RpcError).message).toContain("fakechain fetch guard");
  });

  test("a seed pinned to another genesis refuses to sign, and so does a pin to the real devnet", async () => {
    const dir = fs.mkdtempSync(path.join(w.dir, "pins-"));
    const otherWorld = path.join(dir, "other.chain.json");
    fs.writeFileSync(otherWorld, JSON.stringify({ chainId: "31337", genesisHash: toHex(crypto.getRandomValues(new Uint8Array(32))), pinnedAt: "test" }));
    await expect(pinOrCheckChain(otherWorld)).rejects.toThrow("was reset");
    const realDevnet = path.join(dir, "real.chain.json");
    fs.writeFileSync(realDevnet, JSON.stringify({ chainId: "1337", genesisHash: REAL_DEVNET_GENESIS, pinnedAt: "test" }));
    await expect(pinOrCheckChain(realDevnet)).rejects.toThrow("pinned to chain 1337, connected to chain 31337");
    expect(() => checkChainPin({ chainId: "1337", genesisHash: REAL_DEVNET_GENESIS, pinnedAt: "" }, { chainId: 31337n, genesisHash: w.chain.genesisHash })).toThrow();
    // The account's own signer checks its pin before every signature: a copy of this seed pinned elsewhere cannot sign.
    const copy = path.join(dir, "copy.seed");
    fs.copyFileSync(w.deployment.tree!.seedFile, copy);
    fs.writeFileSync(`${copy}.chain.json`, JSON.stringify({ chainId: "31337", genesisHash: toHex(crypto.getRandomValues(new Uint8Array(32))), pinnedAt: "test" }));
    await expect(accountSigner({ ...w.deployment, tree: { ...w.deployment.tree!, seedFile: copy } })).rejects.toThrow("was reset");
  });
});

describe("cold transfers", () => {
  test("a cold sendKeyed lands OnChain; receipt, gas, balances, key and admission report add up", async () => {
    const r = await send([{ to: SHOP, value: 12_345n }]);
    expect(r.outcome).toBe("OnChain");
    const raw = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [r.txHash]);
    expect([raw.type, raw.status, raw.payer]).toEqual(["0x6", "0x1", ACCOUNT]);
    expect(raw.frameReceipts.map((f: any) => f.status)).toEqual(["0x1", "0x1", "0x1"]);
    const frameGas = raw.frameReceipts.map((f: any) => BigInt(f.gasUsed));
    expect(frameGas[0]).toBe(3_051n); // the expiry frame, as measured on the devnet
    expect(frameGas[1]).toBe(BigInt(Math.round(54_630 + 66.09 * r.grind!.steps))); // account 2's measured verify model
    expect(frameGas[2]).toBe(3_000n); // a cold target
    const block = BigInt(raw.blockNumber), gasUsed = BigInt(raw.gasUsed), price = BigInt(raw.effectiveGasPrice);
    expect(price).toBe(7n + GWEI); // min(maxFeePerGas, base fee + priority fee)
    const sent = fromWire((await gateway.explorerRecord(r.txHash)).entry.tx);
    const m = frameGasModel(sent);
    expect(gasUsed).toBe(m.floored(m.intrinsic + frameGas[0] + frameGas[1] + frameGas[2])); // the calldata floor binds
    expect(await balanceAt(ACCOUNT, block)).toBe((await balanceAt(ACCOUNT, block - 1n)) - 12_345n - gasUsed * price);
    expect(await balanceAt(SHOP, block)).toBe((await balanceAt(SHOP, block - 1n)) + 12_345n);
    expect(await balanceAt(COINBASE, block) - await balanceAt(COINBASE, block - 1n)).toBe(gasUsed * GWEI);
    expect(BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(ACCOUNT, r.nonceKey)))).toBe(1n);
    expect(journal.get(r.leaf)?.status).toBe("onchain");
    expect(await gateway.status(r.txHash)).toBe("OnChain");
    expect((await gateway.receipt(r.txHash))!.frameReceipts.map((f) => f.status)).toEqual(["success", "success", "success"]);
    const tx = await rpc<any>(DEVNET.node, "eth_getTransactionByHash", [r.txHash]);
    expect([tx.type, tx.blockNumber, tx.from]).toEqual(["0x6", raw.blockNumber, ACCOUNT]);
    // The admission report: the devnet's real record's rules, in its order.
    expect(r.admission?.outcome).toBe("included");
    const shape = (c: any) => [c.rule, c.verdict, c.frameIndex ?? null, c.entity ?? null];
    expect(r.admission!.checks.map(shape)).toEqual(FIXTURE.included.admission.checks.map(shape));
    expect(r.simulation?.canonicalMempoolValid).toBe(true);
  }, T);

  test("the account's views and the factory over eth_call", async () => {
    const d = w.deployment;
    expect(await view("root")).toBe(BigInt(d.params.root));
    expect(await view("treeSeed")).toBe(BigInt(d.params.treeSeed));
    expect([await view("height"), await view("epoch"), await view("hotStart")]).toEqual([10n, 0n, 1008n]);
    expect([await view("hotValueCap"), await view("hotFeeCap")]).toEqual([10n ** 16n, 2n * 10n ** 15n]);
    expect([await view("allowedTarget"), await view("owner"), await view("hybridRequired")]).toEqual([BigInt(SHOP), BigInt(privateKeyToAccount(w.eoaKey).address), 0n]);
    expect(BigInt(await rpc<Hex>(DEVNET.node, "eth_call", [{ to: FACTORY, data: encodeFunctionData({ abi: FACTORY_VIEWS, functionName: "implementation" }) }, "latest"]))).toBe(BigInt(IMPLEMENTATION));
    expect(BigInt(await rpc<Hex>(DEVNET.node, "eth_getTransactionCount", [ACCOUNT, "latest"]))).toBe(1n); // a contract starts at nonce 1
  });

  test("a flipped signature byte is refused: 'sig: hash-based check', in simulation and at the sidecar", async () => {
    await withLeaf("flipped byte", async (leaf) => {
      const tx = await signedFor(leaf, leaf);
      const e = hexBytes(tx.signatures[0]!.signature as Hex);
      e[2 + 32 * 10 + 5]! ^= 0x01;
      const bad = { ...tx, signatures: [{ ...tx.signatures[0]!, signature: toHex(e) }] };
      expect(await simulatedReason(bad)).toBe("sig: hash-based check");
      const err = await gateway.send(bad).catch((x) => x);
      expect([err.code, accountReason(err)]).toEqual([-32500, "sig: hash-based check"]);
      const rec = (await gateway.explorerRecord(frameTxHash(bad))).admission;
      expect(rec.outcome).toBe("rejected");
      expect(rec.checks.find((c: any) => c.verdict === "fail").rule).toBe("simulation");
    });
  });

  test("leaf A's signature under leaf B's key is refused: 'sig: hash-based check'", async () => {
    await withLeaf("signing leaf A", (a) => withLeaf("key of leaf B", async (b) => {
      const tx = await signedFor(b, a);
      expect(await simulatedReason(tx)).toBe("sig: hash-based check");
      expect(accountReason(await gateway.send(tx).catch((x) => x))).toBe("sig: hash-based check");
    }));
  });

  test("a used key: the protocol refuses it at sequence 0 (Nonce mismatch), the account at sequence 1 (nonce: sequence)", async () => {
    const used = journal.all().find((r) => r.status === "onchain")!.leaf;
    await withLeaf("signer for a used key", async (s) => {
      const err = await gateway.send(await signedFor(used, s)).catch((x) => x);
      expect([err.code, err.message]).toEqual([-32500, "eth_sendFrameTransaction: Nonce mismatch: expected 1, got 0 (-32500)"]);
      const sim = await node.simulate(await signedFor(used, s)).catch((x) => x);
      expect(sim.message).toContain("Nonce mismatch: expected 1, got 0");
      const seq1 = await signedFor(used, s, { seq: 1n });
      expect(await simulatedReason(seq1)).toBe("nonce: sequence");
      expect(accountReason(await gateway.send(seq1).catch((x) => x))).toBe("nonce: sequence");
    });
  });
});

describe("hot tickets", () => {
  test("a hot ticket within the caps lands; its verify frame adds the policy reads", async () => {
    const shop = await node.balance(SHOP);
    const r = await sendHot([{ to: SHOP, value: 10n ** 15n }]);
    expect(r.outcome).toBe("OnChain");
    expect(r.leaf).toBeGreaterThanOrEqual(1008);
    expect(BigInt(r.receipt!.frameReceipts[1]!.gasUsed.execution)).toBe(BigInt(Math.round(54_630 + 6_623 + 66.09 * r.grind!.steps)));
    expect(await node.balance(SHOP)).toBe(shop + 10n ** 15n);
  }, T);

  test("over the cap, to another target, with data, over the fee cap: refused with the account's strings", async () => {
    const reason = async (calls: Call[], o: Partial<SendKeyedParams> = {}) => {
      const e = await refusedAtSubmission(sendHot(calls, { preflight: false, ...o }));
      expect(e.admission?.failed[0]?.rule).toBe("simulation");
      expect(journal.get(e.leaf!)?.status).toBe("burned");
      return accountReason(e);
    };
    expect(await reason([{ to: SHOP, value: 10n ** 16n + 1n }])).toBe("hot: value cap");
    expect(await reason([{ to: OTHER, value: 1n }])).toBe("hot: frame target");
    expect(await reason([{ to: SHOP, value: 1n, data: "0x01" }])).toBe("hot: frame data");
    expect(await reason([{ to: SHOP, value: 1n }], { fees: { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 1n } })).toBe("hot: fee cap");
    // With a preflight the node's coarse text stops it first, as ethrex says it: no account string there.
    const pre = await sendHot([{ to: OTHER, value: 1n }]).catch((x) => x);
    expect(pre).toBeInstanceOf(PreflightRefused);
    expect(pre.message).toContain("validation prefix frame reverted");
  }, T);

  test("the kill switch: value cap 0 stops every hot ticket ('hot: disabled'); restoring it needs state gas", async () => {
    expect((await send([{ to: ACCOUNT, data: hotPolicy(1008, 0n) }])).outcome).toBe("OnChain");
    expect(await view("hotValueCap")).toBe(0n);
    expect(accountReason(await refusedAtSubmission(sendHot([{ to: SHOP, value: 1n }], { preflight: false })))).toBe("hot: disabled");
    // Slot 3 goes from zero to non-zero: 97,920 state gas. Without a state limit the admin frame reverts, the key is used.
    const noState = await send([{ to: ACCOUNT, data: hotPolicy(1008, 10n ** 16n) }], { preflight: false });
    expect(noState.outcome).toBe("Reverted");
    const raw = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [noState.txHash]);
    expect(raw.frameReceipts[2].status).toBe("0x0");
    expect(raw.fakechainRevertReasons["2"]).toContain("out of state gas");
    expect(await view("hotValueCap")).toBe(0n);
    expect((await send([{ to: ACCOUNT, data: hotPolicy(1008, 10n ** 16n), stateGas: 100_000n }])).outcome).toBe("OnChain");
    expect(await view("hotValueCap")).toBe(10n ** 16n);
  }, T);
});

describe("fees, expiry and retries", () => {
  test("a fee below the base fee is refused at admission with ethrex's text, in preflight and at the sidecar", async () => {
    const low = { fees: { maxFeePerGas: 6n, maxPriorityFeePerGas: 1n }, grind: undefined };
    const e = await refusedAtSubmission(send([{ to: SHOP, value: 1n }], { ...low, preflight: false }));
    expect(e.message).toContain("Vm execution error: Invalid Transaction: Insufficient max fee per gas");
    expect((e.cause as RpcError).code).toBe(-32500);
    const p = await send([{ to: SHOP, value: 1n }], low).catch((x) => x);
    expect(p).toBeInstanceOf(PreflightRefused);
    expect(p.message).toContain("Insufficient max fee per gas");
  }, T);

  test("a payment that cannot land before its deadline ends Expired; sendWithRetry lands the retry on a fresh leaf", async () => {
    w.chain.paused = true; // no block until the first attempt's deadline has passed
    setTimeout(() => { w.chain.paused = false; }, 3_000);
    const r = await sendWithRetry({
      journal, band: COLD, sender: ACCOUNT, calls: [{ to: SHOP, value: 7n }], verifyGas: 90_000n, grind: GRIND.cold, preflight: true, signatures: slots,
      pollMs: 200, receiptWaitMs: 10_000, attempts: 2, firstAttempt: { expirySeconds: 1 }, dropWaitMs: 30_000,
    });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["Expired", "OnChain"]);
    const [dead, live] = r.attempts as [typeof r.final, typeof r.final];
    expect(live.leaf).not.toBe(dead.leaf);
    expect(live.nonceKey).not.toBe(dead.nonceKey);
    expect(r.burnedLeaves).toEqual([dead.leaf]);
    expect([journal.get(dead.leaf)?.status, journal.get(live.leaf)?.status]).toEqual(["burned", "onchain"]);
    const st = await rpc<any>(DEVNET.gateway, "skandha_frameTransactionStatus", [dead.txHash]);
    expect(st.status).toBe("Cancelled");
    expect(st.reason).toContain("revalidation failed as of block");
    expect(st.reason).toContain("validation frame 0: reverted"); // the expiry frame
    expect(BigInt(await node.storage(NONCE_MANAGER, nonceManagerSlot(ACCOUNT, dead.nonceKey)))).toBe(0n);
  }, T);

  test("with the sidecar's enforceGasPrice, a fee below the quote is admitted but never relayed: Expired, then the retry lands", async () => {
    w.chain.opts.enforceGasPrice = true;
    try {
      const r = await sendWithRetry({
        journal, band: COLD, sender: ACCOUNT, calls: [{ to: SHOP, value: 8n }], verifyGas: 90_000n, grind: GRIND.cold, preflight: true, signatures: slots,
        pollMs: 200, receiptWaitMs: 10_000, attempts: 2, dropWaitMs: 30_000,
        firstAttempt: { expirySeconds: 4, fees: { maxFeePerGas: 1_500_000_000n, maxPriorityFeePerGas: GWEI } },
      });
      expect(r.attempts.map((a) => a.outcome)).toEqual(["Expired", "OnChain"]);
      const rec = (await gateway.explorerRecord(r.attempts[0]!.txHash)).admission;
      expect(rec.outcome).toBe("dropped"); // accepted, then cancelled once it could no longer land
    } finally {
      w.chain.opts.enforceGasPrice = false;
    }
  }, T);
});

describe("mempools", () => {
  test("eight keyed sends at once: all pending together in the alt mempool, all included", async () => {
    w.chain.paused = true;
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => send([{ to: SHOP, value: BigInt(1_000 + i) }])));
    let held = 0;
    for (let i = 0; i < 300 && held < 8; i++) {
      await sleep(100);
      held = (await rpc<any>(DEVNET.gateway, "skandha_explorer_listTransactions", [{}])).items.filter((t: any) => t.status === "New" || t.status === "Submitted").length;
    }
    w.chain.paused = false;
    expect(held).toBe(8);
    const rs = await all;
    expect(rs.map((r) => r.outcome)).toEqual(Array(8).fill("OnChain"));
    expect(new Set(rs.map((r) => r.leaf)).size).toBe(8);
    expect(new Set(rs.map((r) => r.nonceKey)).size).toBe(8);
    expect(new Set(rs.map((r) => r.receipt!.blockNumber)).size).toBeLessThanOrEqual(3); // four relayed per bundler pass
  }, T);

  test("the public pool holds one frame transaction per sender: a second is refused, the alt mempool takes it", async () => {
    await withLeaf("public pool first", (a) => withLeaf("public pool second", async (b) => {
      const [t1, t2] = [await signedFor(a, a), await signedFor(b, b)];
      w.chain.paused = true;
      let h1: Hex;
      try {
        h1 = await node.sendRawPublic(t1);
        const err = await node.sendRawPublic(t2).catch((x) => x);
        expect(err).toBeInstanceOf(RpcError);
        expect(err.message).toContain(`sender ${ACCOUNT} already has 1 pending frame transaction(s), the limit is 1 per sender`);
        expect(await gateway.send(t2)).toBe(frameTxHash(t2)); // a separate key: the alt mempool holds it beside the first
      } finally {
        w.chain.paused = false;
      }
      const deadline = Number(BigInt(t1.frames[0]!.data));
      const [r1, r2] = await Promise.all([
        waitForInclusion(h1!, { sender: ACCOUNT, nonceKey: nonceKeyFor(0, a), deadline, pollMs: 200 }),
        waitForInclusion(frameTxHash(t2), { sender: ACCOUNT, nonceKey: nonceKeyFor(0, b), deadline, pollMs: 200 }),
      ]);
      expect([r1.outcome, r2.outcome]).toEqual(["OnChain", "OnChain"]);
      expect(await gateway.status(h1!)).toBeNull(); // the sidecar never saw the public one
    }));
  }, T);

  test("the alt mempool: one pending transaction per key, no replacement without a 10% fee bump, 'already known'", async () => {
    // Three messages on one leaf: harmless with this run's throwaway seed, and exactly why the pipeline never fee-bumps.
    await withLeaf("replacement", async (leaf) => {
      const a = await signedFor(leaf, leaf);
      const paid = { maxFeePerGas: a.fees.maxFeePerGas, maxPriorityFeePerGas: a.fees.maxPriorityFeePerGas }; // as ground
      const same = await signedFor(leaf, leaf, { fees: paid, calls: [{ to: SHOP, value: 2n }] });
      const bumped = await signedFor(leaf, leaf, { calls: [{ to: SHOP, value: 3n }], fees: { maxFeePerGas: (paid.maxFeePerGas * 11n) / 10n + 1n, maxPriorityFeePerGas: (paid.maxPriorityFeePerGas * 11n) / 10n + 1n } });
      w.chain.paused = true;
      try {
        expect(await gateway.send(a)).toBe(frameTxHash(a));
        expect((await gateway.send(same).catch((x) => x)).message).toBe("eth_sendFrameTransaction: Frame transaction cannot be replaced: fee too low (-32602)");
        expect((await gateway.send(a).catch((x) => x)).message).toBe("eth_sendFrameTransaction: Frame transaction already known (-32602)");
        expect(await gateway.send(bumped)).toBe(frameTxHash(bumped));
        expect(await gateway.status(frameTxHash(a))).toBeNull(); // replaced: no longer held
        expect((await gateway.explorerRecord(frameTxHash(a))).admission.outcome).toBe("replaced");
      } finally {
        w.chain.paused = false;
      }
      const r = await waitForInclusion(frameTxHash(bumped), { sender: ACCOUNT, nonceKey: nonceKeyFor(0, leaf), deadline: Number(BigInt(bumped.frames[0]!.data)), pollMs: 200 });
      expect(r.outcome).toBe("OnChain");
    });
  }, T);
});

describe("estimates, crash recovery and the prefix cap", () => {
  test("estimateCalls: state gas 0 to an existing account, 183,600 to a fresh one; the send with the estimates lands", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const calls: Call[] = [{ to: SHOP, value: 1n }, { to: fresh, value: 1n }, { to: ACCOUNT, data: hotPolicy(1008, 10n ** 16n) }];
    // estimateCalls signs each estimate unground at 94,900: about 1 message in 60 runs dry behind the proxy (see README).
    let est: Awaited<ReturnType<typeof estimateCalls>> | undefined;
    for (let i = 0; i < 4 && !est; i++) {
      est = await estimateCalls({ journal, band: COLD, sender: ACCOUNT, calls, signatures: slots }).catch((e) => {
        if (i < 3 && /validation frame 1: reverted \(-32500\)$/.test(String(e.message))) return undefined;
        throw e;
      });
    }
    expect(est!.map((e) => e.state)).toEqual([0n, 183_600n, 0n]);
    expect(est![0]!.used).toBe(3_000n);
    expect(est!.every((e) => journal.get(e.leaf)?.status === "burned")).toBe(true);
    const r = await send(withEstimates([calls[1]!], [est![1]!]));
    expect(r.outcome).toBe("OnChain");
    expect(BigInt(r.receipt!.frameReceipts[2]!.gasUsed.state)).toBe(183_600n);
    expect(await node.balance(fresh)).toBe(1n);
  }, T);

  test("settleSubmitted finishes a lane left 'submitted' by a crash right after the send", async () => {
    let sentWire: unknown;
    const crashed = await send([{ to: SHOP, value: 9n }], {
      onSend: (wire) => {
        sentWire = wire;
        void rpc(DEVNET.gateway, "eth_sendFrameTransaction", [wire]); // the transaction leaves; then the process "dies"
        throw new Error("simulated crash after the send");
      },
    }).catch((x) => x);
    expect(crashed.message).toBe("simulated crash after the send");
    expect(sentWire).toBeDefined();
    const pending = journal.all().filter((l) => l.status === "submitted");
    expect(pending.length).toBe(1);
    const out = await settleSubmitted(journal, { pollMs: 200, receiptWaitMs: 10_000 });
    expect(out).toEqual([{ leaf: pending[0]!.leaf, outcome: "OnChain" }]);
    expect(journal.get(pending[0]!.leaf)?.status).toBe("onchain");
  }, T);

  test("the prefix cap: 'validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000'", async () => {
    await withLeaf("120k prefix", async (leaf) => {
      const sl = slots(leaf);
      let tx = buildFrameTx({
        chainId: DEVNET.chainId, sender: ACCOUNT, nonce: { keys: [nonceKeyFor(0, leaf)], seq: 0n }, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90,
        calls: [{ to: SHOP, value: 1n }], fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, signatures: placeholders(sl),
      });
      tx = { ...tx, frames: tx.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, execution: 115_000n } } : f)) }; // buildFrameTx refuses this itself
      const signed = (await signFrameTx(tx, sl)).tx;
      const text = "validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000";
      const err = await gateway.send(signed).catch((x) => x);
      expect([err.code, err.message]).toEqual([-32602, `eth_sendFrameTransaction: ${text} (-32602)`]);
      const rec = (await gateway.explorerRecord(frameTxHash(signed))).admission;
      expect(rec.checks.find((c: any) => c.verdict === "fail")).toEqual({ rule: "structure", verdict: "fail", detail: text });
      const fixtureRules = FIXTURE.rejected.admission.checks.map((c: any) => [c.rule, c.verdict]);
      for (const pair of fixtureRules) expect(rec.checks.map((c: any) => [c.rule, c.verdict])).toContainEqual(pair);
      const sim: any = await node.simulate(signed, false);
      expect([sim.canonicalMempoolValid, sim.canonicalMempoolViolation]).toEqual([false, text]);
    });
    const e = await send([{ to: SHOP, value: 1n }], { verifyGas: 99_000n }).catch((x) => x);
    expect(e.stage).toBe("check"); // the pipeline refuses it before reserving a leaf
  }, T);

  test("the faucet: 1 ETH once per address, then refused", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const r = await gateway.faucet(fresh);
    expect(r.amount).toBe("1000000000000000000");
    for (let i = 0; i < 100 && (await node.balance(fresh)) === 0n; i++) await sleep(200);
    expect(await node.balance(fresh)).toBe(ETH);
    expect((await gateway.faucet(fresh).catch((x) => x)).message).toContain("This address already received funds");
  }, T);

  test("the faucet funds an address with code (the account) with estimated gas; code that refuses ETH gets 'Internal error'", async () => {
    const r = await gateway.faucet(ACCOUNT);
    let receipt: any = null;
    for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [r.txHash]); if (!receipt) await sleep(200); }
    expect(receipt.status).toBe("0x1");
    expect(BigInt(receipt.gasUsed)).toBeGreaterThan(21_000n); // the proxy's DELEGATECALL runs
    const block = BigInt(receipt.blockNumber);
    expect(await balanceAt(ACCOUNT, block) - await balanceAt(ACCOUNT, block - 1n)).toBe(ETH);
    // The factory has no payable function: viem's estimate fails in the real faucet, nothing is sent, no drip counted.
    for (let i = 0; i < 2; i++) {
      const e = await gateway.faucet(FACTORY).catch((x) => x);
      expect([e.code, e.message]).toEqual([-32603, "skandha_explorer_faucet: Internal error (-32603)"]);
    }
    expect(await node.balance(FACTORY)).toBe(0n);
  }, T);

  test("eth_estimateFrameTransactionGas takes the legacy shorthand `nonce` alone, as the sidecar does: [0]/nonce", async () => {
    const tx = buildFrameTx({
      chainId: DEVNET.chainId, sender: ACCOUNT, nonce: { keys: [nonceKeyFor(0, 1)], seq: 0n }, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90,
      calls: [{ to: SHOP, value: 1n }], fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, signatures: placeholders(slots(1)),
    });
    const { nonceKeys, nonceSeq, ...rest } = toWire(tx);
    const legacy = { ...rest, nonce: "0x1" }; // the account's own nonce is 1
    const e = await rpc(DEVNET.gateway, "eth_estimateFrameTransactionGas", [legacy]).catch((x) => x);
    expect(accountReason(e)).toBe("nonce: legacy key"); // read as [0]/1: the protocol takes it, the account refuses key 0
    const both = await rpc(DEVNET.gateway, "eth_estimateFrameTransactionGas", [{ ...legacy, nonceKeys, nonceSeq }]).catch((x) => x);
    expect(both.message).toContain("send either nonce or nonceKeys/nonceSeq, not both");
  });
});

describe("admin calls (last: rotation changes the epoch)", () => {
  test("setHotPolicy applies; raising hotStart is refused by the account: the frame reverts, the key is used", async () => {
    expect((await send([{ to: ACCOUNT, data: hotPolicy(1008, 3n * 10n ** 15n) }])).outcome).toBe("OnChain");
    expect(await view("hotValueCap")).toBe(3n * 10n ** 15n);
    const raise = await send([{ to: ACCOUNT, data: hotPolicy(1009, 3n * 10n ** 15n) }], { preflight: false });
    expect(raise.outcome).toBe("Reverted");
    const raw = await rpc<any>(DEVNET.node, "eth_getTransactionReceipt", [raise.txHash]);
    expect(raw.fakechainRevertReasons).toEqual({ 2: "hot: band cannot shrink" });
    expect(await view("hotStart")).toBe(1008n);
    expect(journal.get(raise.leaf)?.note).toContain("frame 2 reverted");
    const pre = await send([{ to: ACCOUNT, data: hotPolicy(1009, 3n * 10n ** 15n) }]).catch((x) => x);
    expect(pre).toBeInstanceOf(PreflightRefused);
    expect(pre.message).toContain("execution reverted");
  }, T);

  test("rotate moves the epoch; a key of the old epoch is refused ('nonce: epoch'); the new tree signs", async () => {
    const seed = loadOrCreateSeed(w.deployment.tree!.seedFile);
    const k1 = new Keyring({ seed, generation: 1, height: 10, chains: [DEVNET.chainId], cacheDir: `${DATA_DIR}/hashsig-cache` });
    const [root1, seed1] = [bytesToHex(k1.root()), bytesToHex(k1.treeSeed)];
    const r = await send([{ to: ACCOUNT, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "rotate", args: [root1, seed1, 10] }) }]);
    expect(r.outcome).toBe("OnChain");
    expect([await view("epoch"), await view("root")]).toEqual([1n, BigInt(root1)]);
    await withLeaf("old-epoch key", async (leaf) => {
      const old = await signedFor(leaf, leaf);
      expect(await simulatedReason(old)).toBe("nonce: epoch");
      expect(accountReason(await gateway.send(old).catch((x) => x))).toBe("nonce: epoch");
    });
    // The new epoch gets its own journal, born now, and the generation-1 signer.
    const d1 = { ...w.deployment, params: { ...w.deployment.params, root: root1, treeSeed: seed1 } };
    const j1 = openJournal(d1, 1, { create: true });
    try {
      const s1 = keyringSigner(k1);
      const r1 = await sendKeyed({
        journal: j1, band: COLD, sender: ACCOUNT, calls: [{ to: SHOP, value: 1n }], verifyGas: 90_000n, grind: GRIND.cold, preflight: true,
        signatures: (leaf) => [{ kind: "hash", signer: s1, leaf }], pollMs: 200, receiptWaitMs: 10_000,
      });
      expect(r1.outcome).toBe("OnChain");
      expect(r1.nonceKey >> 32n).toBe(1n);
    } finally {
      j1.close();
    }
  }, T);
});

const hexBytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
