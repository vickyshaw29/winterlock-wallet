// Hot tickets with the real Rust CLI (export-leaves, sign --ticket-file) on a throwaway seed at height 4: the cut's
// off-by-one, the order "marked exported, then written", the ticket directory, and a ticket signing exactly as the
// seed does (the TypeScript keyring is the cross-check). Nothing touches ~/.winterlock or any network.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { LeafJournal } from "../src/leaves.ts";
import { HashSignerError } from "../src/signer.ts";
import { TicketDevice, cliTicketSigner, cutStart, exportTickets, readTicketInfo, ticketFilesOf, type ExportParams } from "../src/tickets.ts";
import { Keyring, keyringSigner, verifyEntry } from "../src/hashsig/keyring.ts";

const BIN = process.env.WL_SIGNER_BIN ?? path.resolve(import.meta.dir, "../../signer/target/release/signer");
if (!fs.existsSync(BIN)) {
  throw new Error(`the ticket tests need the Rust CLI at ${BIN}: build it with (cd signer && ~/.cargo/bin/cargo build --release)`);
}

const ACCOUNT: Address = "0x00000000000000000000000000000000000000a1";
const SEED: Hex = `0x${"5a".repeat(32)}`; // throwaway
const OTHER_SEED: Hex = `0x${"6b".repeat(32)}`; // throwaway
const H = 4, HOT_START = 12, CHAIN = 1337n;
const MSG: Hex = `0x${"42".repeat(32)}`;

let keyring: Keyring;
let tree: { treeSeed: Hex; root: Hex };
let dir: string, coldDir: string, seedFile: string, ticketsDir: string, journal: LeafJournal;
const opened: LeafJournal[] = [];

