// The model on its own, without HTTP: the account's checks, the admin refusals, gas, the state window, drift checks.
// Written with Claude Code (AI) for Vicky.
// The verify-frame cases are the ones account-sim.ts runs on the devnet; the drift checks compare the model with
// Account.yul, IWinterlockAccount.sol and the factory artifact.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, concat, encodeFunctionData, hexToBytes, keccak256, numberToHex, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { GRIND, buildFrameTx, createAccountCalldata, grind, nonceKeyFor, nonceManagerSlot, placeholders, predictAccountAddress, signFrameTx, wotsVerifySteps, FRAME_MODE, type Call, type FrameTransaction, type SignatureSlot } from "../../pipeline/src/index.ts";
import { NONCE_MANAGER } from "../../pipeline/src/config.ts";
import { Keyring, keyringSigner } from "../../pipeline/src/hashsig/keyring.ts";
import { Meter, OutOfGas, REASONS, Revert, SELECTORS, StateMeter, StorageCtx, VERIFY_GAS, accountCall, cfg, decodeReason, hashsigGas, packConfig } from "../src/accountModel.ts";
import { applyEoaTx, parseEoaTx } from "../src/eoaTx.ts";
import { FakeChain, StateUnavailable } from "../src/chain.ts";
import { CHAIN_ID, COINBASE, DEFAULT_OPTIONS, ETH, FACTORY, GWEI, IMPLEMENTATION, SHOP } from "../src/constants.ts";
import { FACTORY_SELECTORS, factoryCall } from "../src/factoryModel.ts";
import { ProtocolRefusal, runFrameTx, type BlockCtx, type RunResult } from "../src/frameTx.ts";
import { validateStructuralRules, recognizeValidationPrefix } from "../src/sidecarRules.ts";
import { factoryCode, genesisState, implementationCode } from "../src/world.ts";
import type { WorldState } from "../src/state.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const HEIGHT = 4; // a small tree keeps keygen instant; the checks do not depend on the height
const HOT_START = 2 ** HEIGHT - 4;
const COLD = 3, HOT = HOT_START + 1;
const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey);

/** An account made through the factory model, funded, on a fresh genesis. */
function makeWorld(o: { hybrid?: boolean; height?: number } = {}) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const height = o.height ?? HEIGHT;
  const k = new Keyring({ seed, generation: 0, height, chains: [CHAIN_ID] });
  const { state } = genesisState({ eoa: owner.address, faucet: privateKeyToAccount(generatePrivateKey()).address });
  const params = {
    root: bytesToHex(k.root()), treeSeed: bytesToHex(k.treeSeed), height, owner: owner.address, hotStart: HOT_START,
    hotValueCap: 10n ** 16n, hotFeeCap: 2n * 10n ** 15n, allowedTarget: SHOP, salt: keccak256(toHex("model test")),
  };
  factoryCall(hexToBytes(createAccountCalldata(params)), state, new Meter(10_000_000), new StateMeter(10_000_000n));
  const account = predictAccountAddress(FACTORY, IMPLEMENTATION, params);
  state.setBalance(account, 10n * ETH);
  if (o.hybrid) {
    const c = state.sload(account, 2n);
    state.sstore(account, 2n, packConfig(cfg.owner(c), cfg.height(c), cfg.epoch(c), 1n, cfg.hotStart(c)));
  }
  return { state, k, account, signer: keyringSigner(k), params };
}
const ctx = (): BlockCtx => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFee: 7n, coinbase: COINBASE, chainId: CHAIN_ID });
const opts = { proxyHoldback: true };

interface Case {
  name: string;
  expect: string;
  keys?: bigint[]; seq?: bigint; leaf?: number; epoch?: number; hybrid?: boolean;
  slots?: (w: ReturnType<typeof makeWorld>) => SignatureSlot[];
  calls?: Call[] | ((w: ReturnType<typeof makeWorld>) => Call[]);
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  shape?: (tx: FrameTransaction) => FrameTransaction;
  tamper?: (tx: FrameTransaction) => FrameTransaction | Promise<FrameTransaction>;
  before?: (w: ReturnType<typeof makeWorld>) => void;
}

