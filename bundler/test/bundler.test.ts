// The local bundler for MetaMask Flask, against the pipeline's stand-in chain, with transactions signed by the real
// keyring through signPrepared, as the Snap signs them. Written with Claude Code (AI) for Vicky, Nov 6.
import { describe, expect, test } from "bun:test";
import { hexToBytes, type Address, type Hex } from "viem";
import {
  FLASK_ENTRYPOINT, GRIND, Keyring, MemoryJournal, USEROP_GRIND_HEADROOM, createPipeline, encodeIntents, envelopeFor,
  frameTxHash, keyringSigner, quantity, signPrepared, txOfSignature, userOpNonce, type SignatureSlot,
} from "../../pipeline/src/index.ts";
import { fakeChain } from "../../pipeline/test/fixtures/sandbox-scenario.ts";
import { Bundler, answer, memoryStore } from "../src/bundler.ts";

const CHAIN = 1337n;
const HEIGHT = 4;
const SENDER: Address = "0x00000000000000000000000000000000000acc01";
const TO: Address = "0x000000000000000000000000000000000000beef";
const keyring = new Keyring({ seed: hexToBytes(`0x${"5a".repeat(32)}`), generation: 0, height: HEIGHT, chains: [CHAIN] });
const signer = keyringSigner(keyring);

/** The stand-in chain, with block hashes, and a log of what was sent. */
function chain() {
  const c = fakeChain();
  const sent: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "eth_sendFrameTransaction") sent.push(body.params[0].nonceKeys[0]);
    const res = await c.fetch(url, init);
    if (body.method !== "eth_getBlockByNumber") return res;
    const parsed = JSON.parse(await res.text());
    parsed.result.hash = `0x${"ab".repeat(32)}`;
    return { status: 200, text: async () => JSON.stringify(parsed) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const p = createPipeline({ chainId: CHAIN, nodeUrl: "http://node.invalid", gatewayUrl: "http://gateway.invalid", fetch });
  return { p, sent, calls: c.calls };
}

/** What the Snap and MetaMask produce: a user operation in MetaMask's JSON, carrying a frame transaction signed for it. */
async function signedOp(p: ReturnType<typeof chain>["p"], fees = { maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n }, journal?: MemoryJournal) {
  const j = journal ?? MemoryJournal.open(null, { wallet: SENDER, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: signer.treeSeed }, { create: true, ephemeral: true });
  const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
  const { leaf, nonceKey } = j.reserveNext({ from: 1, to: 2 ** HEIGHT });
  const calls = [{ to: TO, value: 10n ** 15n }];
  const env = envelopeFor({ chainId: CHAIN, sender: SENDER, nonceKey, verifyGas: 90_000n, calls, slots: slots(leaf) });
  const signed = await signPrepared({
    journal: j, leaf, sender: SENDER, calls, verifyGas: 90_000n, signatures: slots, fees,
    grind: { ...GRIND.cold, maxTries: USEROP_GRIND_HEADROOM }, preflight: true, network: p.network,
  });
  const op = {
    sender: SENDER, nonce: quantity(userOpNonce(nonceKey)), initCode: "0x", callData: encodeIntents([{ to: TO, value: 10n ** 15n, data: "0x" }]),
    callGasLimit: quantity(env.callGasLimit), verificationGasLimit: quantity(env.verificationGasLimit), preVerificationGas: quantity(env.preVerificationGas),
    maxFeePerGas: quantity(fees.maxFeePerGas), maxPriorityFeePerGas: quantity(fees.maxPriorityFeePerGas), paymasterAndData: "0x", signature: signed.raw,
  };
  return { op, signed, journal: j };
}

const rpc = (b: Bundler, method: string, params: unknown[]) => answer(b, { jsonrpc: "2.0", id: 1, method, params }) as Promise<{ result?: any; error?: { code: number; message: string } }>;

