// The journal of exposed leaves as an interface (Nov 6, for browsers and Snaps), and MemoryJournal, a journal held in
// memory that saves through a store the host provides (a Snap's snap_manageState, a browser's IndexedDB).
// Written with Claude Code (AI) for Vicky.
//
// What every journal must guarantee, because a second signature on a leaf leaks its key (spec, "Package pipeline"):
//   1. Once a leaf is in the journal it is never handed out again, whatever its status; leaf 0 at epoch 0 is never
//      handed out (nonce key 0 is the legacy nonce).
//   2. A reservation is stored before the leaf signs, and a transaction's hash and deadline before it is sent. A
//      journal that stores synchronously (LeafJournal: write, fsync, rename) has no durable(); one that stores later
//      (snap_manageState is async) has durable(), and sendKeyed and estimateCalls wait for it at both points.
//   3. A missing journal is never recreated empty: it would hand out leaves that may already have signed. Only a new
//      account, or a new epoch after rotate, creates one.
//   4. One writer: two writers would hand out the same leaf. LeafJournal holds a flock; a Snap keeps exactly one
//      MemoryJournal per journal for its whole life (not one per request) and handles requests that use it one at a
//      time or through that one instance; a browser host holds a navigator.locks lock across tabs. MemoryJournal
//      numbers its snapshots (seq), so a store can refuse a save that is not newer than the one it holds.
//   5. Statuses only move forward (ALLOWED_MOVES), and nothing leaves the journal.
//   6. A restore from an older snapshot or backup reopens every leaf that signed after it: like a seed restore
//      (spec, rotate), it needs a rotation before the next signature.
// LeafJournal (leaves.ts, Bun only: it locks with bun:ffi) also refuses a second journal on the same tree in one directory; a Snap that
// holds several accounts must refuse the same (one seed serves one account).
import { toHex, type Address, type Hex } from "viem";
import { nonceKeyFor } from "./builder.ts";

export type LeafStatus = "reserved" | "submitted" | "onchain" | "burned" | "exported";

export interface LeafRecord {
  leaf: number;
  nonceKey: Hex;
  status: LeafStatus;
  txHash?: Hex;
  /** the expiry frame's deadline, so a pending transaction can be followed to its end after a crash */
  deadline?: number;
  note?: string;
  updatedAt: string;
}

export interface JournalIdentity { wallet: Address; chainId: bigint; epoch: number; height: number; treeSeed?: Hex }

/** Allowed moves. Nothing ever goes back, and nothing leaves the journal. */
export const ALLOWED_MOVES: Readonly<Record<LeafStatus, readonly LeafStatus[]>> = Object.freeze({
  reserved: Object.freeze(["submitted", "burned"] as const),
  submitted: Object.freeze(["onchain", "burned"] as const),
  onchain: Object.freeze([] as const),
  burned: Object.freeze([] as const),
  exported: Object.freeze([] as const),
});

/** What the send path needs from a journal. LeafJournal (Node) and MemoryJournal implement it. */
export interface Journal {
  /** where it lives, for messages: a file path, or a label */
  readonly file: string;
  /** lowercase */
  readonly wallet: Address;
  readonly chainId: bigint;
  readonly epoch: number;
  readonly height: number;
  /** the tree this journal hands out leaves of (lowercase); absent in journals written before Nov 6 */
  readonly treeSeed: Hex | undefined;
  get(leaf: number): LeafRecord | undefined;
  all(): LeafRecord[];
  /** The leaf reserveNext would hand out, without reserving it. Only meaningful with no await before reserveNext. */
  peekNext(band: { from: number; to: number }): { leaf: number; nonceKey: bigint };
  /** The lowest leaf in [from, to) never seen, now "reserved". Throws "no unused leaf left in [from, to)" when none is left. */
  reserveNext(band: { from: number; to: number }, note?: string): { leaf: number; nonceKey: bigint };
  mark(leaf: number, status: LeafStatus, extra?: { txHash?: Hex; deadline?: number; note?: string }): void;
  note(leaf: number, text: string): void;
  /** Leaves handed to a hot device in a ticket file: spent from this journal's point of view. */
  markExported(from: number, to: number, note?: string): void;
  /**
   * Resolves once every write made so far is stored, rejects if one could not be. Only a journal that stores after
   * its methods return has it; the send path waits for it before a leaf signs and before a transaction is sent.
   */
  durable?(): Promise<void>;
}