/** Builds, grinds (so a valid case fits the verify limit), signs and runs one case: "valid" or the account's reason. */
async function runCase(c: Case): Promise<string> {
  const w = makeWorld({ hybrid: c.hybrid });
  c.before?.(w);
  const leaf = c.leaf ?? COLD;
  const slots = c.slots?.(w) ?? [{ kind: "hash" as const, signer: w.signer, leaf: Math.min(leaf, 2 ** HEIGHT - 1) }];
  const fees = c.fees ?? { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI };
  const build = (fee: bigint) => {
    let tx = buildFrameTx({
      chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90, fees: { ...fees, maxFeePerGas: fee },
      nonce: { keys: c.keys ?? [nonceKeyFor(c.epoch ?? 0, leaf)], seq: c.seq ?? 0n }, calls: (typeof c.calls === "function" ? c.calls(w) : c.calls) ?? [{ to: SHOP, value: 1n }], signatures: placeholders(slots),
    });
    if (c.shape) tx = c.shape(tx);
    return tx;
  };
  const g = grind((i) => ({ value: fees.maxFeePerGas + BigInt(i), tx: build(fees.maxFeePerGas + BigInt(i)) }), { ...(leaf >= HOT_START ? GRIND.hot : GRIND.cold), verifyGasLimit: 90_000n });
  let tx = (await signFrameTx(g.tx, slots)).tx;
  if (c.tamper) tx = await c.tamper(tx);
  return verdict(runFrameTx(tx, w.state, ctx(), opts));
}
function verdict(r: RunResult): string {
  if (r.signatureError !== null) return `signature ${r.signatureError} invalid`;
  if (r.shapeError) return r.shapeError;
  if (r.prefixFailure) return decodeReason(r.prefixFailure.revertData) ?? `${r.prefixFailure.haltReason} (${r.prefixFailure.revertData ?? ""})`;
  return r.frames!.every((f) => f.status === "success") ? "valid" : `frame reverted: ${r.frames!.find((f) => f.reason)?.reason}`;
}
const setBytes = (i: number, edit: (b: Uint8Array) => Uint8Array) => (tx: FrameTransaction): FrameTransaction =>
  ({ ...tx, signatures: tx.signatures.map((s, j) => (j === i ? { ...s, signature: toHex(edit(hexToBytes(s.signature as Hex))) } : s)) });
const withByte = (pos: number, v: number) => (b: Uint8Array) => { const c = b.slice(); c[pos] = v; return c; };
const hash = (w: ReturnType<typeof makeWorld>, leaf = COLD): SignatureSlot => ({ kind: "hash", signer: w.signer, leaf });
const ecdsa = (key: Hex): SignatureSlot => ({ kind: "ecdsa", privateKey: key, signer: privateKeyToAccount(key).address });
const OTHER: Address = "0x000000000000000000000000000000000000dEaD";