beforeAll(() => {
  keyring = new Keyring({ seed: hexToBytes(SEED), generation: 0, height: H, chains: [CHAIN] });
  tree = { treeSeed: bytesToHex(keyring.treeSeed), root: bytesToHex(keyring.root()) };
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tickets-"));
  coldDir = path.join(dir, "cold");
  fs.mkdirSync(coldDir, { mode: 0o700 });
  seedFile = path.join(coldDir, "account.seed");
  fs.writeFileSync(seedFile, `${SEED}\n`, { mode: 0o600 });
  ticketsDir = TicketDevice.ticketsDirOf(path.join(dir, "device"));
  journal = open(`${seedFile}.journal-epoch0.json`, tree.treeSeed, true);
});
afterEach(() => {
  for (const j of opened.splice(0)) j.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(file: string, treeSeed: Hex, create = false) {
  const j = LeafJournal.open(file, { wallet: ACCOUNT, chainId: CHAIN, epoch: 0, height: H, treeSeed }, { create });
  opened.push(j);
  return j;
}
const params = (over: Partial<ExportParams> = {}): ExportParams => ({
  bin: BIN, seedFile, coldJournal: journal, tree: { height: H, generation: 0, chains: [CHAIN], root: tree.root },
  chainId: CHAIN, hotStart: HOT_START, from: HOT_START, count: 3, ticketsDir, ...over,
});
const exported = (j = journal) => j.all().filter((r) => r.status === "exported").map((r) => r.leaf);
const device = (create = true) => {
  const d = TicketDevice.open({ dir: path.join(dir, "device"), wallet: ACCOUNT, chainId: CHAIN, epoch: 0, height: H, treeSeed: tree.treeSeed, create });
  opened.push(d.journal);
  return d;
};

describe("cutting tickets", () => {
  test("a cut of 3 exports exactly 3 leaves in the cold journal and exactly 3 in the file, mode 0600, in tickets/", async () => {
    const r = await exportTickets(params());
    expect([r.from, r.to, r.count]).toEqual([12, 14, 3]);
    expect(r.file).toBe(path.join(ticketsDir, "epoch0-12-14.json"));
    expect(exported()).toEqual([12, 13, 14]);
    expect(journal.all().length).toBe(3);
    const info = readTicketInfo(r.file);
    expect(info.leaves).toEqual([12, 13, 14]);
    expect([info.treeSeed, info.root, info.height, info.generation, info.chainId]).toEqual([tree.treeSeed, tree.root, H, 0, CHAIN]);
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(seedFile)).some((n) => n.startsWith("epoch"))).toBe(false); // nothing beside the journal
  });

  test("the next cut is contiguous and has its own file", async () => {
    await exportTickets(params());
    const r = await exportTickets(params({ from: 15, count: 1 }));
    expect([r.from, r.to]).toEqual([15, 15]);
    expect(exported()).toEqual([12, 13, 14, 15]);
    expect(fs.readdirSync(ticketsDir).sort()).toEqual(["epoch0-12-14.json", "epoch0-15-15.json"]);
  });

  test("nothing is marked when a check fails before the cut", async () => {
    const journalDir = path.join(dir, "journal-dir");
    fs.mkdirSync(journalDir);
    fs.writeFileSync(path.join(journalDir, "journal-epoch0.json"), "{}");
    fs.mkdirSync(ticketsDir, { recursive: true });
    fs.writeFileSync(path.join(ticketsDir, "epoch0-12-12.json"), "{}");
    const cases: [Partial<ExportParams>, RegExp][] = [
      [{ from: 11 }, /below hotStart/],
      [{ count: 0 }, /count must be/],
      [{ from: 15, count: 2 }, /past the tree's last leaf, 15/],
      [{ ticketsDir: coldDir }, /holds the cold journal/],
      [{ ticketsDir: journalDir }, /holds a journal/],
      [{ chainId: 1n }, /cold journal is for chain 1337/],
      [{ tree: { height: H, generation: 0, chains: [CHAIN], root: tree.root }, chainId: CHAIN, bin: "/nonexistent/signer" }, /missing or not executable/],
      [{ count: 1 }, /already exists/],
    ];
    for (const [over, why] of cases) {
      const err = await exportTickets(params(over)).catch((e) => e);
      expect(err.message).toMatch(/^no tickets cut: /);
      expect(err.message).toMatch(why);
    }
    journal.reserveNext({ from: 13, to: 14 });
    expect((await exportTickets(params()).catch((e) => e)).message).toMatch(/leaf 13 is already reserved/);
    expect(exported()).toEqual([]);
  });

  test("a CLI failure after the mark wastes the leaves, and they are never cut again", async () => {
    fs.writeFileSync(seedFile, "0x1234\n"); // the CLI refuses it: bad_seed
    const err = await exportTickets(params({ count: 2 })).catch((e) => e);
    expect(err.message).toContain("they are wasted, never reused");
    expect(err.cause).toBeInstanceOf(HashSignerError);
    expect(err.cause.code).toBe("bad_seed");
    expect(exported()).toEqual([12, 13]);
    expect(fs.readdirSync(ticketsDir)).toEqual([]);
    fs.writeFileSync(seedFile, `${SEED}\n`);
    expect((await exportTickets(params({ count: 2 })).catch((e) => e)).message).toMatch(/leaf 12 is already exported/);
  });

  test("a file that fails its checks is removed: it must never be signed from", async () => {
    const err = await exportTickets(params({ tree: { height: H, generation: 0, chains: [CHAIN], root: `0x${"99".repeat(32)}` } })).catch((e) => e);
    expect(err.message).toContain("the file's root is not");
    expect(fs.readdirSync(ticketsDir)).toEqual([]);
    expect(exported()).toEqual([12, 13, 14]); // wasted
  });
});

describe("where a cut starts (cutStart)", () => {
  /** A leaf a script signed and saw land, as pipeline/scripts/hashsig-devnet.ts does with the hot leaf at hotStart. */
  const landed = (j: LeafJournal, leaf: number) => {
    j.reserveNext({ from: leaf, to: leaf + 1 });
    j.mark(leaf, "submitted", { txHash: `0x${"ee".repeat(32)}`, deadline: 1_800_000_000 });
    j.mark(leaf, "onchain");
  };

  test("height 10, hot leaf 1008 on chain: the first cut of 3 is 1009 to 1011, the next starts at 1012, never past a used leaf", () => {
    const own = path.join(dir, "h10");
    fs.mkdirSync(own, { mode: 0o700 });
    const j = LeafJournal.open(path.join(own, "account.seed.journal-epoch0.json"), { wallet: ACCOUNT, chainId: CHAIN, epoch: 0, height: 10, treeSeed: `0x${"0a".repeat(32)}` }, { create: true });
    opened.push(j);
    landed(j, 1008);
    const first = cutStart({ coldJournal: j, hotStart: 1008, band: null });
    expect(first).toBe(1009);
    j.markExported(first!, first! + 3, "the first cut"); // what exportTickets marks for a cut of 3
    const band = { from: 1009, to: 1012 };
    expect(cutStart({ coldJournal: j, hotStart: 1008, band })).toBe(1012);
    // a later cut stays contiguous: a used leaf where the band ends is not skipped (exportTickets then refuses the cut)
    landed(j, 1012);
    expect(cutStart({ coldJournal: j, hotStart: 1008, band })).toBe(1012);
    // the first cut never starts below hotStart, and finds nothing once every hot leaf is used
    expect(cutStart({ coldJournal: j, hotStart: 1013, band: null })).toBe(1013);
    j.markExported(1013, 1024, "the rest");
    expect(cutStart({ coldJournal: j, hotStart: 1008, band: null })).toBeNull();
  });

  test("with the CLI: hot leaf 12 on chain, the first cut starts at 13 and the device's band follows the file", async () => {
    landed(journal, 12);
    const d = device();
    const r = await exportTickets(params({ from: cutStart({ coldJournal: journal, hotStart: HOT_START, band: d.band() })! }));
    expect([r.from, r.to]).toEqual([13, 15]);
    expect(exported()).toEqual([13, 14, 15]);
    d.reload();
    expect(d.band()).toEqual({ from: 13, to: 16 });
    expect(cutStart({ coldJournal: journal, hotStart: HOT_START, band: d.band() })).toBe(16); // past the tree's last leaf: no more
    // a ticket of the cut signs exactly as the seed does
    const entry = await d.signer({ bin: BIN }).sign({ chainId: CHAIN, leaf: 13, msg: MSG });
    expect(entry).toBe(await keyringSigner(keyring).sign({ chainId: CHAIN, leaf: 13, msg: MSG }));
  });
});

describe("the ticket device", () => {
  // As the backend does: the device journal is born before the first cut, and reloads its files after each cut.
  test("band, counts, and a ticket that signs exactly as the seed does", async () => {
    const d = device();
    await exportTickets(params());
    await exportTickets(params({ from: 15, count: 1 }));
    d.reload();
    expect(d.band()).toEqual({ from: 12, to: 16 });
    expect(d.counts()).toEqual({ exported: 4, used: 0, left: 4 });
    const entry = await d.signer({ bin: BIN }).sign({ chainId: CHAIN, leaf: 13, msg: MSG });
    expect(entry).toBe(await keyringSigner(keyring).sign({ chainId: CHAIN, leaf: 13, msg: MSG }));
    expect(verifyEntry({ entry: hexToBytes(entry), msg: hexToBytes(MSG), root: hexToBytes(tree.root), treeSeed: hexToBytes(tree.treeSeed), height: H, chainId: CHAIN, leaf: 13 }).ok).toBe(true);
    expect(d.journal.reserveNext(d.band()!).leaf).toBe(12);
    expect(d.counts()).toEqual({ exported: 4, used: 1, left: 3 });
  });

  test("before the first cut: no band, nothing to sign", () => {
    const d = device();
    expect([d.band(), d.tree]).toEqual([null, null]);
    expect(d.counts()).toEqual({ exported: 0, used: 0, left: 0 });
  });

  test("a leaf outside the files is refused, by the device and by the CLI; so is another chain", async () => {
    const d = device();
    const { file } = await exportTickets(params());
    d.reload();
    const outside = await d.signer({ bin: BIN }).sign({ chainId: CHAIN, leaf: 11, msg: MSG }).catch((e) => e);
    expect([outside.constructor, outside.code]).toEqual([HashSignerError, "leaf_not_in_ticket"]);
    const cli = await cliTicketSigner({ bin: BIN, ticketFile: file }).sign({ chainId: CHAIN, leaf: 15, msg: MSG }).catch((e) => e);
    expect([cli.constructor, cli.code]).toEqual([HashSignerError, "leaf_not_in_ticket"]);
    const chain = await cliTicketSigner({ bin: BIN, ticketFile: file }).sign({ chainId: 1n, leaf: 12, msg: MSG }).catch((e) => e);
    expect(chain.code).toBe("bad_chain");
  });

  test("the signer names the files' tree, which sendKeyed checks against the journal", async () => {
    const { file } = await exportTickets(params());
    const s = cliTicketSigner({ bin: BIN, ticketFile: file });
    expect([s.height, s.generation, s.treeSeed]).toEqual([H, 0, tree.treeSeed]);
  });

  test("a device refuses files of another tree, and files with a gap", async () => {
    const d = device();
    await exportTickets(params({ count: 1 }));
    const other = path.join(dir, "other.seed");
    fs.writeFileSync(other, `${OTHER_SEED}\n`, { mode: 0o600 });
    const run = Bun.spawnSync([BIN, "export-leaves", "--seed-file", other, "--height", String(H), "--chains", "1337", "--chain-id", "1337",
      "--from", "13", "--to", "13", "--hot-start", "12", "--out", path.join(ticketsDir, "epoch0-13-13.json")]);
    expect(run.exitCode).toBe(0);
    expect(() => d.reload()).toThrow("not of this device's tree");
    expect(() => device(false)).toThrow("not of this device's tree"); // and so does opening it again
    fs.rmSync(path.join(ticketsDir, "epoch0-13-13.json"));
    await exportTickets(params({ from: 14, count: 1 })); // leaf 13 skipped: a gap
    expect(() => d.reload()).toThrow("contiguous band");
  });

  test("a lost device journal is never recreated beside ticket files of its epoch: it would re-sign used tickets (A)", async () => {
    const d = device();
    await exportTickets(params());
    d.reload();
    expect(d.journal.reserveNext(d.band()!).leaf).toBe(12); // ticket 12 is about to sign: only this journal knows
    d.journal.close();
    const file = TicketDevice.journalFile(path.join(dir, "device"), 0);
    fs.rmSync(file); // the journal is lost; its lock anchor stays
    expect(() => device()).toThrow(`recover ${file}; a new journal would re-sign used tickets`);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => device(false)).toThrow("no journal at");
    expect(ticketFilesOf(ticketsDir, 0)).toEqual([{ name: "epoch0-12-14.json", from: 12, to: 14 }]);
    expect(ticketFilesOf(ticketsDir, 1)).toEqual([]); // another epoch's files do not count
  });

  test("why tickets/ exists: a ticket file beside a journal stops that journal from opening", async () => {
    const { file } = await exportTickets(params());
    journal.close();
    fs.copyFileSync(file, path.join(coldDir, "stray-ticket.json"));
    expect(() => open(`${seedFile}.journal-epoch0.json`, tree.treeSeed)).toThrow("One seed serves one account");
  });

  test("a damaged ticket file is refused without quoting it", () => {
    fs.mkdirSync(ticketsDir, { recursive: true });
    const secret = "0x" + "c3".repeat(32);
    const file = path.join(ticketsDir, "epoch0-12-12.json");
    fs.writeFileSync(file, `{"version": 1, "leaves": [${secret}]}`);
    const err = (() => { try { readTicketInfo(file); } catch (e) { return e as Error; } })()!;
    expect(err.message).toContain("is not JSON");
    expect(err.message).not.toContain("c3c3");
  });
});
