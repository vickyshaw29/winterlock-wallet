// The send path against a fake chain and a fake sidecar, one test per failure the Nov 6 review found.
// The fake follows the protocol rules that matter here: a key is consumed once, at inclusion; the expiry frame stops
// inclusion in any block whose timestamp is past the deadline; state is read at a given block. Nothing is sent anywhere.
// Written with Claude Code (AI) for Vicky.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import { RpcError, gateway, node, normalizeNodeReceipt } from "../src/rpc.ts";
import {
  LeavesExhausted, OutcomeUnknown, PreflightRefused, RetryStopped, SendError, SubmissionRefused, forgetSystemCheck, sendKeyed, sendWithRetry,
  settleSubmitted, waitForInclusion, type SendKeyedParams,
} from "../src/submit.ts";
import { LeafJournal } from "../src/leaves.ts";
import { frameTxHash } from "../src/admission.ts";
import { nonceKeyFor, nonceManagerSlot } from "../src/builder.ts";
import { placeholderSigner, type HashSigner } from "../src/signer.ts";
import { DEVNET, EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, NONCE_MANAGER, NONCE_MANAGER_CODE } from "../src/config.ts";
import type { FrameTransaction } from "../src/codec/FrameTx.ts";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
const TREE: Hex = `0x${"11".repeat(32)}`;
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const answered = (method: string, code: number, msg: string) => new RpcError(method, code, msg, undefined, "answered");
const lost = (method: string) => new RpcError(method, undefined, "no response: The operation timed out.", undefined, "transport");

const g = gateway as any, n = node as any;
const realGateway = { ...gateway }, realNode = { ...node };
afterAll(() => { Object.assign(gateway, realGateway); Object.assign(node, realNode); });

/** Blocks every 6 s from now; each eth_blockNumber call (one per poll) sees one more block. */
class Chain {
  readonly base = 1_000n;
  head = this.base;
  readonly t0 = BigInt(Math.floor(Date.now() / 1000));
  consumed = new Map<Hex, bigint>(); // nonce-manager slot -> block that consumed it
  receipts = new Map<Hex, any>(); // tx hash -> the node's raw receipt
  ts(b: bigint) { return this.t0 + 6n * (b - this.base); }
  seqAt(slot: Hex, b: bigint) { const c = this.consumed.get(slot); return c !== undefined && c <= b ? 1n : 0n; }
  /** Puts the transaction in the next block, unless its expiry frame would revert there. */
  include(tx: FrameTransaction, hash: Hex, frames = ["0x1", "0x1", "0x1"]): boolean {
    const block = this.head + 1n;
    if (this.ts(block) > BigInt(tx.frames[0]!.data)) return false;
    this.consumed.set(nonceManagerSlot(tx.sender, tx.nonceKeys[0]!), block);
    this.receipts.set(hash, {
      blockNumber: hex(block), status: "0x1", payer: tx.sender, cumulativeGasUsed: "0x1", gasUsed: "0x1",
      frameReceipts: frames.map((s) => ({ status: s, gasUsed: "0x1", stateGasUsed: "0x0", logs: [] })),
    });
    return true;
  }
}

let chain: Chain;
let held: Map<Hex, { deadline: number }>; // what the fake sidecar holds, by hash
let sends: { hash: Hex; at: bigint }[];
let journal: LeafJournal;
let dir: string;
const VALID = { canonicalMempoolValid: true, canonicalMempoolViolation: null, executionStatus: "success", prefixShape: "SelfVerify", payer: ACCOUNT, maxCost: "0x1", gasUsed: "0x1", frames: [] };