describe("Account.yul's verify frame, case by case (account-sim.ts's cases)", () => {
  const cases: Case[] = [
    { name: "a valid cold transfer", expect: "valid" },
    { name: "a valid cold admin call (setHybrid(false) on itself)", expect: "valid", calls: (w) => [{ to: w.account, data: encodeFunctionData({ abi: parseAbi(["function setHybrid(bool)"]), functionName: "setHybrid", args: [false] }) }] },
    { name: "two nonce keys", expect: "nonce: key count", keys: [nonceKeyFor(0, COLD), nonceKeyFor(0, COLD + 1)] },
    { name: "the legacy nonce [0] (the account's nonce is 1)", expect: "nonce: legacy key", keys: [0n], seq: 1n },
    { name: "a key from another epoch", expect: "nonce: epoch", epoch: 1 },
    { name: "a leaf beyond 2^height", expect: "nonce: leaf range", leaf: 2 ** HEIGHT },
    { name: "two entries while hybrid is off", expect: "sig: count", slots: (w) => [ecdsa(ownerKey), hash(w)] },
    { name: "an ECDSA entry only", expect: "sig: entry scheme", slots: () => [ecdsa(ownerKey)] },
    { name: "the hash-based entry with an explicit msg", expect: "sig: entry msg", tamper: (tx) => ({ ...tx, signatures: tx.signatures.map((s) => ({ ...s, msg: keccak256("0x01") })) }) },
    { name: "the entry one byte short", expect: "sig: entry length", tamper: setBytes(0, (b) => b.slice(0, b.length - 1)) },
    { name: "entry version 0x02", expect: "sig: entry version", tamper: setBytes(0, withByte(0, 2)) },
    { name: "chain slot 16", expect: "sig: entry slot", tamper: setBytes(0, withByte(1, 16)) },
    { name: "the entry signs another message", expect: "sig: hash-based check", tamper: setBytes(0, withByte(2, 0xff)) },
    { name: "a used key at sequence 1 (the protocol accepts it, the account does not)", expect: "nonce: sequence", seq: 1n,
      before: (w) => w.state.sstore(NONCE_MANAGER, BigInt(nonceManagerSlot(w.account, nonceKeyFor(0, COLD))), 1n) },
    { name: "hot: a valid ticket under the caps", expect: "valid", leaf: HOT, calls: [{ to: SHOP, value: 5n * 10n ** 15n }] },
    { name: "hot: pays another target", expect: "hot: frame target", leaf: HOT, calls: [{ to: OTHER, value: 1n }] },
    { name: "hot: one payment over the value cap", expect: "hot: value cap", leaf: HOT, calls: [{ to: SHOP, value: 10n ** 16n + 1n }] },
    { name: "hot: two payments summing over the cap", expect: "hot: value cap", leaf: HOT, calls: [{ to: SHOP, value: 5n * 10n ** 15n + 1n }, { to: SHOP, value: 5n * 10n ** 15n }] },
    { name: "hot: a payment with calldata", expect: "hot: frame data", leaf: HOT, calls: [{ to: SHOP, value: 1n, data: "0x01" }] },
    { name: "hot: a DEFAULT frame after the verify frame", expect: "hot: frame mode", leaf: HOT, shape: (tx) => ({ ...tx, frames: [...tx.frames.slice(0, -1), { ...tx.frames.at(-1)!, mode: FRAME_MODE.DEFAULT, value: 0n }] }) },
    { name: "hot: the maximum cost over the fee cap", expect: "hot: fee cap", leaf: HOT, fees: { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 1n } },
    { name: "hot: values that overflow 2^256", expect: "hot: value overflow", leaf: HOT, calls: [{ to: SHOP, value: 1n << 255n }, { to: SHOP, value: 1n << 255n }] },
    { name: "hot: the kill switch (value cap 0)", expect: "hot: disabled", leaf: HOT, before: (w) => w.state.sstore(w.account, 3n, 0n) },
    { name: "hybrid: owner ECDSA plus the hash-based entry", expect: "valid", hybrid: true, slots: (w) => [ecdsa(ownerKey), hash(w)] },
    { name: "hybrid: a cold leaf without the owner's signature", expect: "sig: count", hybrid: true },
    { name: "hybrid: signed by someone else", expect: "sig: owner", hybrid: true, slots: (w) => [ecdsa(generatePrivateKey()), hash(w)] },
    { name: "hybrid: the owner signed an explicit digest, not the transaction", expect: "sig: owner msg", hybrid: true, slots: (w) => [ecdsa(ownerKey), hash(w)],
      tamper: async (tx) => {
        const digest = keccak256(toHex("not this transaction"));
        const s = await sign({ hash: digest, privateKey: ownerKey });
        return { ...tx, signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, msg: digest, signature: concat([toHex(s.yParity!, { size: 1 }), s.r, s.s]) } : e)) };
      } },
    { name: "hybrid: entry 0 is not ECDSA", expect: "sig: owner scheme", hybrid: true, slots: (w) => [hash(w), hash(w)] },
    { name: "hybrid: a hot ticket still needs no classical key", expect: "valid", hybrid: true, leaf: HOT, calls: [{ to: SHOP, value: 1n }] },
  ];
  for (const c of cases) test(c.name, async () => expect(await runCase(c)).toBe(c.expect));

  test("a used key at sequence 0 is refused before any frame runs: Nonce mismatch", async () => {
    const w = makeWorld();
    w.state.sstore(NONCE_MANAGER, BigInt(nonceManagerSlot(w.account, nonceKeyFor(0, COLD))), 1n);
    const tx = buildFrameTx({ chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90, fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, nonce: { keys: [nonceKeyFor(0, COLD)], seq: 0n }, calls: [{ to: SHOP, value: 1n }], signatures: placeholders([hash(w)]) });
    expect(() => runFrameTx(tx, w.state, ctx(), opts)).toThrow("Nonce mismatch: expected 1, got 0");
  });
});

