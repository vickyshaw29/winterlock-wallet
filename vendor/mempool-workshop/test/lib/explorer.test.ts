import { describe, expect, it } from "vitest";
import { getReputation, type ReputationItem, type ReputationPage } from "../../src/lib/explorer.js";

const item = (address: string, status: ReputationItem["status"], opsSeen: number, opsIncluded: number, isStaked = true) =>
  ({ address, status, opsSeen, opsIncluded, isStaked, isWhitelisted: false, isBlacklisted: false, stake: "0x0", unstakeDelaySec: 0, withdrawTime: "0x0" });

const pages: Record<string, ReputationPage> = {
  "": { items: [item("0x00000000000000000000000000000000000000aa", "ok", 1, 1)], nextCursor: "1" },
  "1": { items: [item("0x00000000000000000000000000000000000000bb", "banned", 10000, 0)] },
};
const pager = async (cursor?: string) => pages[cursor ?? ""];

describe("getReputation", () => {
  it("finds an entity on a later page and maps the explorer's lowercase status", async () => {
    const r = await getReputation("0x00000000000000000000000000000000000000BB", pager);
    expect(r).toEqual({ status: "BANNED", opsSeen: 10000, opsIncluded: 0, isStaked: true });
  });

  it("an entity the node has never seen is OK with zero counters", async () => {
    const r = await getReputation("0x00000000000000000000000000000000000000cc", pager);
    expect(r).toEqual({ status: "OK", opsSeen: 0, opsIncluded: 0, isStaked: false });
  });
});

import { failedChecks, getAdmission, getLifecycle, type TransactionDetail } from "../../src/lib/explorer.js";

const HASH = `0x${"ab".repeat(32)}` as const;
const rejected: TransactionDetail = {
  hash: HASH,
  entry: null,
  admission: {
    id: 7, txHash: HASH, sender: "0x00000000000000000000000000000000000000b1", nonce: "0x1", nonceKeys: ["0x0"], at: 1, source: "rpc",
    outcome: "rejected", errorCode: -32502, frames: [], frameStatuses: ["not-run"],
    checks: [
      { rule: "structure", verdict: "pass" },
      { rule: "storage", frameIndex: 0, entity: "payer", verdict: "fail", detail: "unstaked payer accessed 0x61… slot 0x0" },
      { rule: "OP-011", frameIndex: 0, verdict: "skipped" },
    ],
  },
  events: [{ seq: 1, txHash: HASH, at: 2, kind: "rejected", reason: "unstaked payer accessed" } as any],
};
const fetchDetail = async (hash: string) => (hash === HASH ? rejected : null);

describe("debug lookups", () => {
  it("getAdmission returns the record and failedChecks lists only the failing rules", async () => {
    const a = await getAdmission(HASH, fetchDetail);
    expect(a?.outcome).toBe("rejected");
    expect(failedChecks(a!).map((c) => [c.rule, c.entity, c.frameIndex])).toEqual([["storage", "payer", 0]]);
  });

  it("getLifecycle returns the event log, and unknown hashes give null / []", async () => {
    expect((await getLifecycle(HASH, fetchDetail)).map((e) => e.kind)).toEqual(["rejected"]);
    expect(await getAdmission(`0x${"cd".repeat(32)}` as const, fetchDetail)).toBeNull();
    expect(await getLifecycle(`0x${"cd".repeat(32)}` as const, fetchDetail)).toEqual([]);
  });
});
