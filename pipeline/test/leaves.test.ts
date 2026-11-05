import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeafJournal } from "../src/leaves.ts";

const id = { wallet: "0x00000000000000000000000000000000000000a1" as const, chainId: 1337n, epoch: 0, height: 10 };
const COLD = { from: 0, to: 1008 };
const HOT = { from: 1008, to: 1024 };
let file: string;
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "journal-")), "journal.json"); });

describe("leaf journal", () => {
  test("epoch 0 skips leaf 0 (key 0 is the legacy nonce), then hands out leaves in order", () => {
    const j = LeafJournal.open(file, id);
    expect(j.reserveNext(COLD).leaf).toBe(1);
    expect(j.reserveNext(COLD).leaf).toBe(2);
  });

  test("epoch 1 starts at leaf 0, whose key is 1 << 32", () => {
    const j = LeafJournal.open(file, { ...id, epoch: 1 });
    expect(j.reserveNext(COLD)).toEqual({ leaf: 0, nonceKey: 1n << 32n });
  });

  test("a leaf in the journal is never handed out again, whatever its status, even after a restart", () => {
    const j = LeafJournal.open(file, id);
    const a = j.reserveNext(COLD).leaf;
    j.mark(a, "burned", { note: "expired" });
    const b = j.reserveNext(COLD).leaf;
    j.mark(b, "submitted", { txHash: "0xabc" });
    const reopened = LeafJournal.open(file, id);
    expect(reopened.reserveNext(COLD).leaf).toBe(b + 1);
    expect(reopened.get(a)?.status).toBe("burned");
  });

  test("the leaf is on disk as reserved before reserveNext returns", () => {
    const j = LeafJournal.open(file, id);
    const { leaf } = j.reserveNext(COLD);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.leaves[leaf].status).toBe("reserved");
  });

  test("statuses only move forward", () => {
    const j = LeafJournal.open(file, id);
    const { leaf } = j.reserveNext(COLD);
    j.mark(leaf, "submitted");
    j.mark(leaf, "onchain");
    expect(() => j.mark(leaf, "burned")).toThrow("not allowed");
    expect(() => j.mark(leaf, "reserved")).toThrow("not allowed");
  });

  test("refuses a journal written for another wallet or epoch", () => {
    LeafJournal.open(file, id);
    expect(() => LeafJournal.open(file, { ...id, epoch: 1 })).toThrow("belongs to");
    expect(() => LeafJournal.open(file, { ...id, wallet: "0x00000000000000000000000000000000000000b2" })).toThrow("belongs to");
  });

  test("exported tickets are spent: the hot band is then empty for this journal", () => {
    const j = LeafJournal.open(file, id);
    j.markExported(HOT.from, HOT.to, "ticket file for the phone");
    expect(() => j.reserveNext(HOT)).toThrow("no unused leaf");
    expect(j.reserveNext(COLD).leaf).toBe(1);
  });

  test("cannot export a leaf that was already used", () => {
    const j = LeafJournal.open(file, id);
    const { leaf } = j.reserveNext(COLD);
    expect(() => j.markExported(leaf, leaf + 4)).toThrow("already reserved");
  });
});