describe("gas: the measured verify model and the proxy's 63/64 holdback (EIP-150)", () => {
  /** A signed cold transfer whose message needs exactly `steps` chain steps. */
  async function atSteps(w: ReturnType<typeof makeWorld>, steps: number, leaf = COLD) {
    const slots = [hash(w, leaf)];
    for (let i = 0; i < 200_000; i++) {
      const tx = buildFrameTx({ chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90, fees: { maxFeePerGas: 2n * GWEI + BigInt(i), maxPriorityFeePerGas: GWEI }, nonce: { keys: [nonceKeyFor(0, leaf)], seq: 0n }, calls: [{ to: SHOP, value: 1n }], signatures: placeholders(slots) });
      const { tx: signed, sigHash } = await signFrameTx(tx, slots);
      if (wotsVerifySteps(sigHash) === steps) return signed;
    }
    throw new Error(`no message of ${steps} steps found`);
  }

  let tall: ReturnType<typeof makeWorld> | undefined; // height 10, where the fit was measured; built once (about 2 s)
  const measured = () => (tall ??= makeWorld({ height: 10 }));

  test("a valid cold verify frame at height 10 costs 54,630 + 66.09 x steps (account 2's measured fit)", async () => {
    const w = measured();
    const tx = await atSteps(w, 495);
    const r = runFrameTx(tx, w.state, ctx(), opts);
    expect(r.approval!.steps).toBe(495);
    expect(r.approval!.gas).toBe(Math.round(54_630 + 66.09 * 495));
    expect(r.frames![1]!.gas).toBe(BigInt(r.approval!.gas));
    expect(VERIFY_GAS.proxyPreCall + VERIFY_GAS.accountChecks + VERIFY_GAS.verifierBase + VERIFY_GAS.freshKey).toBe(54_630);
    expect(hashsigGas(0, 10)).toBe(24_070);
  }, 30_000);

  test("verify gas follows the tree height: (height + 4) path levels where the fit had 14", async () => {
    const [low, high] = [makeWorld(), measured()];
    const gas = async (w: ReturnType<typeof makeWorld>) => runFrameTx(await atSteps(w, 495), w.state, ctx(), opts).approval!.gas;
    expect(await gas(high) - await gas(low)).toBe((10 - HEIGHT) * (VERIFY_GAS.pathLevel + VERIFY_GAS.entryWord));
    expect(hashsigGas(495, 12) - hashsigGas(495, 10)).toBe(2 * 190); // measured: 190 per level at heights 4, 10 and 12
  }, 30_000);

  test("at 90,000 declared and height 10: 510 steps fit behind the proxy, 525 steps run dry (the devnet's own 89,356 against 88,643)", async () => {
    const w = measured();
    const ok = runFrameTx(await atSteps(w, 510), w.state, ctx(), opts);
    expect(ok.prefixFailure).toBeNull();
    const dry = runFrameTx(await atSteps(w, 525), w.state, ctx(), opts);
    expect(dry.prefixFailure).toMatchObject({ failedFrameIndex: 1, haltReason: "revert", revertData: "0x" }); // the proxy reverts with no data
    const plain = runFrameTx(await atSteps(w, 525), w.state, ctx(), { proxyHoldback: false });
    expect(plain.prefixFailure).toBeNull(); // the brief's simpler rule: up to the declared limit
  }, 30_000);

  test("a forgery reverts at the hash-based check, before the fresh key's 20,000 could run it dry", async () => {
    const w = makeWorld();
    const tx = setBytes(0, withByte(40, 0x01))(await atSteps(w, 555));
    const r = runFrameTx(tx, w.state, ctx(), opts);
    expect(decodeReason(r.prefixFailure!.revertData)).toBe("sig: hash-based check");
  });

  test("the transaction's gas: mandatory + max(calldata + execution, floor), refund and tip add up", async () => {
    const w = makeWorld();
    const tx = await atSteps(w, 480);
    const before = w.state.balance(w.account);
    const r = runFrameTx(tx, w.state, ctx(), opts);
    const price = 7n + GWEI;
    expect(r.effectivePrice).toBe(price);
    expect(r.post!.balance(w.account)).toBe(before - 1n - r.gasUsed! * price);
    expect(r.post!.balance(SHOP)).toBe(ETH + 1n);
    expect(r.post!.balance(COINBASE)).toBe(r.gasUsed! * GWEI);
    expect(r.post!.sload(NONCE_MANAGER, BigInt(nonceManagerSlot(w.account, nonceKeyFor(0, COLD))))).toBe(1n);
  });

  test("a payment to a brand-new address needs 183,600 state gas from its frame, else that frame reverts and the key stays used", async () => {
    const w = makeWorld();
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    for (const [leaf, stateGas, want] of [[COLD, 0n, "reverted"], [COLD + 1, 183_600n, "success"]] as const) {
      const slots = [hash(w, leaf)];
      const key = nonceKeyFor(0, leaf);
      const g = grind((i) => ({ value: i, tx: buildFrameTx({ chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90, fees: { maxFeePerGas: 2n * GWEI + BigInt(i), maxPriorityFeePerGas: GWEI }, nonce: { keys: [key], seq: 0n }, calls: [{ to: fresh, value: 1n, stateGas }], signatures: placeholders(slots) }) }), { ...GRIND.cold, verifyGasLimit: 90_000n });
      const r = runFrameTx((await signFrameTx(g.tx, slots)).tx, w.state, ctx(), opts);
      expect(r.frames![2]!.status).toBe(want);
      expect(r.frames![2]!.stateGas).toBe(want === "success" ? 183_600n : 0n);
      expect(r.post!.sload(NONCE_MANAGER, BigInt(nonceManagerSlot(w.account, key)))).toBe(1n); // a failed frame still used the key
    }
  });

  test("a fee below the base fee is refused before any frame runs, with ethrex's text", () => {
    const w = makeWorld();
    const tx = buildFrameTx({ chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: Math.floor(Date.now() / 1000) + 90, fees: { maxFeePerGas: 6n, maxPriorityFeePerGas: 1n }, nonce: { keys: [nonceKeyFor(0, COLD)], seq: 0n }, calls: [{ to: SHOP, value: 1n }], signatures: placeholders([hash(w)]) });
    expect(() => runFrameTx(tx, w.state, ctx(), opts)).toThrow("Vm execution error: Invalid Transaction: Insufficient max fee per gas");
  });
});