describe("the Winterlock bundler", () => {
  test("sends a checked user operation once, follows it on chain, and answers MetaMask's receipt", async () => {
    const c = chain();
    const store = memoryStore();
    const b = new Bundler({ network: c.p.network, store, follow: false, log: () => {} });
    const { op, signed } = await signedOp(c.p);
    const sent = await rpc(b, "eth_sendUserOperation", [op, FLASK_ENTRYPOINT]);
    expect(sent.error).toBeUndefined();
    expect(sent.result).toBe(frameTxHash(txOfSignature(op.signature as Hex)));
    expect(sent.result).toBe(signed.txHash);
    expect(c.sent).toHaveLength(1);
    expect(store.ops[0]!.state).toBe("sent");
    expect((await rpc(b, "eth_getUserOperationReceipt", [sent.result])).result).toBeNull(); // not followed yet

    await b.follow(sent.result);
    const r = (await rpc(b, "eth_getUserOperationReceipt", [sent.result])).result;
    expect(r.success).toBe(true);
    expect(r.receipt.transactionHash).toBe(sent.result);
    expect(r.receipt.blockHash).toBe(`0x${"ab".repeat(32)}`);
    expect(BigInt(r.actualGasUsed)).toBeGreaterThan(0n);
    const byHash = (await rpc(b, "eth_getUserOperationByHash", [sent.result])).result;
    expect(byHash.transactionHash).toBe(sent.result);

    // MetaMask sending it again changes nothing.
    expect((await rpc(b, "eth_sendUserOperation", [op, FLASK_ENTRYPOINT])).result).toBe(sent.result);
    expect(c.sent).toHaveLength(1);

    // A restart keeps the record and its outcome.
    const again = new Bundler({ network: c.p.network, store, follow: false, log: () => {} });
    expect((await rpc(again, "eth_getUserOperationReceipt", [sent.result])).result.success).toBe(true);
  });

  test("a user operation that does not describe its transaction is refused and nothing is sent", async () => {
    const c = chain();
    const b = new Bundler({ network: c.p.network, store: memoryStore(), follow: false, log: () => {} });
    const { op } = await signedOp(c.p);
    const tampered = [
      { ...op, callData: encodeIntents([{ to: "0x000000000000000000000000000000000000dead", value: 10n ** 15n, data: "0x" }]) },
      { ...op, maxFeePerGas: quantity(5_000_000_000n) },
      { ...op, preVerificationGas: "0x0" },
      { ...op, sender: "0x00000000000000000000000000000000000acc02" },
      { ...op, signature: `${op.signature}00` },
      { ...op, paymasterAndData: "0x01" },
    ];
    for (const bad of tampered) {
      const r = await rpc(b, "eth_sendUserOperation", [bad, FLASK_ENTRYPOINT]);
      expect(r.error?.code).toBe(-32602);
    }
    expect((await rpc(b, "eth_sendUserOperation", [op, "0x0000000000000000000000000000000000000001"])).error?.message).toContain("entry point");
    expect(c.sent).toHaveLength(0);
  });

  test("a second, different transaction on a nonce key it already carries is refused", async () => {
    const c = chain();
    const lines: string[] = [];
    const b = new Bundler({ network: c.p.network, store: memoryStore(), follow: false, log: (l) => lines.push(l) });
    const first = await signedOp(c.p);
    // A second journal handing out the same leaf: the failure the Snap's journal exists to prevent.
    const second = await signedOp(c.p, { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n });
    expect(second.op.nonce).toBe(first.op.nonce);
    expect((await rpc(b, "eth_sendUserOperation", [first.op, FLASK_ENTRYPOINT])).error).toBeUndefined();
    const r = await rpc(b, "eth_sendUserOperation", [second.op, FLASK_ENTRYPOINT]);
    expect(r.error?.message).toContain("already carries");
    expect(c.sent).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("ALERT"))).toBe(true);
  });

  test("nothing to estimate; unknown methods and hashes", async () => {
    const c = chain();
    const b = new Bundler({ network: c.p.network, store: memoryStore(), follow: false, log: () => {} });
    expect((await rpc(b, "eth_estimateUserOperationGas", [{}, FLASK_ENTRYPOINT])).error?.code).toBe(-32601);
    expect((await rpc(b, "eth_supportedEntryPoints", [])).result).toEqual([FLASK_ENTRYPOINT]);
    expect((await rpc(b, "eth_chainId", [])).result).toBe("0x539");
    expect((await rpc(b, "eth_getUserOperationReceipt", [`0x${"00".repeat(32)}`])).result).toBeNull();
    expect((await rpc(b, "eth_sendRawTransaction", [])).error?.code).toBe(-32601);
    expect(await answer(b, { method: "eth_chainId" })).toMatchObject({ error: { code: -32600 } });
  });
});
