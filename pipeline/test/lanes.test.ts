// Tests of parallel lanes (lanes.ts): lane cost, the plan, relay settings, and each refusal string against its source.
// Written with Claude Code (AI) for Vicky.
// One lane's cost is checked against ethrex's gas formula by hand; each refusal is built from its source's template.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import { buildFrameTx, nonceKeyFor, type BuildParams } from "../src/builder.ts";
import { EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE } from "../src/config.ts";
import { frameGasModel } from "../src/estimate.ts";
import { hashEntryLength } from "../src/signer.ts";
import {
  ONE_LANE_SECONDS, RELAY_DEFAULTS, accountReason, explainRefusal, laneCost, laneMaxCostWei, planLanes, relayConfig, type RefusalExplained,
  type RelayConfig,
} from "../src/lanes.ts";
import type { FrameTransaction, SignatureEntry } from "../src/codec/FrameTx.ts";

const SENDER: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
const A: Address = "0x00000000000000000000000000000000000000a1";
/** 0x0000000069000000: one non-zero byte and seven zero bytes in the expiry frame's data */
const DEADLINE = 0x6900_0000;
const GWEI2 = 2_000_000_000n;

const entry = (height: number, fill = 0): SignatureEntry =>
  ({ scheme: 0, signer: "0x", msg: "0x", signature: toHex(new Uint8Array(hashEntryLength(height)).fill(fill)) });
const lane = (over: Partial<BuildParams> = {}): FrameTransaction => buildFrameTx({
  chainId: 1337n, sender: SENDER, nonce: { keys: [nonceKeyFor(0, 5)], seq: 0n }, verifyGas: 90_000n, deadline: DEADLINE,
  calls: [{ to: BOB, value: 1_000n }], fees: { maxFeePerGas: GWEI2, maxPriorityFeePerGas: 1_000_000_000n }, signatures: [entry(10)], ...over,
});
const word = (reason: string) => `0x${Buffer.from(reason).toString("hex").padEnd(64, "0")}`;

