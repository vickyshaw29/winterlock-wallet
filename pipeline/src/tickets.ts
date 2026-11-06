// Hot tickets (spec, "Hot and cold wallet"; plan, interface 6): the cold side cuts a contiguous range of hot leaves
// into a ticket file with the Rust CLI, and the hot side signs from its ticket files, each leaf through its own journal.
// Written with Claude Code (AI) for Vicky.
//   - a cut is marked exported in the cold journal before the CLI writes the file: if the CLI then fails, those leaves
//     are wasted, never handed out twice.
//   - cuts are contiguous: each starts where the device's band ends; the epoch's first starts at the lowest hot leaf
//     the cold journal has never seen (cutStart), and every leaf of a cut must be free.
//   - a ticket file holds secrets. It is read here only to check its public fields and its shape; the secrets are never
//     kept, logged or put in an error, and the seed only ever reaches the CLI as --seed-file.
//   - ticket files live in their own directory, never beside a journal: they carry a top-level treeSeed, and a journal
//     refuses to open beside another file naming its tree (leaves.ts, refuseSecondJournalForTree).
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { LeafJournal } from "./leaves.ts";
import { HashSignerError, type HashSigner } from "./signer.ts";

export const TICKET_VERSION = 1;
const WORD = /^0x[0-9a-f]{64}$/;
const CHAINS = 67;
const TICKET_NAME = /^epoch(\d+)-(\d+)-(\d+)\.json$/;

/** File name of the cut [from, to] of one generation; `to` is inclusive, as export-leaves takes it. */
export const ticketFileName = (generation: number, from: number, to: number) => `epoch${generation}-${from}-${to}.json`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "error";

/** The public part of a ticket file. */
export interface TicketInfo {
  file: string;
  treeSeed: Hex;
  root: Hex;
  height: number;
  generation: number;
  chainId: bigint;
  slot: number;
  /** the leaves the file holds, in file order */
  leaves: number[];
}

/**
 * Checks a ticket file's shape and returns its public fields. Error messages never quote the file: a malformed file
 * could put a secret anywhere, and a JSON parser's own message can quote its input.
 */
export function readTicketInfo(file: string): TicketInfo {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`cannot read ticket file ${file}: ${errno(e)}`); }
  let t: any;
  try { t = JSON.parse(text); } catch { throw new Error(`ticket file ${file} is not JSON`); }
  const bad = (what: string) => new Error(`ticket file ${file}: ${what}`);
  const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
  if (!t || typeof t !== "object") throw bad("not an object");
  if (t.version !== TICKET_VERSION) throw bad(`not ticket file version ${TICKET_VERSION}`);
  const height = int(t.height, 1, 28), generation = int(t.generation, 0, 0xffff_ffff), slot = int(t.slot, 0, 15);
  if (height === null) throw bad("bad height");
  if (generation === null) throw bad("bad generation");
  if (slot === null) throw bad("bad slot");
  if (int(t.chainId, 1, Number.MAX_SAFE_INTEGER) === null) throw bad("bad chainId");
  if (typeof t.treeSeed !== "string" || !WORD.test(t.treeSeed)) throw bad("bad treeSeed");
  if (typeof t.root !== "string" || !WORD.test(t.root)) throw bad("bad root");
  if (!Array.isArray(t.leaves) || t.leaves.length === 0) throw bad("no leaves");
  const words = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((w) => typeof w === "string" && WORD.test(w));
  const leaves: number[] = [];
  for (const l of t.leaves) {
    const leaf = l && typeof l === "object" ? int(l.leaf, 0, 2 ** height - 1) : null;
    if (leaf === null) throw bad("a leaf outside the tree");
    if (!words(l.secrets, CHAINS) || !words(l.authPath, height + 4)) throw bad(`leaf ${leaf} does not have ${CHAINS} secrets and ${height + 4} path nodes`);
    leaves.push(leaf);
  }
  return { file, treeSeed: t.treeSeed, root: t.root, height, generation, chainId: BigInt(t.chainId), slot, leaves };
}

/** The CLI's environment never carries a seed: the cold side passes --seed-file, the hot side has none. */
function cliEnv() {
  const env = { ...process.env };
  delete env.PQ_SEED;
  return env;
}

/**
 * Throws a HashSignerError unless the CLI exists and runs (`--help` exits 0). Checked before a ticket is reserved, so a
 * missing or broken CLI burns no ticket (review, Nov 6).
 */
export async function checkCli(bin: string): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "--help"], { env: cliEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    throw new HashSignerError("cli_missing", `cannot run ${bin}: ${errno(e)}`);
  }
  const code = await proc.exited;
  if (code !== 0) throw new HashSignerError("cli_broken", `${bin} --help exited with ${code}`);
}

