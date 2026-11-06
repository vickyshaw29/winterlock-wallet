// The ERC-4337 envelope for MetaMask Flask (userop.ts) and the sign-only step behind it (signPrepared in submit.ts).
// Written with Claude Code (AI) for Vicky, Nov 6.
import { describe, expect, test } from "bun:test";
import { hexToBytes, type Address, type Hex } from "viem";
import {
  GRIND, Keyring, MemoryJournal, NONCE_MANAGER, createPipeline, keyringSigner, laneCost, nonceKeyFor, nonceManagerSlot,
  verifyEntry, type FrameTransaction, type HashSigner, type JournalSnapshot, type SignatureSlot,
} from "../src/core.ts";
import {
  USEROP_GRIND_HEADROOM, UserOpError, checkUserOpTx, decodeIntents, encodeIntents, envelopeFor, nonceKeyOf, parseIntents,
  parseUserOp, quantity, txOfSignature, userOpNonce, type UserOp,
} from "../src/userop.ts";
import { encodeRawFrameTx } from "../src/codec/codec.ts";
import { signPrepared } from "../src/submit.ts";
import { fakeChain } from "./fixtures/sandbox-scenario.ts";

const CHAIN = 1337n;
const HEIGHT = 4;
const SENDER: Address = "0x00000000000000000000000000000000000acc01";
const TO: Address = "0x000000000000000000000000000000000000beef";
const keyring = new Keyring({ seed: hexToBytes(`0x${"5a".repeat(32)}`), generation: 0, height: HEIGHT, chains: [CHAIN] });
const inner = keyringSigner(keyring);

describe("callData: the SENDER frames as Winterlock calls", () => {
  test("round trip, lowercase", () => {
    const calls = [{ to: TO, value: 10n ** 15n, data: "0x" as Hex }, { to: "0x00000000000000000000000000000000000000AA" as Address, value: 0n, data: "0xdeadbeef" as Hex }];
    const callData = encodeIntents(calls);
    expect(callData.startsWith("0x574c0001")).toBe(true);
    expect(decodeIntents(callData)).toEqual([calls[0]!, { ...calls[1]!, to: "0x00000000000000000000000000000000000000aa" }]);
  });
  test("strict: prefix, canonical encoding, 1 to 16 calls", () => {
    const callData = encodeIntents([{ to: TO, value: 1n, data: "0x" }]);
    expect(() => decodeIntents(`0x574c0002${callData.slice(10)}`)).toThrow("prefix");
    expect(() => decodeIntents(`${callData}00`)).toThrow(UserOpError);
    expect(() => encodeIntents([])).toThrow("1 to 16");
    expect(() => encodeIntents(Array.from({ length: 17 }, () => ({ to: TO, value: 0n, data: "0x" as Hex })))).toThrow("1 to 16");
  });
  test("MetaMask's intents are read strictly", () => {
    expect(parseIntents([{ to: TO, value: "0x10", data: "0x" }])).toEqual([{ to: TO, value: 16n, data: "0x" }]);
    expect(() => parseIntents([{ to: "0x12", value: "0x0", data: "0x" }])).toThrow("address");
    expect(() => parseIntents([{ to: TO, value: "16", data: "0x" }])).toThrow("quantity");
    expect(() => parseIntents([])).toThrow();
  });
});

describe("nonce: key << 64, sequence 0", () => {
  test("round trip", () => {
    const key = nonceKeyFor(0, 7);
    expect(nonceKeyOf(userOpNonce(key))).toBe(key);
  });
  test("a sequence other than 0, key 0, or a key of 192 bits or more is refused", () => {
    expect(() => nonceKeyOf((7n << 64n) | 1n)).toThrow("sequence must be 0");
    expect(() => nonceKeyOf(0n)).toThrow("legacy nonce");
    expect(() => userOpNonce(0n)).toThrow();
    expect(() => userOpNonce(1n << 192n)).toThrow();
  });
});

/** A Snap-like setup: a journal with leaf 1 reserved by "prepare", the envelope computed then, and the user op MetaMask would build. */
function setup(opts: { events?: string[]; signer?: HashSigner } = {}) {
  const events = opts.events ?? [];
  const chain = fakeChain(events);
  const traced = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body)).method;
    if (method === "ethrex_simulateFrameTransaction") events.push("rpc simulate");
    return chain.fetch(url, init);
  }) as unknown as typeof fetch;
  const net = createPipeline({ chainId: CHAIN, nodeUrl: "http://node.invalid", gatewayUrl: "http://gateway.invalid", fetch: traced });
  const store = { save: async (s: JournalSnapshot) => { await new Promise((r) => setTimeout(r, 1)); events.push(`stored ${Object.values(s.leaves).map((l) => `${l.leaf}:${l.status}`).join(",")}`); } };
  const journal = MemoryJournal.open(null, { wallet: SENDER, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: inner.treeSeed }, { create: true, store });
  const signer = opts.signer ?? inner;
  const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
  const { leaf, nonceKey } = journal.reserveNext({ from: 1, to: 2 ** HEIGHT }, "prepared for a MetaMask user operation");
  const calls = [{ to: TO, value: 10n ** 15n }];
  const env = envelopeFor({ chainId: CHAIN, sender: SENDER, nonceKey, verifyGas: 90_000n, calls, slots: slots(leaf) });
  const op: UserOp = {
    sender: SENDER, nonce: userOpNonce(nonceKey), initCode: "0x", callData: encodeIntents(calls.map((c) => ({ ...c, data: "0x" as Hex }))),
    callGasLimit: env.callGasLimit, verificationGasLimit: env.verificationGasLimit, preVerificationGas: env.preVerificationGas,
    maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n, paymasterAndData: "0x", signature: "0x",
  };
  const sign = (extra: Partial<Parameters<typeof signPrepared>[0]> = {}) => signPrepared({
    journal, leaf, sender: SENDER, calls, verifyGas: 90_000n, signatures: slots,
    fees: { maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas },
    grind: { ...GRIND.cold, maxTries: USEROP_GRIND_HEADROOM }, preflight: true, network: net.network, ...extra,
  });
  return { events, chain, net, journal, leaf, nonceKey, op, env, sign, calls };
}

