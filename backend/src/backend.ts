// Everything behind the HTTP routes (spec, Shared interfaces 5): wallets, keyed and hot sends, rotation, the hot
// policy, ticket cuts, the transaction store, and recovery at startup.
// Written with Claude Code (AI) for Vicky.
//
// The brief's invariants, and where each one is kept:
//   I1  a leaf signs once: signers are only ever handed to sendKeyed or estimateCalls, always with a journal.
//   I2  keyed sends and admin calls use [0, hotStart) of the cold journal; hot sends only the device's own band.
//       Keyed sends stop short of the last 4 unused cold leaves, which stay for two admin calls of 2 leaves each, the
//       kill switch and a rotation (Vicky, Nov 6); a policy that lowers hotStart must leave 4 below it after its own 2.
//   I3  ticket cuts start where the device's band ends (the epoch's first cut: at the lowest hot leaf the cold journal
//       has never seen, cutStart), every leaf of a cut free, and go through exportTickets, which marks the leaves
//       exported before the CLI writes the file.
//   I4  devices live in <backendDir>/devices/<address>/ (journal) and its tickets/ (files), apart from every journal.
//       A device journal is born on a real first cut only; a lost one is never recreated (review, Nov 6).
//   I5  one LeafJournal per file per process, opened once and kept; another process's lock is 409 journal_busy.
//   I6  no seed, ticket secret or EOA key in a response or a log line; request logs carry no bodies.
//   I7  only sendWithRetry retries, and only after Expired.
//   I8  a rotation waits for no lane in flight and no send before its reservation, one rotation at a time; the new
//       epoch's journal exists before the rotate call; the switch waits for the chain to show the new tree, and a
//       rotation left without an outcome is looked at again every 30 s until the chain decides it.
//   I9  the record's, the signer's and the chain's trees agree before the first signature of each wallet and epoch.
//   I10 every journal opened is settled: its submitted lanes followed to their end, the outcomes into the store.
//   I11 a wallet's admin calls run one at a time (Runtime.admin), from the leaf check until the call is submitted or
//       has failed: a second one checks the leaves again after the first has taken its two.
import fs from "node:fs";
import path from "node:path";
import {
  bytesToHex, concat, encodeFunctionData, getAddress, hexToBytes, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  ChainChanged, DEFAULTS, DEVNET, FACTORY_ABI, FRAME_MODE, GRIND, LeafJournal, PreflightRefused, RetryStopped, SIG_SCHEME, SendError, SubmissionRefused,
  TicketDevice, admissionReport, buildFrameTx, checkChainPin, checkCli, checkSystemContracts, createAccountCalldata, cutStart, estimateCalls,
  exportTickets, frameGasModel, frameTxHash, fromWire, gateway, hashEntryLength, laneCost, node, nonceKeyFor, pinFileFor, pinOrCheckChain,
  planLanes, predictAccountAddress, proxyRuntimeCode, receiptSucceeded, relayConfig, sendKeyed, sendWithRetry, settleSubmitted, ticketFilesOf,
  withEstimates, type AccountParams, type Call, type ChainIdentity, type ChainPin, type FrameTxReceipt, type GrindInfo, type HashSigner,
  type JournalIdentity, type LeafRecord, type RelayConfig, type SendKeyedParams, type SendKeyedResult, type SignatureSlot,
  type SimulationResult, type SubmittedInfo,
} from "../../pipeline/src/index.ts";
import { Keyring, keyringSigner, loadOrCreateSeed } from "../../pipeline/src/hashsig/keyring.ts";
import { journalFile } from "../../pipeline/scripts/lib/wallet.ts";
import type { Config } from "./config.ts";
import { ACCOUNT_ABI, NEW_ACCOUNT_STATE_GAS, accountViews, eth, isEmptyAccount, requireLiveChain, type AccountViews } from "./chain.ts";
import { Mutex, message, sleep } from "./files.ts";
import { HttpError, check, errorResponse, fields, json, mapError, queryFields, queryNumber, simulationView, type Mode } from "./http.ts";
import { Registry, chainsOf, currentTree, epochsOf, type TreeState, type Wallet, type WalletRecord } from "./registry.ts";
import { TxStore, newRecord, type TxGrind, type TxRecord, type TxStatus } from "./store.ts";

/** The spec's ceiling for the declared verify limit (Transaction format; Level A). */
export const VERIFY_GAS = 90_000n;
/** deploy-account.ts's defaults for what POST /wallets leaves out: 0.002 ETH of fee cap, the devnet genesis account. */
export const DEFAULT_HOT_FEE_CAP = 2_000_000_000_000_000n;
export const DEFAULT_TARGET: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
const CREATE_ACCOUNT_GAS = 2_000_000n; // measured 953,678 (spec, Factory)
const FUND_GAS = 100_000n; // the proxy's DELEGATECALL on receipt needs more than 21,000
/** What one admin call spends: a cold leaf for its estimate and one for the call. */
export const ADMIN_CALL_LEAVES = 2;
/** The unused cold leaves keyed sends leave for admin calls: two calls, so the kill switch and a rotation both fit (Vicky, Nov 6). */
export const ADMIN_LEAVES = 2 * ADMIN_CALL_LEAVES;
/** The lowest hotStart at epoch 0: leaf 0 cannot sign there, ADMIN_LEAVES stay for admin calls, and one keyed send. */
export const MIN_HOT_START = 1 + ADMIN_LEAVES + 1;
/** The local fake chain's id (fakechain/, never the devnet's 1337). */
export const FAKE_CHAIN_ID = 31337n;
/** The most lanes one plan (GET /lanes/plan) covers, as one ticket cut. */
export const MAX_PLAN_LANES = 64;
/** What grinding can add to maxFeePerGas: grind() tries at most 4,096 values, one wei apart (grind.ts, pipeline). */
const GRIND_FEE_HEADROOM = 4_096n;

/** The backend cannot make the owner's ECDSA co-signature (plan, section 8): a hybrid account's cold leaves cannot sign. */
const hybridUnsupported = (w: Wallet) =>
  new HttpError(409, "hybrid_unsupported", `${w.address} requires an ECDSA co-signature on cold leaves (hybridRequired), which the backend does not make; nothing was spent`);

type End = "landed" | "dead" | "unknown";

interface Runtime {
  /** requests between their start and their answer (and, with retries, until no attempt can follow) */
  busy: number;
  /** a rotation between its checks and its pending record */
  rotating: boolean;
  /** "<epoch>:<mode>" whose trees were checked (I9) */
  checked: Set<string>;
  cuts: Mutex;
  /** admin calls (hot policy, rotation), one at a time from the leaf check until submitted or failed (I11) */
  admin: Mutex;
}

interface Launch {
  w: Wallet;
  kind: TxRecord["kind"];
  mode: Mode;
  mempool: "alt" | "public";
  to: Address;
  value: bigint;
  params: SendKeyedParams;
  retries: number;
  /** with retries: the first attempt's own fee and deadline (maxFeePerGasWei, firstAttemptExpirySeconds) */
  firstAttempt?: Partial<Pick<SendKeyedParams, "fees" | "expirySeconds">>;
  answer: (s: SubmittedInfo) => unknown;
  release: () => void;
  onSubmitted?: (s: SubmittedInfo) => void;
  /** after the last attempt: whether the transaction landed, is dead, or nobody knows */
  after?: (end: End) => Promise<void>;
}

export interface Deps { log?: (line: string) => void }

/** Journals held by a live Backend in this process: a second instance must not recover them under the first. */
const claimed = new Map<string, Backend>();

export class Backend {
  readonly store: TxStore;
  readonly registry: Registry;
  readonly log: (line: string) => void;
  private journals = new Map<string, LeafJournal>();
  private settling = new Map<string, { w: Wallet; done: Promise<void>; ready: Promise<void> }>();
  private keyrings = new Map<string, Keyring>();
  private devices = new Map<string, TicketDevice>();
  private runtimes = new Map<string, Runtime>();
  private tasks = new Set<Promise<unknown>>();
  /** rotations left without an outcome, looked at again until the chain decides them (default 7), by wallet */
  private watchers = new Map<string, Promise<void>>();
  /** the sidecar's relay settings by URL, one read per cfg.relayCacheMs for every lanes plan; `at` is null while it runs */
  private relays = new Map<string, { at: number | null; read: Promise<RelayConfig> }>();
  /** wallets GET /wallets left out, by address and reason, so the log says each once */
  private hidden = new Set<string>();
  private readonly closing = Promise.withResolvers<void>();
  private readonly eoaLock = new Mutex();
  private readonly createLock = new Mutex();
  private eoaAccount: PrivateKeyAccount | null = null;
  private closed = false;

  constructor(readonly cfg: Config, deps: Deps = {}) {
    this.log = deps.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
    this.store = new TxStore(path.join(cfg.backendDir, "txs.json"));
    this.registry = new Registry(cfg.dataDir, path.join(cfg.backendDir, "wallets"), this.log);
  }

  private dir(...parts: string[]) { return path.join(this.cfg.backendDir, ...parts); }

  // ================================================================ lifecycle

  /** Loads the store and the wallets, then opens and settles every journal in the background (I10). */
  start(): void {
    fs.mkdirSync(this.cfg.backendDir, { recursive: true, mode: 0o700 });
    this.store.load();
    this.registry.load();
    for (const w of this.registry.list()) this.bg(this.recover(w));
  }

  /** Resolves once no background work is left (tests wait for it); a rotation watcher's periodic looks do not count. */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  /** Waits for background work and stops the rotation watchers, then releases every journal lock. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.resolve();
    await this.idle();
    await Promise.allSettled([...this.watchers.values()]);
    for (const [file, j] of this.journals) { j.close(); claimed.delete(file); }
    this.journals.clear();
  }

  /** Waits ms, or less once the backend closes. */
  private pause(ms: number): Promise<unknown> { return Promise.race([sleep(ms), this.closing.promise]); }