describe("the admin functions and initialize", () => {
  const ABI = parseAbi([
    "function rotate(bytes32,bytes32,uint8)", "function setHybrid(bool)", "function setHotPolicy(uint32,uint256,uint256,address)", "function setOwner(address)",
    "function initialize(bytes32,bytes32,uint8,address,uint32,uint256,uint256,address)", "function hotStart() view returns (uint32)",
  ]);
  /** One call into the account as a SENDER frame of itself (self) or from anyone else. */
  function call(state: WorldState, account: Address, data: Hex, self = true): string {
    const meter = new Meter(1_000_000);
    const s = new StorageCtx((slot) => state.sload(account, slot), (slot) => state.sload(account, slot), (slot, v) => state.sstore(account, slot, v), new Set(), meter, new StateMeter(1_000_000n));
    try { accountCall(hexToBytes(data), self, s, meter); return "ok"; } catch (e) { if (e instanceof Revert) return e.reason; throw e; }
  }
  const enc = (fn: string, args: unknown[]) => encodeFunctionData({ abi: ABI, functionName: fn as never, args: args as never });

  test("refusals carry the account's strings", () => {
    const w = makeWorld();
    const a = w.account, S = w.state;
    expect(call(S, a, enc("rotate", [w.params.root, keccak256("0x02"), 10]))).toBe("rotate: same tree");
    expect(call(S, a, enc("rotate", [keccak256("0x01"), w.params.treeSeed, 10]))).toBe("rotate: same tree");
    expect(call(S, a, enc("rotate", [`0x${"00".repeat(32)}`, keccak256("0x02"), 10]))).toBe("bad argument");
    expect(call(S, a, enc("rotate", [keccak256("0x01"), keccak256("0x02"), 29]))).toBe("bad height");
    expect(call(S, a, enc("setHotPolicy", [HOT_START + 1, 1n, 1n, SHOP]))).toBe("hot: band cannot shrink");
    expect(call(S, a, enc("setHotPolicy", [1, 1n, 1n, SHOP]))).toBe("hot: no cold leaf left"); // epoch 0: leaf 0 cannot sign
    expect(call(S, a, enc("setHotPolicy", [0, 1n, 1n, SHOP]))).toBe("hot: no cold leaf left");
    expect(call(S, a, enc("setOwner", [`0x${"00".repeat(20)}`]))).toBe("ok"); // hybrid off: allowed
    expect(call(S, a, enc("setHybrid", [true]))).toBe("hybrid: no owner");
    expect(call(S, a, enc("setOwner", [owner.address]))).toBe("ok");
    expect(call(S, a, enc("setHybrid", [true]))).toBe("ok");
    expect(call(S, a, enc("setOwner", [`0x${"00".repeat(20)}`]))).toBe("hybrid: owner needed");
    expect(call(S, a, enc("initialize", [w.params.root, w.params.treeSeed, 10, owner.address, 1000, 1n, 1n, SHOP]), false)).toBe("already initialized");
    expect(call(S, a, "0x58aaa077")).toBe("short calldata");
    expect(call(S, a, "0x12345678", false)).toBe("no such function");
    expect(call(S, a, enc("setHotPolicy", [HOT_START, 1n, 1n, SHOP]), false)).toBe("no such function"); // not a SENDER frame of the account
    expect(call(S, a, "0x", false)).toBe("ok"); // a plain ETH receipt
  });

  test("rotate moves the epoch and keeps owner, flags and hotStart", () => {
    const w = makeWorld({ hybrid: true });
    expect(call(w.state, w.account, enc("rotate", [keccak256("0x01"), keccak256("0x02"), 12]))).toBe("ok");
    const c = w.state.sload(w.account, 2n);
    expect([cfg.epoch(c), cfg.height(c), cfg.flags(c), cfg.hotStart(c), cfg.owner(c)]).toEqual([1n, 12n, 1n, BigInt(HOT_START), BigInt(owner.address)]);
    expect(w.state.sload(w.account, 0n)).toBe(BigInt(keccak256("0x01")));
  });

  test("initialize's checks, run by the factory: a bad hotStart reverts the whole createAccount", () => {
    const { state } = genesisState({ eoa: owner.address, faucet: owner.address });
    const p = { root: keccak256("0x01"), treeSeed: keccak256("0x02"), height: 10, owner: owner.address, hotStart: 0, hotValueCap: 1n, hotFeeCap: 1n, allowedTarget: SHOP, salt: keccak256("0x03") };
    expect(() => factoryCall(hexToBytes(createAccountCalldata(p)), state, new Meter(10_000_000), new StateMeter(10_000_000n))).toThrow("hot: no cold leaf left");
    expect(() => factoryCall(hexToBytes(createAccountCalldata({ ...p, hotStart: 1000, height: 29 })), state, new Meter(10_000_000), new StateMeter(10_000_000n))).toThrow("bad height");
  });
});

