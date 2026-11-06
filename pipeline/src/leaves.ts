// The journal of exposed leaves (spec, "Package pipeline"): one file per wallet and epoch, written
// before signing, never cleared, authoritative over chain state. Once a leaf is in the journal it is
// never handed out again, whatever its status, because a second signature on a leaf leaks its key.
// Written with Claude Code (AI) for Vicky; hardened after two reviews on Nov 6:
//   - one writer per journal file: an exclusive flock(2) on the file's lock anchor, held for as long as the journal is
//     open. The kernel drops it when the process ends, however it ends, so there is never a stale lock to take over;
//     and it locks the file, not a spelling of its path, so a symlink or a different letter case cannot open a second
//     writer. Within one process every open of the same file returns the same instance. Two writers would hand out the
//     same leaf.
//   - a missing journal is never recreated silently: it would hand out leaves that may already have signed. Whether
//     the file exists is decided under the lock.
//   - writes are atomic and durable: unique temp file, full write, fsync, rename, fsync of the directory.
//   - the journal names its tree (tree seed), and no two journals in one directory may name the same tree: one
//     seed serves one account (spec), so a second account on the same tree would hand out its leaves again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dlopen, FFIType } from "bun:ffi";
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

interface JournalData {
  version: 1;
  wallet: Address;
  chainId: string;
  epoch: number;
  height: number;
  /** the tree this journal hands out leaves of; absent in journals written before Nov 6 */
  treeSeed?: Hex;
  leaves: Record<string, LeafRecord>;
}

export interface JournalIdentity { wallet: Address; chainId: bigint; epoch: number; height: number; treeSeed?: Hex }

/** Allowed moves. Nothing ever goes back, and nothing leaves the journal. */
const NEXT: Record<LeafStatus, LeafStatus[]> = {
  reserved: ["submitted", "burned"],
  submitted: ["onchain", "burned"],
  onchain: [],
  burned: [],
  exported: [],
};

/** flock(2) from the C library, loaded on first use. No platform without it may open a journal. */
let flockFn: ((fd: number, op: number) => number) | null = null;
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
function flock(fd: number, op: number): number {
  if (!flockFn) {
    const lib = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
    if (!lib) throw new Error(`no flock(2) on ${process.platform}: a journal cannot be locked here`);
    flockFn = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock as (fd: number, op: number) => number;
  }
  return flockFn(fd, op);
}
const inode = (st: fs.Stats) => `${st.dev}:${st.ino}`;

export class LeafJournal {
  /** One instance per journal file in this process, keyed by its lock anchor's inode, not by a path spelling. */
  private static readonly instances = new Map<string, LeafJournal>();
  private closed = false;

  private constructor(
    readonly file: string,
    private data: JournalData,
    private readonly lockFile: string,
    private readonly lockFd: number,
    private readonly lockInode: string,
  ) {}

