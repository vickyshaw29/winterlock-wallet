// Winterlock in MetaMask Flask: the cold wallet of a Winterlock account, inside a Snap, on the alt-mempool devnet.
//   - The seed is this Snap's own entropy. snap_getEntropy derives a BIP-32 key from the MetaMask SRP, this Snap's id
//     (local:http://localhost:15191) and our salt (snaps-rpc-methods 14, getEntropy.cjs); no dapp and no other Snap can
//     read it. The salt holds the devnet's genesis hash and a random nonce made at install, so a reinstall or a devnet
//     reset gets a new tree, never the old one's leaves (spec: one master seed per account, a new seed after a reset).
//     The cost: removing the Snap loses this account's keys (send its balance away first).
//   - The account is created by the user's MetaMask EOA calling the factory (decided Nov 6: never a deploy frame). The
//     Snap hands out the calldata, then signs only for the address it predicted from its own nine createAccount
//     arguments (CREATE2 commits to all of them), once the chain shows our proxy there holding our root and tree seed.
//     Its hot caps are 0, so the account refuses every hot leaf ("hot: disabled", Account.yul).
//   - One MemoryJournal for the Snap's whole life, kept in snap_manageState; every state write runs after the previous
//     one, so a later write is never overtaken (journal.ts, rules 2 and 4). Hash-signed sends are keyed only: leaf i on
//     nonce key (0 << 32) | i at sequence 0.
//   - MetaMask (snaps-controllers 22, SnapController.cjs): a request times out after 60 s, but the timer pauses while
//     the Snap waits on its own outbound requests (snap_dialog, snap_manageState, fetch); an idle Snap is stopped 30 s
//     after its last request. So winterlock_send answers once its transaction is submitted and follows it in the
//     background while the page keeps polling winterlock_status; a lane a stopped Snap left pending is settled by the
//     next start, and no new send goes out until it is.
//   - Before the dialog, a send must fit the balance with what pending lanes hold (laneCost: maximum gas plus value,
//     what the sidecar sets aside), so a send the account cannot pay is refused with no leaf used.
// Only the page origins in snap.manifest.json may call it. Written with Claude Code (AI) for Vicky.
import type { Json, OnRpcRequestHandler } from "@metamask/snaps-sdk";
import { InvalidParamsError, MethodNotFoundError, UserRejectedRequestError } from "@metamask/snaps-sdk";
import { Address, Box, Divider, Heading, Row, Text } from "@metamask/snaps-sdk/jsx";
import {
  DEFAULTS, GRIND, Keyring, MemoryJournal, createAccountCalldata, createPipeline, keyringSigner, laneMaxCostWei,
  placeholders, predictAccountAddress, proxyRuntimeCode, type AccountParams, type HashSigner, type JournalSnapshot,
  type Pipeline, type SendKeyedResult, type SignatureSlot, type SubmittedInfo,
} from "@winterlock/pipeline/core";
import { fakeChain } from "./fake-chain";

declare const process: { env: Record<string, string | undefined> };
/** npm test only (snap.config.ts): talk to the stand-in chain in fake-chain.ts, never the devnet */
const FAKE = process.env.WL_SNAP_FAKE_CHAIN === "1";

type Hex = `0x${string}`;
const CHAIN = 1337n;
const NODE_URL = "https://altmempool.forshtat.com";
/** the miner's own sidecar: the public gateway admits, but often has no peers to relay to (Nov 6) */
const SIDECAR_URL = "https://altmempool.forshtat.com/rpc";
const EXPLORER = "https://explorer.altmempool.wtf";
/** the deployment of Nov 6, 12:36 IST, on the reset chain (pipeline/.data/deployment-1337.json); checked on chain */
const FACTORY: Hex = "0xe7227c802ea370f04ae533827041c89dc5a4e659";
const IMPLEMENTATION: Hex = "0x13075a0f56d6a793eba4493d866e6502052abe87";
const HEIGHT = 10;
/** plan section 8: hotStart 1008. The Snap is the cold side only: hot caps 0, so no hot leaf can ever pay. */
const HOT_START = 1008;
/** keyed sends: leaves [1, 1006). Leaf 0 would be nonce key 0, the legacy nonce; 1006 and 1007 stay for admin calls. */
const KEYED_BAND = { from: 1, to: HOT_START - 2 };
const VERIFY_GAS = 90_000n; // backend/src/backend.ts
const EXPIRY_SECONDS = DEFAULTS.expirySeconds; // 90 s, what sendKeyed uses (spec: single transactions keep 90 s)
const NEW_ACCOUNT_STATE_GAS = 183_600n; // a SENDER frame that creates its target (spec, frame list; backend/src/chain.ts)
const CREATE_GAS = 1_200_000n; // createAccount measured 953,678 (spec, Factory)
const SETTLE_RETRY_MS = 30_000; // the backend's settleRetryMs
const ZERO: Hex = "0x0000000000000000000000000000000000000000";

const bytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (u8: Uint8Array): Hex => `0x${Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const lower = (a: string) => a.toLowerCase() as Hex;
const isAddress = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const eth = (wei: bigint) => {
  const s = wei.toString().padStart(19, "0");
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ""}`;
};

/** The Snap's whole state. Every write stores all of it, so nothing kept here is ever dropped. */
type State = {
  install?: { nonce: Hex; genesis: Hex };
  /** the account prepared for the EOA's createAccount call, before it exists */
  pending?: { owner: Hex; address: Hex };
  account?: { address: Hex };
  journal?: JournalSnapshot;
};
let state: State = {};
let writes: Promise<void> = Promise.resolve();
/** state writes asked for and not yet stored (winterlock_status shows it) */
let writesPending = 0;
/** requests being handled now */
let inbound = 0;
let wakeWriters: (() => void)[] = [];
const whenInbound = () => (inbound > 0 ? Promise.resolve() : new Promise<void>((wake) => { wakeWriters.push(wake); }));
/**
 * Stores the whole state as it is when the write runs; writes run one after another, in call order, and only while a
 * request is being handled. MetaMask's Snap simulator never completes a snap_manageState that a Snap starts between
 * requests (found Nov 6: a background follow's write stayed pending and blocked every later write), so a write asked
 * for between requests, such as a lane's final status, waits for the next request (the page polls every 3 s), and
 * every request waits for its writes before it answers. The writes that keep a leaf from signing twice, "reserved"
 * before it signs and "submitted" before its transaction leaves, are always made inside the send request.
 */
function saveState(): Promise<void> {
  writesPending += 1;
  const next = writes.then(async () => {
    await whenInbound();
    await snap.request({ method: "snap_manageState", params: { operation: "update", newState: state as unknown as Record<string, Json> } });
  }).finally(() => { writesPending -= 1; });
  writes = next.catch(() => undefined);
  return next;
}
/** Every write asked for so far, stored before a request answers; at most 10 s, so a stuck store cannot hang the page. */
async function flushWrites() {
  const until = Date.now() + 10_000;
  while (writesPending > 0 && Date.now() < until) {
    await Promise.race([writes, new Promise((r) => setTimeout(r, 1_000))]);
  }
}

interface Wallet { p: Pipeline; signer: HashSigner; root: Hex; treeSeed: Hex; genesis: Hex; journal: MemoryJournal | null }
let wallet: Promise<Wallet> | null = null;
/** lanes this Snap follows now: sends in the background, or a settle */
let following = 0;
/** what each lane this Snap submitted holds of the balance until it ends (laneCost upper bound) */
const holds = new Map<number, bigint>();
/** submitted lanes whose hold is unknown (left by a stopped Snap, or a follow that failed): no send until settled */
const unsettled = new Set<number>();
/** how each lane followed here ended, for winterlock_status */
const outcomes = new Map<number, string>();
let settling = false;
let lastSettle = 0;
let settleError: string | null = null;

function pipeline(tree?: { root: Hex; treeSeed: Hex }): Pipeline {
  return createPipeline({
    chainId: CHAIN, nodeUrl: NODE_URL, gatewayUrl: SIDECAR_URL, explorerUrl: EXPLORER,
    ...(FAKE ? { fetch: fakeChain({ ...tree, factory: FACTORY, implementation: IMPLEMENTATION, account: () => state.account?.address ?? state.pending?.address }) } : {}),
  });
}

function openJournal(w: Wallet, address: Hex, create: boolean) {
  const store = { save: async (snapshot: JournalSnapshot) => { state.journal = snapshot; await saveState(); } };
  const id = { wallet: address, chainId: CHAIN, epoch: 0, height: HEIGHT, treeSeed: w.treeSeed };
  return MemoryJournal.open(create ? null : (state.journal ?? null), id, { create, store, label: "the Winterlock Snap's journal" });
}