describe("drift checks against the sources the model copies", () => {
  const yul = fs.readFileSync(path.join(REPO, "account/yul/Account.yul"), "utf8");

  test("every fail(...) string of Account.yul is in the model, and nothing else", () => {
    const inYul = new Set([...yul.matchAll(/fail\("([^"]+)"\)/g)].map((m) => m[1]!));
    expect([...inYul].sort()).toEqual([...REASONS].sort());
  });

  test("the selectors match Account.yul's dispatch and the interface's signatures", () => {
    const inYul = new Map([...yul.matchAll(/case (0x[0-9a-f]{8}) \{ (\w+)\(/g)].map((m) => [m[2]!, Number(m[1])]));
    for (const [name, sel] of Object.entries(SELECTORS)) {
      if (inYul.has(name)) expect(inYul.get(name)).toBe(sel);
    }
    const iface = fs.readFileSync(path.join(REPO, "account/src/IWinterlockAccount.sol"), "utf8");
    for (const m of iface.matchAll(/function (\w+)\(([^)]*)\)/g)) {
      const types = m[2]!.split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean).join(",");
      expect(numberToHex(SELECTORS[m[1] as keyof typeof SELECTORS], { size: 4 })).toBe(toFunctionSelector(`function ${m[1]}(${types})`));
    }
  });

  test("the factory's selectors and its runtime with the implementation filled in", () => {
    const art = JSON.parse(fs.readFileSync(path.join(REPO, "account/out/Factory.sol/Factory.json"), "utf8"));
    for (const [sig, sel] of Object.entries(art.methodIdentifiers as Record<string, string>)) {
      expect(Number(FACTORY_SELECTORS[sig.split("(")[0] as keyof typeof FACTORY_SELECTORS])).toBe(parseInt(sel, 16));
    }
    const f = factoryCode();
    expect(f.placeholder).toBe(false);
    for (const refs of Object.values(art.deployedBytecode.immutableReferences) as { start: number }[][]) {
      for (const r of refs) expect(f.runtime.slice(2 + 2 * r.start + 24, 2 + 2 * r.start + 64)).toBe(IMPLEMENTATION.slice(2).toLowerCase());
    }
  });

  test("the implementation's code is Account.bin's runtime", () => {
    const i = implementationCode();
    expect(i.placeholder).toBe(false);
    const bin = fs.readFileSync(path.join(REPO, "account/build/Account.bin"), "utf8").trim();
    expect((i.runtime.length - 2) / 2).toBe(parseInt(bin.slice(2, 6), 16));
    expect(bin.includes(i.runtime.slice(2))).toBe(true);
  });

  test("the sidecar's prefix-cap message, word for word as the devnet answered it on Day 0", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "pipeline/test/fixtures/admission-records.json"), "utf8"));
    const w = makeWorld();
    let tx = buildFrameTx({ chainId: CHAIN_ID, sender: w.account, verifyGas: 90_000n, deadline: 1_900_000_000, fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, nonce: { keys: [nonceKeyFor(0, COLD)], seq: 0n }, calls: [{ to: SHOP, value: 1n }], signatures: placeholders([hash(w)]) });
    tx = { ...tx, frames: tx.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, execution: 115_000n } } : f)) };
    const r = validateStructuralRules(tx, recognizeValidationPrefix(tx.frames, tx.sender)!);
    expect(r).toEqual({ valid: false, reason: fixture.rejected.admission.checks.find((c: { verdict: string }) => c.verdict === "fail").detail });
  });
});