  private bg(p: Promise<unknown>): void {
    const t: Promise<unknown> = p.catch((e) => this.log(`background: ${message(e)}`)).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  private rt(w: Wallet): Runtime {
    const key = w.address.toLowerCase();
    let r = this.runtimes.get(key);
    if (!r) this.runtimes.set(key, (r = { busy: 0, rotating: false, checked: new Set(), cuts: new Mutex(), admin: new Mutex() }));
    return r;
  }

  /** The HTTP answer for any error; an unexpected one is logged here and answered without its detail. */
  toHttp(e: unknown, mode: Mode = "keyed"): HttpError {
    const mapped = mapError(e, mode);
    if (mapped) return mapped;
    this.log(`internal error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return new HttpError(500, "internal", "internal error; the backend's log has the cause");
  }

  wallet(address: string): Wallet {
    let w = this.registry.get(address);
    if (!w) { this.registry.load(); w = this.registry.get(address); }
    if (!w) throw new HttpError(404, "unknown_wallet", `no wallet ${address}`);
    return w;
  }

  // ================================================================ journals, signers, devices

  /** One LeafJournal per file per process, kept open (I5). The first open recovers it: stale reservations, settling. */
  private journal(file: string, id: JournalIdentity, opts: { create?: boolean }, w: Wallet): LeafJournal {
    const key = path.resolve(file);
    const have = this.journals.get(key);
    if (have) {
      // the open journal must be the one asked for, as LeafJournal.open checks on a first open
      const same = have.wallet === id.wallet.toLowerCase() && have.chainId === id.chainId && have.epoch === id.epoch && have.height === id.height &&
        (!id.treeSeed || !have.treeSeed || have.treeSeed === id.treeSeed.toLowerCase());
      if (!same) throw new HttpError(409, "journal_unusable", `journal ${key} is for epoch ${have.epoch}, height ${have.height}, tree seed ${have.treeSeed}; asked for epoch ${id.epoch}, height ${id.height}, tree seed ${id.treeSeed}`);
      return have;
    }
    const other = claimed.get(key);
    if (other && other !== this) throw new HttpError(409, "journal_busy", `journal ${key} is held by another backend in this process`);
    let j: LeafJournal;
    try {
      j = LeafJournal.open(key, id, opts);
    } catch (e) {
      const text = message(e);
      throw new HttpError(409, /in use by another process/.test(text) ? "journal_busy" : "journal_unusable", text);
    }
    this.journals.set(key, j);
    claimed.set(key, this);
    this.burnStale(j);
    let ready!: () => void;
    const readyP = new Promise<void>((r) => { ready = r; });
    const done = this.settle(j, ready);
    this.settling.set(key, { w, done, ready: readyP });
    this.bg(done);
    return j;
  }

  /**
   * A leaf left "reserved" by a process that ended never reached a mempool: sendKeyed journals "submitted" before it
   * sends. Burned, so it neither signs again nor counts as a lane in flight forever.
   */
  private burnStale(j: LeafJournal): void {
    const stale = j.all().filter((r) => r.status === "reserved");
    for (const r of stale) j.mark(r.leaf, "burned", { note: "reserved by a process that ended before submitting it; burned when the backend opened the journal" });
    if (stale.length) this.log(`journal ${path.basename(j.file)}: burned ${stale.length} stale reservation(s): ${stale.map((r) => r.leaf).join(", ")}`);
  }

  /**
   * I10: follows the lanes a previous process left "submitted". settleSubmitted lists them after its own system-contract
   * check, so that check is made first: then the list is taken at once, before any send of this process can submit.
   */
  private async settle(j: LeafJournal, ready: () => void): Promise<void> {
    const stale = new Set(j.all().filter((r) => r.status === "submitted").map((r) => r.leaf));
    if (!stale.size) { ready(); return; }
    for (;;) {
      try { await checkSystemContracts(); break; } catch (e) {
        if (this.closed) { ready(); return; }
        this.log(`settle ${path.basename(j.file)}: ${message(e)}; again in ${this.cfg.settleRetryMs} ms`);
        await sleep(this.cfg.settleRetryMs);
      }
    }
    const run = settleSubmitted(j, { pollMs: this.cfg.follow.pollMs, receiptWaitMs: this.cfg.follow.receiptWaitMs, confirmations: this.cfg.follow.confirmations });
    ready();
    let out: Awaited<typeof run>;
    try { out = await run; } catch (e) { this.log(`settle ${path.basename(j.file)}: ${message(e)}; its lanes stay submitted until the next start`); return; }
    await this.recordSettled(j, out, "after a restart", stale);
  }

  /** settleSubmitted's outcomes into the store; `when` says on the timeline when they were settled. */
  private async recordSettled(j: LeafJournal, out: Awaited<ReturnType<typeof settleSubmitted>>, when: string, only?: Set<number>): Promise<void> {
    for (const o of out) {
      if (only && !only.has(o.leaf)) continue;
      const hash = j.get(o.leaf)?.txHash;
      const tx = hash ? this.store.get(hash) : undefined;
      if (!tx) continue;
      if (o.outcome === "unknown") {
        if (tx.status !== "Unknown") this.store.update(tx.txHash, { status: "Unknown", detail: o.detail ?? tx.detail }, `Unknown ${when}: no outcome`);
        continue;
      }
      const receipt = o.outcome === "Expired" ? null : await readReceipt(tx.txHash);
      const admission = tx.mempool === "public" ? null : ((await admissionReport(tx.txHash).catch(() => null)) ?? tx.admission);
      this.store.update(tx.txHash, { status: o.outcome, receipt, admission, simulation: simulationView(null, receipt, admission), detail: j.get(o.leaf)?.note ?? tx.detail }, `settled ${when}: ${o.outcome}`);
    }
  }

  /** Sends on a journal wait until its settling has listed the stale lanes (immediate when there are none). */
  private async settled(j: LeafJournal): Promise<void> {
    await this.settling.get(path.resolve(j.file))?.ready;
  }

  private identity(w: Wallet, t: TreeState): JournalIdentity {
    return { wallet: w.address, chainId: DEVNET.chainId, epoch: t.epoch, height: t.height, treeSeed: t.treeSeed };
  }

  /** The wallet's cold journal for one epoch, beside its seed (wallet.ts journalFile). Created only by POST /wallets and rotation. */
  private coldJournal(w: Wallet, t: TreeState, create = false): LeafJournal {
    const legacy = path.join(this.cfg.dataDir, `journal-${w.address.toLowerCase()}-epoch${t.epoch}.json`);
    if (fs.existsSync(legacy)) {
      throw new HttpError(409, "journal_unusable", `a journal for ${w.address} is still in the pipeline's .data (${legacy}); the account's journal lives beside its seed. Move it with pipeline/scripts/move-journal.ts, or look at both before removing anything`);
    }
    return this.journal(journalFile(w.record, t.epoch), this.identity(w, t), { create }, w);
  }

  private deviceDir(w: Wallet) { return this.dir("devices", w.address.toLowerCase()); }

  /**
   * The wallet's ticket device for one epoch, or null before its first cut (unless create). Its journal is born on a
   * real first cut only: once tickets of the epoch were cut, a missing journal is 409 device_unusable, because a new
   * one would hand out tickets that already signed (review, Nov 6).
   */
  private device(w: Wallet, t: TreeState, create = false): TicketDevice | null {
    const key = `${w.address.toLowerCase()}:${t.epoch}`;
    const have = this.devices.get(key);
    if (have) return have;
    const dir = this.deviceDir(w);
    const file = TicketDevice.journalFile(dir, t.epoch);
    const exists = fs.existsSync(file);
    if (!exists) {
      if (!create) return null;
      const lost = this.unjournaled(w, t);
      if (lost) throw new HttpError(409, "device_unusable", lost.detail);
    }
    const id = this.identity(w, t);
    let d: TicketDevice;
    try {
      // TicketDevice.open creates the journal on a first cut, and refuses to beside ticket files of the epoch
      d = TicketDevice.open({ dir, wallet: w.address, chainId: DEVNET.chainId, epoch: t.epoch, height: t.height, treeSeed: t.treeSeed, create: !exists });
    } catch (e) {
      attempt(() => this.journal(file, id, {}, w)); // an unusable device's journal is still recovered and settled (I10)
      const text = message(e);
      throw new HttpError(409, /in use by another process/.test(text) ? "journal_busy" : "device_unusable", `the ticket device of ${w.address}: ${text}`);
    }
    this.journal(file, id, {}, w); // the same instance, through here so it is recovered and settled like any journal
    this.devices.set(key, d);
    return d;
  }

  /**
   * Tickets of an epoch whose device journal is missing: leaves the cold journal marked exported, or ticket files in the
   * device's tickets/. Only that journal knew which of them signed, so none may be handed out again. Null when the
   * journal exists or nothing was cut.
   */
  private unjournaled(w: Wallet, t: TreeState): { count: number; detail: string } | null {
    const dir = this.deviceDir(w);
    const file = TicketDevice.journalFile(dir, t.epoch);
    if (fs.existsSync(file)) return null;
    const exported = this.coldJournal(w, t).all().filter((r) => r.status === "exported").length;
    const files = ticketFilesOf(TicketDevice.ticketsDirOf(dir), t.epoch);
    if (!exported && !files.length) return null;
    const count = Math.max(exported, files.reduce((n, f) => n + f.to - f.from + 1, 0));
    return {
      count,
      detail: `${count} ticket(s) of epoch ${t.epoch} were cut for ${w.address} (${exported} exported in the cold journal, ` +
        `${files.length} ticket file(s) in ${TicketDevice.ticketsDirOf(dir)}), but the device journal is missing: recover ${file}; a new journal would re-sign used tickets`,
    };
  }

  /** The cold tree of one epoch, from the wallet's own seed file; a missing seed is an error, never a new seed. */
  private keyring(w: Wallet, epoch: number, height: number): Keyring {
    const key = `${w.address.toLowerCase()}:${epoch}:${height}`;
    const have = this.keyrings.get(key);
    if (have) return have;
    const file = w.record.tree.seedFile;
    let text: string;
    try { text = fs.readFileSync(file, "utf8").trim(); } catch {
      throw new HttpError(409, "cannot_send", `the seed file of ${w.address} (${file}) cannot be read; a missing seed is never recreated for an existing wallet`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new HttpError(409, "cannot_send", `the seed file of ${w.address} (${file}) does not hold 32 bytes of hex`);
    const seed = hexToBytes(text as Hex);
    try {
      const k = new Keyring({ seed, generation: epoch, height, chains: chainsOf(w.record), cacheDir: this.dir("hashsig-cache") });
      this.keyrings.set(key, k);
      return k;
    } finally {
      seed.fill(0); // the keyring keeps its own copy
    }
  }

  /** A devnet reset must stop signing before a leaf is reused: the genesis pin is checked before every signature. */
  private pinned(w: Wallet, inner: HashSigner): HashSigner {
    const pin = pinFileFor(w.record.tree.seedFile);
    return { ...inner, sign: async (req) => { await pinOrCheckChain(pin, () => eth.chainIdentity()); return inner.sign(req); } };
  }

  private coldSigner(w: Wallet, t: TreeState): HashSigner { return this.pinned(w, keyringSigner(this.keyring(w, t.epoch, t.height))); }

  /** The Rust CLI exists and runs (`--help`); otherwise 500 signer_unavailable, before any ticket is reserved or cut. */
  private async requireSigner(): Promise<void> {
    try {
      await checkCli(this.cfg.signerBin);
    } catch (e) {
      this.log(`signer CLI: ${message(e)}`);
      throw new HttpError(500, "signer_unavailable", `the signer CLI ${this.cfg.signerBin} cannot run (${message(e)}); no ticket was reserved, cut or burned`);
    }
  }

  /** Keyed sends and admin calls: [0, hotStart), within the tree (I2). Epoch 0 skips leaf 0 in the journal. */
  private coldBand(v: AccountViews, t: TreeState) { return { from: 0, to: Math.min(v.hotStart, 2 ** t.height) }; }

  /** The cold leaves the journal has never seen, lowest first (epoch 0 has no leaf 0). */
  private unusedCold(j: LeafJournal, v: AccountViews, t: TreeState): number[] {
    const { from, to } = this.coldBand(v, t);
    const out: number[] = [];
    for (let leaf = from; leaf < to; leaf++) if (!j.get(leaf) && !(j.epoch === 0 && leaf === 0)) out.push(leaf);
    return out;
  }

  /**
   * A keyed send's band: the cold band short of its last ADMIN_LEAVES unused leaves, which stay for two admin calls
   * (the kill switch and a rotation); its retries draw from the same band. 409 when the send would eat into them.
   */
  private keyedBand(j: LeafJournal, v: AccountViews, t: TreeState, needed: number): { from: number; to: number } {
    const free = this.unusedCold(j, v, t);
    if (free.length < needed + ADMIN_LEAVES) {
      throw new HttpError(409, "leaves_exhausted", `${free.length} unused cold leaf(s) and this send needs ${needed}: the last ${ADMIN_LEAVES} cold leaves are kept for the kill switch and a rotation (${ADMIN_CALL_LEAVES} each)`);
    }
    return { from: 0, to: free[free.length - ADMIN_LEAVES]! };
  }

  /**
   * Before an admin call spends anything: no hybrid account (the backend cannot co-sign), and its two cold leaves. A
   * policy that lowers hotStart must also leave ADMIN_LEAVES unused cold leaves below the new hotStart after its own two.
   */
  private adminReady(w: Wallet, j: LeafJournal, v: AccountViews, t: TreeState, newHotStart?: number): void {
    if (v.hybridRequired) throw hybridUnsupported(w);
    const free = this.unusedCold(j, v, t);
    if (free.length < ADMIN_CALL_LEAVES) {
      throw new HttpError(409, "leaves_exhausted", `${free.length} unused cold leaf(s): an admin call needs ${ADMIN_CALL_LEAVES}, one for its estimate and one for the call; nothing was spent`);
    }
    if (newHotStart !== undefined && newHotStart < v.hotStart) {
      const below = free.filter((leaf) => leaf < newHotStart).length; // this call's two are the lowest of them
      if (below - ADMIN_CALL_LEAVES < ADMIN_LEAVES) {
        throw new HttpError(409, "leaves_exhausted", `the new hotStart would leave too few cold leaves for rotation and the kill switch: ${below} unused cold leaf(s) below ${newHotStart}, this call spends ${ADMIN_CALL_LEAVES} and ${ADMIN_LEAVES} must stay; nothing was spent`);
      }
    }
  }

  private async views(w: Wallet): Promise<AccountViews> {
    const v = await accountViews(w.address);
    if (!v) throw new HttpError(409, "not_deployed", `${w.address} has no code on chain${w.record.createTx ? ` (its createAccount transaction is ${w.record.createTx})` : ""}`);
    return v;
  }

  /**
   * I9: before the first signature of a (wallet, epoch), the record's tree, the signer's tree and the chain's views
   * must agree; otherwise 409 tree_mismatch and no leaf is spent. Hot sends compare the ticket files' tree.
   */
  private checkTree(w: Wallet, t: TreeState, v: AccountViews, mode: Mode, device?: TicketDevice): void {
    const rt = this.rt(w);
    const key = `${t.epoch}:${mode}`;
    if (rt.checked.has(key)) return;
    const fmt = (x: TreeState) => `epoch ${x.epoch}, height ${x.height}, root ${x.root}, tree seed ${x.treeSeed}`;
    const chain: TreeState = { epoch: v.epoch, height: v.height, root: v.root, treeSeed: v.treeSeed };
    let signer: TreeState;
    if (mode === "keyed") {
      const k = this.keyring(w, t.epoch, t.height);
      signer = { epoch: k.generation, height: k.height, root: bytesToHex(k.root()), treeSeed: bytesToHex(k.treeSeed) };
    } else {
      const f = device?.tree;
      if (!f || f.chainId !== DEVNET.chainId) throw new HttpError(409, "tree_mismatch", `the ticket files of ${w.address} are not for chain ${DEVNET.chainId}`);
      signer = { epoch: f.generation, height: f.height, root: f.root, treeSeed: f.treeSeed };
    }
    const same = (a: TreeState, b: TreeState) => a.epoch === b.epoch && a.height === b.height && a.root === b.root && a.treeSeed === b.treeSeed;
    if (!same(t, chain) || !same(t, signer)) {
      throw new HttpError(409, "tree_mismatch", `the trees of ${w.address} disagree; no leaf was spent. Record: ${fmt(t)}. ${mode === "keyed" ? "Seed" : "Tickets"}: ${fmt(signer)}. Chain: ${fmt(chain)}`);
    }
    rt.checked.add(key);
  }

  /** A request that may sign: refused while a rotation is pending, and counted so a rotation waits for it (I8). */
  private claim(w: Wallet): () => void {
    const rt = this.rt(w);
    if (rt.rotating || w.record.rotation) {
      throw new HttpError(409, "rotation_pending", `a rotation of ${w.address} is pending: sends, ticket cuts and policy changes wait until the chain shows it or it fails`);
    }
    rt.busy++;
    let done = false;
    return () => { if (!done) { done = true; rt.busy--; } };
  }

  private follow() {
    const f = this.cfg.follow;
    return { pollMs: f.pollMs, receiptWaitMs: f.receiptWaitMs, timeoutMs: f.timeoutMs, confirmations: f.confirmations };
  }

  // ================================================================ sending

  /**
   * Starts a send and answers once it is submitted (200) or fails before that (its error). The send goes on in the
   * background and writes every step into the store. Only sendWithRetry retries (I7).
   */
  private launch(o: Launch): Promise<Response> {
    return new Promise<Response>((resolve) => {
      let answered = false;
      let current: Hex | null = null;
      const now = () => new Date().toISOString();
      const safely = (what: string, f: () => void) => { try { f(); } catch (e) { this.log(`store: ${what}: ${message(e)}`); } };
      // The JSON each attempt sent, by its hash: onSend comes right before the send, and never throws into it.
      const wires = new Map<string, unknown>();
      const onSend = (sent: unknown) => {
        safely("wire", () => { wires.set(frameTxHash(fromWire(sent as Parameters<typeof fromWire>[0])).toLowerCase(), sent); });
        safely("onSend", () => o.params.onSend?.(sent));
      };

      const onSubmitted = (s: SubmittedInfo) => {
        const previous = current;
        current = s.txHash.toLowerCase() as Hex;
        const wire = wires.get(current) ?? null;
        const rec = newRecord({
          txHash: s.txHash, status: "Submitted", wallet: o.w.address, kind: o.kind, leaf: s.leaf, nonceKey: toHex(s.nonceKey),
          mode: o.mode, mempool: o.mempool, to: o.to, valueWei: o.value.toString(), deadline: s.deadline, retryOf: previous,
          maxCostWei: maxCostOf(s.simulation, wire), wire, grind: grindView(s.grind),
        });
        rec.timeline.push({ status: s.accepted ? "Submitted" : "Submitted (the mempool's answer was lost: followed by its key)", at: rec.createdAt });
        safely("submitted", () => {
          this.store.put(rec);
          if (previous) this.store.update(previous, { retriedAs: rec.txHash }, `retried as ${rec.txHash}`);
        });
        safely("hook", () => o.onSubmitted?.(s));
        if (!answered) {
          answered = true;
          if (o.retries === 0) o.release();
          resolve(json(200, o.answer(s)));
        }
      };
      const onStatus = (status: string) => { if (current) safely("status", () => this.store.update(current!, {}, status)); };
      const finish = (r: SendKeyedResult) => safely("outcome", () => {
        const note = o.params.journal.get(r.leaf)?.note ?? null;
        this.store.update(r.txHash, {
          status: r.outcome, receipt: r.receipt, admission: r.admission, simulation: simulationView(r.simulation, r.receipt, r.admission),
          detail: r.outcome === "OnChain" ? null : note,
        }, `${r.outcome}${r.receipt ? ` in block ${BigInt(r.receipt.blockNumber)}` : ""}`);
      });

      const run = async () => {
        let end: End = "unknown";
        try {
          const params = { ...o.params, onSubmitted, onStatus, onSend };
          let final: SendKeyedResult;
          if (o.retries === 0) {
            final = await sendKeyed(params);
          } else {
            final = (await sendWithRetry({
              ...params, attempts: 1 + o.retries, dropWaitMs: this.cfg.follow.dropWaitMs,
              ...(o.firstAttempt ? { firstAttempt: o.firstAttempt } : {}),
              onRetry: (dead) => finish(dead),
            })).final;
          }
          finish(final);
          end = final.outcome === "Expired" ? "dead" : "landed";
        } catch (e) {
          const cause = e instanceof RetryStopped && e.cause ? e.cause : e;
          if (cause instanceof PreflightRefused || cause instanceof SubmissionRefused) {
            safely("refused", () => this.recordRefusal(o, cause, current, wires));
          }
          if (!answered) {
            // A SendError before the answer means nothing this send signed reached a mempool that holds it. Anything
            // else (a journal write that failed, a bug) may have come after the transaction left: unknown, so a
            // rotation stays pending until the chain decides it (review, Nov 6).
            end = cause instanceof SendError ? "dead" : "unknown";
            await o.after?.(end).catch((x) => this.log(`after: ${message(x)}`));
            o.after = undefined;
            answered = true;
            resolve(errorResponse(this.toHttp(e, o.mode)));
          } else {
            end = this.afterAnswer(e, cause, current);
          }
        } finally {
          o.release();
          if (o.after) await o.after(end).catch((x) => this.log(`after: ${message(x)}`));
        }
      };
      this.bg(run());
    });
  }

  /** A failure after the answer: write what is known on the transaction it belongs to. */
  private afterAnswer(e: unknown, cause: unknown, current: Hex | null): End {
    if (cause instanceof PreflightRefused || cause instanceof SubmissionRefused) return "dead"; // a retry refused; recorded
    if (cause instanceof SendError && cause.stage === "follow" && cause.txHash) {
      this.store.update(cause.txHash, { status: "Unknown", detail: cause.message }, "Unknown: no outcome in time; never paid again automatically");
      return "unknown";
    }
    if (e instanceof RetryStopped && current) {
      this.store.update(current, { detail: `no retry: ${message(cause)}` }, "no retry sent");
      return this.store.get(current)?.status === "Expired" ? "dead" : "unknown";
    }
    if (current) this.store.update(current, { status: "Unknown", detail: message(e) }, "Unknown: the follow stopped");
    return "unknown";
  }

  /** A refused attempt's record; `wires` holds what this launch sent, so a lane refused at submission keeps its JSON. */
  private recordRefusal(o: Launch, err: PreflightRefused | SubmissionRefused, retryOf: Hex | null, wires: Map<string, unknown>): void {
    if (!err.txHash || err.leaf === null || err.nonceKey === null) return;
    const wire = wires.get(err.txHash.toLowerCase()) ?? null; // none for a dry-run refusal: nothing was sent
    const rec = newRecord({
      txHash: err.txHash, status: "Refused", wallet: o.w.address, kind: o.kind, leaf: err.leaf, nonceKey: toHex(err.nonceKey),
      mode: o.mode, mempool: o.mempool, to: o.to, valueWei: o.value.toString(), deadline: err.deadline, retryOf,
      detail: err.message, admission: err.admission, simulation: simulationView(err.simulation, null, err.admission, err.cause),
      maxCostWei: maxCostOf(err.simulation, wire), wire, grind: grindView(err.grind),
    });
    rec.timeline.push({ status: err instanceof PreflightRefused ? "Refused by the node's dry run" : "Refused at submission", at: rec.createdAt });
    this.store.put(rec);
    if (retryOf) this.store.update(retryOf, { retriedAs: rec.txHash }, `retried as ${rec.txHash}`);
  }

  /** POST /wallets/:address/send. */
  async send(address: string, body: unknown): Promise<Response> {
    const w = this.wallet(address);
    const f = fields(body, ["to", "valueWei", "data", "mode", "expirySeconds", "firstAttemptExpirySeconds", "mempool", "maxFeePerGasWei", "retries"]);
    if (f.to === undefined) throw new HttpError(400, "bad_request", "to is required");
    const to = check.address(f.to, "to");
    const value = f.valueWei === undefined ? 0n : check.wei(f.valueWei, "valueWei");
    const data = f.data === undefined ? "0x" : check.hex(f.data, "data");
    const mode = f.mode === undefined ? "keyed" : check.oneOf(f.mode, "mode", ["keyed", "hot"] as const);
    const expirySeconds = f.expirySeconds === undefined ? DEFAULTS.expirySeconds : check.int(f.expirySeconds, "expirySeconds", 1, 86_400);
    // the first attempt's deadline only (the demo's stuck payment: 4 s should miss a 6 s block); retries keep expirySeconds
    const firstExpiry = f.firstAttemptExpirySeconds === undefined ? null : check.int(f.firstAttemptExpirySeconds, "firstAttemptExpirySeconds", 1, 86_400);
    const mempool = f.mempool === undefined ? "alt" : check.oneOf(f.mempool, "mempool", ["alt", "public"] as const);
    const maxFee = f.maxFeePerGasWei === undefined ? null : check.wei(f.maxFeePerGasWei, "maxFeePerGasWei");
    if (maxFee === 0n) throw new HttpError(400, "bad_request", "maxFeePerGasWei must be above 0");
    const retries = f.retries === undefined ? 0 : check.int(f.retries, "retries", 0, 3);
    if (data !== "0x" && to.toLowerCase() === w.address.toLowerCase()) {
      // an admin call sent this way would change the account behind the record's back (rotation, hybrid, owner)
      throw new HttpError(400, "bad_request", "calls to the wallet itself go through /rotate and /hot-policy");
    }

    const release = this.claim(w);
    try {
      await requireLiveChain();
      const views = await this.views(w);
      const tree = currentTree(w.record);
      let journal: LeafJournal, band: { from: number; to: number }, signer: HashSigner;
      if (mode === "keyed") {
        if (views.hybridRequired) throw hybridUnsupported(w); // a hot leaf needs no co-signature, a cold one does
        journal = this.coldJournal(w, tree);
        this.checkTree(w, tree, views, "keyed");
        band = this.keyedBand(journal, views, tree, data === "0x" ? 1 : 2); // a call with data burns a leaf on its estimate
        signer = this.coldSigner(w, tree);
      } else {
        const device = this.device(w, tree);
        const held = device?.band() ?? null;
        if (!device || !held) {
          // tickets cut but their journal lost: 409 device_unusable, as the cut is; never an invitation to cut
          const lost = device ? null : this.unjournaled(w, tree);
          if (lost) throw new HttpError(409, "device_unusable", lost.detail);
          throw new HttpError(409, "no_tickets", `${w.address} holds no tickets for epoch ${tree.epoch}: cut some with POST /api/wallets/${w.address}/tickets`);
        }
        this.checkTree(w, tree, views, "hot", device);
        await this.requireSigner(); // every ticket signs through the CLI: a missing one must burn no ticket
        journal = device.journal;
        band = held;
        signer = this.pinned(w, device.signer({ bin: this.cfg.signerBin }));
      }
      await this.settled(journal);
      const signatures = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
      const call: Call = { to, value, data };
      let calls: Call[];
      if (data === "0x" || mode === "hot") {
        // a plain transfer, or a hot call sent as it is: the account refuses data on a hot leaf, and that refusal is the scene
        calls = [{ ...call, gas: DEFAULTS.transferGas, stateGas: (await isEmptyAccount(to)) ? NEW_ACCOUNT_STATE_GAS : 0n }];
      } else {
        calls = withEstimates([call], await estimateCalls({ journal, band, sender: w.address, calls: [call], signatures }));
      }
      // the first attempt's own fee and deadline: sendWithRetry's firstAttempt, or without retries the one attempt's
      const firstAttempt: NonNullable<Launch["firstAttempt"]> = firstExpiry === null ? {} : { expirySeconds: firstExpiry };
      if (maxFee !== null) {
        const market = BigInt((await gateway.gasPrice()).maxPriorityFeePerGas);
        firstAttempt.fees = { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee < market ? maxFee : market };
      }
      const params: SendKeyedParams = {
        journal, band, sender: w.address, calls, verifyGas: VERIFY_GAS, signatures, expirySeconds, preflight: true, mempool,
        grind: mode === "hot" ? GRIND.hot : GRIND.cold, ...this.follow(), ...(retries === 0 ? firstAttempt : {}),
      };
      return await this.launch({
        w, kind: "send", mode, mempool, to, value, params, retries, firstAttempt, release,
        answer: (s) => ({ txHash: s.txHash, leaf: s.leaf, nonceKeys: [toHex(s.nonceKey)], nonceSeq: "0x0", status: "Submitted" }),
      });
    } catch (e) {
      release();
      throw this.toHttp(e, mode);
    }
  }

  // ================================================================ admin calls: hot policy and rotation

  /**
   * An admin call to the account itself, on a cold leaf, with limits from estimateCalls (one throwaway leaf). Runs
   * inside the wallet's admin lock (I11); newHotStart is the hotStart a policy call sets.
   */
  private async adminCall(w: Wallet, v: AccountViews, data: Hex, newHotStart?: number) {
    const tree = currentTree(w.record);
    const journal = this.coldJournal(w, tree);
    const band = this.coldBand(v, tree); // the whole cold band: admin calls may use the leaves keyed sends leave them
    this.checkTree(w, tree, v, "keyed");
    this.adminReady(w, journal, v, tree, newHotStart);
    const signer = this.coldSigner(w, tree);
    await this.settled(journal);
    const signatures = (leaf: number): SignatureSlot[] => [{ kind: "hash", signer, leaf }];
    const call: Call = { to: w.address, value: 0n, data };
    const calls = withEstimates([call], await estimateCalls({ journal, band, sender: w.address, calls: [call], signatures }));
    const params: SendKeyedParams = {
      journal, band, sender: w.address, calls, verifyGas: VERIFY_GAS, signatures, preflight: true, grind: GRIND.cold, ...this.follow(),
    };
    return params;
  }

  /** POST /wallets/:address/hot-policy: setHotPolicy signed by a cold leaf; a value cap of 0 is the kill switch. */
  async hotPolicy(address: string, body: unknown): Promise<Response> {
    const w = this.wallet(address);
    const f = fields(body, ["hotStart", "valueCapWei", "feeCapWei", "allowedTarget"]);
    for (const k of ["hotStart", "valueCapWei", "feeCapWei", "allowedTarget"]) if (f[k] === undefined) throw new HttpError(400, "bad_request", `${k} is required`);
    const hotStart = check.int(f.hotStart, "hotStart", 0, 0xffff_ffff);
    const valueCap = check.wei(f.valueCapWei, "valueCapWei");
    const feeCap = check.wei(f.feeCapWei, "feeCapWei");
    const target = check.address(f.allowedTarget, "allowedTarget");
    const release = this.claim(w);
    try {
      // I11: held until the call is submitted or has failed, so a second policy call counts the leaves this one took
      return await this.rt(w).admin.run(async () => {
        await requireLiveChain();
        const v = await this.views(w);
        // both refusals of Account.yul's setHotPolicy, before any leaf is spent
        if (hotStart > v.hotStart) throw new HttpError(400, "bad_request", `hotStart ${hotStart} is above the account's ${v.hotStart}: the hot band never grows back toward cold leaves within an epoch (rotate instead)`);
        if (hotStart === 0 || (hotStart === 1 && v.epoch === 0)) throw new HttpError(400, "bad_request", `hotStart ${hotStart} leaves no cold leaf for admin calls at epoch ${v.epoch}`);
        const params = await this.adminCall(w, v, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setHotPolicy", args: [hotStart, valueCap, feeCap, target] }), hotStart);
        return await this.launch({
          w, kind: "hot-policy", mode: "keyed", mempool: "alt", to: w.address, value: 0n, params, retries: 0, release,
          answer: (s) => ({ txHash: s.txHash, status: "Submitted" }),
        });
      });
    } catch (e) {
      release();
      throw this.toHttp(e);
    }
  }