/** Runs the hashsig CLI: its JSON on success, its {error, detail} object as a HashSignerError otherwise. */
async function runCli(bin: string, args: string[]): Promise<any> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { env: cliEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new HashSignerError("cli_missing", `cannot run ${bin}: ${errno(e)}`);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited,
  ]);
  if (code !== 0) {
    let parsed: { error?: unknown; detail?: unknown } = {};
    try { parsed = JSON.parse(err); } catch { /* not the CLI's error object */ }
    if (typeof parsed.error === "string") throw new HashSignerError(parsed.error, typeof parsed.detail === "string" ? parsed.detail : "");
    // Anything else on stderr is not ours to repeat.
    throw new HashSignerError(`exit_${code}`, "the CLI failed without its JSON error object");
  }
  try { return JSON.parse(out); } catch { throw new HashSignerError("bad_output", "the CLI printed something that is not JSON"); }
}

/**
 * Signs from one ticket file with the CLI (`sign --ticket-file`). Its tree comes from the file's public fields, so
 * sendKeyed checks it against the journal before any leaf is used. The secrets stay in the file.
 */
export function cliTicketSigner(opts: { bin: string; ticketFile: string }): HashSigner {
  const info = readTicketInfo(opts.ticketFile);
  return {
    height: info.height, generation: info.generation, treeSeed: info.treeSeed,
    async sign({ chainId, leaf, msg }) {
      const res = await runCli(opts.bin, ["sign", "--ticket-file", opts.ticketFile, "--chain-id", String(chainId), "--leaf", String(leaf), "--msg", msg]);
      if (res?.leaf !== leaf) throw new HashSignerError("leaf_mismatch", `asked for leaf ${leaf}, the CLI signed ${JSON.stringify(res?.leaf)}`);
      if (typeof res.entry !== "string" || !/^0x([0-9a-f]{2})+$/.test(res.entry)) throw new HashSignerError("bad_output", "the CLI returned no entry");
      return res.entry as Hex;
    },
  };
}

export interface ExportParams {
  bin: string;
  seedFile: string;
  coldJournal: LeafJournal;
  /** the tree the cold journal hands out leaves of; the file's root is checked against `root` */
  tree: { height: number; generation: number; chains: bigint[]; root: Hex };
  chainId: bigint;
  /** the account's hotStart: no leaf below it is exported, because cold leaves have no caps */
  hotStart: number;
  from: number;
  count: number;
  /** the hot device's ticket directory, which must not hold any journal */
  ticketsDir: string;
}

export interface ExportResult { file: string; from: number; to: number; count: number; slot: number }

/**
 * Where the next cut starts. A later cut stays contiguous with the device's band: it starts where the band ends. The
 * epoch's first cut (no band yet) starts at the lowest leaf at or above hotStart that the cold journal has never seen,
 * so an account whose hot leaf was signed directly by a script (pipeline/scripts/hashsig-devnet.ts signs one at
 * hotStart) can still cut tickets. Every leaf of the cut must still be free: exportTickets refuses the cut otherwise.
 * Null when no leaf from hotStart to the tree's last is free.
 */
export function cutStart(p: { coldJournal: LeafJournal; hotStart: number; band: { from: number; to: number } | null }): number | null {
  if (p.band) return p.band.to;
  for (let leaf = Math.max(0, p.hotStart); leaf < 2 ** p.coldJournal.height; leaf++) if (!p.coldJournal.get(leaf)) return leaf;
  return null;
}

/**
 * Cuts `count` tickets starting at `from`: every check that needs no leaf first, then the leaves marked exported in
 * the cold journal, then `export-leaves`, then the file checked against the tree. The caller chooses `from` with
 * cutStart: where the device's band ends, or for the epoch's first cut the lowest free leaf at or above hotStart.
 */