/** Loaded once per Snap start. A new install gets its nonce here; nothing signs until an account is set. */
async function load(): Promise<Wallet> {
  state = ((await snap.request({ method: "snap_manageState", params: { operation: "get" } })) as State | null) ?? {};
  const chain = await pipeline().currentChain();
  if (chain.chainId !== CHAIN) throw new Error(`the node answers chain ${chain.chainId}, not ${CHAIN}`);
  const genesis = lower(chain.genesisHash);
  if (!state.install) {
    state.install = { nonce: hex(crypto.getRandomValues(new Uint8Array(32))), genesis };
    await saveState(); // stored before the entropy it salts is used
  } else if (state.install.genesis !== genesis) {
    throw new Error(`the devnet was reset (genesis ${genesis}; this install's account is on ${state.install.genesis}). Remove the Winterlock Snap in MetaMask and install it again: a new install gets a new tree.`);
  }
  const salt = `winterlock-snap-v1/${CHAIN}/${genesis}/${state.install.nonce}`;
  const entropy = await snap.request({ method: "snap_getEntropy", params: { version: 1, salt } });
  const keyring = new Keyring({ seed: bytes(entropy), generation: 0, height: HEIGHT, chains: [CHAIN] });
  const signer = keyringSigner(keyring);
  const root = hex(keyring.root());
  const w: Wallet = { p: pipeline({ root, treeSeed: signer.treeSeed }), signer, root, treeSeed: lower(signer.treeSeed), genesis, journal: null };
  if (state.account) {
    const journal = openJournal(w, state.account.address, false); // a missing journal is never recreated empty (rule 3)
    // Rule 2: a transaction's hash is stored as "submitted" before it is sent, so a leaf still "reserved" was never
    // sent. Burn it; it is never handed out again either way (rule 1).
    for (const r of journal.all()) if (r.status === "reserved") journal.mark(r.leaf, "burned", { note: "left reserved by a Snap that stopped; never sent" });
    await journal.durable();
    for (const r of journal.all()) if (r.status === "submitted") unsettled.add(r.leaf);
    w.journal = journal;
  }
  return w;
}
const getWallet = () => (wallet ??= load().catch((e) => { wallet = null; throw e; }));

let queue: Promise<unknown> = Promise.resolve();
/** Requests that write run one at a time (journal.ts: one writer). Reads skip the queue. */
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

const balanceOf = async (w: Wallet, a: Hex) => (await w.p.node.balance(a)).toString();

async function getAccount() {
  const w = await getWallet();
  const account = state.account?.address ?? null;
  return {
    chainId: CHAIN.toString(), genesis: w.genesis, height: HEIGHT, root: w.root, treeSeed: w.treeSeed,
    factory: FACTORY, implementation: IMPLEMENTATION, account, balanceWei: account ? await balanceOf(w, account) : null,
  };
}

function accountParams(w: Wallet, owner: Hex): AccountParams {
  return {
    root: w.root, treeSeed: w.treeSeed, height: HEIGHT, owner, hotStart: HOT_START, hotValueCap: 0n, hotFeeCap: 0n,
    allowedTarget: ZERO, salt: state.install!.nonce,
  };
}

async function prepareAccount(p: Record<string, unknown>) {
  if (!isAddress(p.owner)) throw new InvalidParamsError("owner must be an address");
  const w = await getWallet();
  if (state.account) throw new Error(`this Snap already has its account, ${state.account.address}`);
  const code = await w.p.node.code(FACTORY);
  if (code === "0x") throw new Error(`no factory at ${FACTORY} on this chain: was the devnet reset?`);
  const impl = await w.p.node.call(FACTORY, "0x5c60da1b"); // implementation()
  if (BigInt(impl) !== BigInt(IMPLEMENTATION)) throw new Error(`the factory at ${FACTORY} creates proxies to ${impl}, not ${IMPLEMENTATION}`);
  const owner = lower(p.owner);
  const ap = accountParams(w, owner);
  const address = lower(predictAccountAddress(FACTORY, IMPLEMENTATION, ap));
  state.pending = { owner, address }; // only the latest prepared address is accepted
  await saveState();
  return { factory: FACTORY, data: createAccountCalldata(ap), address, gas: `0x${CREATE_GAS.toString(16)}` };
}

