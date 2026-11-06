import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeafJournal, type JournalIdentity } from "../src/leaves.ts";

const id = { wallet: "0x00000000000000000000000000000000000000a1" as const, chainId: 1337n, epoch: 0, height: 10 };
const COLD = { from: 0, to: 1008 };
const HOT = { from: 1008, to: 1024 };
let file: string;
const opened: LeafJournal[] = [];
const open = (f = file, i: JournalIdentity = id, create = true) => { const j = LeafJournal.open(f, i, { create }); opened.push(j); return j; };
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "journal-")), "journal.json"); });
afterEach(() => { for (const j of opened.splice(0)) j.close(); });

describe("leaf journal", () => {
  test("epoch 0 skips leaf 0 (key 0 is the legacy nonce), then hands out leaves in order", () => {
    const j = open();
    expect(j.reserveNext(COLD).leaf).toBe(1);
    expect(j.reserveNext(COLD).leaf).toBe(2);
  });

  test("epoch 1 starts at leaf 0, whose key is 1 << 32", () => {
    const j = open(file, { ...id, epoch: 1 });
    expect(j.reserveNext(COLD)).toEqual({ leaf: 0, nonceKey: 1n << 32n });
  });

  test("a leaf in the journal is never handed out again, whatever its status, even after a restart", () => {
    const j = open();
    const a = j.reserveNext(COLD).leaf;
    j.mark(a, "burned", { note: "expired" });
    const b = j.reserveNext(COLD).leaf;
    j.mark(b, "submitted", { txHash: "0xabc" });
    j.close();
    const reopened = open(file, id, false);
    expect(reopened.reserveNext(COLD).leaf).toBe(b + 1);
    expect(reopened.get(a)?.status).toBe("burned");
  });

  test("the leaf is on disk as reserved before reserveNext returns", () => {
    const j = open();
    const { leaf } = j.reserveNext(COLD);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.leaves[leaf].status).toBe("reserved");
  });

  test("statuses only move forward", () => {
    const j = open();
    const { leaf } = j.reserveNext(COLD);
    j.mark(leaf, "submitted");
    j.mark(leaf, "onchain");
    expect(() => j.mark(leaf, "burned")).toThrow("not allowed");
    expect(() => j.mark(leaf, "reserved")).toThrow("not allowed");
  });

  test("refuses a journal written for another wallet or epoch", () => {
    open();
    expect(() => LeafJournal.open(file, { ...id, epoch: 1 })).toThrow("belongs to");
    expect(() => LeafJournal.open(file, { ...id, wallet: "0x00000000000000000000000000000000000000b2" })).toThrow("belongs to");
  });

  test("exported tickets are spent: the hot band is then empty for this journal", () => {
    const j = open();
    j.markExported(HOT.from, HOT.to, "ticket file for the phone");
    expect(() => j.reserveNext(HOT)).toThrow("no unused leaf");
    expect(j.reserveNext(COLD).leaf).toBe(1);
  });

  test("cannot export a leaf that was already used", () => {
    const j = open();
    const { leaf } = j.reserveNext(COLD);
    expect(() => j.markExported(leaf, leaf + 4)).toThrow("already reserved");
  });
});