  private lanesInFlight(w: Wallet, t: TreeState): number {
    const lanes = (j: LeafJournal) => j.all().filter((r) => r.status === "reserved" || r.status === "submitted").length;
    const device = this.device(w, t);
    return lanes(this.coldJournal(w, t)) + (device ? lanes(device.journal) : 0);
  }

  /** POST /wallets/:address/rotate (I8, I9): a new tree as the next generation, switched to once the chain shows it. */
  async rotate(address: string, body: unknown): Promise<Response> {
    const w = this.wallet(address);
    const f = fields(body, ["height"]);
    if (f.height === undefined) throw new HttpError(400, "bad_request", "height is required");
    const height = check.int(f.height, "height", 2, 12);
    const rt = this.rt(w);
    if (rt.rotating || w.record.rotation) throw new HttpError(409, "rotation_pending", `a rotation of ${w.address} is already pending`);
    if (rt.busy > 0) throw new HttpError(409, "lanes_in_flight", `${rt.busy} request(s) for ${w.address} are still running; a rotation waits until none is`);
    const tree = currentTree(w.record);
    const lanes = this.lanesInFlight(w, tree);
    if (lanes > 0) throw new HttpError(409, "lanes_in_flight", `${lanes} lane(s) of ${w.address} are in flight; rotation would invalidate them, so it waits until they end`);
    rt.rotating = true; // from here every send, cut and policy change of this wallet is refused
    let launched = false;
    try {
      // I11: held until the rotate call is submitted or has failed (a policy call meanwhile is 409 rotation_pending)
      return await rt.admin.run(async () => {
        await requireLiveChain();
        const v = await this.views(w);
        this.checkTree(w, tree, v, "keyed");
        this.adminReady(w, this.coldJournal(w, tree), v, tree); // before the next epoch's journal exists
        // A rotation dropped earlier left the next epoch's journal, which names its height. The next epoch keeps that
        // height: its tree seed depends only on the seed and the epoch, so a tree of another height would share one-time
        // keys with the dropped one (slot 0's leaf indices do not depend on the height).
        const earlier = journalHeight(journalFile(w.record, tree.epoch + 1));
        if (earlier !== null && earlier !== height) {
          throw new HttpError(409, "cannot_rotate", `an earlier rotation of ${w.address} to epoch ${tree.epoch + 1} used height ${earlier}, and its journal stays: rotate with height ${earlier}`);
        }
        const nextKeys = this.keyring(w, tree.epoch + 1, height);
        const next: TreeState = { epoch: tree.epoch + 1, height, root: bytesToHex(nextKeys.root()), treeSeed: bytesToHex(nextKeys.treeSeed) };
        const user = this.registry.usingTree(next.treeSeed);
        if (user && user.address !== w.address) throw new HttpError(409, "cannot_rotate", `the new tree seed is already used by ${user.address}`);
        // The new epoch's journal first: once the chain is on the new epoch, its journal must already exist.
        this.coldJournal(w, next, true);
        w.record.rotation = { ...next, startedAt: new Date().toISOString() };
        this.registry.write(w);
        const params = await this.adminCall(w, v, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "rotate", args: [next.root, next.treeSeed, next.height] }));
        launched = true;
        return await this.launch({
          w, kind: "rotate", mode: "keyed", mempool: "alt", to: w.address, value: 0n, params, retries: 0, release: () => {},
          answer: (s) => ({ txHash: s.txHash, newRoot: next.root, epoch: next.epoch }),
          onSubmitted: (s) => { if (w.record.rotation) { w.record.rotation.txHash = s.txHash; this.registry.write(w); } },
          after: (end) => this.resolveRotation(w, end),
        });
      });
    } catch (e) {
      if (!launched) this.dropRotation(w, `it never left: ${message(e)}`);
      throw this.toHttp(e);
    } finally {
      rt.rotating = false; // the record's pending rotation keeps refusing sends from here
    }
  }

  /**
   * Decides a pending rotation from the chain: switch only when it shows the new epoch and root (I8). With no outcome
   * yet, or a chain that cannot be read, it stays pending and is looked at again (default 7).
   */
  private async resolveRotation(w: Wallet, end: End): Promise<void> {
    const pending = w.record.rotation;
    if (!pending) return;
    if (end === "unknown") return this.watchRotation(w);
    if (end === "dead") return this.dropRotation(w, "the rotate transaction never landed");
    let v: AccountViews | null = null;
    for (let i = 0; i < 5 && !v && !this.closed; i++) {
      v = await this.views(w).catch(() => null);
      if (!v) await this.pause(this.cfg.settleRetryMs);
    }
    if (!v) { this.log(`rotation of ${w.address}: the chain cannot be read; it stays pending, looked at again every ${this.cfg.settleRetryMs} ms`); return this.watchRotation(w); }
    if (v.epoch === pending.epoch && v.root === pending.root && v.treeSeed === pending.treeSeed && v.height === pending.height) {
      const before = epochsOf(w.record).filter((e) => e.epoch !== pending.epoch);
      w.record.tree = { ...w.record.tree, generation: pending.epoch, height: pending.height, root: pending.root, treeSeed: pending.treeSeed };
      w.record.epochs = [...before, { epoch: pending.epoch, root: pending.root, treeSeed: pending.treeSeed, height: pending.height }];
      delete w.record.rotation;
      this.registry.write(w);
      this.log(`rotation of ${w.address}: the chain shows epoch ${pending.epoch}, root ${pending.root}; switched`);
      return;
    }
    const old = currentTree(w.record);
    if (v.epoch !== old.epoch || v.root !== old.root) this.log(`rotation of ${w.address}: ALERT the chain shows epoch ${v.epoch}, root ${v.root}: neither the old tree nor the new one`);
    this.dropRotation(w, `the chain does not show the new tree (epoch ${v.epoch}, root ${v.root})`);
  }

  private dropRotation(w: Wallet, why: string): void {
    if (!w.record.rotation) return;
    delete w.record.rotation;
    this.registry.write(w);
    this.log(`rotation of ${w.address} dropped: ${why}; the wallet stays on epoch ${currentTree(w.record).epoch}`);
  }

  /** What the store and the journal say of a pending rotation's transaction. */
  private rotationEnd(w: Wallet): End {
    const pending = w.record.rotation!;
    const tx = pending.txHash ? this.store.get(pending.txHash) : undefined;
    if (tx) return ["OnChain", "Reverted", "Included"].includes(tx.status) ? "landed" : ["Expired", "Refused"].includes(tx.status) ? "dead" : "unknown";
    // never answered: once nothing it may have signed is in flight, the chain decides
    const old = attempt(() => this.coldJournal(w, currentTree(w.record)));
    return old?.all().some((r) => r.status === "submitted") ? "unknown" : "landed";
  }

  /**
   * Default 7: a rotation left pending with no outcome (its lane Unknown, or the chain unreadable when it ended) is
   * looked at again every settleRetryMs (30 s) in this process, until the chain decides it; no restart is needed.
   */
  private watchRotation(w: Wallet): void {
    const key = w.address.toLowerCase();
    if (this.closed || this.watchers.has(key)) return;
    const run = (async () => {
      while (!this.closed && w.record.rotation) {
        await this.pause(this.cfg.settleRetryMs);
        if (this.closed || !w.record.rotation) return;
        try {
          // one look at the rotate's lane: journal and store follow when the chain decides it now
          const j = this.coldJournal(w, currentTree(w.record));
          if (j.all().some((r) => r.status === "submitted")) {
            const f = this.cfg.follow;
            await this.recordSettled(j, await settleSubmitted(j, { pollMs: f.pollMs, receiptWaitMs: f.receiptWaitMs, confirmations: f.confirmations, timeoutMs: 0 }), "when re-checked");
          }
          const end = this.rotationEnd(w);
          if (end !== "unknown") await this.resolveRotation(w, end);
        } catch (e) {
          this.log(`rotation of ${w.address}: ${message(e)}; looked at again in ${this.cfg.settleRetryMs} ms`);
        }
      }
    })().finally(() => this.watchers.delete(key));
    this.watchers.set(key, run);
  }

  // ================================================================ tickets

  /** POST /wallets/:address/tickets (I3, I4): the next `count` hot leaves, cut to the wallet's ticket device. */
  async tickets(address: string, body: unknown): Promise<Response> {
    const w = this.wallet(address);
    const f = fields(body, ["count"]);
    if (f.count === undefined) throw new HttpError(400, "bad_request", "count is required");
    const count = check.int(f.count, "count", 1, 64);
    const release = this.claim(w);
    try {
      return await this.rt(w).cuts.run(async () => {
        const v = await this.views(w);
        const tree = currentTree(w.record);
        this.checkTree(w, tree, v, "keyed"); // the tickets must be of the tree the chain trusts
        await this.requireSigner(); // a CLI that cannot run would waste the cut once it is marked exported
        const cold = this.coldJournal(w, tree);
        const device = this.device(w, tree, true)!; // the device journal is born on a real first cut, else 409 device_unusable
        // contiguous: where the device's band ends; the epoch's first cut at the lowest hot leaf the cold journal has
        // never seen (a script may have signed hot leaves directly)
        const from = cutStart({ coldJournal: cold, hotStart: v.hotStart, band: device.band() });
        if (from === null) {
          throw new HttpError(409, "leaves_exhausted", `no hot leaf from hotStart ${v.hotStart} to leaf ${2 ** tree.height - 1} is free in the cold journal: the hot band has no uncut leaf left`);
        }
        const last = from + count - 1;
        if (last >= 2 ** tree.height) {
          throw new HttpError(409, "leaves_exhausted", `the hot band has ${Math.max(0, 2 ** tree.height - from)} uncut leaf(s) left from leaf ${from}, not ${count}`);
        }
        for (let leaf = from; leaf <= last; leaf++) {
          const rec = cold.get(leaf);
          if (rec) throw new HttpError(409, "cannot_cut", `leaf ${leaf} is already ${rec.status} in the cold journal${rec.note ? ` (${rec.note})` : ""}; cuts stay contiguous, so none is cut`);
        }
        let r;
        try {
          r = await exportTickets({
            bin: this.cfg.signerBin, seedFile: w.record.tree.seedFile, coldJournal: cold, chainId: DEVNET.chainId, hotStart: v.hotStart,
            tree: { height: tree.height, generation: tree.epoch, chains: chainsOf(w.record), root: tree.root }, from, count, ticketsDir: device.ticketsDir,
          });
        } catch (e) {
          attempt(() => device.reload());
          const text = message(e);
          if (text.startsWith("no tickets cut:")) throw new HttpError(409, "cannot_cut", text);
          this.log(`ticket cut of ${w.address}: ${text}`);
          throw new HttpError(500, "cut_failed", text);
        }
        device.reload(); // the new file joins the device's band
        return json(200, { from: r.from, to: r.to, count: r.count });
      });
    } catch (e) {
      throw this.toHttp(e, "hot");
    } finally {
      release();
    }
  }

  // ================================================================ reads

  /** GET /wallets/:address: values from the chain, counts from the journals and the device. */
  async walletView(address: string) {
    const w = this.wallet(address);
    const v = await this.views(w);
    const tree = currentTree(w.record);
    const cold = this.coldJournal(w, tree);
    const device = this.device(w, tree);
    const lanes = (j: LeafJournal) => j.all().filter((r) => r.status === "reserved" || r.status === "submitted").length;
    const balance = await node.balance(w.address);
    // cut, but the device journal is lost: none can be signed (left 0), and none is known used (used 0)
    const lost = device ? null : this.unjournaled(w, tree);
    return {
      address: w.address, root: v.root, treeSeed: v.treeSeed, height: v.height, epoch: v.epoch,
      leavesUsed: cold.all().length, leafCount: 2 ** v.height, lanesInFlight: lanes(cold) + (device ? lanes(device.journal) : 0),
      hybrid: v.hybridRequired, locked: false, balanceWei: balance.toString(),
      hotStart: v.hotStart, hotValueCapWei: v.hotValueCap.toString(), hotFeeCapWei: v.hotFeeCap.toString(), allowedTarget: v.allowedTarget,
      tickets: device?.counts() ?? (lost ? { exported: lost.count, used: 0, left: 0, unjournaled: lost.count } : { exported: 0, used: 0, left: 0 }),
      rotationPending: this.rt(w).rotating || !!w.record.rotation,
      leaves: leafStates(cold, device),
    };
  }

  /**
   * GET /status, for the screens' status line: the node's chain id and head, how old the head is by the host clock,
   * stalled as the 503 rule has it (more than 60 s off), and fake for the local fake chain (chain id 31337).
   */
  async status() {
    let id: bigint, head: { number: bigint; timestamp: bigint };
    try {
      [{ chainId: id }, head] = await Promise.all([eth.chainIdentity(), node.block("latest")]);
    } catch (e) {
      throw new HttpError(502, "rpc_failed", `the node cannot be read: ${message(e)}`);
    }
    const age = Math.floor(Date.now() / 1000) - Number(head.timestamp);
    return { chainId: Number(id), head: Number(head.number), headAgeSeconds: age, stalled: Math.abs(age) > DEFAULTS.maxClockSkewSeconds, fake: id === FAKE_CHAIN_ID };
  }

  /**
   * GET /wallets: every wallet on this chain, with its record's epoch and height and its balance. A wallet that can
   * never sign here is left out (Nov 6, Vicky): its seed is pinned to another chain (a devnet reset; the pin refuses
   * every signature), or its address has no code on this chain. A pin that cannot be read keeps the wallet listed.
   */
  async listWallets() {
    this.registry.load();
    const ws = this.registry.list();
    const [now, reads] = await Promise.all([
      eth.chainIdentity(),
      Promise.all(ws.map((w) => Promise.all([node.balance(w.address), node.code(w.address)]))),
    ]);
    const out: { address: Address; epoch: number; height: number; balanceWei: string }[] = [];
    ws.forEach((w, i) => {
      const [balance, code] = reads[i]!;
      const gone = pinnedElsewhere(w, now) ?? (code === "0x" ? "it has no code on this chain" : null);
      if (gone) {
        const key = `${w.address.toLowerCase()}:${gone}`;
        if (!this.hidden.has(key)) { this.hidden.add(key); this.log(`GET /wallets leaves out ${w.address}: ${gone}`); }
        return;
      }
      const t = currentTree(w.record);
      out.push({ address: w.address, epoch: t.epoch, height: t.height, balanceWei: balance.toString() });
    });
    return out;
  }

  /** Every journal of every wallet that can be opened now, for lookups by hash. */
  private *allJournals(): Generator<{ w: Wallet; j: LeafJournal; mode: Mode }> {
    for (const w of this.registry.list()) {
      for (const t of epochsOf(w.record)) {
        const cold = attempt(() => this.coldJournal(w, t));
        if (cold) yield { w, j: cold, mode: "keyed" };
        const device = attempt(() => this.device(w, t));
        if (device) yield { w, j: device.journal, mode: "hot" };
      }
    }
  }

  private journalView(w: Wallet, r: LeafRecord, mode: Mode, receipt: FrameTxReceipt | null, admission: TxRecord["admission"]): TxRecord {
    let status = statusFromJournal(r);
    if (receipt && r.status === "onchain") status = receiptSucceeded(receipt) ? "OnChain" : "Reverted";
    const rec = newRecord({
      txHash: r.txHash!, status, wallet: w.address, kind: "send", leaf: r.leaf, nonceKey: r.nonceKey, mode, mempool: "alt",
      to: w.address, valueWei: "0", deadline: r.deadline ?? null, detail: r.note ?? null, receipt, admission,
      simulation: simulationView(null, receipt, admission), createdAt: r.updatedAt, updatedAt: r.updatedAt,
    });
    // what the journal does not know stays empty rather than guessed
    return { ...rec, kind: null, mempool: null, to: null, valueWei: null } as unknown as TxRecord;
  }

  /**
   * GET /tx/:hash: the store's record, else the journal's, with the receipt and admission report read live, and its
   * gas columns (gasView) worked out from the JSON sent and the receipt.
   */
  async txView(hash: string): Promise<TxView> {
    const stored = this.store.get(hash);
    if (stored) return { ...stored, gas: gasView(stored) };
    for (const { w, j, mode } of this.allJournals()) {
      const r = j.all().find((x) => x.txHash?.toLowerCase() === hash.toLowerCase());
      if (!r) continue;
      const receipt = r.status === "onchain" ? await readReceipt(r.txHash!) : null;
      const admission = await admissionReport(r.txHash!).catch(() => null);
      const rec = this.journalView(w, r, mode, receipt, admission);
      return { ...rec, gas: gasView(rec) };
    }
    throw new HttpError(404, "unknown_tx", `no transaction ${hash} in the store or in any journal`);
  }

  /**
   * GET /wallets/:address/txs: the lane board, newest first; journal-only lanes (e.g. from scripts) included. Each
   * record carries maxCostWei and its gas columns but not wire, the JSON sent, which only GET /tx/:hash returns.
   */
  walletTxs(address: string): Omit<TxView, "wire">[] {
    const w = this.wallet(address);
    const out = this.store.forWallet(w.address);
    const known = new Set(out.map((t) => t.txHash.toLowerCase()));
    for (const t of epochsOf(w.record)) {
      for (const [j, mode] of [[attempt(() => this.coldJournal(w, t)), "keyed"], [attempt(() => this.device(w, t))?.journal, "hot"]] as const) {
        for (const r of j?.all() ?? []) {
          if (r.txHash && !known.has(r.txHash.toLowerCase())) out.push(this.journalView(w, r, mode, null, null));
        }
      }
    }
    return out
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(({ wire, ...rest }) => ({ ...rest, gas: gasView({ ...rest, wire }) }));
  }

  /**
   * GET /wallets/:address/lanes/plan (parallel lanes): what n lanes sent at once would hold of the balance and take to
   * relay, before any leaf is reserved. One lane's cost is laneMaxCostWei of a transfer built as POST /send builds it,
   * with a placeholder entry, the epoch's costliest nonce key and the market's fee plus what grinding can add, so it is
   * an upper bound; the pending cost is maxCostWei + valueWei over the wallet's lanes in flight (Submitted, Unknown).
   * The sidecar's relay settings come from one read a minute (relay). Nothing is signed, reserved or written.
   */
  async lanesPlan(address: string, query: URLSearchParams) {
    const w = this.wallet(address);
    const q = queryFields(query, ["n", "mode", "valueWei", "to", "expirySeconds"]);
    if (q.n === undefined) throw new HttpError(400, "bad_request", "n, the number of lanes, is required");
    const n = check.int(queryNumber(q.n), "n", 1, MAX_PLAN_LANES);
    const mode = q.mode === undefined ? "keyed" : check.oneOf(q.mode, "mode", ["keyed", "hot"] as const);
    const value = q.valueWei === undefined ? 0n : check.wei(q.valueWei, "valueWei");
    const expirySeconds = q.expirySeconds === undefined ? DEFAULTS.expirySeconds : check.int(queryNumber(q.expirySeconds), "expirySeconds", 1, 86_400);
    const asked = q.to === undefined ? null : check.address(q.to, "to");
    try {
      const v = await this.views(w);
      const to = asked ?? v.allowedTarget; // the plan and the burst default to the account's allowed target
      const tree = currentTree(w.record);
      const [balance, price, empty, shared, stalled] = await Promise.all([
        node.balance(w.address), gateway.gasPrice(), isEmptyAccount(to), this.relay(DEVNET.gateway), // read once a minute
        // a stalled chain is worth saying in a plan, not a reason to refuse one; an unreadable node still is (502)
        requireLiveChain().then(() => null, (e) => (e instanceof HttpError && e.status === 503 ? e.message : Promise.reject(e))),
      ]);
      const relay: RelayConfig = { ...shared, notes: [...shared.notes] }; // the cached read is shared: this plan's own copy

      // One lane, built as send() builds a plain transfer; no journal is asked for a leaf.
      const tx = buildFrameTx({
        chainId: DEVNET.chainId, sender: w.address, nonce: { keys: [nonceKeyFor(tree.epoch, 2 ** tree.height - 1)], seq: 0n }, // no key bills more bytes
        verifyGas: VERIFY_GAS, deadline: Math.floor(Date.now() / 1000) + expirySeconds,
        fees: { maxFeePerGas: BigInt(price.maxFeePerGas) + GRIND_FEE_HEADROOM, maxPriorityFeePerGas: BigInt(price.maxPriorityFeePerGas) },
        calls: [{ to, value, data: "0x", gas: DEFAULTS.transferGas, stateGas: empty ? NEW_ACCOUNT_STATE_GAS : 0n }],
        signatures: [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: toHex(new Uint8Array(hashEntryLength(tree.height))) }],
      });
      const cost = laneCost(tx);

      // What is pending: the store's records in flight, and lanes only a journal knows (a send not yet submitted, a script's).
      const records = this.store.forWallet(w.address);
      const inFlight = records.filter((t) => t.status === "Submitted" || t.status === "Unknown");
      let pendingCostWei = 0n, unpriced = 0;
      for (const t of inFlight) {
        if (t.maxCostWei === null || t.valueWei === null) unpriced++;
        else pendingCostWei += BigInt(t.maxCostWei) + BigInt(t.valueWei);
      }
      const recorded = new Set(records.map((t) => t.txHash.toLowerCase()));
      const cold = this.coldJournal(w, tree);
      // A hot plan reads the ticket device as a hot send does (an unusable one is its 409); a keyed plan only looks at it
      // for lanes in flight. No device: no cut yet, or tickets cut whose journal is lost (then none can sign).
      const device = mode === "hot" ? this.device(w, tree) : attempt(() => this.device(w, tree));
      const lost = mode === "hot" && !device ? attempt(() => this.unjournaled(w, tree)) : null;
      let journalOnly = 0;
      for (const j of [cold, device?.journal]) {
        for (const r of j?.all() ?? []) {
          if ((r.status === "reserved" || r.status === "submitted") && !(r.txHash && recorded.has(r.txHash.toLowerCase()))) journalOnly++;
        }
      }
      const lanesLeft = mode === "keyed" ? Math.max(0, this.unusedCold(cold, v, tree).length - ADMIN_LEAVES) : (device?.counts().left ?? 0);
      // An expired lane can stay in the sidecar, counted against the balance, until its reconciler drops it (sendWithRetry
      // waits for that): about one pass per relay attempt.
      const dropWindow = relay.bundleIntervalSeconds * (relay.maxSubmitAttempts + 1);
      const recentlyExpired = records.filter((t) => t.status === "Expired" && Date.now() - Date.parse(t.updatedAt) < dropWindow * 1000).length;

      const notes: string[] = [];
      if (stalled) notes.push(`the chain looks stalled (${stalled}): every send is refused (503) until it moves`);
      if (this.rt(w).rotating || w.record.rotation) notes.push("a rotation of this wallet is pending: sends wait until the chain decides it (409 rotation_pending)");
      if (lost) {
        notes.push(`no ticket can sign: ${lost.detail} (hot sends and cuts are 409 device_unusable until then)`);
      } else if (lanesLeft < n) {
        notes.push(mode === "keyed"
          ? `only ${lanesLeft} cold leaf(s) are left for keyed lanes (the last ${ADMIN_LEAVES} stay for the kill switch and a rotation): the burst would stop after ${lanesLeft}`
          : `only ${lanesLeft} ticket(s) are left on the ticket device: the burst would stop after ${lanesLeft}${lanesLeft === 0 ? `; cut some with POST /api/wallets/${w.address}/tickets` : ""}`);
      }
      if (mode === "keyed" && v.hybridRequired) notes.push("this account requires the ECDSA co-signature on cold leaves, which the backend does not make: keyed lanes are refused (409 hybrid_unsupported)");
      if (mode === "hot") {
        if (v.hotValueCap === 0n) notes.push(`the hot value cap is 0, the kill switch: the account refuses every hot lane ("hot: disabled")`);
        else if (value > v.hotValueCap) notes.push(`each lane's value, ${value} wei, is above the hot value cap of ${v.hotValueCap} wei: the account refuses it ("hot: value cap")`);
        if (to.toLowerCase() !== v.allowedTarget.toLowerCase()) notes.push(`hot lanes may pay only the allowed target ${v.allowedTarget}: the account refuses ${to} ("hot: frame target")`);
        if (cost.gasCostWei > v.hotFeeCap) notes.push(`each lane's maximum cost, ${cost.gasCostWei} wei, is above the hot fee cap of ${v.hotFeeCap} wei: the account refuses it ("hot: fee cap")`);
      }
      if (unpriced + journalOnly) notes.push(`${unpriced + journalOnly} lane(s) in flight have no recorded maximum cost (still being sent, sent by a script, or recorded before Nov 6): the set-aside leaves them out`);
      if (recentlyExpired) notes.push(`${recentlyExpired} lane(s) expired in the last ${dropWindow} s: the sidecar may still count them against the balance until it drops them`);

      const plan = planLanes({ n, perLaneCostWei: cost.totalWei, pendingCostWei, balanceWei: balance, relay, expirySeconds });
      return {
        wallet: w.address, n, mode, to, valueWei: value, expirySeconds,
        affordable: plan.affordable, setAsideWei: plan.setAsideWei, shortfallWei: plan.shortfallWei, passes: plan.passes, etaSeconds: plan.etaSeconds,
        warnings: [...plan.warnings, ...notes],
        perLaneCostWei: cost.totalWei,
        perLane: { gasLimit: cost.gasLimit, maxFeePerGasWei: cost.maxFeePerGas, gasCostWei: cost.gasCostWei, valueWei: cost.valueWei },
        pendingLanes: inFlight.length + journalOnly, pendingCostWei, unpricedLanes: unpriced + journalOnly,
        balanceWei: balance, lanesLeft, relay,
      };
    } catch (e) {
      throw this.toHttp(e, mode);
    }
  }

  /**
   * The sidecar's relay settings for the lanes plan, read once per cfg.relayCacheMs (60 s) in this process and shared
   * by every plan asked meanwhile, those asked during the read included: a screen asking for a plan every few seconds
   * costs two sidecar calls a minute, not two a plan. relayConfig never throws; a read that could not reach the
   * sidecar (assumed, with its notes) is kept just as long, so a dead sidecar is not asked again on every plan either.
   */
  private relay(url: string): Promise<RelayConfig> {
    const have = this.relays.get(url);
    if (have && (have.at === null || Date.now() - have.at < this.cfg.relayCacheMs)) return have.read;
    const entry: { at: number | null; read: Promise<RelayConfig> } = { at: null, read: relayConfig(url) };
    entry.read.then(() => { entry.at = Date.now(); }, () => { if (this.relays.get(url) === entry) this.relays.delete(url); });
    this.relays.set(url, entry);
    return entry.read;
  }

  // ================================================================ recovery at startup

  /** Opens every journal of a wallet (each settles itself), reconciles the store, then decides a pending rotation. */
  private async recover(w: Wallet): Promise<void> {
    for (const t of epochsOf(w.record)) {
      attempt(() => this.coldJournal(w, t), (e) => this.log(`start: ${w.address} epoch ${t.epoch}: ${message(e)}`));
      attempt(() => this.device(w, t), (e) => this.log(`start: ${w.address} device epoch ${t.epoch}: ${message(e)}`));
      const lost = attempt(() => this.unjournaled(w, t));
      if (lost) this.log(`start: ${lost.detail}`);
    }
    if (w.record.rotation) attempt(() => this.coldJournal(w, w.record.rotation!), (e) => this.log(`start: ${w.address} pending epoch: ${message(e)}`));
    this.reconcile(w);
    await Promise.all([...this.settling.values()].filter((s) => s.w === w).map((s) => s.done));
    if (w.record.rotation) await this.resolveRotation(w, this.rotationEnd(w)); // its lane is settled by now, if it can be
  }

  /** A store record left "Submitted" or "Unknown" whose journal leaf already ended (a stop between the two writes). */
  private reconcile(w: Wallet): void {
    for (const tx of this.store.forWallet(w.address)) {
      if (tx.status !== "Submitted" && tx.status !== "Unknown") continue;
      const epoch = Number(BigInt(tx.nonceKey) >> 32n);
      const t = epochsOf(w.record).find((e) => e.epoch === epoch);
      if (!t) continue;
      const j = tx.mode === "hot" ? attempt(() => this.device(w, t))?.journal : attempt(() => this.coldJournal(w, t));
      const r = j?.get(tx.leaf);
      if (!r || r.status === "submitted" || r.status === "reserved" || r.txHash?.toLowerCase() !== tx.txHash) continue;
      const status = statusFromJournal(r);
      this.store.update(tx.txHash, { status, detail: r.note ?? tx.detail }, `from the journal at start: ${status}`);
    }
  }

  // ================================================================ creating a wallet

  private eoa(): PrivateKeyAccount {
    if (this.eoaAccount) return this.eoaAccount;
    const file = this.cfg.eoaKeyFile;
    let text: string;
    try { text = fs.readFileSync(file, "utf8").trim(); } catch { throw new HttpError(409, "cannot_create", `no EOA key file at ${file} (WL_EOA_KEY_FILE)`); }
    if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new HttpError(409, "cannot_create", `${file} does not hold a 32-byte hex key`);
    try { this.eoaAccount = privateKeyToAccount(text as Hex); } catch { throw new HttpError(409, "cannot_create", `${file} does not hold a valid secp256k1 key`); }
    return this.eoaAccount;
  }

  /**
   * One legacy transaction from the EOA, waited for. All of them run one at a time, on the mined nonce, and none is sent
   * while an earlier one of the EOA is still pending (deploy-account.ts: a re-run once queued a second payment).
   */
  private eoaTx(eoa: PrivateKeyAccount, to: Address, data: Hex, value: bigint, gas: bigint, label: string) {
    return this.eoaLock.run(async () => {
      const [latest, pending] = await Promise.all([node.nonce(eoa.address, "latest"), node.nonce(eoa.address, "pending")]);
      if (pending > latest) throw new HttpError(409, "eoa_busy", `${label}: the EOA has ${pending - latest} transaction(s) still pending; nothing was sent`);
      const raw = await eoa.signTransaction({ chainId: Number(DEVNET.chainId), nonce: Number(latest), to, value, gas, gasPrice: this.cfg.eoa.gasPriceWei, data, type: "legacy" });
      const hash = await eth.sendRawTransaction(raw);
      this.log(`${label}: EOA transaction ${hash}`);
      for (const until = Date.now() + this.cfg.eoa.waitMs; ;) {
        const r = await node.receipt(hash).catch(() => null);
        if (r) {
          if (r.status !== "success") throw new HttpError(409, "cannot_create", `${label} ${hash} reverted in block ${BigInt(r.blockNumber)}`);
          return { hash, receipt: r };
        }
        if (Date.now() > until) throw new HttpError(502, "not_mined", `${label} ${hash} was not mined in ${this.cfg.eoa.waitMs / 1000} s; nothing more is sent from the EOA while it is pending`);
        await sleep(this.cfg.eoa.pollMs);
      }
    });
  }

  /** The faucet first (it is often dry), then the EOA up to WL_FUND_WEI. Funding problems never fail the creation. */
  private async fund(eoa: PrivateKeyAccount, account: Address): Promise<boolean> {
    let balance = 0n;
    try {
      balance = await node.balance(account);
      if (balance < this.cfg.fundWei) {
        const before = balance; // the top-up is counted after the faucet's payment shows, whatever was there
        const paid = await gateway.faucet(account).then(() => true, (e) => { this.log(`faucet for ${account}: ${message(e)}`); return false; });
        for (const until = Date.now() + this.cfg.faucetWaitMs; paid && balance === before && Date.now() < until;) {
          await sleep(this.cfg.eoa.pollMs);
          balance = await node.balance(account);
        }
      }
      if (balance < this.cfg.fundWei) {
        const need = this.cfg.fundWei - balance;
        const have = await node.balance(eoa.address);
        if (have >= need + FUND_GAS * this.cfg.eoa.gasPriceWei) {
          await this.eoaTx(eoa, account, "0x", need, FUND_GAS, "fund");
          balance = await node.balance(account);
        } else {
          this.log(`fund ${account}: the EOA holds ${have} wei, not enough for ${need} wei and gas; fund it another way`);
        }
      }
    } catch (e) {
      this.log(`fund ${account}: ${message(e)}`);
    }
    return balance > 0n;
  }

  /** The next free seed file in <backendDir>/seeds/: account-<n>.seed. */
  private nextSeedFile(): string {
    const dir = this.dir("seeds");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let n = 1;
    for (const name of fs.readdirSync(dir)) {
      const m = /^account-(\d+)\.seed/.exec(name);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    return path.join(dir, `account-${n}.seed`);
  }

  /** POST /wallets. The order is deploy-account.ts's: tree, journal, record, createAccount, code check, funding. */
  async createWallet(body: unknown): Promise<Response> {
    const f = fields(body, ["height", "hybrid", "spendLimitWei", "chainIds", "hotStart", "hotFeeCapWei", "allowedTarget"]);
    const height = f.height === undefined ? 10 : check.int(f.height, "height", 2, 12);
    if (f.hybrid !== undefined && check.bool(f.hybrid, "hybrid")) throw new HttpError(400, "bad_request", "hybrid co-signing stays off (plan, section 8): send hybrid false or leave it out");
    if (f.spendLimitWei === undefined) throw new HttpError(400, "bad_request", "spendLimitWei (the hot value cap) is required");
    const hotValueCap = check.wei(f.spendLimitWei, "spendLimitWei");
    const chains = f.chainIds === undefined ? [DEVNET.chainId] : chainList(f.chainIds);
    const leaves = 2 ** height;
    const hotStart = f.hotStart === undefined ? Math.max(MIN_HOT_START, leaves - 16) : check.int(f.hotStart, "hotStart", 0, 0xffff_ffff);
    if (hotStart < MIN_HOT_START) {
      throw new HttpError(400, "bad_request", `hotStart ${hotStart} leaves too few cold leaves at epoch 0: leaf 0 cannot sign, ${ADMIN_LEAVES} stay for the kill switch and a rotation, and a keyed send needs one more, so hotStart must be at least ${MIN_HOT_START}`);
    }
    if (hotStart > leaves) {
      throw new HttpError(400, "bad_request", `hotStart ${hotStart} is above the tree's ${leaves} leaves${f.hotStart === undefined ? ` (the default at height ${height}; epoch 0 needs a hotStart of at least ${MIN_HOT_START})` : ""}`);
    }
    const hotFeeCap = f.hotFeeCapWei === undefined ? DEFAULT_HOT_FEE_CAP : check.wei(f.hotFeeCapWei, "hotFeeCapWei");
    const allowedTarget = f.allowedTarget === undefined ? DEFAULT_TARGET : check.address(f.allowedTarget, "allowedTarget");

    try {
      const dep = this.registry.pipelineDeployment();
      if (!dep || dep.verifier !== "hashsig") {
        throw new HttpError(409, "cannot_create", `no hashsig deployment record at ${path.join(this.cfg.dataDir, `deployment-${DEVNET.chainId}.json`)}: deploy the implementation and factory first (pipeline/scripts/deploy-account.ts)`);
      }
      const implementation = getAddress(dep.implementation), factory = getAddress(dep.factory);
      const [implCode, factoryCode, bound] = await Promise.all([
        node.code(implementation), node.code(factory), node.call(factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "implementation" })),
      ]);
      if (implCode === "0x") throw new HttpError(409, "cannot_create", `the implementation ${implementation} has no code on chain`);
      if (factoryCode === "0x") throw new HttpError(409, "cannot_create", `the factory ${factory} has no code on chain`);
      if (!/^0x[0-9a-fA-F]{64}$/.test(bound) || getAddress(`0x${bound.slice(26)}`) !== implementation) {
        throw new HttpError(409, "cannot_create", `the factory ${factory} is not bound to the implementation ${implementation}`);
      }
      await requireLiveChain(); // a stalled chain would never mine createAccount
      const eoa = this.eoa();
      return await this.createLock.run(async () => {
        const [latest, pending] = await Promise.all([node.nonce(eoa.address, "latest"), node.nonce(eoa.address, "pending")]);
        if (pending > latest) throw new HttpError(409, "eoa_busy", `the EOA has ${pending - latest} transaction(s) still pending; nothing was created`);

        const seedFile = this.nextSeedFile();
        if (fs.existsSync(seedFile)) throw new Error(`${seedFile} exists`); // loadOrCreateSeed would load it: never reuse a seed
        const seed = loadOrCreateSeed(seedFile);
        let keyring: Keyring;
        try {
          await pinOrCheckChain(pinFileFor(seedFile), () => eth.chainIdentity());
          keyring = new Keyring({ seed, generation: 0, height, chains, cacheDir: this.dir("hashsig-cache") });
        } finally {
          seed.fill(0);
        }
        const root = bytesToHex(keyring.root()), treeSeed = bytesToHex(keyring.treeSeed);
        const params: AccountParams = {
          // owner: the EOA, the classical co-signer if hybrid is ever turned on (Vicky's default 4); hybrid stays off
          root, treeSeed, height, owner: eoa.address, hotStart, hotValueCap, hotFeeCap, allowedTarget,
          salt: keccak256(concat([toHex("winterlock/backend/salt"), treeSeed])),
        };
        const address = predictAccountAddress(factory, implementation, params);
        const predicted = await node.call(factory, encodeFunctionData({
          abi: FACTORY_ABI, functionName: "predictAddress",
          args: [params.root, params.treeSeed, params.height, params.owner, params.hotStart, params.hotValueCap, params.hotFeeCap, params.allowedTarget, params.salt],
        }));
        if (!/^0x[0-9a-fA-F]{64}$/.test(predicted) || getAddress(`0x${predicted.slice(26)}`) !== address) {
          throw new HttpError(409, "cannot_create", `the factory predicts ${predicted}, the pipeline ${address}: their CREATE2 formulas differ`);
        }
        // one seed, one account (spec)
        const user = this.registry.usingTree(treeSeed) ?? this.registry.get(address);
        if (user) throw new HttpError(409, "cannot_create", `the new tree is already used by ${user.address}`);
        if ((await node.code(address)) !== "0x") throw new HttpError(409, "cannot_create", `${address} already has code`);

        const record: WalletRecord = {
          chainId: DEVNET.chainId.toString(), verifier: "hashsig", implementation, factory, account: address,
          ...(dep.implementationCodeHash ? { implementationCodeHash: dep.implementationCodeHash } : {}),
          params: { ...params, hotValueCap: hotValueCap.toString(), hotFeeCap: hotFeeCap.toString() },
          tree: { seedFile, generation: 0, height, chains: chains.map(String), root, treeSeed },
          epochs: [{ epoch: 0, root, treeSeed, height }],
          createdBy: "backend",
          createdAt: new Date().toISOString(),
        };
        const w = this.registry.draft(record);
        // The journal is born before the account, so nothing can ever sign for it without one.
        this.coldJournal(w, currentTree(record), true);
        this.registry.add(w);
        this.keyrings.set(`${address.toLowerCase()}:0:${height}`, keyring);
        const created = await this.eoaTx(eoa, factory, createAccountCalldata(params), 0n, CREATE_ACCOUNT_GAS, "createAccount");
        w.record.createTx = created.hash;
        this.registry.write(w);
        const code = await node.code(address);
        if (code.toLowerCase() !== proxyRuntimeCode(implementation).toLowerCase()) {
          throw new HttpError(409, "cannot_create", `the code at ${address} is not the proxy to ${implementation}`);
        }
        const funded = await this.fund(eoa, address);
        this.log(`created ${address} (height ${height}, hotStart ${hotStart}, seed ${path.basename(seedFile)})`);
        return json(200, { address, root, epoch: 0, funded });
      });
    } catch (e) {
      throw this.toHttp(e);
    }
  }
}