describe("laneCost: ethrex's total_gas_limit times maxFeePerGas, plus the frames' value", () => {
  test("a height-10 transfer by hand: 206,121 gas, the standard branch", () => {
    // mandatory: 12,000 + 475 x 3 frames + 100 (ARBITRARY entry) + 6,000 (one value frame) = 19,525
    // data: expiry 1 x 16 + 7 x 4 = 44; the placeholder entry priced as 2,594 non-zero bytes = 41,504; the nonce RLP
    //       0xc105 0x80, 3 non-zero bytes = 48. Intrinsic 19,525 + 41,596 = 61,121
    // standard: 61,121 + 5,000 + 90,000 + 50,000 = 206,121; floor: 19,525 + 64 x 2,605 bytes = 186,245
    const c = laneCost(lane());
    expect(c).toEqual({ gasLimit: 206_121n, maxFeePerGas: GWEI2, gasCostWei: 206_121n * GWEI2, valueWei: 1_000n, totalWei: 206_121n * GWEI2 + 1_000n });
    expect(laneMaxCostWei(lane())).toBe(c.totalWei);
  });

  test("small limits take the floor branch, and state gas is paid on top of the floor, never inside it", () => {
    const small = { verifyGas: 10_000n, calls: [{ to: BOB, value: 1_000n, gas: 1_000n }] };
    expect(laneCost(lane(small)).gasLimit).toBe(186_245n); // 61,121 + 16,000 = 77,121 is below the floor
    const fresh = { verifyGas: 10_000n, calls: [{ to: BOB, value: 1_000n, gas: 1_000n, stateGas: 183_600n }] };
    expect(laneCost(lane(fresh)).gasLimit).toBe(186_245n + 183_600n); // floor + state, above 77,121 + 183,600
    // the standard branch adds state too
    expect(laneCost(lane({ calls: [{ to: BOB, value: 1_000n, stateGas: 183_600n }] })).gasLimit).toBe(206_121n + 183_600n);
  });

  test("a placeholder entry is priced as non-zero bytes (an upper bound); a signed entry is priced exactly", () => {
    const placeholder = lane();
    const m = frameGasModel({ ...placeholder, signatures: [entry(10, 0xff)] });
    expect(laneCost(placeholder).gasLimit).toBe(m.intrinsic + 145_000n);
    expect(frameGasModel(placeholder).dataCost).toBe(m.dataCost - 12n * 2_594n); // what pricing zeros at 4 would have said
    // a signed entry with ten zero bytes: exactly 10 x 12 gas less than the placeholder's bound
    const bytes = new Uint8Array(hashEntryLength(10)).fill(0xab);
    bytes.fill(0, 100, 110);
    const signed = { ...placeholder, signatures: [{ ...entry(10), signature: toHex(bytes) }] };
    expect(laneCost(placeholder).gasLimit - laneCost(signed).gasLimit).toBe(120n);
    // with no zero byte the bound is exact
    expect(laneCost({ ...placeholder, signatures: [entry(10, 0xab)] }).gasLimit).toBe(laneCost(placeholder).gasLimit);
  });

  test("the value of every top-level frame counts; the fee scales the gas part only", () => {
    const two = lane({ calls: [{ to: BOB, value: 7n }, { to: A, value: 5n }] });
    const c = laneCost(two);
    expect(c.valueWei).toBe(12n);
    expect(c.totalWei).toBe(c.gasLimit * GWEI2 + 12n);
    const cheap = laneCost(lane({ fees: { maxFeePerGas: 7n, maxPriorityFeePerGas: 1n } }));
    expect([cheap.gasCostWei, cheap.totalWei]).toEqual([206_121n * 7n, 206_121n * 7n + 1_000n]);
  });

  test("blobs and recent-root references are refused rather than priced wrong", () => {
    expect(() => laneCost({ ...lane(), blobVersionedHashes: [`0x${"01".repeat(32)}`] })).toThrow(/does not price blobs/);
    expect(() => laneCost({ ...lane(), recentRootReferences: [{ sourceId: `0x${"02".repeat(32)}`, slot: 1n, root: `0x${"03".repeat(32)}` }] })).toThrow(/recent-root/);
  });
});