/** A journal as stored: the same shape as LeafJournal's file. */
export interface JournalSnapshot {
  version: 1;
  wallet: Address;
  chainId: string;
  epoch: number;
  height: number;
  treeSeed?: Hex;
  leaves: Record<string, LeafRecord>;
  /** MemoryJournal only: 1 more on every save, so a store can refuse a save that is not newer than what it holds */
  seq?: number;
}

/**
 * Where a MemoryJournal stores itself. save gets every snapshot in write order; a resolved save means stored, and
 * any rejection (whatever its reason, even none) means not stored.
 */
export interface JournalStore { save(snapshot: JournalSnapshot): void | Promise<void> }

/** The first leaf in the band the journal has never seen (rule 1). Shared by LeafJournal and MemoryJournal. */
export function firstUnseenLeaf(data: JournalSnapshot, band: { from: number; to: number }): { leaf: number; nonceKey: bigint } {
  const max = 2 ** data.height;
  if (!Number.isInteger(band.from) || !Number.isInteger(band.to) || band.from < 0 || band.to > max || band.from >= band.to) {
    throw new Error(`bad band [${band.from}, ${band.to}) for height ${data.height}`);
  }
  for (let leaf = band.from; leaf < band.to; leaf++) {
    if (data.leaves[leaf]) continue;
    if (data.epoch === 0 && leaf === 0) continue; // key 0 is the legacy nonce, see nonceKeyFor
    return { leaf, nonceKey: nonceKeyFor(data.epoch, leaf) };
  }
  throw new Error(`no unused leaf left in [${band.from}, ${band.to})`);
}

const copy = (s: JournalSnapshot): JournalSnapshot => JSON.parse(JSON.stringify(s));

/**
 * A journal in memory that saves every change through a JournalStore, in order. Its methods change the memory copy at
 * once, so two sends in one realm can never take the same leaf, and durable() says when the store has caught up.
 * After a failed save it hands out no more leaves and durable() keeps rejecting: memory and store no longer agree.
 */
export class MemoryJournal implements Journal {
  private saved: Promise<void> = Promise.resolve();
  /** set once a save failed; sticky. A flag, because a store may reject with a falsy reason (review, Nov 6) */
  private failed = false;
  private failure: unknown = null;

  private constructor(readonly file: string, private readonly data: JournalSnapshot, private readonly store: JournalStore | null) {}

  /**
   * Opens the journal of one wallet and epoch from what the store last saved. `stored` null means none was found: an
   * error unless `create` is set, which only a new account (or a new epoch after rotate) may do (rule 3); with
   * `create`, a stored journal is opened as it is, like LeafJournal.open. Refuses a snapshot of another wallet, chain,
   * epoch, height or tree. A store is required: a journal held only in memory is lost with the page or the Snap, and the
   * next one would come back empty (rule 3); `ephemeral: true` allows that for throwaway seeds only. A new journal must
   * name its tree (id.treeSeed), so the send path can check every signer against it.
   */
  static open(
    stored: JournalSnapshot | null,
    id: JournalIdentity,
    opts: { create?: boolean; store?: JournalStore; ephemeral?: boolean; label?: string } = {},
  ): MemoryJournal {
    const label = opts.label ?? `memory journal of ${id.wallet.toLowerCase()}, epoch ${id.epoch}`;
    const want = { wallet: id.wallet.toLowerCase() as Address, chainId: id.chainId.toString(), epoch: id.epoch, height: id.height };
    const treeSeed = id.treeSeed?.toLowerCase() as Hex | undefined;
    if (!opts.store && !opts.ephemeral) throw new Error(`${label}: no store. Pass one, or ephemeral: true for a throwaway seed whose leaves never matter again`);
    if (!stored && opts.create && !treeSeed) throw new Error(`${label}: a new journal must name its tree (treeSeed)`);
    if (!stored && !opts.create) {
      throw new Error(
        `no stored journal for ${label}. A journal is created once, with its account or epoch; a missing one must not come ` +
          "back empty, because it would hand out leaves that may already have signed. Recover it, or rotate.",
      );
    }
    const data: JournalSnapshot = stored ? copy(stored) : { version: 1, ...want, ...(treeSeed ? { treeSeed } : {}), leaves: {}, seq: 0 };
    // stored with another letter case, it would open here and then fail every check of the send path
    if (typeof data.wallet === "string") data.wallet = data.wallet.toLowerCase() as Address;
    if (typeof data.treeSeed === "string") data.treeSeed = data.treeSeed.toLowerCase() as Hex;
    const have = { wallet: data.wallet, chainId: data.chainId, epoch: data.epoch, height: data.height };
    if (data.version !== 1 || JSON.stringify(have) !== JSON.stringify(want)) throw new Error(`${label}: the stored journal belongs to ${JSON.stringify(have)}, not ${JSON.stringify(want)}`);
    if (treeSeed && data.treeSeed && data.treeSeed !== treeSeed) throw new Error(`${label}: the stored journal is for tree seed ${data.treeSeed}, not ${treeSeed}`);
    if (treeSeed && !data.treeSeed) data.treeSeed = treeSeed;
    const journal = new MemoryJournal(label, data, opts.store ?? null);
    if (!stored || data.treeSeed !== stored.treeSeed || data.wallet !== stored.wallet) journal.save();
    return journal;
  }

