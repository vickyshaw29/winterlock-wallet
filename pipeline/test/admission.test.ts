import { describe, expect, test } from "bun:test";
import { formatAdmissionReport, frameTxHash, parseAdmissionRecord, simulationSummary } from "../src/admission.ts";
import { fromWire } from "../src/rpc.ts";

const sighashFixture = await Bun.file(new URL("./fixtures/devnet-sighash.json", import.meta.url)).json();
const records = await Bun.file(new URL("./fixtures/admission-records.json", import.meta.url)).json();

describe("admission reports", () => {
  test("frameTxHash is the hash the sidecar returned for two landed transactions", () => {
    for (const c of sighashFixture.cases) expect(frameTxHash(fromWire(c.tx))).toBe(c.hash);
  });

  test("an included transaction: every rule passed", () => {
    const r = parseAdmissionRecord(records.included.txHash, records.included.admission);
    expect(r.outcome).toBe("included");
    expect(r.failed).toEqual([]);
    expect(r.summary).toBe("included: 17 of 17 rules passed");
    expect(r.checks.find((c) => c.rule === "OP-011")).toMatchObject({ verdict: "pass", frameIndex: 1, entity: "payer" });
    expect(formatAdmissionReport(r).split("\n")).toHaveLength(18);
  });

  test("a refused transaction: the failing rule and its message lead the summary", () => {
    const r = parseAdmissionRecord(records.rejected.txHash, records.rejected.admission);
    expect(r.outcome).toBe("rejected");
    expect(r.errorCode).toBe(-32602);
    expect(r.failed.map((c) => c.rule)).toEqual(["structure"]);
    expect(r.summary).toStartWith("rejected: structure: validation prefix execution gas sum 120000");
    expect(formatAdmissionReport(r)).toContain("FAIL structure: validation prefix");
  });

  test("a simulation in one line", () => {
    const line = simulationSummary({
      canonicalMempoolValid: true, canonicalMempoolViolation: null, prefixShape: "SelfVerify", payer: null, maxCost: "0x10",
      gasUsed: "0x1", executionStatus: "success", frames: [{ gasUsed: "0xbeb", succeeded: true }, { gasUsed: "0x77d5", succeeded: true }],
    });
    expect(line).toBe("simulation: valid, shape SelfVerify, frame gas 3051 / 30677, execution success, max cost 16 wei");
  });
});

describe("receipts", () => {
  test("the node's receipt is converted to the sidecar's shape (real receipt, block 406,260)", async () => {
    const { normalizeNodeReceipt } = await import("../src/rpc.ts");
    const node = {
      blockNumber: "0x632f4", status: "0x1", gasUsed: "0x2d785", payer: "0x107445c26594fdb3eb62803a8e79b9d7732148c3", cumulativeGasUsed: "0x2d785",
      frameReceipts: [
        { gasUsed: "0xbeb", logs: [], stateGasUsed: "0x0", status: "0x1" },
        { gasUsed: "0x77d5", logs: [], stateGasUsed: "0x0", status: "0x1" },
        { gasUsed: "0x64", logs: [], stateGasUsed: "0x0", status: "0x0" },
      ],
    };
    const r = normalizeNodeReceipt(node);
    expect(r.status).toBe("success");
    expect(r.gasUsed).toBe("0x2d785");
    expect(r.frameReceipts[1]).toEqual({ status: "success", gasUsed: { execution: "0x77d5", state: "0x0" }, logs: [] });
    expect(r.frameReceipts[2]!.status).toBe("reverted");
  });
});