describe("planLanes", () => {
  const relay = { bundleSize: 4, bundleIntervalSeconds: 10, assumed: false, bundlingMode: "auto" };
  const base = { n: 8, perLaneCostWei: 1_000n, pendingCostWei: 500n, balanceWei: 10_000n, relay, expirySeconds: 90 };

  test("eight lanes: set aside pending + 8 x per lane, two passes, about 38 s", () => {
    expect(planLanes(base)).toEqual({ affordable: true, setAsideWei: 8_500n, shortfallWei: 0n, passes: 2, etaSeconds: 38, warnings: [] });
    expect(ONE_LANE_SECONDS).toBe(28);
  });

  test("the balance must cover everything pending plus the new lanes: the shortfall is the difference", () => {
    expect(planLanes({ ...base, balanceWei: 8_000n })).toMatchObject({ affordable: false, setAsideWei: 8_500n, shortfallWei: 500n });
    expect(planLanes({ ...base, balanceWei: 8_500n })).toMatchObject({ affordable: true, shortfallWei: 0n }); // exactly enough
  });

  test("passes and the estimate follow the relay: 16 lanes take 4 passes, 58 s; one pass of 10 in testing mode", () => {
    expect(planLanes({ ...base, n: 16 })).toMatchObject({ passes: 4, etaSeconds: 58 });
    expect(planLanes({ ...base, n: 1 })).toMatchObject({ passes: 1, etaSeconds: 28 });
    expect(planLanes({ ...base, n: 8, relay: { ...relay, bundleSize: 10 } })).toMatchObject({ passes: 1, etaSeconds: 28 });
    expect(planLanes({ ...base, n: 9, relay: { ...relay, bundleIntervalSeconds: 0.5 } })).toMatchObject({ passes: 3, etaSeconds: 29 });
  });

  test("warnings: assumed defaults (with why), a last pass after the deadline, a sidecar that relays nothing by itself", () => {
    const assumed = planLanes({ ...base, relay: { ...relay, assumed: true, notes: ["skandha_config: no response"] } });
    expect(assumed.warnings).toEqual(["the sidecar's relay settings were not read (skandha_config: no response): assumed its defaults, 4 lanes per pass every 10 s"]);
    const late = planLanes({ ...base, expirySeconds: 30 });
    expect(late.warnings).toEqual(["the last of 2 relay passes is due about 38 s after the send (an estimate), past the 30 s deadline: its lanes may expire before they are relayed; send fewer lanes at once, or give them a longer expiry"]);
    expect(planLanes({ ...base, relay: { ...relay, bundlingMode: "manual" } }).warnings[0]).toMatch(/^the sidecar's bundling mode is manual: it relays nothing by itself/);
  });

  test("bad input throws", () => {
    for (const bad of [{ n: 0 }, { n: 1.5 }, { perLaneCostWei: -1n }, { balanceWei: -1n }, { expirySeconds: 0 }, { relay: { ...relay, bundleSize: 0 } }, { relay: { ...relay, bundleIntervalSeconds: 0 } }]) {
      expect(() => planLanes({ ...base, ...bad })).toThrow();
    }
  });
});

describe("relayConfig: skandha_config and skandha_explorer_info, else the defaults", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const CONFIG = { chainId: 1337, flags: { testingMode: false, redirectRpc: false }, bundleSize: 4, bundleInterval: 10_000, maxSubmitAttempts: 3, useropsTTL: 300 };
  /** A fake sidecar: answers per method, or an error object, or no answer at all (throws). */
  function sidecar(answers: Record<string, unknown>) {
    const seen: { url: string; method: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(url), method: body.method });
      const a = answers[body.method];
      if (a === undefined) throw new Error("connection refused");
      const payload = a instanceof Error ? { error: { code: -32601, message: a.message } } : { result: a };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), { status: 200 });
    }) as typeof fetch;
    return seen;
  }

  test("read: the configured numbers, the interval in seconds, the bundling mode", async () => {
    const seen = sidecar({ skandha_config: CONFIG, skandha_explorer_info: { bundlingMode: "auto", chainId: 1337 } });
    expect(await relayConfig("http://sidecar.test/rpc")).toEqual({
      bundleSize: 4, bundleIntervalSeconds: 10, maxSubmitAttempts: 3, useropsTTLSeconds: 300, bundlingMode: "auto", testingMode: false, assumed: false, notes: [],
    } satisfies RelayConfig);
    expect(seen.map((s) => s.method).sort()).toEqual(["skandha_config", "skandha_explorer_info"]);
    expect(seen.every((s) => s.url === "http://sidecar.test/rpc")).toBe(true);
    sidecar({ skandha_config: { ...CONFIG, bundleSize: 2, bundleInterval: 500 }, skandha_explorer_info: { bundlingMode: "manual" } });
    expect(await relayConfig("x")).toMatchObject({ bundleSize: 2, bundleIntervalSeconds: 0.5, bundlingMode: "manual", assumed: false });
  });

  test("not read (no answer, an error, or unusable numbers): the defaults, assumed, and why", async () => {
    sidecar({});
    const lost = await relayConfig("x");
    expect(lost).toMatchObject({ ...RELAY_DEFAULTS, bundlingMode: null, testingMode: false, assumed: true });
    expect(lost.notes).toEqual(["skandha_config: no response: connection refused", "skandha_explorer_info: no response: connection refused"]);
    sidecar({ skandha_config: new Error("the method skandha_config does not exist"), skandha_explorer_info: { bundlingMode: "auto" } });
    expect(await relayConfig("x")).toMatchObject({ bundleSize: 4, bundleIntervalSeconds: 10, bundlingMode: "auto", assumed: true });
    sidecar({ skandha_config: { ...CONFIG, bundleSize: "4" }, skandha_explorer_info: {} });
    const bad = await relayConfig("x");
    expect(bad).toMatchObject({ bundleSize: 4, assumed: true, bundlingMode: null });
    expect(bad.notes).toEqual(["skandha_config named no usable bundleSize and bundleInterval", "skandha_explorer_info named no bundlingMode"]);
  });

  test("testingMode relays up to 10 per bundle (executor.ts:225-227), whatever bundleSize says", async () => {
    sidecar({ skandha_config: { ...CONFIG, flags: { testingMode: true } }, skandha_explorer_info: { bundlingMode: "manual" } });
    const r = await relayConfig("x");
    expect([r.bundleSize, r.testingMode, r.assumed]).toEqual([10, true, false]);
    expect(r.notes).toEqual(["testingMode: up to 10 lanes per bundle, relayed only on demand"]);
  });
});