  get wallet() { return this.data.wallet; }
  get chainId() { return BigInt(this.data.chainId); }
  get epoch() { return this.data.epoch; }
  get height() { return this.data.height; }
  get treeSeed() { return this.data.treeSeed; }
  get(leaf: number): LeafRecord | undefined { return this.data.leaves[leaf]; }
  all(): LeafRecord[] { return Object.values(this.data.leaves).sort((a, b) => a.leaf - b.leaf); }
  /** A copy of the journal as it is now, e.g. to show. Restoring an older copy needs a rotation first (rule 6). */
  snapshot(): JournalSnapshot { return copy(this.data); }

  peekNext(band: { from: number; to: number }): { leaf: number; nonceKey: bigint } {
    this.assertHealthy();
    return firstUnseenLeaf(this.data, band);
  }

  reserveNext(band: { from: number; to: number }, note?: string): { leaf: number; nonceKey: bigint } {
    const { leaf, nonceKey } = this.peekNext(band);
    this.write(leaf, { leaf, nonceKey: toHex(nonceKey), status: "reserved", ...(note ? { note } : {}), updatedAt: new Date().toISOString() });
    return { leaf, nonceKey };
  }

  mark(leaf: number, status: LeafStatus, extra: { txHash?: Hex; deadline?: number; note?: string } = {}): void {
    const rec = this.data.leaves[leaf];
    if (!rec) throw new Error(`leaf ${leaf} is not in the journal`);
    if (!ALLOWED_MOVES[rec.status].includes(status)) throw new Error(`leaf ${leaf}: ${rec.status} -> ${status} is not allowed`);
    this.write(leaf, { ...rec, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)), status, updatedAt: new Date().toISOString() });
  }

  note(leaf: number, text: string): void {
    const rec = this.data.leaves[leaf];
    if (!rec) throw new Error(`leaf ${leaf} is not in the journal`);
    this.write(leaf, { ...rec, note: rec.note ? `${rec.note}; ${text}` : text, updatedAt: new Date().toISOString() });
  }

  markExported(from: number, to: number, note?: string): void {
    this.assertHealthy();
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.leaves[leaf]) throw new Error(`leaf ${leaf} is already ${this.data.leaves[leaf]!.status}; cannot export it`);
    }
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.epoch === 0 && leaf === 0) continue;
      this.data.leaves[leaf] = { leaf, nonceKey: toHex(nonceKeyFor(this.data.epoch, leaf)), status: "exported", ...(note ? { note } : {}), updatedAt: new Date().toISOString() };
    }
    this.save();
  }

  durable(): Promise<void> {
    return this.saved.then(() => {
      if (this.failed) throw new Error(`${this.file} could not be stored: ${this.reason()}`);
    });
  }

  private reason() {
    return this.failure instanceof Error ? this.failure.message : this.failure === undefined || this.failure === null || this.failure === "" ? "the store rejected without a reason" : String(this.failure);
  }

  /** No new leaf once memory and store disagree: a leaf handed out now could be handed out again after a restart. */
  private assertHealthy() {
    if (this.failed) throw new Error(`${this.file} could not be stored, so it hands out no more leaves: ${this.reason()}`);
  }

  private write(leaf: number, rec: LeafRecord) {
    this.data.leaves[leaf] = rec;
    this.save();
  }

  /** Queues the snapshot as it is now; saves run one after another, in write order. */
  private save() {
    if (!this.store) return;
    this.data.seq = (this.data.seq ?? 0) + 1;
    const snapshot = copy(this.data);
    const store = this.store;
    this.saved = this.saved.then(async () => {
      if (this.failed) return; // the store is behind for good; later writes stay in memory only
      try { await store.save(snapshot); } catch (e) { this.failed = true; this.failure = e; }
    });
  }
}