describe("Solidity's, the EVM's and ethrex's own rules", () => {
  const params = () => ({ root: keccak256("0x01"), treeSeed: keccak256("0x02"), height: 10, owner: owner.address, hotStart: 1008, hotValueCap: 1n, hotFeeCap: 1n, allowedTarget: SHOP, salt: keccak256("0x03") });

  test("the factory has no payable function: ETH sent with createAccount reverts with no data, and the ETH stays", async () => {
    const { state } = genesisState({ eoa: owner.address, faucet: owner.address });
    const p = params(), account = predictAccountAddress(FACTORY, IMPLEMENTATION, p);
    expect(() => factoryCall(hexToBytes(createAccountCalldata(p)), state, new Meter(10_000_000), new StateMeter(10_000_000n), 1n)).toThrow(Revert);
    const create = async (value: bigint) => applyEoaTx(parseEoaTx(await owner.signTransaction({
      chainId: Number(CHAIN_ID), nonce: 0, to: FACTORY, value, gas: 2_000_000n, gasPrice: 2n * GWEI, data: createAccountCalldata(p), type: "legacy",
    })), state, ctx(), opts)!;
    const paid = await create(1n);
    expect([paid.status, paid.post.balance(FACTORY), paid.post.code(account)]).toEqual([0, 0n, "0x"]);
    const free = await create(0n);
    expect(free.status).toBe(1);
    expect(free.post.code(account)).not.toBe("0x");
  });

  test("EIP-2200: an SSTORE with 2,300 gas or less left fails the call; 2,301 is enough for a warm no-op write", () => {
    const store = (left: number) => {
      const meter = new Meter(left);
      const s = new StorageCtx(() => 5n, () => 5n, () => {}, new Set([3n]), meter, new StateMeter(0n));
      try { s.sstore(3n, 5n); return "ok"; } catch (e) { if (e instanceof OutOfGas) return "out of gas"; throw e; }
    };
    expect([store(2_300), store(2_301)]).toEqual(["out of gas", "ok"]);
  });

  test("an EOA transaction on a pooled nonce replaces it only with ethrex's fee bump, else ethrex's own refusal", async () => {
    const { state } = genesisState({ eoa: owner.address, faucet: owner.address });
    const chain = new FakeChain({ ...DEFAULT_OPTIONS }, state);
    const sign = (gasPrice: bigint, value: bigint, nonce = 0) => owner.signTransaction({ chainId: Number(CHAIN_ID), nonce, to: SHOP, value, gas: 21_000n, gasPrice, type: "legacy" });
    const [first, same, short, bumped, gap] = await Promise.all([sign(10n * GWEI, 1n), sign(10n * GWEI, 2n), sign(10_900_000_000n, 2n), sign(11n * GWEI, 3n), sign(10n * GWEI, 1n, 5)]);
    const h1 = chain.submitEoa(first);
    for (const raw of [same, short]) expect(() => chain.submitEoa(raw)).toThrow("Attempted to replace a pooled transaction with an underpriced transaction");
    expect(() => chain.submitEoa(gap)).toThrow("nonce too high");
    const h3 = chain.submitEoa(bumped);
    expect(chain.tx(h1)).toBeNull(); // replaced: no longer known
    chain.produceBlock();
    expect(chain.receipt(h1)).toBeNull();
    expect(chain.receipt(h3)?.status).toBe("0x1");
    expect(chain.latest().balance(SHOP)).toBe(ETH + 3n);
  });
});