beforeEach(() => {
  chain = new Chain();
  held = new Map();
  sends = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "submit-"));
  journal = LeafJournal.open(path.join(dir, "journal.json"), { wallet: ACCOUNT, chainId: DEVNET.chainId, epoch: 0, height: 10, treeSeed: TREE }, { create: true });
  forgetSystemCheck();
  n.code = async (a: Address) => (a.toLowerCase() === NONCE_MANAGER ? NONCE_MANAGER_CODE : a.toLowerCase() === EXPIRY_VERIFIER ? EXPIRY_VERIFIER_CODE : "0x");
  n.blockNumber = async () => ++chain.head;
  n.block = async (b: bigint | "latest") => ({ number: b === "latest" ? chain.head : b, timestamp: chain.ts(b === "latest" ? chain.head : b) });
  n.blockTimestamp = async () => chain.ts(chain.head);
  n.storage = async (a: Address, slot: Hex) => word(a.toLowerCase() === NONCE_MANAGER ? chain.seqAt(slot, chain.head) : 0n);
  n.storageAt = async (a: Address, slot: Hex, b: bigint) => word(a.toLowerCase() === NONCE_MANAGER ? chain.seqAt(slot, b) : 0n);
  n.receipt = async (h: Hex) => {
    const r = chain.receipts.get(h);
    return r && BigInt(r.blockNumber) <= chain.head ? normalizeNodeReceipt(r) : null;
  };
  n.simulate = async () => VALID;
  g.gasPrice = async () => ({ maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" });
  // As the sidecar: OnChain once mined; a held entry is cancelled once the head is past its deadline (reconcileNew).
  g.status = async (h: Hex) => {
    if (chain.receipts.has(h)) return "OnChain";
    const e = held.get(h);
    return e ? (chain.ts(chain.head) > BigInt(e.deadline) ? "Cancelled" : "New") : null;
  };
  g.receipt = async () => { throw answered("eth_getFrameTransactionReceipt", -32000, "transaction receipt not found"); };
  g.explorerRecord = async () => null;
  g.send = async (tx: FrameTransaction) => {
    const h = frameTxHash(tx);
    sends.push({ hash: h, at: chain.head });
    hold(tx, h);
    chain.include(tx, h);
    return h;
  };
});
afterEach(() => { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const hold = (tx: FrameTransaction, h: Hex) => held.set(h, { deadline: Number(BigInt(tx.frames[0]!.data)) });
const signer = placeholderSigner({ treeSeed: TREE });
const base = (over: Partial<SendKeyedParams> = {}): SendKeyedParams => ({
  journal, band: { from: 1, to: 500 }, sender: ACCOUNT, calls: [{ to: BOB, value: 1n }], verifyGas: 90_000n,
  signatures: (leaf) => [{ kind: "hash", signer, leaf }], admission: false, pollMs: 1, ...over,
});

describe("outcomes come from chain state, two blocks deep", () => {
  test("a landed transfer is OnChain, decided at least two blocks after its block", async () => {
    const r = await sendKeyed(base());
    expect(r.outcome).toBe("OnChain");
    expect(r.decidedAt).toBeGreaterThanOrEqual(BigInt(r.receipt!.blockNumber));
    expect(chain.head - r.decidedAt).toBe(2n);
    expect(journal.get(r.leaf)?.status).toBe("onchain");
  });

  test("review #5/#13/#18: receipt lookups failing when it matters never turn a landed transfer into Expired", async () => {
    let outage = 6;
    n.receipt = async (h: Hex) => {
      if (outage-- > 0) throw lost("eth_getTransactionReceipt");
      const r = chain.receipts.get(h);
      return r ? normalizeNodeReceipt(r) : null;
    };
    const r = await sendKeyed(base({ expirySeconds: 7 })); // lands in the first block, then the deadline passes during the outage
    expect(r.outcome).toBe("OnChain");
    expect(chain.ts(r.decidedAt)).toBeGreaterThan(BigInt(r.deadline));
    expect(sends.length).toBe(1);
  });

  test("review #5: sendWithRetry pays once when the first attempt landed but its receipt was unreadable", async () => {
    let outage = 6;
    n.receipt = async (h: Hex) => {
      if (outage-- > 0) throw lost("eth_getTransactionReceipt");
      const r = chain.receipts.get(h);
      return r ? normalizeNodeReceipt(r) : null;
    };
    const r = await sendWithRetry({ ...base({ expirySeconds: 7 }), attempts: 3, dropWaitMs: 0 });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["OnChain"]);
    expect(sends.length).toBe(1);
  });

  test("a transaction that cannot land is Expired only once a block two deep is past the deadline with the key unused", async () => {
    const r = await sendKeyed(base({ expirySeconds: 1 })); // the next block is 6 s later: the expiry frame stops it
    expect(r.outcome).toBe("Expired");
    expect(chain.ts(r.decidedAt)).toBeGreaterThan(BigInt(r.deadline));
    expect(chain.seqAt(nonceManagerSlot(ACCOUNT, r.nonceKey), r.decidedAt)).toBe(0n);
    expect(journal.get(r.leaf)?.status).toBe("burned");
  });

  test("review #8/#14: a failed payment frame is Reverted, journaled as used, and not retried", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); sends.push({ hash: h, at: chain.head }); chain.include(tx, h, ["0x1", "0x1", "0x0"]); return h; };
    const r = await sendWithRetry({ ...base(), attempts: 3, dropWaitMs: 0 });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["Reverted"]);
    expect(r.final.receipt!.frameReceipts[2]!.status).toBe("reverted");
    expect(journal.get(r.final.leaf)?.status).toBe("onchain");
    expect(journal.get(r.final.leaf)?.note).toBe("included, but frame 2 reverted (frames 0, 1 succeeded): read the receipt before paying again");
    expect(sends.length).toBe(1);
  });

  test("a skipped frame is not a success either", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); chain.include(tx, h, ["0x1", "0x1", "0x2"]); return h; };
    expect((await sendKeyed(base())).outcome).toBe("Reverted");
  });

  test("review #9: without a deadline, Cancelled is never final; a found receipt still wins", async () => {
    const key = nonceKeyFor(0, 9);
    const h = `0x${"ab".repeat(32)}` as Hex;
    g.status = async () => "Cancelled";
    await expect(waitForInclusion(h, { sender: ACCOUNT, nonceKey: key, deadline: null, pollMs: 1, timeoutMs: 30 })).rejects.toBeInstanceOf(OutcomeUnknown);
    chain.consumed.set(nonceManagerSlot(ACCOUNT, key), chain.head);
    chain.receipts.set(h, { blockNumber: hex(chain.head), status: "0x1", payer: ACCOUNT, cumulativeGasUsed: "0x1", frameReceipts: [{ status: "0x1", gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }] });
    const r = await waitForInclusion(h, { sender: ACCOUNT, nonceKey: key, deadline: null, pollMs: 1 });
    expect(r.outcome).toBe("OnChain");
  });

  test("review #10: a receipt seen at zero confirmations decides nothing", async () => {
    let returnedAtHead = 0n;
    const r = await sendKeyed(base({ onStatus: (s) => { if (s.startsWith("chain: OnChain")) returnedAtHead = chain.head; } }));
    expect(returnedAtHead - BigInt(r.receipt!.blockNumber)).toBeGreaterThanOrEqual(2n);
  });
});

