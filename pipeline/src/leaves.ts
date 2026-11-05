// The journal of exposed leaves (spec, "Package pipeline"): one file per wallet and epoch, written
// before signing, never cleared, authoritative over chain state. Once a leaf is in the journal it is
// never handed out again, whatever its status, because a second signature on a leaf leaks its key.
import fs from "node:fs";
import path from "node:path";
import { toHex, type Address, type Hex } from "viem";
import { nonceKeyFor } from "./builder.ts";

export type LeafStatus = "reserved" | "submitted" | "onchain" | "burned" | "exported";

export interface LeafRecord {
  leaf: number;
  nonceKey: Hex;
  status: LeafStatus;
  txHash?: Hex;
  note?: string;
  updatedAt: string;
}

interface JournalData {
  version: 1;
  wallet: Address;
  chainId: string;
  epoch: number;
  height: number;
  leaves: Record<string, LeafRecord>;
}

export interface JournalIdentity { wallet: Address; chainId: bigint; epoch: number; height: number }

/** Allowed moves. Nothing ever goes back, and nothing leaves the journal. */
const NEXT: Record<LeafStatus, LeafStatus[]> = {
  reserved: ["submitted", "burned"],
  submitted: ["onchain", "burned"],
  onchain: [],
  burned: [],
  exported: [],
};

export class LeafJournal {
  private constructor(readonly file: string, private data: JournalData) {}

  /** Opens the journal, or creates it. Refuses a file written for another wallet, chain, epoch or height. */
  static open(file: string, id: JournalIdentity): LeafJournal {
    const want = { wallet: id.wallet.toLowerCase() as Address, chainId: id.chainId.toString(), epoch: id.epoch, height: id.height };
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as JournalData;
      const have = { wallet: data.wallet, chainId: data.chainId, epoch: data.epoch, height: data.height };
      if (JSON.stringify(have) !== JSON.stringify(want)) {
        throw new Error(`journal ${file} belongs to ${JSON.stringify(have)}, not ${JSON.stringify(want)}`);
      }
      return new LeafJournal(file, data);
    }
    const journal = new LeafJournal(file, { version: 1, ...want, leaves: {} });
    journal.persist();
    return journal;
  }

  get epoch() { return this.data.epoch; }
  get height() { return this.data.height; }
  get(leaf: number): LeafRecord | undefined { return this.data.leaves[leaf]; }
  all(): LeafRecord[] { return Object.values(this.data.leaves).sort((a, b) => a.leaf - b.leaf); }

  /**
   * The lowest leaf in [from, to) this journal has never seen. It is on disk as "reserved" before
   * this returns, so a crash after signing cannot hand it out again.
   */
  reserveNext(band: { from: number; to: number }, note?: string): { leaf: number; nonceKey: bigint } {
    const max = 2 ** this.data.height;
    if (band.from < 0 || band.to > max || band.from >= band.to) throw new Error(`bad band [${band.from}, ${band.to}) for height ${this.data.height}`);
    for (let leaf = band.from; leaf < band.to; leaf++) {
      if (this.data.leaves[leaf]) continue;
      if (this.data.epoch === 0 && leaf === 0) continue; // key 0 is the legacy nonce, see nonceKeyFor
      const nonceKey = nonceKeyFor(this.data.epoch, leaf);
      this.write(leaf, { leaf, nonceKey: toHex(nonceKey), status: "reserved", note, updatedAt: new Date().toISOString() });
      return { leaf, nonceKey };
    }
    throw new Error(`no unused leaf left in [${band.from}, ${band.to})`);
  }

  mark(leaf: number, status: LeafStatus, extra: { txHash?: Hex; note?: string } = {}): void {
    const rec = this.data.leaves[leaf];
    if (!rec) throw new Error(`leaf ${leaf} is not in the journal`);
    if (!NEXT[rec.status].includes(status)) throw new Error(`leaf ${leaf}: ${rec.status} -> ${status} is not allowed`);
    this.write(leaf, { ...rec, ...extra, status, updatedAt: new Date().toISOString() });
  }

  /** Leaves handed to a hot device in a ticket file: spent from this journal's point of view. */
  markExported(from: number, to: number, note?: string): void {
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.leaves[leaf]) throw new Error(`leaf ${leaf} is already ${this.data.leaves[leaf]!.status}; cannot export it`);
    }
    for (let leaf = from; leaf < to; leaf++) {
      if (this.data.epoch === 0 && leaf === 0) continue;
      this.data.leaves[leaf] = { leaf, nonceKey: toHex(nonceKeyFor(this.data.epoch, leaf)), status: "exported", note, updatedAt: new Date().toISOString() };
    }
    this.persist();
  }

  private write(leaf: number, rec: LeafRecord) {
    this.data.leaves[leaf] = rec;
    this.persist();
  }

  /** Write to a temp file, flush it to disk, then rename over the journal: never a half-written file. */
  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
