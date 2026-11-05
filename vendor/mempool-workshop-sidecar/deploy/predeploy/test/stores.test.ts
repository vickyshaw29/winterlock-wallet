import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileArtifactStore } from "../src/artifacts";
import { FileJournalStore } from "../src/journal";
import { hash, makeArtifact } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "predeploy-stores-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileArtifactStore", () => {
  it("round-trips an artifact", () => {
    const store = new FileArtifactStore(dir);
    const artifact = makeArtifact({ hash: hash(1) });
    store.write("usdt", artifact);
    expect(store.read("usdt", hash(1))).toEqual(artifact);
    expect(fs.existsSync(path.join(dir, "usdt", `${hash(1)}.json`))).toBe(true);
  });

  it("explains how to fetch a missing artifact", () => {
    const store = new FileArtifactStore(dir);
    expect(() => store.read("usdt", hash(2))).toThrow(/predeploy fetch usdt/);
  });
});

describe("FileJournalStore", () => {
  it("returns an empty journal for an unknown chain", () => {
    expect(new FileJournalStore(dir).load(1337)).toEqual({ chainId: 1337, protocols: {} });
  });

  it("round-trips a journal", () => {
    const store = new FileJournalStore(dir);
    const journal = {
      chainId: 1337,
      protocols: {
        link: {
          stepsDone: ["token"],
          contracts: { LINK: "0x0000000000000000000000000000000000000001" as const },
          mainnetToDevnet: {
            "0x514910771af9ca656af840dff83e8264ecf986ca":
              "0x0000000000000000000000000000000000000001" as const,
          },
        },
      },
    };
    store.save(journal);
    expect(store.load(1337)).toEqual(journal);
    expect(fs.readdirSync(dir)).toEqual(["1337.json"]); // no leftover temporary file
  });
});
