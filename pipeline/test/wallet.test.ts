// Where journals live (scripts/lib/wallet.ts): a real tree's journal sits beside its seed file, so every checkout that
// can sign with the seed shares it (second review, Nov 6, S1). Uses throwaway seed paths; no seed is read.
// Written with Claude Code (AI) for Vicky.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import type { LeafJournal } from "../src/leaves.ts";
import type { Deployment } from "../scripts/lib/wallet.ts";

// This file's own data folder, never the checkout's .data (a reinjected bug once wrote test journals there).
process.env.WL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-data-"));
const { journalFile, legacyJournalFile, openJournal, DATA_DIR } = await import("../scripts/lib/wallet.ts");
afterAll(() => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); delete process.env.WL_DATA_DIR; });

const TREE: Hex = `0x${"5e".repeat(32)}`;
let dir: string;
const opened: LeafJournal[] = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-")); });
afterEach(() => { for (const j of opened.splice(0)) j.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const deployment = (account: Address, seedFile = path.join(dir, "account.seed"), treeSeed = TREE): Deployment => ({
  chainId: "1337", verifier: "hashsig", implementation: "0x0000000000000000000000000000000000000001", factory: "0x0000000000000000000000000000000000000002",
  account, params: { height: 10, treeSeed }, tree: { seedFile, generation: 0, height: 10, chains: ["1337"] },
});
const open = (d: Deployment, create = false) => { const j = openJournal(d, 0, { create }); opened.push(j); return j; };

describe("a real tree's journal lives beside its seed", () => {
  test("this file runs on its own data folder", () => {
    expect(DATA_DIR).toBe(process.env.WL_DATA_DIR!);
    expect(DATA_DIR.startsWith(os.tmpdir())).toBe(true);
  });

  test("the path is the seed file's, not this checkout's .data", () => {
    const d = deployment("0x00000000000000000000000000000000000000a1");
    expect(journalFile(d)).toBe(`${d.tree!.seedFile}.journal-epoch0.json`);
    expect(journalFile(d, 1)).toBe(`${d.tree!.seedFile}.journal-epoch1.json`);
    expect(journalFile({ ...d, verifier: "placeholder" })).toBe(legacyJournalFile(d.account));
  });

  test("a second account on the same seed file is refused: the seed's journal names the first account", () => {
    open(deployment("0x00000000000000000000000000000000000000a1"), true).close();
    expect(() => open(deployment("0x00000000000000000000000000000000000000b2"), true)).toThrow("belongs to");
  });

  test("a copy of the seed under another name is refused too: one tree, one journal", () => {
    open(deployment("0x00000000000000000000000000000000000000a1"), true);
    expect(() => open(deployment("0x00000000000000000000000000000000000000b2", path.join(dir, "copy.seed")), true)).toThrow("One seed serves one account");
  });

  test("every checkout reaches the same journal: a second checkout of the same account gets the leaves already used", () => {
    const d = deployment("0x00000000000000000000000000000000000000a1");
    const first = open(d, true);
    first.reserveNext({ from: 1, to: 500 });
    first.close();
    const again = open(d); // what a second checkout opens: the seed path is the same, .data is not involved
    expect(again.get(1)?.status).toBe("reserved");
    expect(again.reserveNext({ from: 1, to: 500 }).leaf).toBe(2);
  });
});