describe("a lost answer from eth_sendFrameTransaction is followed, not called a refusal", () => {
  test("review #6/#15/#19: timeout after admission: followed by its key, lands OnChain, one payment", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); hold(tx, h); chain.include(tx, h); throw lost("eth_sendFrameTransaction"); };
    const r = await sendKeyed(base());
    expect(r.outcome).toBe("OnChain");
    expect(journal.get(r.leaf)?.status).toBe("onchain");
    expect(journal.get(r.leaf)?.note).toContain("send outcome unknown");
  });

  test("a proxy's 502 is not a refusal: followed, even when the status call fails too", async () => {
    g.send = async (tx: FrameTransaction) => { chain.include(tx, frameTxHash(tx)); throw new RpcError("eth_sendFrameTransaction", 502, "HTTP 502", undefined, "http"); };
    g.status = async () => { throw lost("skandha_frameTransactionStatus"); };
    expect((await sendKeyed(base())).outcome).toBe("OnChain");
  });

  test("an internal error (-32603) is not a verdict: followed; never admitted, so it ends Expired and burned", async () => {
    g.send = async () => { throw answered("eth_sendFrameTransaction", -32603, "Internal error"); };
    const r = await sendKeyed(base({ expirySeconds: 12 }));
    expect(r.outcome).toBe("Expired");
    expect(journal.get(r.leaf)?.status).toBe("burned");
  });

  test("a deliberate refusal for a hash the sidecar does not hold: SubmissionRefused at once, leaf burned", async () => {
    g.send = async () => { throw answered("eth_sendFrameTransaction", -32602, "validation prefix execution gas sum exceeds MAX_VERIFY_GAS"); };
    const err = await sendKeyed(base()).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionRefused);
    expect(err.leaf).toBe(1);
    expect(err.deadline).toBeGreaterThan(0);
    expect(journal.get(1)?.status).toBe("burned");
    expect(journal.get(1)?.txHash).toBe(err.txHash);
  });

  test("a refusal while the sidecar does hold the hash: followed", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); hold(tx, h); chain.include(tx, h); throw answered("eth_sendFrameTransaction", -32602, "late failure"); };
    expect((await sendKeyed(base())).outcome).toBe("OnChain");
  });

  test("the hash and deadline are in the journal before the send leaves", async () => {
    let atSend: any;
    g.send = async (tx: FrameTransaction) => { atSend = { ...journal.get(1) }; const h = frameTxHash(tx); chain.include(tx, h); return h; };
    const r = await sendKeyed(base());
    expect(atSend.status).toBe("submitted");
    expect(atSend.txHash).toBe(r.txHash);
    expect(atSend.deadline).toBe(r.deadline);
  });
});