export async function exportTickets(p: ExportParams): Promise<ExportResult> {
  const j = p.coldJournal;
  const fail = (why: string): never => { throw new Error(`no tickets cut: ${why}`); };
  if (!Number.isInteger(p.count) || p.count < 1) fail(`count must be a whole number of at least 1, got ${p.count}`);
  if (!Number.isInteger(p.from) || p.from < 0) fail(`from must be a leaf index, got ${p.from}`);
  const to = p.from + p.count - 1; // export-leaves exports [from, to]; markExported takes [from, to + 1)
  if (j.epoch !== p.tree.generation || j.height !== p.tree.height) {
    fail(`the cold journal is for epoch ${j.epoch} and height ${j.height}, not generation ${p.tree.generation} and height ${p.tree.height}`);
  }
  if (j.chainId !== p.chainId) fail(`the cold journal is for chain ${j.chainId}, not ${p.chainId}`);
  if (!j.treeSeed) fail(`the cold journal ${j.file} names no tree`);
  if (!p.tree.chains.includes(p.chainId)) fail(`chain ${p.chainId} is not in the tree's chain list`);
  if (!Number.isInteger(p.hotStart) || p.hotStart < 1) fail(`bad hotStart ${p.hotStart}`);
  if (p.from < p.hotStart) fail(`leaf ${p.from} is below hotStart ${p.hotStart}: cold leaves have no caps`);
  if (to >= 2 ** p.tree.height) fail(`leaves ${p.from}..${to} run past the tree's last leaf, ${2 ** p.tree.height - 1}`);
  for (let leaf = p.from; leaf <= to; leaf++) {
    const rec = j.get(leaf);
    if (rec) fail(`leaf ${leaf} is already ${rec.status} in the cold journal`);
  }
  const dir = path.resolve(p.ticketsDir);
  if (dir === path.dirname(path.resolve(j.file))) fail(`${dir} holds the cold journal: ticket files need their own directory`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(dir).some((n) => /journal-epoch\d+\.json$/.test(n))) fail(`${dir} holds a journal: ticket files need their own directory`);
  const file = path.join(dir, ticketFileName(p.tree.generation, p.from, to));
  if (fs.existsSync(file)) fail(`${file} already exists`);
  try { fs.accessSync(p.bin, fs.constants.X_OK); } catch { fail(`the signer CLI ${p.bin} is missing or not executable`); }
  if (!fs.existsSync(p.seedFile)) fail(`the seed file ${p.seedFile} is missing`);

  // Spent from here on, before the secrets exist anywhere else.
  j.markExported(p.from, to + 1, `ticket file ${path.basename(file)}`);
  try {
    const out = await runCli(p.bin, [
      "export-leaves", "--seed-file", p.seedFile, "--height", String(p.tree.height), "--generation", String(p.tree.generation),
      "--chains", p.tree.chains.join(","), "--chain-id", String(p.chainId), "--from", String(p.from), "--to", String(to),
      "--hot-start", String(p.hotStart), "--out", file,
    ]);
    if (out?.count !== p.count) throw new Error(`the CLI reports ${JSON.stringify(out?.count)} leaves, not ${p.count}`);
    const info = readTicketInfo(file);
    if (info.treeSeed !== j.treeSeed) throw new Error("the file's tree seed is not the cold journal's");
    if (info.root !== p.tree.root.toLowerCase()) throw new Error(`the file's root is not ${p.tree.root}`);
    if (info.height !== p.tree.height || info.generation !== p.tree.generation || info.chainId !== p.chainId) {
      throw new Error("the file's height, generation or chain is not this tree's");
    }
    if (info.leaves.length !== p.count || info.leaves.some((l, i) => l !== p.from + i)) throw new Error(`the file holds leaves other than ${p.from}..${to}`);
    fs.chmodSync(file, 0o600); // the CLI narrows it after creating it; make sure
    return { file, from: p.from, to, count: p.count, slot: info.slot };
  } catch (e) {
    // A file that failed its checks must never be signed from.
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to remove */ }
    throw new Error(`ticket cut failed after leaves ${p.from}..${to} were marked exported in the cold journal; they are wasted, never reused: ${message(e)}`, { cause: e });
  }
}

export interface DeviceParams {
  /** the hot device's own directory: its journal here, its ticket files in tickets/; never a cold journal's directory */
  dir: string;
  wallet: Address;
  chainId: bigint;
  epoch: number;
  height: number;
  treeSeed: Hex;
  /**
   * create the device journal if it is missing: the first cut of an epoch only. Refused when ticket files of the epoch
   * exist: they were cut, maybe signed, and only their lost journal knew which (review, Nov 6).
   */
  create?: boolean;
}

/** The ticket files of one epoch in a tickets/ directory, by name, with the leaves [from, to] each holds. */
export function ticketFilesOf(ticketsDir: string, epoch: number): { name: string; from: number; to: number }[] {
  const names = fs.existsSync(ticketsDir) ? fs.readdirSync(ticketsDir).sort() : [];
  return names.flatMap((name) => {
    const m = TICKET_NAME.exec(name);
    return m && Number(m[1]) === epoch ? [{ name, from: Number(m[2]), to: Number(m[3]) }] : [];
  });
}

/**
 * The hot side of one wallet and epoch: its own leaf journal and its ticket files. Hot sends use only the band the
 * files hold, through this journal, so a ticket signs at most once even though the cold journal never sees it used.
 */
export class TicketDevice {
  private files: TicketInfo[] = [];

  private constructor(readonly journal: LeafJournal, readonly ticketsDir: string, private readonly p: DeviceParams) {}