async function useAccount(p: Record<string, unknown>) {
  if (!isAddress(p.address)) throw new InvalidParamsError("address must be an address");
  const w = await getWallet();
  const address = lower(p.address);
  if (state.account) {
    if (state.account.address !== address) throw new Error(`this Snap already has its account, ${state.account.address}`);
    return { account: address, balanceWei: await balanceOf(w, address) };
  }
  // Only the address predicted from our own arguments: one tree signs for one account only (spec), so an account
  // someone else created with our public root, under other caps, is never ours.
  if (state.pending?.address !== address) throw new Error(`${address} is not the account this Snap prepared`);
  const code = lower(await w.p.node.code(address));
  if (code !== lower(proxyRuntimeCode(IMPLEMENTATION))) throw new Error(`no Winterlock account at ${address} yet (code ${code.slice(0, 18)}…)`);
  const [root, treeSeed] = await Promise.all([w.p.node.call(address, "0xebf0c717"), w.p.node.call(address, "0x6f9875b4")]);
  if (lower(root) !== w.root || lower(treeSeed) !== w.treeSeed) throw new Error(`the account at ${address} holds another tree`);
  state.account = { address };
  delete state.pending;
  try {
    w.journal = openJournal(w, address, true);
  } catch (e) {
    delete state.account;
    throw e;
  }
  await w.journal.durable(); // its first save stores the account and the new, empty journal together
  return { account: address, balanceWei: await balanceOf(w, address) };
}

function confirmation(o: { from: Hex; to: Hex; value: bigint; leaf: number; nonceKey: bigint; maxCost: bigint }) {
  return (
    <Box>
      <Heading>Send with a one-time key</Heading>
      <Row label="Network"><Text>Alt-mempool devnet, chain 1337</Text></Row>
      <Row label="From"><Address address={o.from} /></Row>
      <Row label="To"><Address address={o.to} /></Row>
      <Row label="Amount"><Text>{`${eth(o.value)} ETH`}</Text></Row>
      <Row label="At most, with gas"><Text>{`${eth(o.maxCost)} ETH`}</Text></Row>
      <Divider />
      <Row label="Next unused leaf"><Text>{String(o.leaf)}</Text></Row>
      <Row label="Nonce key"><Text>{`0x${o.nonceKey.toString(16)}`}</Text></Row>
      <Text>The leaf signs once, on its own nonce key, which the chain consumes once. If the transaction does not land before its 90 s deadline it expires and the leaf is burned. It is never fee-bumped.</Text>
    </Box>
  );
}

/**
 * What this send can cost at most (laneCost of the transaction with placeholder signatures, priced at 10 % above the
 * fee quoted now), refused before the dialog when it does not fit the balance beside the pending lanes' holds.
 */
async function maxCostWithin(w: Wallet, account: Hex, calls: { to: Hex; value: bigint; gas: bigint; stateGas: bigint }[], next: { leaf: number; nonceKey: bigint }) {
  const [quote, balance] = await Promise.all([w.p.gateway.gasPrice(), w.p.node.balance(account)]);
  const slots: SignatureSlot[] = [{ kind: "hash", signer: w.signer, leaf: next.leaf }];
  const tx = w.p.buildFrameTx({
    sender: account, nonce: { keys: [next.nonceKey], seq: 0n }, verifyGas: VERIFY_GAS, calls,
    deadline: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS,
    fees: { maxFeePerGas: (BigInt(quote.maxFeePerGas) * 11n) / 10n, maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas) },
    signatures: placeholders(slots),
  });
  const cost = laneMaxCostWei(tx);
  const held = [...holds.values()].reduce((a, b) => a + b, 0n);
  if (balance < held + cost) {
    throw new Error(`the account holds ${eth(balance)} ETH; this send can cost up to ${eth(cost)} ETH with gas${held ? `, and pending lanes hold ${eth(held)} ETH` : ""}. Fund it first. No leaf was used.`);
  }
  return cost;
}

