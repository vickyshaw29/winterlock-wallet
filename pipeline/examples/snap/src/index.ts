// Example MetaMask Snap on @winterlock/pipeline/core (the installable, browser- and Snap-safe bundle):
//   - one account per install: a random account nonce, kept in the Snap's state, salts snap_getEntropy, so a reinstall
//     (which clears the state but not the entropy) gets a new tree instead of re-signing the old one's leaves
//     (spec: one master seed per account, a new seed after a reset);
//   - one journal for the Snap's whole life, a MemoryJournal saved through snap_manageState (an async store), so the
//     send path waits for it (Journal.durable) before a leaf signs and before a transaction is sent; requests run one
//     at a time (journal.ts, rule 4: one writer);
//   - winterlock_sign builds, grinds and signs one transfer two-pass and checks the entry against the tree;
//   - winterlock_send runs the whole send path on a pipeline of its own (createPipeline) against a stand-in chain.
// Only the origin in snap.manifest.json may call it. Example only, not a wallet: chain 1337, example addresses, nothing
// reaches a real network. Written with Claude Code (AI) for Vicky.
import type { Json, OnRpcRequestHandler } from "@metamask/snaps-sdk";
import {
  GRIND, Keyring, MemoryJournal, createPipeline, entryLength, frameTxHash, grind, keyringSigner, placeholders,
  prefixBudget, signFrameTx, verifyEntry, type HashSigner, type JournalSnapshot, type SignatureSlot,
} from "@winterlock/pipeline/core";
import { fakeChain } from "./fake-chain";

const CHAIN = 1337n;
const HEIGHT = 10;
const COLD = { from: 1, to: 1008 };
const VERIFY_GAS = 90_000n;
const SENDER = "0x00000000000000000000000000000000000acc01" as const; // example account
const TO = "0x000000000000000000000000000000000000bEEF" as const; // example recipient

const bytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (u8: Uint8Array) => `0x${Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** The Snap's whole state. Every write merges into it, so nothing else kept here is ever dropped. */
type State = { account?: { nonce: string }; journal?: JournalSnapshot } & Record<string, Json | JournalSnapshot | undefined>;
let state: State | null = null;
async function writeState(patch: Partial<State>) {
  state = { ...(state ?? {}), ...patch };
  await snap.request({ method: "snap_manageState", params: { operation: "update", newState: state as unknown as Record<string, Json> } });
}

/** Events of the request being handled, for the test (requests run one at a time). */
let events: string[] = [];

interface Wallet { keyring: Keyring; signer: HashSigner; journal: MemoryJournal }
let wallet: Promise<Wallet> | null = null;

/** Loaded once per Snap start; created once per install. */
async function load(): Promise<Wallet> {
  state = ((await snap.request({ method: "snap_manageState", params: { operation: "get" } })) as State | null) ?? {};
  if (state.journal && !state.account) throw new Error("the Snap's state has a journal but no account: refusing to sign");
  const create = !state.account;
  if (create) {
    // A new install: a new account nonce, so a new tree. The journal created below is saved with it.
    state.account = { nonce: hex(crypto.getRandomValues(new Uint8Array(16))) };
  }
  const entropy = await snap.request({ method: "snap_getEntropy", params: { version: 1, salt: `winterlock-example-tree-v1/${state.account!.nonce}` } });
  const keyring = new Keyring({ seed: bytes(entropy), generation: 0, height: HEIGHT, chains: [CHAIN] });
  const inner = keyringSigner(keyring);
  const signer: HashSigner = { ...inner, sign: async (r) => { events.push(`sign leaf ${r.leaf}`); return inner.sign(r); } };
  const store = {
    save: async (snapshot: JournalSnapshot) => {
      await writeState({ journal: snapshot });
      events.push(`stored ${Object.values(snapshot.leaves).map((l) => `${l.leaf}:${l.status}`).join(",") || "empty"}`);
    },
  };
  const id = { wallet: SENDER, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: inner.treeSeed };
  const journal = MemoryJournal.open(state.journal ?? null, id, { create, store, label: "the example Snap's journal" });
  await journal.durable(); // a new account's nonce and empty journal are stored together, before any leaf is used
  return { keyring, signer, journal };
}

const getWallet = () => (wallet ??= load().catch((e) => { wallet = null; throw e; }));

let queue: Promise<unknown> = Promise.resolve();
/** One request at a time: every request shares the one journal, and the test reads one request's events. */
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

async function signOne() {
  const { keyring, signer, journal } = await getWallet();
  const { leaf, nonceKey } = journal.reserveNext(COLD);
  await journal.durable(); // stored before the leaf signs
  const slots: SignatureSlot[] = [{ kind: "hash", signer, leaf }];
  const p = createPipeline({ chainId: CHAIN, nodeUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:1" }); // not called
  const deadline = Math.floor(Date.now() / 1000) + 90;
  const g = grind((i) => {
    const fee = 2_000_000_000n + BigInt(i);
    return { value: fee, tx: p.buildFrameTx({ sender: SENDER, nonce: { keys: [nonceKey], seq: 0n }, verifyGas: VERIFY_GAS, deadline, calls: [{ to: TO, value: 10n ** 15n }], fees: { maxFeePerGas: fee, maxPriorityFeePerGas: 1n }, signatures: placeholders(slots) }) };
  }, { ...GRIND.cold, verifyGasLimit: VERIFY_GAS });
  const { tx, sigHash } = await signFrameTx(g.tx, slots);
  journal.mark(leaf, "burned", { note: "signed in the example Snap, never sent" });
  await journal.durable();
  const entry = bytes(tx.signatures[0]!.signature);
  return {
    leaf, nonceKey: `0x${nonceKey.toString(16)}`, sigHash, txHash: frameTxHash(tx), root: hex(keyring.root()),
    entryLength: entry.length, expectedEntryLength: entryLength(HEIGHT), prefixBudget: prefixBudget(tx).toString(),
    chainSteps: g.steps, maxSteps: g.maxSteps,
    verified: verifyEntry({ entry, msg: bytes(sigHash), root: keyring.root(), treeSeed: keyring.treeSeed, height: HEIGHT, chainId: CHAIN, leaf }).ok,
    journal: journal.all().map((r) => `${r.leaf}:${r.status}`),
    globals: { process: typeof (globalThis as any).process, Buffer: typeof (globalThis as any).Buffer, require: typeof (globalThis as any).require },
  };
}

/**
 * The whole send path against the stand-in chain, which decides at once. On a real chain the follow phase lasts until
 * the transaction is decided (up to the deadline plus two blocks), longer than MetaMask's 60 s limit per request: a
 * real Snap would answer from onSubmitted and settle the lane in a later request (settleSubmitted) or a cronjob.
 */
async function sendOne() {
  const { signer, journal } = await getWallet();
  const p = createPipeline({ chainId: CHAIN, nodeUrl: "http://node.invalid", gatewayUrl: "http://gateway.invalid", fetch: fakeChain(events) });
  const r = await p.sendKeyed({
    journal, band: COLD, sender: SENDER, calls: [{ to: TO, value: 10n ** 15n }], verifyGas: VERIFY_GAS,
    signatures: (leaf) => [{ kind: "hash", signer, leaf }], grind: GRIND.cold, preflight: true, pollMs: 10,
  });
  await journal.durable();
  return {
    outcome: r.outcome, leaf: r.leaf, nonceKey: `0x${r.nonceKey.toString(16)}`, explorerUrl: r.explorerUrl,
    admission: r.admission?.summary ?? null, journal: journal.all().map((x) => `${x.leaf}:${x.status}`),
  };
}

export const onRpcRequest: OnRpcRequestHandler = ({ request }) =>
  oneAtATime(async () => {
    events = [];
    const result = request.method === "winterlock_sign" ? await signOne() : request.method === "winterlock_send" ? await sendOne() : null;
    if (!result) throw new Error(`method not found: ${request.method}`);
    return { ...result, events };
  });