const now = () => Math.floor(Date.now() / 1000);

describe("signPrepared: a leaf reserved at prepare signs once, recorded before anyone sees it", () => {
  test("signs the user's exact fees inside the envelope; the envelope check passes; the entry verifies", async () => {
    const s = setup();
    const signed = await s.sign();
    expect(signed.leaf).toBe(s.leaf);
    expect(signed.tx.fees.maxFeePerGas).toBe(s.op.maxFeePerGas);
    expect(signed.tx.fees.maxPriorityFeePerGas).toBe(s.op.maxPriorityFeePerGas);
    const op = { ...s.op, signature: signed.raw };
    const tx = txOfSignature(op.signature);
    checkUserOpTx(op, tx, { chainId: CHAIN, now: now() });
    expect(laneCost(tx).gasLimit).toBeLessThanOrEqual(op.callGasLimit + op.verificationGasLimit + op.preVerificationGas);
    const entry = hexToBytes(tx.signatures[0]!.signature);
    expect(verifyEntry({ entry, msg: hexToBytes(signed.sigHash), root: keyring.root(), treeSeed: keyring.treeSeed, height: HEIGHT, chainId: CHAIN, leaf: s.leaf }).ok).toBe(true);
    const rec = s.journal.get(s.leaf)!;
    expect(rec.status).toBe("submitted");
    expect(rec.txHash).toBe(signed.txHash);
    expect(rec.deadline).toBe(signed.deadline);
  });

  test("the leaf is stored as submitted before the node's dry run sees the signed transaction", async () => {
    const events: string[] = [];
    const s = setup({ events });
    await s.sign();
    const stored = events.findIndex((e) => e.startsWith("stored") && e.includes(`${s.leaf}:submitted`));
    const simulated = events.indexOf("rpc simulate");
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(simulated).toBeGreaterThan(stored);
    expect(s.chain.calls).not.toContain("eth_sendFrameTransaction"); // signPrepared sends nothing
  });

  test("a second signature on the same leaf is refused, whatever the message", async () => {
    const s = setup();
    await s.sign();
    await expect(s.sign()).rejects.toThrow("only a leaf reserved and never signed may sign");
    await expect(s.sign({ fees: { maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n } })).rejects.toThrow("only a leaf reserved");
  });

  test("a leaf never reserved is refused, and nothing signs", async () => {
    let signs = 0;
    const counting: HashSigner = { ...inner, sign: async (r) => { signs += 1; return inner.sign(r); } };
    const s = setup({ signer: counting });
    await expect(s.sign({ leaf: s.leaf + 1 })).rejects.toThrow("not in the journal");
    expect(signs).toBe(0);
  });

  test("a failed check before signing leaves the leaf reserved and unsigned", async () => {
    let signs = 0;
    const counting: HashSigner = { ...inner, sign: async (r) => { signs += 1; return inner.sign(r); } };
    const s = setup({ signer: counting });
    await expect(s.sign({ checkUnsigned: () => { throw new Error("not what the user approved"); } })).rejects.toThrow("not what the user approved");
    expect(signs).toBe(0);
    expect(s.journal.get(s.leaf)!.status).toBe("reserved");
  });

  test("a failed check after signing burns the leaf: it never signs again", async () => {
    const s = setup();
    await expect(s.sign({ checkSigned: () => { throw new Error("mismatch"); } })).rejects.toThrow("mismatch");
    expect(s.journal.get(s.leaf)!.status).toBe("burned");
    await expect(s.sign()).rejects.toThrow("only a leaf reserved");
  });

  test("a key already used on chain burns the leaf before signing", async () => {
    const s = setup();
    const used = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getStorageAt" && String(body.params[0]).toLowerCase() === NONCE_MANAGER && body.params[1] === nonceManagerSlot(SENDER, s.nonceKey)) {
        return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"0".repeat(63)}1` }) } as unknown as Response;
      }
      return s.chain.fetch(url, init);
    };
    const net = createPipeline({ chainId: CHAIN, nodeUrl: "http://node.invalid", gatewayUrl: "http://gateway.invalid", fetch: used as unknown as typeof fetch });
    await expect(s.sign({ network: net.network })).rejects.toThrow("already used on chain");
    expect(s.journal.get(s.leaf)!.status).toBe("burned");
  });

  test("a priority fee above the max fee is refused before anything happens", async () => {
    const s = setup();
    await expect(s.sign({ fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n } })).rejects.toThrow("above maxFeePerGas");
    expect(s.journal.get(s.leaf)!.status).toBe("reserved");
  });
});

describe("checkUserOpTx: the bundler sends nothing the user operation does not describe", () => {
  async function signedPair() {
    const s = setup();
    const signed = await s.sign();
    return { s, op: { ...s.op, signature: signed.raw }, tx: signed.tx };
  }
  const reencode = (op: UserOp, tx: FrameTransaction) => ({ ...op, signature: encodeRawFrameTx(tx) });
  const check = (op: UserOp, tx: FrameTransaction, at = now()) => () => checkUserOpTx(op, tx, { chainId: CHAIN, now: at });

  test("each change to the transaction is caught", async () => {
    const { op, tx } = await signedPair();
    const sender = { ...tx.frames[2]!, target: "0x000000000000000000000000000000000000dead" as Address };
    const cases: [string, FrameTransaction, string][] = [
      ["recipient", { ...tx, frames: [tx.frames[0]!, tx.frames[1]!, sender] }, "frame 2 is not call 0"],
      ["value", { ...tx, frames: [tx.frames[0]!, tx.frames[1]!, { ...tx.frames[2]!, value: 10n ** 18n }] }, "frame 2 is not call 0"],
      ["extra call", { ...tx, frames: [...tx.frames, tx.frames[2]!] }, "frames"],
      ["fee", { ...tx, fees: { ...tx.fees, maxFeePerGas: tx.fees.maxFeePerGas + 1n } }, "maxFeePerGas"],
      ["tip", { ...tx, fees: { ...tx.fees, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas + 1n } }, "maxPriorityFeePerGas"],
      ["nonce key", { ...tx, nonceKeys: [tx.nonceKeys[0]! + 1n] }, "nonce keys"],
      ["sequence", { ...tx, nonceSeq: 1n }, "sequence"],
      ["sender", { ...tx, sender: "0x00000000000000000000000000000000000acc02" }, "sender"],
      ["chain", { ...tx, chainId: 1n }, "chain"],
      ["second signature", { ...tx, signatures: [...tx.signatures, tx.signatures[0]!] }, "signature entries"],
      ["no expiry", { ...tx, frames: tx.frames.slice(1) }, "frames"],
      ["call limit above the envelope", { ...tx, frames: [tx.frames[0]!, tx.frames[1]!, { ...tx.frames[2]!, limits: { ...tx.frames[2]!.limits, execution: op.callGasLimit + 1n } }] }, "callGasLimit"],
    ];
    for (const [name, bad, msg] of cases) {
      expect(check(op, bad), name).toThrow(msg);
    }
    expect(check(op, tx)).not.toThrow();
  });

  test("each change to the user operation is caught", async () => {
    const { op, tx } = await signedPair();
    expect(check({ ...op, preVerificationGas: 0n }, tx)).toThrow("gas limit");
    expect(check({ ...op, verificationGasLimit: op.verificationGasLimit - 1n }, tx)).toThrow("verificationGasLimit");
    expect(check({ ...op, initCode: "0x01" }, tx)).toThrow("initCode");
    expect(check({ ...op, paymasterAndData: "0x01" }, tx)).toThrow("paymasterAndData");
    expect(check({ ...op, nonce: op.nonce | 1n }, tx)).toThrow("sequence must be 0");
    expect(check({ ...op, callData: encodeIntents([{ to: TO, value: 1n, data: "0x" }]) }, tx)).toThrow("frame 2 is not call 0");
    expect(check(op, tx, Number(BigInt(tx.frames[0]!.data)))).toThrow("has passed");
  });

  test("the signature must be exactly the canonical raw transaction", async () => {
    const { op, tx } = await signedPair();
    expect(txOfSignature(reencode(op, tx).signature)).toEqual(tx);
    expect(() => txOfSignature(`${op.signature}00`)).toThrow();
    expect(() => txOfSignature(`0x02${op.signature.slice(4)}`)).toThrow("type");
    expect(() => txOfSignature("0x")).toThrow();
  });

  test("parseUserOp reads MetaMask's JSON strictly", async () => {
    const { op } = await signedPair();
    const wire = Object.fromEntries(Object.entries(op).map(([k, v]) => [k, typeof v === "bigint" ? quantity(v) : v]));
    expect(parseUserOp(wire)).toEqual(op);
    expect(() => parseUserOp({ ...wire, maxFeePerGas: "100" })).toThrow("maxFeePerGas");
    expect(() => parseUserOp({ ...wire, sender: "0x1" })).toThrow("sender");
    expect(() => parseUserOp([])).toThrow();
  });
});