async function send(p: Record<string, unknown>) {
  if (!isAddress(p.to)) throw new InvalidParamsError("to must be an address");
  if (typeof p.valueWei !== "string" || !/^(0|[1-9]\d{0,40})$/.test(p.valueWei)) throw new InvalidParamsError("valueWei must be a decimal string of wei");
  const w = await getWallet();
  const account = state.account?.address;
  if (!account || !w.journal) throw new Error("no account yet: create it first");
  const journal = w.journal;
  if (unsettled.size) throw new Error(`lanes from before (leaves ${[...unsettled].join(", ")}) are still being settled; send again once they end. No leaf was used.`);
  const to = lower(p.to);
  if (to === account) throw new InvalidParamsError("a call to the account itself is an admin call: not offered here");
  const value = BigInt(p.valueWei);

  // A recipient that does not exist yet needs state gas for its creation (backend/src/chain.ts, isEmptyAccount).
  const [code, balance, nonce] = await Promise.all([w.p.node.code(to), w.p.node.balance(to), w.p.node.nonce(to, "latest")]);
  const empty = code === "0x" && balance === 0n && nonce === 0n;
  const calls = [{ to, value, gas: DEFAULTS.transferGas, stateGas: empty ? NEW_ACCOUNT_STATE_GAS : 0n }];
  const next = journal.peekNext(KEYED_BAND); // what sendKeyed reserves next: sends run one at a time until submitted
  const maxCost = await maxCostWithin(w, account, calls, next);

  const ok = await snap.request({ method: "snap_dialog", params: { type: "confirmation", content: confirmation({ from: account, to, value, maxCost, ...next }) } });
  if (!ok) throw new UserRejectedRequestError("Rejected in MetaMask: no leaf was used.");

  let submitted!: (s: SubmittedInfo) => void;
  const atSubmission = new Promise<SubmittedInfo>((resolve) => { submitted = resolve; });
  let leafSent: number | null = null;
  following += 1;
  const run: Promise<SendKeyedResult> = w.p.sendKeyed({
    journal, band: KEYED_BAND, sender: account, calls, verifyGas: VERIFY_GAS, expirySeconds: EXPIRY_SECONDS,
    signatures: (leaf) => [{ kind: "hash", signer: w.signer, leaf }], grind: GRIND.cold, preflight: true,
    onSubmitted: (s) => { leafSent = s.leaf; holds.set(s.leaf, maxCost); submitted(s); },
  });
  run.then(
    (r) => { outcomes.set(r.leaf, r.outcome); },
    () => { if (leafSent !== null && journal.all().find((r) => r.leaf === leafSent)?.status === "submitted") unsettled.add(leafSent); },
  ).finally(() => { if (leafSent !== null) holds.delete(leafSent); following -= 1; });
  // Answer at submission. A send refused before it left rejects here with its reason (its leaf is burned, if one signed).
  const first = await Promise.race([atSubmission, run]);
  const txHash = first.txHash ?? null;
  return {
    txHash, leaf: first.leaf, nonceKey: `0x${first.nonceKey.toString(16)}`, deadline: first.deadline,
    explorerUrl: txHash ? w.p.explorerTxUrl(txHash) : null, status: "outcome" in first ? first.outcome : "Submitted",
  };
}

/** Follows lanes a stopped Snap (or a failed follow) left "submitted", one settle at a time, at most every 30 s. */
function settleLeftovers(w: Wallet, journal: MemoryJournal) {
  if (settling || following > 0 || unsettled.size === 0 || Date.now() - lastSettle < SETTLE_RETRY_MS) return;
  settling = true;
  lastSettle = Date.now();
  following += 1;
  w.p.settleSubmitted(journal).then(
    (out) => {
      for (const o of out) if (o.outcome !== "unknown") outcomes.set(o.leaf, o.outcome);
      const open = out.filter((o) => o.outcome === "unknown");
      settleError = open.length ? open.map((o) => `leaf ${o.leaf}: ${o.detail ?? "not decided yet"}`).join("; ") : null;
    },
    (e) => { settleError = message(e); },
  ).finally(() => {
    for (const leaf of [...unsettled]) if (journal.all().find((r) => r.leaf === leaf)?.status !== "submitted") unsettled.delete(leaf);
    settling = false;
    following -= 1;
  });
}

async function status() {
  const w = await getWallet();
  const account = state.account?.address ?? null;
  if (!account || !w.journal) return { account, balanceWei: null, following, settling, unsettled: [], settleError, writesPending, leaves: [] };
  const journal = w.journal;
  settleLeftovers(w, journal);
  return {
    account, balanceWei: await balanceOf(w, account), following, settling, unsettled: [...unsettled], settleError, writesPending,
    leaves: journal.all().reverse().map((r) => ({
      leaf: r.leaf, nonceKey: r.nonceKey, status: r.status, ...(r.txHash ? { txHash: r.txHash, explorerUrl: w.p.explorerTxUrl(r.txHash) } : {}),
      ...(r.deadline ? { deadline: r.deadline } : {}), ...(r.note ? { note: r.note } : {}),
      ...(outcomes.has(r.leaf) ? { outcome: outcomes.get(r.leaf)! } : {}),
    })),
  };
}

function route(method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "winterlock_getAccount": return getAccount();
    case "winterlock_status": return status();
    case "winterlock_prepareAccount": return oneAtATime(() => prepareAccount(p));
    case "winterlock_useAccount": return oneAtATime(() => useAccount(p));
    case "winterlock_send": return oneAtATime(() => send(p));
    default: throw new MethodNotFoundError({ method });
  }
}

export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  inbound += 1;
  for (const wake of wakeWriters.splice(0)) wake(); // writes asked for between requests go now
  try {
    return (await route(request.method, (request.params ?? {}) as Record<string, unknown>)) as Json;
  } finally {
    await flushWrites();
    inbound -= 1;
  }
};
