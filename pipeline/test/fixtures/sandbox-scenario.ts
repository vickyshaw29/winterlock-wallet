// One run of the browser- and Snap-safe core, end to end, with no network: imported by the tests in Node, and bundled
// (bun build --target=browser --format=iife) and run inside a SES compartment that has only a MetaMask Snap's
// globals (test/fixtures/ses-run.ts). Everything here comes from src/core.ts only.
// Written with Claude Code (AI) for Vicky.
import {
  EXPIRY_VERIFIER_CODE, GRIND, Keyring, MemoryJournal, NONCE_MANAGER, NONCE_MANAGER_CODE, EXPIRY_VERIFIER, buildFrameTx,
  createPipeline, entryLength, frameTxHash, grind, keyedNonce, keyringSigner, placeholders, prefixBudget, signFrameTx,
  toWire, verifyEntry, type FrameTransaction, type HashSigner, type JournalSnapshot, type SignatureSlot,
} from "../../src/core.ts";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";

const SEED = hexToBytes("0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a");
const CHAIN = 1337n;
const HEIGHT = 4;
const SENDER: Address = "0x00000000000000000000000000000000000acc01";
const TO: Address = "0x000000000000000000000000000000000000bEEF";

/** A JSON-RPC node and sidecar in one function, shaped like fetch: just enough chain for keyed sends. */
export function fakeChain(events: string[] = [], chainId = CHAIN) {
  let head = 100n;
  let included: { block: bigint; hash: Hex } | null = null;
  const nowHex = () => `0x${Math.floor(Date.now() / 1000).toString(16)}`;
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return `0x${chainId.toString(16)}`;
      case "eth_getCode": return params[0].toLowerCase() === NONCE_MANAGER ? NONCE_MANAGER_CODE : params[0].toLowerCase() === EXPIRY_VERIFIER ? EXPIRY_VERIFIER_CODE : "0x";
      case "skandha_getGasPrice": return { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1" };
      case "eth_blockNumber": return `0x${head.toString(16)}`;
      case "eth_getBlockByNumber": return { number: params[0] === "latest" ? `0x${head.toString(16)}` : params[0], timestamp: nowHex(), baseFeePerGas: "0x7" };
      case "eth_getStorageAt": {
        if (params[0].toLowerCase() !== NONCE_MANAGER || !included) return `0x${"0".repeat(64)}`;
        const at = params[2] === "latest" ? head : BigInt(params[2]);
        return at >= included.block ? `0x${"0".repeat(63)}1` : `0x${"0".repeat(64)}`;
      }
      case "ethrex_simulateFrameTransaction":
        return { canonicalMempoolValid: true, canonicalMempoolViolation: null, prefixShape: "SelfVerify", payer: SENDER, maxCost: "0x2386f26fc10000", gasUsed: "0x2d76d", frames: null, executionStatus: "success" };
      case "eth_sendFrameTransaction": {
        events.push(`send key ${params[0].nonceKeys[0]}`);
        const hash = keccak256(new TextEncoder().encode(JSON.stringify(params[0])));
        included = { block: head + 1n, hash };
        head += 3n; // included, and two blocks on top: decided at once
        return hash;
      }
      case "skandha_frameTransactionStatus": return { status: included ? "OnChain" : "New" };
      case "eth_getTransactionReceipt":
      case "eth_getFrameTransactionReceipt":
        return included ? { blockNumber: `0x${included.block.toString(16)}`, status: "0x1", payer: SENDER, cumulativeGasUsed: "0x2d76d", gasUsed: "0x2d76d", frameReceipts: [0, 1, 2].map(() => ({ status: "0x1", gasUsed: "0x1", logs: [] })) } : null;
      case "skandha_explorer_getTransaction": return { admission: { outcome: "included", checks: [{ rule: "PREFIX-001", verdict: "pass" }], frameStatuses: [] } };
      default: throw new Error(`fake chain: no ${method}`);
    }
  };
  const calls: string[] = [];
  // No Response class in a Snap's globals: rpc() only reads status and text().
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init?.body));
    calls.push(method);
    let body: unknown;
    try { body = { jsonrpc: "2.0", id, result: answer(method, params) }; } catch (e) { body = { jsonrpc: "2.0", id, error: { code: -32601, message: (e as Error).message } }; }
    return { status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function runCoreScenario() {
  const events: string[] = [];
  const keyring = new Keyring({ seed: SEED, generation: 0, height: HEIGHT, chains: [CHAIN] });
  const root = keyring.root();
  const inner = keyringSigner(keyring);
  const signer: HashSigner = { ...inner, sign: async (r) => { events.push(`sign leaf ${r.leaf}`); return inner.sign(r); } };
  const slots = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];

  // 1. Deterministic: build with a fixed deadline, grind the fee, sign two-pass, verify off chain.
  const at = (fee: bigint): FrameTransaction => buildFrameTx({
    chainId: CHAIN, sender: SENDER, nonce: keyedNonce(0, 3), verifyGas: 90_000n, deadline: 1_800_000_000,
    calls: [{ to: TO, value: 10n ** 15n }], fees: { maxFeePerGas: fee, maxPriorityFeePerGas: 1n }, signatures: placeholders(slots(3)),
  });
  const g = grind((i) => ({ value: 2_000_000_000n + BigInt(i), tx: at(2_000_000_000n + BigInt(i)) }), { ...GRIND.cold, verifyGasLimit: 90_000n });
  const { tx, sigHash } = await signFrameTx(g.tx, slots(3));
  const entry = hexToBytes(tx.signatures[0]!.signature);
  const verified = verifyEntry({ entry, msg: hexToBytes(sigHash), root, treeSeed: keyring.treeSeed, height: HEIGHT, chainId: CHAIN, leaf: 3 });

  // 2. The whole send path on a pipeline of its own, against the fake chain, with a journal saved through an async store.
  const chain = fakeChain(events);
  const p = createPipeline({ chainId: CHAIN, nodeUrl: "http://node.invalid", gatewayUrl: "http://gateway.invalid", fetch: chain.fetch });
  const saved: JournalSnapshot[] = [];
  const store = {
    save: async (s: JournalSnapshot) => {
      await new Promise((r) => setTimeout(r, 1)); // stored later, like snap_manageState
      saved.push(s);
      const statuses = Object.values(s.leaves).map((l) => `${l.leaf}:${l.status}`).join(",");
      events.push(`stored ${statuses || "empty"}`);
    },
  };
  const journal = MemoryJournal.open(null, { wallet: SENDER, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: inner.treeSeed }, { create: true, store });
  const sent = await p.sendKeyed({
    journal, band: { from: 1, to: 2 ** HEIGHT }, sender: SENDER, calls: [{ to: TO, value: 10n ** 15n }], verifyGas: 90_000n,
    signatures: slots, grind: GRIND.cold, preflight: true, pollMs: 5,
  });
  await journal.durable();

  return json({
    globals: { process: typeof (globalThis as any).process, Bun: typeof (globalThis as any).Bun, require: typeof (globalThis as any).require },
    root: bytesToHex(root),
    treeSeed: inner.treeSeed,
    sigHash,
    entryLength: entry.length,
    expectedEntryLength: entryLength(HEIGHT),
    entryHash: keccak256(entry),
    verified,
    prefixBudget: prefixBudget(tx),
    grind: { steps: g.steps, maxSteps: g.maxSteps, tries: g.tries.length },
    txHash: frameTxHash(tx),
    wire: toWire(tx),
    send: { outcome: sent.outcome, leaf: sent.leaf, nonceKey: sent.nonceKey, explorerUrl: sent.explorerUrl, admission: sent.admission?.summary ?? null },
    journal: journal.all().map((r) => `${r.leaf}:${r.status}`),
    lastSaved: Object.values(saved.at(-1)?.leaves ?? {}).map((r) => `${r.leaf}:${r.status}`),
    events,
    rpcMethods: [...new Set(chain.calls)].sort(),
  });
}

(globalThis as { __winterlockScenario?: unknown }).__winterlockScenario = runCoreScenario;
