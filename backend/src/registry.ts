// The wallets the backend serves: the pipeline's hashsig deployment records in WL_DATA_DIR whose seed file exists, and
// the backend's own records in <backendDir>/wallets/. A record is written back, atomically, only to the file it came
// from (or, for a pipeline record whose file now names another account, its archive name), and only when the backend
// changes it: a rotation started, switched or dropped.
// Written with Claude Code (AI) for Vicky.
//   - `params` stay the createAccount arguments the address commits to; `tree` is the account's current tree, and
//     `epochs` every tree it has had, so each epoch's journal can be opened with its own identity.
import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { DEVNET } from "../../pipeline/src/index.ts";
import type { Deployment } from "../../pipeline/scripts/lib/wallet.ts";
import { writeJsonAtomic } from "./files.ts";

export interface TreeState { epoch: number; root: Hex; treeSeed: Hex; height: number }

/** A rotation sent but not yet seen on chain: the wallet stays on its epoch until the chain shows the new tree. */
export interface RotationState extends TreeState { txHash?: Hex; startedAt: string }

export interface WalletRecord extends Deployment {
  tree: { seedFile: string; generation: number; height: number; chains: string[]; root?: Hex; treeSeed?: Hex };
  epochs?: TreeState[];
  rotation?: RotationState;
  createdBy?: "backend";
  createTx?: Hex;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface Wallet {
  /** checksummed */
  address: Address;
  /** the record file it came from and is written back to */
  file: string;
  source: "pipeline" | "backend";
  record: WalletRecord;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** The account's current tree: `tree` names it after a rotation; before one, the creation arguments do. */
export function currentTree(r: WalletRecord): TreeState {
  return {
    epoch: r.tree.generation,
    height: r.tree.height,
    root: (r.tree.root ?? r.params.root).toLowerCase() as Hex,
    treeSeed: (r.tree.treeSeed ?? r.params.treeSeed).toLowerCase() as Hex,
  };
}

/** Every tree the account has had, oldest first. */
export function epochsOf(r: WalletRecord): TreeState[] {
  return r.epochs?.length ? r.epochs.map((e) => ({ ...e, root: e.root.toLowerCase() as Hex, treeSeed: e.treeSeed.toLowerCase() as Hex })) : [currentTree(r)];
}

export const chainsOf = (r: WalletRecord): bigint[] => r.tree.chains.map((c) => BigInt(c));

/** Why a record cannot be served, or null. */
function unusable(r: any): string | null {
  if (!r || typeof r !== "object") return "not an object";
  if (r.verifier !== "hashsig") return `verifier ${r.verifier}`;
  if (String(r.chainId) !== DEVNET.chainId.toString()) return `chain ${r.chainId}`;
  if (typeof r.account !== "string" || !isAddress(r.account, { strict: false })) return "no account address";
  const t = r.tree;
  if (!t || typeof t.seedFile !== "string" || !Number.isInteger(t.generation) || !Number.isInteger(t.height) || !Array.isArray(t.chains)) return "no tree";
  if (!t.chains.map(String).includes(DEVNET.chainId.toString())) return "its tree does not list this chain";
  if (!r.params || !HEX32.test(String(r.params.root)) || !HEX32.test(String(r.params.treeSeed))) return "no root or tree seed";
  if (!fs.existsSync(t.seedFile)) return "its seed file does not exist";
  return null;
}

export class Registry {
  private wallets = new Map<string, Wallet>();

  constructor(private readonly dataDir: string, readonly walletsDir: string, private readonly log: (line: string) => void) {}

  /** Reads every record again; wallets already known keep the record this process holds (it may be newer). */
  load(): void {
    const files: { file: string; source: Wallet["source"] }[] = [];
    const chain = DEVNET.chainId.toString();
    const pipelineName = new RegExp(`^deployment-${chain}(\\.0x[0-9a-fA-F]{40})?\\.json$`);
    if (fs.existsSync(this.dataDir)) {
      for (const n of fs.readdirSync(this.dataDir).sort()) if (pipelineName.test(n)) files.push({ file: path.join(this.dataDir, n), source: "pipeline" });
    }
    if (fs.existsSync(this.walletsDir)) {
      for (const n of fs.readdirSync(this.walletsDir).sort()) if (/^0x[0-9a-f]{40}\.json$/.test(n)) files.push({ file: path.join(this.walletsDir, n), source: "backend" });
    }
    for (const { file, source } of files) {
      let record: any;
      try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.log(`registry: ${file} is not JSON; skipped`); continue; }
      const why = unusable(record);
      if (why) { if (record?.verifier !== "placeholder") this.log(`registry: ${path.basename(file)} skipped (${why})`); continue; }
      const key = record.account.toLowerCase();
      const known = this.wallets.get(key);
      if (known) {
        if (known.file !== file) this.log(`registry: ${path.basename(file)} names ${record.account}, already served from ${known.file}; skipped`);
        continue;
      }
      this.wallets.set(key, { address: getAddress(record.account), file, source, record });
    }
  }

  list(): Wallet[] { return [...this.wallets.values()]; }
  get(address: string): Wallet | undefined { return this.wallets.get(address.toLowerCase()); }

  /** The pipeline's current deployment record, whose implementation and factory new wallets use. */
  pipelineDeployment(): (Deployment & { implementationCodeHash?: Hex }) | null {
    const file = path.join(this.dataDir, `deployment-${DEVNET.chainId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  /** The wallet whose record or history names this tree seed, if any. */
  usingTree(treeSeed: Hex): Wallet | undefined {
    const want = treeSeed.toLowerCase();
    return this.list().find((w) =>
      [w.record.params.treeSeed, w.record.tree.treeSeed, ...epochsOf(w.record).map((e) => e.treeSeed), w.record.rotation?.treeSeed]
        .some((s) => typeof s === "string" && s.toLowerCase() === want));
  }

  /** A new backend wallet, not yet written: its journal is created first, then add() writes the record. */
  draft(record: WalletRecord): Wallet {
    const address = getAddress(record.account);
    return { address, file: path.join(this.walletsDir, `${address.toLowerCase()}.json`), source: "backend", record };
  }

  add(w: Wallet): Wallet {
    if (this.wallets.has(w.address.toLowerCase())) throw new Error(`${w.address} is already a wallet`);
    this.write(w);
    this.wallets.set(w.address.toLowerCase(), w);
    return w;
  }

  /**
   * Back to the file it came from, atomically, keeping that file's mode. A pipeline record's file is read again first:
   * once it no longer names this account (deploy-account.ts made a new one), the record goes to the pipeline's archive
   * name deployment-<chain>.<account>.json, and the current file is left alone (review, Nov 6).
   */
  write(w: Wallet): void {
    if (w.source === "pipeline") {
      const names = (f: string) => { try { return String(JSON.parse(fs.readFileSync(f, "utf8")).account).toLowerCase(); } catch { return null; } };
      const now = names(w.file);
      if (now !== w.address.toLowerCase()) {
        const archive = path.join(path.dirname(w.file), `deployment-${DEVNET.chainId}.${w.address.toLowerCase()}.json`);
        const there = names(archive);
        if (fs.existsSync(archive) && there !== w.address.toLowerCase()) throw new Error(`${archive} names ${there}, not ${w.address}: the record of ${w.address} is not written over it`);
        this.log(`registry: ${path.basename(w.file)} now names ${now ?? "no readable account"}; the record of ${w.address} goes to ${path.basename(archive)}`);
        w.file = archive;
      }
    }
    w.record.updatedAt = new Date().toISOString();
    const mode = fs.existsSync(w.file) ? fs.statSync(w.file).mode & 0o777 : 0o600;
    writeJsonAtomic(w.file, w.record, mode);
  }
}