describe("review #2/#16/#23: checks before any leaf is reserved", () => {
  const nothingReserved = () => expect(journal.all()).toEqual([]);
  const refused = async (over: Partial<SendKeyedParams>, msg: RegExp) => {
    const err = await sendKeyed(base(over)).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.stage).toBe("check");
    expect(err.leaf).toBeNull();
    expect(err.message).toMatch(msg);
    nothingReserved();
    expect(sends.length).toBe(0);
  };

  test("the hash entry must be for the leaf about to be reserved", () =>
    refused({ signatures: (leaf) => [{ kind: "hash", signer, leaf: leaf + 1 }] }, /entry is for leaf 2, but the next leaf is 1/));
  test("the signer's generation must be the journal's epoch", () =>
    refused({ signatures: (leaf) => [{ kind: "hash", signer: { ...signer, generation: 1 }, leaf }] }, /generation 1, the journal's epoch is 0/));
  test("the signer's tree must be the journal's tree", () =>
    refused({ signatures: (leaf) => [{ kind: "hash", signer: placeholderSigner({ treeSeed: `0x${"22".repeat(32)}` }), leaf }] }, /tree seed/));
  test("the signer's height must be the journal's", () =>
    refused({ signatures: (leaf) => [{ kind: "hash", signer: { ...signer, height: 12 } as HashSigner, leaf }] }, /height 12/));
  test("one leaf per transaction", () =>
    refused({ signatures: (leaf) => [{ kind: "hash", signer, leaf }, { kind: "hash", signer, leaf }] }, /at most one leaf/));
  test("the sender must be the journal's wallet", () => refused({ sender: BOB }, /belongs to/));
  test("the expiry must be a whole number of seconds", async () => {
    await refused({ expirySeconds: 0 }, /expirySeconds/);
    await refused({ expirySeconds: 1.5 }, /expirySeconds/);
    await refused({ expirySeconds: Number.NaN }, /expirySeconds/);
  });
  test("a prefix over the 100k cap", () => refused({ verifyGas: 99_000n }, /not reserved/));
  test("a grind limit no message can meet", () => refused({ verifyGas: 40_000n, grind: { baseGas: 39_000, gasPerStep: 80 } }, /even the best message/));
  test("review #21: a host clock far from chain time", async () => {
    n.blockTimestamp = async () => chain.ts(chain.head) + 120n;
    await refused({}, /differ by more than 60 s/);
  });
  test("a nonce manager that cannot be read", async () => {
    n.storage = async () => { throw lost("eth_getStorageAt"); };
    await refused({}, /cannot read nonce key/);
  });
});

describe("deadline and keys", () => {
  test("review #21: with the host clock behind the chain, the deadline counts from chain time", async () => {
    n.blockTimestamp = async () => chain.ts(chain.head) + 40n; // within the 60 s limit
    const startChain = chain.ts(chain.head) + 40n;
    const r = await sendKeyed(base({ expirySeconds: 30 }));
    expect(BigInt(r.deadline)).toBe(startChain + 30n);
  });

  test("a key the chain already consumed (a journal that lost records) is burned with a note and skipped", async () => {
    chain.consumed.set(nonceManagerSlot(ACCOUNT, nonceKeyFor(0, 1)), chain.head);
    const r = await sendKeyed(base());
    expect(r.leaf).toBe(2);
    expect(journal.get(1)?.status).toBe("burned");
    expect(journal.get(1)?.note).toContain("already at sequence 1");
  });

  test("concurrent sends in one process get distinct leaves and distinct keys", async () => {
    const rs = await Promise.all([sendKeyed(base()), sendKeyed(base()), sendKeyed(base()), sendKeyed(base())]);
    expect(new Set(rs.map((r) => r.leaf)).size).toBe(4);
    expect(rs.every((r) => r.outcome === "OnChain")).toBe(true);
  });
});

describe("review #20: every failure after the reservation is written on the leaf", () => {
  test("a refused dry run (a JSON-RPC verdict) is PreflightRefused, leaf burned, nothing sent", async () => {
    n.simulate = async () => { throw answered("ethrex_simulateFrameTransaction", -32000, "Insufficient max fee per gas"); };
    const err = await sendKeyed(base({ preflight: true })).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightRefused);
    expect(journal.get(err.leaf)?.status).toBe("burned");
    expect(err.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sends.length).toBe(0);
  });

  test("an invalid verdict is PreflightRefused too", async () => {
    n.simulate = async () => ({ ...VALID, canonicalMempoolValid: false, canonicalMempoolViolation: "sig: hash-based check" });
    const err = await sendKeyed(base({ preflight: true })).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightRefused);
    expect(err.message).toContain("sig: hash-based check");
  });

  test("a dry run with no answer is a SendError at preflight (not a refusal), leaf burned", async () => {
    n.simulate = async () => { throw lost("ethrex_simulateFrameTransaction"); };
    const err = await sendKeyed(base({ preflight: true })).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err).not.toBeInstanceOf(PreflightRefused);
    expect(err.stage).toBe("preflight");
    expect(journal.get(err.leaf)?.status).toBe("burned");
  });

  test("a signer that throws burns the leaf", async () => {
    const broken: HashSigner = { ...signer, async sign() { throw new Error("seed unreadable"); } };
    const err = await sendKeyed(base({ signatures: (leaf) => [{ kind: "hash", signer: broken, leaf }] })).catch((e) => e);
    expect(err.stage).toBe("sign");
    expect(journal.get(err.leaf)?.status).toBe("burned");
  });

  test("no outcome in time: the leaf stays submitted with a note, never burned", async () => {
    g.send = async (tx: FrameTransaction) => frameTxHash(tx);
    n.storageAt = async () => { throw lost("eth_getStorageAt"); }; // the node goes dark after the send
    const err = await sendKeyed(base({ expirySeconds: 1, timeoutMs: 20 })).catch((e) => e);
    expect(err.stage).toBe("follow");
    expect(err.cause).toBeInstanceOf(OutcomeUnknown);
    expect(journal.get(err.leaf)?.status).toBe("submitted");
    expect(journal.get(err.leaf)?.note).toContain("outcome unknown");
  });
});