describe("one writer per journal (review fixes, Nov 6)", () => {
  const LEAVES = path.resolve(import.meta.dir, "../src/leaves.ts");
  /** Another process that opens the journal, reserves one leaf, says "ready", then holds it until killed. */
  const holder = (f: string, create = false) => {
    const code = `
      import { LeafJournal } from ${JSON.stringify(LEAVES)};
      const j = LeafJournal.open(${JSON.stringify(f)}, { wallet: "${id.wallet}", chainId: 1337n, epoch: 0, height: 10 }, { create: ${create} });
      j.reserveNext({ from: 0, to: 1008 });
      console.log("ready");
      await Bun.sleep(60_000);`;
    return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  };
  const ready = async (p: ReturnType<typeof holder>) => {
    const reader = p.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    if (!new TextDecoder().decode(value).includes("ready")) throw new Error(`holder did not start: ${await new Response(p.stderr).text()}`);
  };

  test("a missing journal is never recreated silently", () => {
    expect(() => LeafJournal.open(file, id)).toThrow("no journal at");
    expect(fs.existsSync(file)).toBe(false);
    open(); // explicit create, as for a new account
    expect(fs.existsSync(file)).toBe(true);
  });

  test("within one process, every open of a file returns the same instance", () => {
    const a = open();
    const b = LeafJournal.open(file, id);
    expect(b).toBe(a);
    expect(a.reserveNext(COLD).leaf).toBe(1);
    expect(b.reserveNext(COLD).leaf).toBe(2); // no second view that could hand out leaf 1 again
  });

  test("another spelling of the same file, through a symlink or in other letter case, is the same instance", () => {
    const a = open();
    const link = path.join(os.tmpdir(), `journal-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(path.dirname(file), link);
    try {
      expect(LeafJournal.open(path.join(link, "journal.json"), id)).toBe(a);
      const upper = path.join(path.dirname(file), "JOURNAL.json");
      if (fs.existsSync(upper)) expect(LeafJournal.open(upper, id)).toBe(a); // case-insensitive volume, as on macOS
    } finally {
      fs.rmSync(link);
    }
  });

  test("a journal another process holds is refused, under any spelling", async () => {
    open().close();
    const p = holder(file);
    try {
      await ready(p);
      expect(() => LeafJournal.open(file, id)).toThrow("in use by another process");
      const link = path.join(os.tmpdir(), `journal-link2-${process.pid}-${Date.now()}`);
      fs.symlinkSync(path.dirname(file), link);
      try { expect(() => LeafJournal.open(path.join(link, "journal.json"), id)).toThrow("in use by another process"); }
      finally { fs.rmSync(link); }
    } finally {
      p.kill();
      await p.exited;
    }
  });

  test("a process killed with SIGKILL leaves the journal free: nothing stale to take over", async () => {
    open().close();
    const p = holder(file);
    await ready(p);
    p.kill(9);
    await p.exited;
    const j = open(file, id, false);
    expect(j.get(1)?.status).toBe("reserved"); // the dead process's reservation is on disk and stays used
    expect(j.reserveNext(COLD).leaf).toBe(2);
  });

  test("two processes creating the same journal: the second finds the first one's journal, never an empty one", async () => {
    const p = holder(file, true);
    try {
      await ready(p);
      expect(() => LeafJournal.open(file, id, { create: true })).toThrow("in use by another process");
    } finally {
      p.kill();
      await p.exited;
    }
    const j = open(file, id, true);
    expect(j.get(1)?.status).toBe("reserved");
  });

  test("close releases the lock, and a closed instance cannot write", async () => {
    const j = open();
    j.close();
    expect(() => j.reserveNext(COLD)).toThrow("closed");
    const p = holder(file); // another process can take it now
    try { await ready(p); } finally { p.kill(); await p.exited; }
  });

  test("removing the lock file while the journal is open stops every write", () => {
    const j = open();
    fs.rmSync(`${file}.lock`);
    expect(() => j.reserveNext(COLD)).toThrow("removed or replaced");
  });

  test("writes leave no temp files behind", () => {
    const j = open();
    for (let i = 0; i < 5; i++) j.reserveNext(COLD);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["journal.json", "journal.json.lock"]);
  });
});

describe("peek, notes and the tree (review fixes, Nov 6)", () => {
  test("peekNext names the next leaf without reserving it", () => {
    const j = open();
    expect(j.peekNext(COLD).leaf).toBe(1);
    expect(j.all()).toEqual([]);
    expect(j.reserveNext(COLD).leaf).toBe(1);
    expect(j.peekNext(COLD).leaf).toBe(2);
  });

  test("a note keeps the status and adds to earlier notes", () => {
    const j = open();
    const { leaf } = j.reserveNext(COLD);
    j.mark(leaf, "submitted", { txHash: "0xabc", deadline: 1_793_000_000 });
    j.note(leaf, "send outcome unknown");
    j.note(leaf, "outcome unknown: timeout");
    expect(j.get(leaf)).toMatchObject({ status: "submitted", txHash: "0xabc", deadline: 1_793_000_000, note: "send outcome unknown; outcome unknown: timeout" });
  });

  test("one tree, one journal: a second journal naming the same tree seed is refused", () => {
    const tree = `0x${"aa".repeat(32)}` as const;
    open(file, { ...id, treeSeed: tree });
    const other = path.join(path.dirname(file), "journal-other.json");
    expect(() => LeafJournal.open(other, { ...id, wallet: "0x00000000000000000000000000000000000000b2", treeSeed: tree }, { create: true })).toThrow("One seed serves one account");
    expect(fs.existsSync(other)).toBe(false);
  });

  test("a journal written before the tree field records its tree on first open, then refuses another", () => {
    open().close(); // no tree seed, as before Nov 6
    const tree = `0x${"bb".repeat(32)}` as const;
    const j = open(file, { ...id, treeSeed: tree }, false);
    expect(j.treeSeed).toBe(tree);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).treeSeed).toBe(tree);
    j.close();
    expect(() => LeafJournal.open(file, { ...id, treeSeed: `0x${"cc".repeat(32)}` })).toThrow("is for tree seed");
  });
});