  /**
   * Opens the journal of one wallet and epoch and holds its lock until close() or the end of the process. A missing
   * file is an error unless `create` is set, which only a new account (or a new epoch after rotate) may do. Refuses a
   * file written for another wallet, chain, epoch, height or tree, and a file another process holds.
   */
  static open(file: string, id: JournalIdentity, opts: { create?: boolean } = {}): LeafJournal {
    const resolved = path.resolve(file);
    const want = { wallet: id.wallet.toLowerCase() as Address, chainId: id.chainId.toString(), epoch: id.epoch, height: id.height };
    const treeSeed = id.treeSeed?.toLowerCase() as Hex | undefined;
    const checkIdentity = (data: JournalData) => {
      const have = { wallet: data.wallet, chainId: data.chainId, epoch: data.epoch, height: data.height };
      if (JSON.stringify(have) !== JSON.stringify(want)) throw new Error(`journal ${resolved} belongs to ${JSON.stringify(have)}, not ${JSON.stringify(want)}`);
      if (treeSeed && data.treeSeed && data.treeSeed !== treeSeed) throw new Error(`journal ${resolved} is for tree seed ${data.treeSeed}, not ${treeSeed}`);
    };
    const missing = () => new Error(
      `no journal at ${resolved}. A journal is created once, with its account or epoch; a missing one must not come ` +
        "back empty, because it would hand out leaves that may already have signed. Recover the file, or rotate.",
    );
    if (!opts.create && !fs.existsSync(resolved)) throw missing();

    // The lock anchor: created once, never deleted or replaced, so its inode names the journal for good.
    const lockFile = `${resolved}.lock`;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const fd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    const key = inode(fs.fstatSync(fd));
    const cached = LeafJournal.instances.get(key);
    if (cached) {
      fs.closeSync(fd); // flock belongs to the instance's own descriptor; closing this one does not release it
      checkIdentity(cached.data);
      return cached;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      let holder: { pid?: number; host?: string; at?: string } = {};
      try { holder = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { /* no details written */ }
      fs.closeSync(fd);
      throw new Error(
        `journal ${resolved} is in use by another process (pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} since ${holder.at ?? "?"}). ` +
          "One writer per journal: two would hand out the same leaf.",
      );
    }
    try {
      // Who holds it, for the message above only; the kernel lock is what counts.
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), 0);
      const exists = fs.existsSync(resolved); // decided under the lock
      if (!exists && !opts.create) throw missing();
      const data: JournalData = exists ? JSON.parse(fs.readFileSync(resolved, "utf8")) : { version: 1, ...want, ...(treeSeed ? { treeSeed } : {}), leaves: {} };
      checkIdentity(data);
      if (treeSeed) LeafJournal.refuseSecondJournalForTree(resolved, treeSeed);
      const journal = new LeafJournal(resolved, data, lockFile, fd, key);
      if (!exists) journal.persist();
      else if (treeSeed && !data.treeSeed) { data.treeSeed = treeSeed; journal.persist(); } // pre-Nov 6 journal: record its tree
      LeafJournal.instances.set(key, journal);
      return journal;
    } catch (e) {
      flock(fd, LOCK_UN);
      fs.closeSync(fd);
      throw e;
    }
  }

  /** One seed serves one account: no other journal in this directory may hand out leaves of the same tree. */
  private static refuseSecondJournalForTree(file: string, treeSeed: Hex) {
    const dir = path.dirname(file);
    for (const name of fs.readdirSync(dir)) {
      const other = path.join(dir, name);
      if (other === file || !/\.json$/.test(name)) continue;
      let seed: unknown, wallet: unknown, epoch: unknown;
      try { ({ treeSeed: seed, wallet, epoch } = JSON.parse(fs.readFileSync(other, "utf8"))); } catch { continue; } // not a journal
      if (typeof seed === "string" && seed.toLowerCase() === treeSeed) {
        throw new Error(`tree seed ${treeSeed} already has a journal, ${other} (wallet ${wallet}, epoch ${epoch}). One seed serves one account.`);
      }
    }
  }

  /** Releases the lock. The instance cannot be used afterwards; open() reads the file again. The lock anchor stays. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    LeafJournal.instances.delete(this.lockInode);
    flock(this.lockFd, LOCK_UN);
    fs.closeSync(this.lockFd);
  }

  get wallet() { return this.data.wallet; }
  get chainId() { return BigInt(this.data.chainId); }
  get epoch() { return this.data.epoch; }
  get height() { return this.data.height; }
  get treeSeed() { return this.data.treeSeed; }
  get(leaf: number): LeafRecord | undefined { return this.data.leaves[leaf]; }
  all(): LeafRecord[] { return Object.values(this.data.leaves).sort((a, b) => a.leaf - b.leaf); }

  /**
   * The lowest leaf in [from, to) this journal has never seen. It is on disk as "reserved" before
   * this returns, so a crash after signing cannot hand it out again.
   */
  reserveNext(band: { from: number; to: number }, note?: string): { leaf: number; nonceKey: bigint } {
    this.assertOpen();
    const { leaf, nonceKey } = this.peekNext(band);
    this.write(leaf, { leaf, nonceKey: toHex(nonceKey), status: "reserved", ...(note ? { note } : {}), updatedAt: new Date().toISOString() });
    return { leaf, nonceKey };
  }

  /**
   * The leaf reserveNext would hand out, without reserving it, so a caller can check its inputs first and waste no
   * leaf on a mistake. Only meaningful when nothing awaits between peekNext and reserveNext.
   */
  peekNext(band: { from: number; to: number }): { leaf: number; nonceKey: bigint } {
    this.assertOpen();
    const max = 2 ** this.data.height;
    if (!Number.isInteger(band.from) || !Number.isInteger(band.to) || band.from < 0 || band.to > max || band.from >= band.to) {
      throw new Error(`bad band [${band.from}, ${band.to}) for height ${this.data.height}`);
    }
    for (let leaf = band.from; leaf < band.to; leaf++) {
      if (this.data.leaves[leaf]) continue;
      if (this.data.epoch === 0 && leaf === 0) continue; // key 0 is the legacy nonce, see nonceKeyFor
      return { leaf, nonceKey: nonceKeyFor(this.data.epoch, leaf) };
    }
    throw new Error(`no unused leaf left in [${band.from}, ${band.to})`);
  }

  mark(leaf: number, status: LeafStatus, extra: { txHash?: Hex; deadline?: number; note?: string } = {}): void {
    this.assertOpen();
    const rec = this.data.leaves[leaf];
    if (!rec) throw new Error(`leaf ${leaf} is not in the journal`);
    if (!NEXT[rec.status].includes(status)) throw new Error(`leaf ${leaf}: ${rec.status} -> ${status} is not allowed`);
    this.write(leaf, { ...rec, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)), status, updatedAt: new Date().toISOString() });
  }

  /** Adds to a leaf's note without changing its status, e.g. "outcome unknown" on a pending transaction. */
  note(leaf: number, text: string): void {
    this.assertOpen();
    const rec = this.data.leaves[leaf];
    if (!rec) throw new Error(`leaf ${leaf} is not in the journal`);
    this.write(leaf, { ...rec, note: rec.note ? `${rec.note}; ${text}` : text, updatedAt: new Date().toISOString() });
  }

  /** Leaves handed to a hot device in a ticket file: spent from this journal's point of view. */
  markExported(from: number, to: number, note?: string): void {
    this.assertOpen();
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.leaves[leaf]) throw new Error(`leaf ${leaf} is already ${this.data.leaves[leaf]!.status}; cannot export it`);
    }
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.epoch === 0 && leaf === 0) continue;
      this.data.leaves[leaf] = { leaf, nonceKey: toHex(nonceKeyFor(this.data.epoch, leaf)), status: "exported", ...(note ? { note } : {}), updatedAt: new Date().toISOString() };
    }
    this.persist();
  }

  private assertOpen() {
    if (this.closed) throw new Error(`journal ${this.file} is closed`);
  }

  private write(leaf: number, rec: LeafRecord) {
    this.data.leaves[leaf] = rec;
    this.persist();
  }

  /** Unique temp file, full write, fsync, rename, then fsync of the directory: never a half-written or lost write. */
  private persist() {
    // If someone deleted or replaced the lock anchor, another process could now lock the new one: stop writing.
    let anchor: string | null = null;
    try { anchor = inode(fs.statSync(this.lockFile)); } catch { /* gone */ }
    if (anchor !== this.lockInode) throw new Error(`the lock file ${this.lockFile} was removed or replaced while this journal was open; stop and check for a second writer`);
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
}