describe("retries", () => {
  test("expiry, then a fresh leaf and a fresh key; the burned leaf is reported", async () => {
    const r = await sendWithRetry({ ...base(), attempts: 3, firstAttempt: { expirySeconds: 1 }, dropWaitMs: 0 });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["Expired", "OnChain"]);
    expect(r.attempts[1]!.leaf).not.toBe(r.attempts[0]!.leaf);
    expect(r.attempts[1]!.nonceKey).not.toBe(r.attempts[0]!.nonceKey);
    expect(r.burnedLeaves).toEqual([r.attempts[0]!.leaf]);
  });

  test("review #7: the retry is sent only after the sidecar has dropped the dead attempt", async () => {
    let retried = false, pollsAfterRetry = 0, sendsBeforeDrop = -1;
    const fakeStatus = g.status;
    g.status = async (h: Hex) => {
      if (retried && h === sends[0]?.hash) {
        if (++pollsAfterRetry <= 3) { sendsBeforeDrop = sends.length; return "Submitted"; } // its reconciler has not run yet
        return "Cancelled";
      }
      return fakeStatus(h);
    };
    const r = await sendWithRetry({ ...base(), attempts: 2, firstAttempt: { expirySeconds: 1 }, dropWaitMs: 5_000, onRetry: () => { retried = true; } });
    expect(r.final.outcome).toBe("OnChain");
    expect(pollsAfterRetry).toBeGreaterThan(3); // it kept asking until the sidecar let go
    expect(sendsBeforeDrop).toBe(1); // and sent nothing while it still held the dead attempt
    expect(sends.length).toBe(2);
  });

  test("review #11: a sidecar that never drops the dead attempt stops the retry, with no leaf used and nothing sent", async () => {
    const fakeStatus = g.status;
    g.status = async (h: Hex) => (h === sends[0]?.hash ? "Submitted" : fakeStatus(h));
    const err = await sendWithRetry({ ...base(), attempts: 3, firstAttempt: { expirySeconds: 1 }, dropWaitMs: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryStopped);
    expect(err.message).toContain("still holds it");
    expect(err.attempts.map((a: any) => a.outcome)).toEqual(["Expired"]);
    expect(sends.length).toBe(1);
    expect(journal.all().length).toBe(1);
  });

  test("review #12: with a deadline, a Cancelled status is not final either: it lands, one payment", async () => {
    g.status = async () => "Cancelled"; // e.g. after maxSubmitAttempts relays, while a peer still includes it
    const r = await sendWithRetry({ ...base(), attempts: 3, dropWaitMs: 0 });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["OnChain"]);
    expect(sends.length).toBe(1);
  });

  test("review #20: an attempt that fails keeps the attempts before it", async () => {
    let n2 = 0;
    const realSend = g.send;
    g.send = async (tx: FrameTransaction) => {
      if (++n2 === 2) throw answered("eth_sendFrameTransaction", -32602, "cannot cover its pending frame transactions");
      return realSend(tx);
    };
    const err = await sendWithRetry({ ...base(), attempts: 3, firstAttempt: { expirySeconds: 1 }, dropWaitMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryStopped);
    expect(err.attempts.map((a: any) => a.outcome)).toEqual(["Expired"]);
    expect(err.cause).toBeInstanceOf(SubmissionRefused);
  });
});

