import type { Hex } from "viem";
import { loadConfig } from "../lib/config.js";
import { failedChecks, getAdmission, getLifecycle } from "../lib/explorer.js";
import { StepError, runStep } from "../lib/output.js";
import { rpc } from "../lib/rpc.js";
import { readState } from "../lib/state.js";

const optional = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

runStep("step_11_debug", async (ctx) => {
  const cfg = loadConfig();
  const hash = (ctx.args[0] ?? readState().lastTxHash) as Hex | undefined;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new StepError("BAD_ARGUMENT", "pass a 32-byte tx hash", { hint: "yarn step_11_debug 0x<txHash>; steps 6, 8 and 10 print the hash of the tx they sent" });
  }

  const [admission, events, status, receipt] = await Promise.all([
    getAdmission(hash),
    getLifecycle(hash),
    optional(rpc(cfg.gatewayUrl, "skandha_frameTransactionStatus", [hash])),
    optional(rpc(cfg.gatewayUrl, "eth_getTransactionReceipt", [hash])),
  ]);
  if (!admission && events.length === 0 && !status && !receipt) {
    throw new StepError("TX_UNKNOWN", `no node knows ${hash}`, {
      hint: "the sidecar explorer keeps its history in memory only (cleared on restart), and ethrex only knows mined txs; check the hash",
    });
  }

  const failed = admission ? failedChecks(admission) : [];
  const lines = [`tx ${hash}`];
  if (admission) {
    lines.push(`admission (${admission.source}): ${admission.outcome.toUpperCase()}${admission.errorCode ? ` (error ${admission.errorCode})` : ""}`);
    lines.push(...(failed.length
      ? failed.map((c) => `  FAIL ${c.rule}${c.entity ? ` [${c.entity}]` : ""}${c.frameIndex !== undefined ? ` frame ${c.frameIndex}` : ""}${c.detail ? `: ${c.detail}` : ""}`)
      : ["  every rule check passed"]));
    lines.push(`  (${admission.checks.filter((c) => c.verdict === "pass").length} checks passed, ${admission.checks.filter((c) => c.verdict === "skipped").length} skipped)`);
  } else {
    lines.push("admission: no record on this node");
  }
  if (events.length) lines.push("lifecycle: " + events.map((e) => `${e.kind}${e.reason ? ` (${e.reason})` : ""}`).join(" -> "));
  if (status) lines.push(`mempool status: ${status.status}${status.reason ? ` (${status.reason})` : ""}`);
  if (receipt) {
    lines.push(`mined: block ${Number(receipt.blockNumber)}, status ${receipt.status === "0x1" ? "success" : "reverted"}, frames: ${(receipt.frameReceipts ?? []).map((f: any) => (f.status === "0x1" ? "ok" : "FAILED")).join(", ")}`);
  }
  return {
    summary: lines.join("\n"),
    data: { txHash: hash, admission, failedChecks: failed, events, status, receipt: receipt && { blockNumber: receipt.blockNumber, status: receipt.status, frameReceipts: receipt.frameReceipts } },
  };
});