describe("the chain's state window", () => {
  test("reads at a block older than the window are an error, never the latest state", () => {
    const { state } = genesisState({ eoa: owner.address, faucet: owner.address });
    const chain = new FakeChain({ ...DEFAULT_OPTIONS }, state);
    for (let i = 0; i < 135; i++) chain.produceBlock();
    expect(chain.head.number).toBe(135n);
    expect(() => chain.stateAt(numberToHex(5))).toThrow(StateUnavailable);
    expect(() => chain.stateAt(numberToHex(5))).toThrow("keeps state for the last 130 blocks");
    expect(chain.stateAt(numberToHex(6)).balance(SHOP)).toBe(ETH);
    expect(() => chain.stateAt(numberToHex(136))).toThrow("beyond the head");
    for (let i = 1; i < chain.blocks.length; i++) expect(chain.blocks[i]!.timestamp > chain.blocks[i - 1]!.timestamp).toBe(true);
  });

  test("a frame transaction from an address without account code is not modelled, and says so", () => {
    const w = makeWorld();
    const eoa = privateKeyToAccount(generatePrivateKey()).address;
    const tx = buildFrameTx({ chainId: CHAIN_ID, sender: eoa, verifyGas: 50_000n, deadline: null, fees: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI }, nonce: { keys: [1n], seq: 0n }, calls: [{ to: SHOP, value: 1n }], signatures: placeholders([hash(w)]) });
    expect(() => runFrameTx(tx, w.state, ctx(), opts)).toThrow(ProtocolRefusal);
    expect(() => runFrameTx(tx, w.state, ctx(), opts)).toThrow("fakechain does not model frame transactions from");
  });
});