describe("after a crash", () => {
  test("settleSubmitted follows each submitted leaf to its end by key and deadline", async () => {
    // leaf 1 landed, leaf 2 never did and its deadline is behind us, leaf 3 predates the deadline field
    const deadline = Number(chain.ts(chain.head)) + 1;
    for (const leaf of [1, 2, 3]) journal.reserveNext({ from: leaf, to: leaf + 1 });
    const h1 = `0x${"01".repeat(32)}` as Hex, h2 = `0x${"02".repeat(32)}` as Hex;
    journal.mark(1, "submitted", { txHash: h1, deadline });
    journal.mark(2, "submitted", { txHash: h2, deadline });
    journal.mark(3, "submitted", { txHash: `0x${"03".repeat(32)}` });
    chain.consumed.set(nonceManagerSlot(ACCOUNT, nonceKeyFor(0, 1)), chain.head);
    chain.receipts.set(h1, { blockNumber: hex(chain.head), status: "0x1", payer: ACCOUNT, cumulativeGasUsed: "0x1", frameReceipts: [{ status: "0x1", gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }] });
    const out = await settleSubmitted(journal, { pollMs: 1 });
    expect(out.map((o) => [o.leaf, o.outcome])).toEqual([[1, "OnChain"], [2, "Expired"], [3, "unknown"]]);
    expect(journal.get(1)?.status).toBe("onchain");
    expect(journal.get(2)?.status).toBe("burned");
    expect(journal.get(3)?.status).toBe("submitted");
  });
});