/** POST /wallets' chainIds: 1 to 16 distinct ids in slot order, the devnet's among them. */
function chainList(v: unknown): bigint[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 16) throw new HttpError(400, "bad_request", "chainIds must be a list of 1 to 16 chain ids");
  const ids = v.map((x, i) => check.chainId(x, `chainIds[${i}]`));
  if (new Set(ids.map(String)).size !== ids.length) throw new HttpError(400, "bad_request", "chainIds lists a chain twice");
  if (!ids.includes(DEVNET.chainId)) throw new HttpError(400, "bad_request", `chainIds must include this devnet's chain id, ${DEVNET.chainId}`);
  return ids;
}

/** A journal record's transaction status (brief, GET /tx/:hash). */
export function statusFromJournal(r: LeafRecord): TxStatus {
  const note = r.note ?? "";
  if (r.status === "submitted") return "Submitted";
  if (r.status === "onchain") {
    if (/no receipt was readable|settled: Included/.test(note)) return "Included";
    if (/included, but|settled: Reverted/.test(note)) return "Reverted";
    return "OnChain";
  }
  if (r.status === "burned") return /expired/i.test(note) ? "Expired" : "Refused";
  return "Unknown";
}

/** The height a journal file names, or null when there is no such file (an unreadable one fails its open later). */
function journalHeight(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")).height;
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * A record's maxCostWei (decimal): ethrex's maxCost from the dry run of exactly this transaction, else the gas part of
 * laneCost over the JSON sent; null when neither is known.
 */
function maxCostOf(sim: SimulationResult | null | undefined, wire: unknown): string | null {
  if (typeof sim?.maxCost === "string") {
    try { return BigInt(sim.maxCost).toString(); } catch { /* not a number: try the JSON */ }
  }
  if (wire) {
    try { return laneCost(fromWire(wire as Parameters<typeof fromWire>[0])).gasCostWei.toString(); } catch { /* not a transaction */ }
  }
  return null;
}

/**
 * Why a wallet's seed can never sign on the chain `now`, from the pin beside its seed, or null: no pin yet (it never
 * signed), a pin of this chain, or a pin that cannot be read (the signer then says what is wrong). Read-only: unlike
 * pinOrCheckChain, it never writes a pin.
 */
export function pinnedElsewhere(w: Pick<Wallet, "record">, now: ChainIdentity): string | null {
  let pin: ChainPin;
  try { pin = JSON.parse(fs.readFileSync(pinFileFor(w.record.tree.seedFile), "utf8")) as ChainPin; } catch { return null; }
  try { checkChainPin(pin, now); } catch (e) { return e instanceof ChainChanged ? `its seed's chain pin refuses this chain: ${message(e)}` : null; }
  return null;
}

/** The pipeline's grinding as a record keeps it: each try's chain steps only (its value is the start plus its index). */
export function grindView(g: GrindInfo | null | undefined): TxGrind | null {
  return g ? { field: g.field, steps: g.steps, maxSteps: g.maxSteps, tries: g.tries.map((t) => t.steps) } : null;
}

/**
 * The spec's four gas columns of one transaction (README "Gas"; Nov 6, Vicky), in decimal gas, each null when it
 * cannot be known: nothing was sent (no JSON), or nothing was included (no receipt).
 */
export interface TxGas {
  /** the self_verify frame's limits.execution in the JSON sent: what the transaction declared for verification */
  declaredVerifyGas: string | null;
  /** the self_verify frame's execution gas: from the receipt once included, else from the node's dry run */
  verifyGas: string | null;
  /** ethrex's intrinsic gas (frameGasModel): 12,000 + 475 per frame + 6,000 per value frame + signature schemes + 4 or 16 per billed byte, signature bytes included */
  intrinsicGas: string | null;
  /** the calldata floor's side of ethrex's billing: the same mandatory part + 64 per billed byte (EIP-7976) */
  floorGas: string | null;
  /** the bytes billed: every frame's data, every signature's signer, msg and bytes, and the nonce fields' RLP */
  billedBytes: number | null;
  /** the receipt's gasUsed: what the payer was charged for, max(execution, floor) plus state */
  gasUsed: string | null;
}

export type TxView = TxRecord & { gas: TxGas };

export function gasView(r: Pick<TxRecord, "wire" | "receipt" | "simulation">): TxGas {
  const out: TxGas = { declaredVerifyGas: null, verifyGas: r.simulation?.verifyGas ?? null, intrinsicGas: null, floorGas: null, billedBytes: null, gasUsed: null };
  try { if (r.receipt?.gasUsed) out.gasUsed = BigInt(r.receipt.gasUsed).toString(); } catch { /* not a number: leave it out */ }
  if (!r.wire) return out;
  try {
    const tx = fromWire(r.wire as Parameters<typeof fromWire>[0]);
    // self_verify: the VERIFY frame that approves (flags bits 0-1); a leading expiry frame is VERIFY with scope 0
    const i = tx.frames.findIndex((f) => f.mode === FRAME_MODE.VERIFY && (f.flags & 0x3) !== 0);
    if (i >= 0) {
      out.declaredVerifyGas = tx.frames[i]!.limits.execution.toString();
      const used = r.receipt?.frameReceipts?.[i]?.gasUsed?.execution;
      if (used !== undefined) out.verifyGas = BigInt(used).toString();
    }
    const m = frameGasModel(tx);
    out.intrinsicGas = m.intrinsic.toString();
    out.floorGas = (m.mandatory + m.floor).toString();
    out.billedBytes = Number(m.bytes);
  } catch { /* not a transaction this model prices (recent-root references): the rest stays null */ }
  return out;
}

/**
 * The wallet view's `leaves` (spec, Shared interfaces 5, Nov 6), read-only, for the screens' key register: the current
 * epoch's leaves by state. Cold leaves come from the cold journal; a ticket's state from the device's own journal,
 * which alone knows which tickets signed. A ticket in none of the three lists is still on the phone; any other leaf in
 * none of them is unused. An exported leaf that no ticket file holds (a cut whose CLI failed) is burned: it is never
 * handed out. With the device journal lost, the cut is what the cold journal marked exported, its use unknown.
 */
export function leafStates(cold: LeafJournal, device: TicketDevice | null) {
  const onChain: number[] = [], burned: number[] = [], inFlight: number[] = [];
  const band = device?.band() ?? null; // [from, to)
  const put = (r: LeafRecord) => {
    if (r.status === "onchain") onChain.push(r.leaf);
    else if (r.status === "burned") burned.push(r.leaf);
    else if (r.status === "reserved" || r.status === "submitted") inFlight.push(r.leaf);
  };
  const exported: number[] = [];
  for (const r of cold.all()) {
    if (r.status !== "exported") put(r);
    else if (!device) exported.push(r.leaf); // the device journal is lost: cut, use unknown
    else if (!band || r.leaf < band.from || r.leaf >= band.to) burned.push(r.leaf); // no ticket file holds it
  }
  for (const r of device?.journal.all() ?? []) put(r);
  const tickets = band ? { from: band.from, to: band.to - 1 }
    : exported.length ? { from: Math.min(...exported), to: Math.max(...exported) } : null;
  const up = (a: number[]) => a.sort((x, y) => x - y);
  return { onChain: up(onChain), burned: up(burned), inFlight: up(inFlight), tickets };
}

/** The receipt from the node, else from the sidecar; null while none can be read. */
async function readReceipt(hash: Hex): Promise<FrameTxReceipt | null> {
  return (await node.receipt(hash).catch(() => null)) ?? (await gateway.receipt(hash).catch(() => null));
}

/** Runs f, returning null (and telling onError) when it throws. */
function attempt<T>(f: () => T, onError?: (e: unknown) => void): T | null {
  try { return f(); } catch (e) { onError?.(e); return null; }
}
