// Admission reports (spec Level A, "the admission report shown for every transaction"): the sidecar's per-rule
// verdict from its explorer record, and a one-line summary of the node's simulation.
// Written with Claude Code (AI) for Vicky.
import { keccak256, type Hex } from "viem";
import { encodeRawFrameTx } from "./codec/codec.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";
import type { SimulationResult } from "./rpc.ts";
import { defaultNetwork, type Network } from "./network.ts";

/** keccak256(0x06 ‖ rlp(tx)) over the signed transaction: the hash the sidecar files it under, even when refused. */
export const frameTxHash = (tx: FrameTransaction): Hex => keccak256(encodeRawFrameTx(tx));

export interface AdmissionCheck {
  rule: string;
  verdict: "pass" | "fail" | "skipped";
  detail?: string;
  frameIndex?: number;
  entity?: string;
}

export interface AdmissionReport {
  txHash: Hex;
  /** accepted, rejected, included, replaced or dropped */
  outcome: string;
  errorCode?: number;
  includer?: string;
  checks: AdmissionCheck[];
  failed: AdmissionCheck[];
  frameStatuses: string[];
  summary: string;
}

/** The admission record the submission endpoint keeps for this hash (in memory: gone after a sidecar restart). */
export async function admissionReport(txHash: Hex, net: Network = defaultNetwork): Promise<AdmissionReport | null> {
  const record = await net.gateway.explorerRecord(txHash).catch(() => null);
  return record?.admission ? parseAdmissionRecord(txHash, record.admission) : null;
}

/** An AdmissionRecord (sidecar docs/sidecar_explorer.md) as a report with a one-line summary. */
export function parseAdmissionRecord(txHash: Hex, a: any): AdmissionReport {
  const checks: AdmissionCheck[] = (a.checks ?? []).map((c: any) => ({
    rule: String(c.rule),
    verdict: c.verdict,
    ...(c.detail ? { detail: String(c.detail) } : {}),
    ...(c.frameIndex !== undefined ? { frameIndex: Number(c.frameIndex) } : {}),
    ...(c.entity ? { entity: String(c.entity) } : {}),
  }));
  const failed = checks.filter((c) => c.verdict === "fail");
  const passed = checks.filter((c) => c.verdict === "pass").length;
  const skipped = checks.length - passed - failed.length;
  const where = (c: AdmissionCheck) => (c.frameIndex !== undefined ? ` (frame ${c.frameIndex})` : "");
  const summary = failed.length
    ? `${a.outcome}: ${failed.map((f) => `${f.rule}${where(f)}: ${f.detail ?? "failed"}`).join("; ")}`
    : `${a.outcome}: ${passed} of ${checks.length} rules passed${skipped ? `, ${skipped} skipped` : ""}`;
  return {
    txHash, outcome: a.outcome, checks, failed, frameStatuses: a.frameStatuses ?? [], summary,
    ...(a.errorCode !== undefined ? { errorCode: a.errorCode } : {}),
    ...(a.includer ? { includer: a.includer } : {}),
  };
}

/** One line per rule, for scripts and the demo. */
export function formatAdmissionReport(r: AdmissionReport): string {
  const mark = { pass: "pass", fail: "FAIL", skipped: "skip" } as const;
  const lines = r.checks.map((c) => {
    const at = [c.frameIndex !== undefined ? `frame ${c.frameIndex}` : "", c.entity ?? ""].filter(Boolean).join(", ");
    return `  ${mark[c.verdict] ?? c.verdict} ${c.rule}${at ? ` [${at}]` : ""}${c.detail ? `: ${c.detail}` : ""}`;
  });
  return [`admission ${r.summary}`, ...lines].join("\n");
}

/** The node's dry run in one line: public-mempool verdict, prefix shape, gas per frame, maximum cost. */
export function simulationSummary(s: SimulationResult): string {
  const valid = s.canonicalMempoolValid ?? s.valid;
  const violation = s.canonicalMempoolViolation ?? s.violation;
  const frames = s.frames?.map((f) => `${BigInt(f.gasUsed)}${f.succeeded ? "" : " (failed)"}`).join(" / ") ?? "not executed";
  return `simulation: ${valid ? "valid" : `invalid (${violation})`}, shape ${s.prefixShape ?? "none"}, frame gas ${frames}, execution ${s.executionStatus ?? "-"}, max cost ${BigInt(s.maxCost)} wei`;
}