describe("second review (Nov 6)", () => {
  test("S3: a used key with no readable receipt is Included, journaled as used, and never paid again", async () => {
    n.receipt = async () => { throw lost("eth_getTransactionReceipt"); };
    const r = await sendWithRetry({ ...base({ receiptWaitMs: 20 }), attempts: 3, dropWaitMs: 0 });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["Included"]);
    expect(r.final.receipt).toBeNull();
    expect(journal.get(r.final.leaf)?.status).toBe("onchain");
    expect(journal.get(r.final.leaf)?.note).toContain("no receipt was readable");
    expect(sends.length).toBe(1);
  });

  test("S3: the node going dark after the key was seen used still ends Included, not in a hang or 'unknown'", async () => {
    let reads = 0;
    const realStorageAt = n.storageAt;
    n.storageAt = async (a: Address, slot: Hex, b: bigint) => {
      const v = await realStorageAt(a, slot, b);
      if (BigInt(v) !== 0n && ++reads > 1) throw lost("eth_getStorageAt");
      return v;
    };
    n.receipt = async () => null;
    expect((await sendKeyed(base({ receiptWaitMs: 20 }))).outcome).toBe("Included");
  });

  test("S3: once the key is seen used, the answer is never 'unknown', even past the give-up time", async () => {
    const key = nonceKeyFor(0, 7);
    chain.consumed.set(nonceManagerSlot(ACCOUNT, key), chain.head - 10n); // landed well before
    n.receipt = async () => null;
    const r = await waitForInclusion(`0x${"cd".repeat(32)}`, {
      sender: ACCOUNT, nonceKey: key, deadline: Number(chain.ts(chain.head)) - 60, timeoutMs: 0, receiptWaitMs: 30, pollMs: 1,
    });
    expect(r.outcome).toBe("Included");
  });

  test("S3: a receipt under the hash the sidecar answered is found", async () => {
    g.send = async (tx: FrameTransaction) => {
      const ours = frameTxHash(tx), theirs = `0x${"ee".repeat(32)}` as Hex;
      chain.include(tx, ours);
      chain.receipts.set(theirs, chain.receipts.get(ours));
      chain.receipts.delete(ours);
      return theirs;
    };
    const r = await sendKeyed(base());
    expect(r.outcome).toBe("OnChain");
    expect(journal.get(r.leaf)?.note).toContain("the sidecar answered hash");
  });

  test("S5: a multi-call transaction that partly ran names the frames that ran", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); chain.include(tx, h, ["0x1", "0x1", "0x1", "0x0"]); return h; };
    const r = await sendKeyed(base({ calls: [{ to: BOB, value: 5n }, { to: BOB, value: 1n }] }));
    expect(r.outcome).toBe("Reverted");
    expect(journal.get(r.leaf)?.note).toBe("included, but frame 3 reverted (frames 0, 1, 2 succeeded): read the receipt before paying again");
  });

  test("S8: an exhausted band is LeavesExhausted, nothing reserved", async () => {
    journal.markExported(1008, 1024, "ticket file");
    const err = await sendKeyed(base({ band: { from: 1008, to: 1024 } })).catch((e) => e);
    expect(err).toBeInstanceOf(LeavesExhausted);
    expect([err.stage, err.leaf]).toEqual(["check", null]);
    expect(sends.length).toBe(0);
  });

  test("S9: the system contracts are the ones Day-0 measured", () => {
    expect(NONCE_MANAGER).toBe("0x0000000000000000000000000000000000008250");
    expect(EXPIRY_VERIFIER).toBe("0x0000000000000000000000000000000000008141");
    expect(NONCE_MANAGER_CODE).toBe("0x60006000fd"); // revert(0, 0)
  });

  test("S9: a chain whose nonce manager is not the Day-0 contract is refused before any leaf is reserved", async () => {
    n.code = async () => "0x";
    const err = await sendKeyed(base()).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.stage).toBe("check");
    expect(err.message).toContain("not the code Day-0 measured");
    expect(journal.all()).toEqual([]);
    expect(sends.length).toBe(0);
  });

  test("S9: key state lives only at the nonce manager: the same slot elsewhere reads as unused", async () => {
    const slot = nonceManagerSlot(ACCOUNT, nonceKeyFor(0, 1));
    chain.consumed.set(slot, chain.head);
    expect(BigInt(await n.storage(NONCE_MANAGER, slot))).toBe(1n);
    expect(BigInt(await n.storage(BOB, slot))).toBe(0n);
  });

  test("S13: 'already known' while the status call fails: followed, lands OnChain, journaled as used", async () => {
    g.send = async (tx: FrameTransaction) => {
      const h = frameTxHash(tx);
      hold(tx, h);
      chain.include(tx, h);
      throw answered("eth_sendFrameTransaction", -32602, "Frame transaction already known");
    };
    let firstStatus = true;
    const fakeStatus = g.status;
    g.status = async (h: Hex) => { if (firstStatus) { firstStatus = false; throw lost("skandha_frameTransactionStatus"); } return fakeStatus(h); };
    const r = await sendKeyed(base());
    expect(r.outcome).toBe("OnChain");
    expect(journal.get(r.leaf)?.status).toBe("onchain");
  });

  test("S13: a deliberate refusal while the status call fails is followed, not burned", async () => {
    g.send = async (tx: FrameTransaction) => { const h = frameTxHash(tx); hold(tx, h); chain.include(tx, h); throw answered("eth_sendFrameTransaction", -32602, "refused"); };
    g.status = async () => { throw lost("skandha_frameTransactionStatus"); };
    expect((await sendKeyed(base())).outcome).toBe("OnChain");
  });

  test("a SendError after the transaction left carries what is needed to prove its end", async () => {
    g.send = async () => { throw answered("eth_sendFrameTransaction", -32602, "nope"); };
    const err = await sendKeyed(base()).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionRefused);
    expect(err.nonceKey).toBe(nonceKeyFor(0, 1));
    const end = await waitForInclusion(err.txHash, { sender: ACCOUNT, nonceKey: err.nonceKey, deadline: err.deadline, pollMs: 1 });
    expect(end.outcome).toBe("Expired");
  });
});