describe("explainRefusal: each message as its source writes it", () => {
  const SIDECAR = path.resolve(import.meta.dir, "../../vendor/mempool-workshop-sidecar");
  const source = (rel: string) => fs.readFileSync(path.join(SIDECAR, rel), "utf8");
  const EXEC = "packages/executor/src";
  const HASH: Hex = `0x${"ab".repeat(32)}`;

  /** [the message as built from the template, the file, a piece of the template that must still be in it, code] */
  const cases: [string, string, string, string][] = [
    [`Frame transaction nonce key 0x5 is already held by pending transaction ${HASH}`, `${EXEC}/services/MempoolService/service.ts`, ")} is already held by pending transaction ${pending.txHash}`", "key_busy"],
    ["Frame transaction cannot be replaced: fee too low", `${EXEC}/services/MempoolService/service.ts`, `"Frame transaction cannot be replaced: fee too low"`, "same_slot"],
    ["Frame transaction already known", `${EXEC}/services/MempoolService/service.ts`, `"Frame transaction already known"`, "duplicate"],
    [`${A} cannot cover its pending frame transactions: they would owe 900 wei (300 for this one), its balance is 800 wei`, `${EXEC}/services/MempoolService/service.ts`,
      "cannot cover its pending frame transactions: they would owe ${owed} wei (${amount} for this one), its balance is ${balance} wei", "over_budget"],
    [`${A} can no longer cover its pending frame transactions as of block 77: balance 5 wei`, `${EXEC}/services/MempoolService/service.ts`,
      "can no longer cover its pending frame transactions as of block ${blockNumber}: balance ${balance} wei", "evicted_for_balance"],
    ["validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000", `${EXEC}/services/UserOpValidation/utils/validationPrefix.ts`,
      "= ${totalVerifyGas} exceeds MAX_VERIFY_GAS ${MAX_VERIFY_GAS}", "prefix_over_cap"],
    ["relayed 4 times without being included in a block", `${EXEC}/services/BundlingService/service.ts`, "`relayed ${entry.submitAttempts} times without being included in a block`", "dropped"],
    ["revalidation failed as of block 9: Execution reverted", `${EXEC}/services/BundlingService/reconciliation.ts`, "`revalidation failed as of block ${this.lastReconciledBlock}: ${", "dropped"],
    [`payer ${A} is throttled`, `${EXEC}/services/MempoolService/reputation.ts`, "`${titles[index]} ${stake.addr} is throttled`", "throttled"],
    [`sender ${A} is banned`, `${EXEC}/services/MempoolService/reputation.ts`, "`${titles[index]} ${stake.addr} is banned`", "banned"],
    [`validation frame 1: reverted with data ${word("hot: value cap")}`, `${EXEC}/services/UserOpValidation/validators/frameTx.ts`, "`${at}: reverted with data ${simResult.revertData}`", "account_refused"],
    ["validation frame 0: reverted", `${EXEC}/services/UserOpValidation/validators/frameTx.ts`, "`${at}: reverted`", "expired"],
    ["revalidation failed as of block 9: validation frame 0: reverted", `${EXEC}/services/BundlingService/reconciliation.ts`, "`revalidation failed as of block ${this.lastReconciledBlock}: ${", "expired"],
    ["validation frame 1: ran out of gas (OutOfGas)", `${EXEC}/services/UserOpValidation/validators/frameTx.ts`, "`${at}: ran out of gas${haltDetail ?", "out_of_gas"],
    // ethrex's NonceMismatch, as the sidecar's own e2e test quotes it, sequence N+1 offered while N is current
    ["Nonce mismatch: expected 3, got 4", "test/e2e/frameTxSelfRelayMultiTx.e2e.test.ts", "Nonce mismatch: expected N, got N+1", "sequence_ahead"],
  ];
  for (const [msg, file, template, code] of cases) {
    test(`${code}: ${msg.slice(0, 70)}`, () => {
      expect(source(file)).toContain(template);
      expect(explainRefusal(msg).code).toBe(code as never);
    });
  }

  test("frameTx.ts names the frame as `validation frame N`, which the account and gas patterns rely on", () => {
    expect(source(`${EXEC}/services/UserOpValidation/validators/frameTx.ts`)).toContain("const at = `validation frame ${frame}`;");
  });

  test("Nonce mismatch compares the two: the chain's sequence above the transaction's is a used key (Day-0: expected 1, got 0)", () => {
    expect(explainRefusal("eth_sendFrameTransaction: Nonce mismatch: expected 1, got 0 (-32500)")).toEqual({
      code: "key_used", laneState: "key already used: the key's sequence on chain is 1, the transaction's 0",
      hint: "an earlier transaction on this key was included, so its leaf is spent: send on a fresh leaf and key, never on this one again",
    });
    expect(explainRefusal("Nonce mismatch: expected 0, got 1")).toMatchObject({ code: "sequence_ahead", laneState: "sequence ahead: the transaction's sequence 1 is past the key's 0 on chain" });
    expect(explainRefusal("Nonce mismatch: expected 2, got 2").code).toBe("unknown"); // not a mismatch at all
  });

  test("the public pool's refusal (ethrex crates/blockchain/error.rs:165 at 9aa3645d, FrameTxSenderAlreadyPending)", () => {
    expect(explainRefusal("eth_sendRawTransaction: A pending frame transaction from this sender is already in the pool (-32000)")).toMatchObject({
      code: "public_one_per_sender", laneState: "public mempool: one pending frame transaction per sender, and this account already has one",
    });
  });

  test("the account's 32-byte reason is decoded, and its hint named", () => {
    expect(explainRefusal(`validation frame 1: reverted with data ${word("hot: value cap")}`)).toEqual({
      code: "account_refused", laneState: `refused by the account (validation frame 1): "hot: value cap"`,
      hint: "the lane sends more than the hot value cap: send less, or raise the cap from a cold leaf (POST /hot-policy)",
    });
    expect(explainRefusal(`validation frame 1: reverted with data ${word("hot: frame target")}`).hint).toBe("hot tickets may pay only the allowed target");
    expect(explainRefusal("validation frame 1: reverted").laneState).toBe("refused by the account (validation frame 1), with no reason");
    expect(explainRefusal(`validation frame 1: reverted with data ${word("rotate: same tree")}`).hint).toMatch(/^the account's own rule \(Account\.yul\) refused it/);
    expect(accountReason(word("hot: fee cap"))).toBe("hot: fee cap");
    expect([accountReason("0x"), accountReason("0xff00"), accountReason("0x123"), accountReason(null)]).toEqual([null, null, null, null]);
  });

  test("frame 0 reverting with no data is the expiry frame: expired at admission and when the reconciler drops it; frame 1 stays the account's", () => {
    // every REVERT in the expiry verifier's code is revert(0, 0): PUSH0 PUSH0 REVERT, so it never returns data
    const code = hexToBytes(EXPIRY_VERIFIER_CODE);
    const reverts: number[] = [];
    for (let i = 0; i < code.length; i++) {
      const op = code[i]!;
      if (op === 0xfd) reverts.push(i);
      if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSHn's data
    }
    expect(reverts.length).toBeGreaterThan(0);
    for (const i of reverts) expect([code[i - 2], code[i - 1]]).toEqual([0x5f, 0x5f]);
    // and the builder puts the expiry frame first, so "validation frame 0" is that frame
    expect(lane().frames[0]!.target).toBe(EXPIRY_VERIFIER);

    const expired: RefusalExplained = {
      code: "expired", laneState: "expired: the deadline passed before the lane was held or relayed (validation frame 0, the expiry frame, reverted)",
      hint: "the leaf is burned: retry on a fresh leaf with a later deadline, never on this leaf and never with a fee bump",
    };
    expect(explainRefusal("validation frame 0: reverted")).toEqual(expired);
    expect(explainRefusal("leaf 5: refused at submission: eth_sendFrameTransaction: validation frame 0: reverted (-32602)")).toEqual(expired);
    expect(explainRefusal("validation frame 0: reverted with data 0x")).toEqual(expired); // empty data is no data
    expect(explainRefusal("revalidation failed as of block 9: validation frame 0: reverted")).toEqual({
      ...expired, laneState: "expired at block 9: the deadline passed before the lane was relayed, and the sidecar dropped it (validation frame 0, the expiry frame, reverted)",
    });
    // the account's verify frame is frame 1: its revert, with a reason or without, is the account's own refusal
    expect(explainRefusal("validation frame 1: reverted")).toMatchObject({ code: "account_refused", laneState: "refused by the account (validation frame 1), with no reason" });
    expect(explainRefusal("revalidation failed as of block 9: validation frame 1: reverted")).toMatchObject({
      code: "dropped", laneState: "dropped at block 9: the sidecar's re-simulation failed (refused by the account (validation frame 1), with no reason)",
    });
    // frame 0 reverting with data is not the expiry verifier (it returns none): left on the account's path
    expect(explainRefusal(`validation frame 0: reverted with data ${word("nonce: epoch")}`).code).toBe("account_refused");
  });

  test("the numbers in a message reach the lane state", () => {
    expect(explainRefusal(`Frame transaction nonce key 0x5 is already held by pending transaction ${HASH}`).laneState).toBe(`key busy: nonce key 0x5 is held by pending transaction ${HASH}`);
    expect(explainRefusal(`${A} cannot cover its pending frame transactions: they would owe 900 wei (300 for this one), its balance is 800 wei`).laneState)
      .toBe(`over budget: ${A}'s pending lanes and this one would owe 900 wei (300 for this one), and its balance is 800 wei`);
    expect(explainRefusal("validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000").laneState)
      .toBe("prefix over the cap: the verify prefix declares 120100 gas with its signature costs, above MAX_VERIFY_GAS 100000");
    expect(explainRefusal(`payer ${A} is throttled`).laneState).toBe(`reputation: the sidecar throttles the payer ${A}, which may then keep at most 4 transactions pending`);
  });

  test("a drop names what it wraps; a message wrapped by the pipeline and the backend is still known", () => {
    expect(explainRefusal(`revalidation failed as of block 9: validation frame 1: reverted with data ${word("hot: value cap")}`).laneState)
      .toBe(`dropped at block 9: the sidecar's re-simulation failed (refused by the account (validation frame 1): "hot: value cap")`);
    expect(explainRefusal("revalidation failed as of block 9: Execution reverted").laneState).toBe("dropped at block 9: the sidecar's re-simulation failed (Execution reverted)");
    const wrapped = `leaf 5: refused at submission: eth_sendFrameTransaction: Frame transaction nonce key 0x5 is already held by pending transaction ${HASH} (-32602)`;
    expect(explainRefusal(wrapped).code).toBe("key_busy");
    expect(explainRefusal("something else entirely")).toEqual({ code: "unknown", laneState: "a message this explainer does not know", hint: "read the message itself" });
  });
});