  static journalFile = (dir: string, epoch: number) => path.join(path.resolve(dir), `journal-epoch${epoch}.json`);
  static ticketsDirOf = (dir: string) => path.join(path.resolve(dir), "tickets");

  static open(p: DeviceParams): TicketDevice {
    const dir = path.resolve(p.dir);
    const file = TicketDevice.journalFile(dir, p.epoch);
    // A missing journal next to ticket files of its epoch is never recreated: an empty one would hand out tickets
    // that already signed. With files present, create is not passed on, so the lock decides on an existing journal.
    const cut = ticketFilesOf(TicketDevice.ticketsDirOf(dir), p.epoch);
    if (p.create && cut.length && !fs.existsSync(file)) {
      throw new Error(`${cut.length} ticket file(s) of epoch ${p.epoch} are in ${TicketDevice.ticketsDirOf(dir)} but the device journal is missing: recover ${file}; a new journal would re-sign used tickets`);
    }
    if (p.create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((n) => /\.seed\.journal-epoch\d+\.json$/.test(n))) {
      throw new Error(`${dir} holds a cold journal: a ticket device needs its own directory`);
    }
    const journal = LeafJournal.open(file, {
      wallet: p.wallet, chainId: p.chainId, epoch: p.epoch, height: p.height, treeSeed: p.treeSeed,
    }, { create: p.create && cut.length === 0 });
    const device = new TicketDevice(journal, TicketDevice.ticketsDirOf(dir), { ...p, dir });
    device.reload();
    return device;
  }

  /** Reads this epoch's ticket files again (after a cut). All must be of this tree and form one contiguous band. */
  reload(): void {
    const files: TicketInfo[] = [];
    for (const { name, from, to } of ticketFilesOf(this.ticketsDir, this.p.epoch)) {
      const info = readTicketInfo(path.join(this.ticketsDir, name));
      if (info.treeSeed !== this.p.treeSeed.toLowerCase() || info.height !== this.p.height || info.generation !== this.p.epoch || info.chainId !== this.p.chainId) {
        throw new Error(`ticket file ${name} is not of this device's tree (epoch ${this.p.epoch}, height ${this.p.height}, chain ${this.p.chainId})`);
      }
      if (info.leaves.length !== to - from + 1 || info.leaves.some((l, i) => l !== from + i)) throw new Error(`ticket file ${name} does not hold exactly leaves ${from}..${to}`);
      files.push(info);
    }
    files.sort((a, b) => a.leaves[0]! - b.leaves[0]!);
    for (let i = 1; i < files.length; i++) {
      const prev = files[i - 1]!, f = files[i]!;
      if (f.root !== files[0]!.root || f.slot !== files[0]!.slot) throw new Error(`ticket files ${path.basename(files[0]!.file)} and ${path.basename(f.file)} are of different trees`);
      if (f.leaves[0] !== prev.leaves.at(-1)! + 1) throw new Error(`ticket files ${path.basename(prev.file)} and ${path.basename(f.file)} do not form one contiguous band`);
    }
    this.files = files;
  }

  /** The leaves this device holds tickets for, as [from, to), or null before the first cut. */
  band(): { from: number; to: number } | null {
    if (!this.files.length) return null;
    return { from: this.files[0]!.leaves[0]!, to: this.files.at(-1)!.leaves.at(-1)! + 1 };
  }

  /** The files' public tree, or null before the first cut. */
  get tree(): Omit<TicketInfo, "file" | "leaves"> | null {
    const f = this.files[0];
    return f ? { treeSeed: f.treeSeed, root: f.root, height: f.height, generation: f.generation, chainId: f.chainId, slot: f.slot } : null;
  }

  /** exported: tickets held; used: those this device's journal has seen (sent, refused or burned); left: the rest. */
  counts(): { exported: number; used: number; left: number } {
    let exported = 0, used = 0;
    for (const f of this.files) for (const leaf of f.leaves) { exported++; if (this.journal.get(leaf)) used++; }
    return { exported, used, left: exported - used };
  }

  /** The ticket file holding a leaf, or null. */
  fileFor(leaf: number): string | null {
    return this.files.find((f) => leaf >= f.leaves[0]! && leaf <= f.leaves.at(-1)!)?.file ?? null;
  }

  /** A HashSigner over this device's files: each signature runs the CLI on the file that holds the leaf. */
  signer(opts: { bin: string }): HashSigner {
    return {
      height: this.p.height, generation: this.p.epoch, treeSeed: this.p.treeSeed.toLowerCase() as Hex,
      sign: async (req) => {
        const file = this.fileFor(req.leaf);
        if (!file) throw new HashSignerError("leaf_not_in_ticket", `no ticket file of this device holds leaf ${req.leaf}`);
        return cliTicketSigner({ bin: opts.bin, ticketFile: file }).sign(req);
      },
    };
  }
}