describe("grinding the fee (Vicky's decision, Nov 6)", () => {
  test("only the fee moves, one wei per try; the deadline is exact and the signed message fits", async () => {
    const tight = { baseGas: 90_000 - 470 * 66.1, gasPerStep: 66.1 }; // room for 470 steps, below the ~506 average
    const r = await sendKeyed(base({ grind: tight, expirySeconds: 90 }));
    const quoted = 0x77359400n; // the fake sidecar's maxFeePerGas
    expect(BigInt(r.deadline)).toBe(chain.ts(chain.base) + 90n);
    expect(r.grind!.tries.map((t) => t.value)).toEqual(r.grind!.tries.map((_, i) => quoted + BigInt(i)));
    expect(r.grind!.steps).toBeLessThanOrEqual(470);
    expect(r.grind!.tries.slice(0, -1).every((t) => t.steps > 470)).toBe(true);
    expect(r.outcome).toBe("OnChain");
  });

  test("a hot ticket under the 90k limit finds a fit with the default tries", async () => {
    // GRIND.hot behind the proxy leaves 409 steps: about 1 message in 227 fits
    const { GRIND } = await import("../src/config.ts");
    const { maxStepsFor } = await import("../src/grind.ts");
    for (let k = 0; k < 3; k++) {
      const r = await sendKeyed(base({ grind: GRIND.hot }));
      expect(r.grind!.steps).toBeLessThanOrEqual(r.grind!.maxSteps);
      expect(r.grind!.maxSteps).toBe(maxStepsFor({ ...GRIND.hot, verifyGasLimit: 90_000n }));
    }
  });
});

