// The fake chain's explorer: small HTML pages (transaction, block, index), each under a FAKE banner.
// Written with Claude Code (AI) for Vicky.
import { formatEther, getAddress, size, type Hex } from "viem";
import { decodeReason } from "./accountModel.ts";
import { CLIENT_VERSION } from "./constants.ts";
import type { FakeChain } from "./chain.ts";
import type { Sidecar } from "./sidecar.ts";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MODES = ["DEFAULT", "VERIFY", "SENDER"];
const SCHEMES = ["ARBITRARY", "SECP256K1", "P256"];

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --ink:#1d1d1f; --paper:#fbfbf8; --line:#d8d6cf; --fake:#b3261e; --muted:#6b6a66; }
@media (prefers-color-scheme: dark) { :root { --ink:#ecebe6; --paper:#17171a; --line:#3a3a3f; --fake:#ff6f61; --muted:#a3a29c; } }
body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.45 system-ui, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:16px; }
.fake { background:var(--fake); color:#fff; padding:10px 16px; font-weight:700; letter-spacing:.02em; }
h1 { font-size:18px; margin:16px 0 8px; } h2 { font-size:15px; margin:20px 0 6px; }
table { border-collapse:collapse; width:100%; margin:6px 0; display:block; overflow-x:auto; }
th, td { border-bottom:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; white-space:nowrap; }
td.wrap { white-space:normal; word-break:break-all; }
code, .mono { font-family:ui-monospace, Menlo, monospace; font-size:12.5px; }
.fail { color:var(--fake); font-weight:600; } .muted { color:var(--muted); }
a { color:inherit; }
</style></head><body>
<div class="fake">FAKE DEVNET: fakechain, a local model in TypeScript. Not ethrex, not the sidecar, not altmempool.wtf. Nothing here happened on a real chain.</div>
<main>${body}<p class="muted">${esc(CLIENT_VERSION)} · <a href="/explorer">index</a></p></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function explorerResponse(url: URL, chain: FakeChain, sidecar: Sidecar): Response {
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["explorer", "tx", hash]
  if (parts.length === 1) return index(chain, sidecar);
  if (parts[1] === "tx" && parts[2]) return txPage(parts[2], chain, sidecar);
  if (parts[1] === "block" && parts[2]) {
    const b = /^\d+$/.test(parts[2]) ? chain.blocks[Number(parts[2])] : chain.blockByHash(parts[2]);
    if (!b) return page("Block not found", `<h1>No block ${esc(parts[2])}</h1>`);
    return page(`Block ${b.number}`, `<h1>Block ${b.number}</h1><table>
<tr><th>hash</th><td class="mono wrap">${esc(b.hash)}</td></tr><tr><th>timestamp</th><td>${esc(b.timestamp)} (${esc(new Date(Number(b.timestamp) * 1000).toISOString())})</td></tr>
<tr><th>base fee</th><td>${esc(b.baseFee)} wei</td></tr><tr><th>gas used</th><td>${esc(b.gasUsed)}</td></tr></table>
<h2>Transactions</h2><table>${b.txHashes.map((h) => `<tr><td class="mono"><a href="/explorer/tx/${h}">${h}</a></td></tr>`).join("") || "<tr><td class='muted'>none</td></tr>"}</table>`);
  }
  return page("Not found", "<h1>Not found</h1>");
}

function index(chain: FakeChain, sidecar: Sidecar): Response {
  const blocks = chain.blocks.slice(-12).reverse();
  const admissions = sidecar.explorerAdmissions({ limit: 30 }).items;
  return page("fakechain explorer", `<h1>fakechain explorer</h1>
<p>Head block ${esc(chain.head.number)}, genesis <code>${esc(chain.genesisHash)}</code>, chain id ${esc(chain.chainId)}.</p>
<h2>Latest blocks</h2><table><tr><th>number</th><th>timestamp</th><th>transactions</th><th>gas used</th></tr>
${blocks.map((b) => `<tr><td><a href="/explorer/block/${b.number}">${b.number}</a></td><td>${esc(b.timestamp)}</td><td>${b.txHashes.length}</td><td>${esc(b.gasUsed)}</td></tr>`).join("")}</table>
<h2>Admissions (sidecar)</h2><table><tr><th>hash</th><th>outcome</th><th>nonce keys</th><th>failed rule</th></tr>
${admissions.map((a) => { const f = a.checks.find((c) => c.verdict === "fail"); return `<tr><td class="mono"><a href="/explorer/tx/${a.txHash}">${a.txHash.slice(0, 18)}…</a></td><td class="${a.outcome === "rejected" ? "fail" : ""}">${esc(a.outcome)}</td><td class="mono">${esc(a.nonceKeys.join(", "))}</td><td>${f ? esc(`${f.rule}: ${f.detail ?? ""}`) : ""}</td></tr>`; }).join("") || "<tr><td class='muted'>none yet</td></tr>"}</table>`);
}

function txPage(hash: string, chain: FakeChain, sidecar: Sidecar): Response {
  const rec = chain.tx(hash);
  const receipt = chain.receipt(hash);
  let explorer: ReturnType<Sidecar["explorerTransaction"]> | null = null;
  try { explorer = sidecar.explorerTransaction(hash); } catch { /* the sidecar does not know it */ }
  if (!rec && !explorer) return page("Transaction not found", `<h1>Unknown transaction</h1><p class="mono">${esc(hash)}</p>`);
  const rows: [string, string][] = [["hash", `<span class="mono wrap">${esc(hash)}</span>`]];
  const status = explorer?.entry?.status ?? (receipt ? (receipt.status === "0x1" ? "included, every frame succeeded" : "included, a frame failed") : "pending in the public pool");
  rows.push(["status", esc(status)]);
  if (explorer?.entry && "revertReason" in explorer.entry && explorer.entry.revertReason) rows.push(["reason", esc(explorer.entry.revertReason)]);
  if (receipt) {
    rows.push(["block", `<a href="/explorer/block/${BigInt(receipt.blockNumber as Hex)}">${BigInt(receipt.blockNumber as Hex)}</a>`]);
    rows.push(["gas used", `${BigInt(receipt.gasUsed as Hex)} at ${BigInt(receipt.effectiveGasPrice as Hex)} wei`]);
  }
  let frames = "";
  if (rec?.kind === "eoa") {
    rows.push(["kind", "EOA transaction"], ["from", esc(rec.tx.from)], ["to", esc(rec.tx.to)], ["value", `${esc(formatEther(rec.tx.value))} ETH`]);
    if (receipt?.fakechainRevertReason) rows.push(["revert (fakechain note)", esc(receipt.fakechainRevertReason)]);
  } else {
    const tx = rec?.kind === "frame" ? rec.tx : null;
    rows.push(["kind", `frame transaction${rec?.kind === "frame" ? ` (${rec.via === "alt" ? "alt mempool" : "public pool"})` : ""}`]);
    const sender = tx?.sender ?? explorer?.admission?.sender;
    if (sender) rows.push(["sender", esc(getAddress(sender))]);
    const keys = tx?.nonceKeys.map((k) => `0x${k.toString(16)}`) ?? explorer?.admission?.nonceKeys ?? [];
    rows.push(["nonce keys", `<span class="mono">${esc(keys.join(", "))}</span> at sequence ${esc(tx?.nonceSeq ?? explorer?.admission?.nonce)}`]);
    const fr = (tx?.frames.map((f) => ({ mode: f.mode, target: f.target, exec: f.limits.execution, state: f.limits.state, value: f.value, data: f.data })) ??
      explorer?.admission?.frames.map((f) => ({ mode: f.mode, target: f.target, exec: BigInt(f.limits.execution), state: BigInt(f.limits.state), value: BigInt(f.value), data: f.data as Hex })) ?? []);
    const fReceipts = (receipt?.frameReceipts ?? []) as { status: string; gasUsed: Hex; stateGasUsed: Hex }[];
    const reasons = (receipt?.fakechainRevertReasons ?? {}) as Record<string, string>;
    frames = `<h2>Frames</h2><table><tr><th>#</th><th>mode</th><th>target</th><th>limits (execution / state)</th><th>value</th><th>data</th><th>status</th><th>gas used</th><th>fakechain note</th></tr>
${fr.map((f, i) => `<tr><td>${i}</td><td>${MODES[f.mode] ?? f.mode}</td><td class="mono">${esc(f.target ?? "(sender)")}</td><td>${f.exec} / ${f.state}</td><td>${esc(formatEther(f.value))} ETH</td><td>${size(f.data)} bytes</td>
<td class="${fReceipts[i] && fReceipts[i]!.status !== "0x1" ? "fail" : ""}">${fReceipts[i] ? (fReceipts[i]!.status === "0x1" ? "success" : "reverted") : esc(explorer?.admission?.frameStatuses[i] ?? "")}</td>
<td>${fReceipts[i] ? `${BigInt(fReceipts[i]!.gasUsed)}${BigInt(fReceipts[i]!.stateGasUsed) ? ` + ${BigInt(fReceipts[i]!.stateGasUsed)} state` : ""}` : ""}</td><td>${esc(reasons[String(i)] ?? "")}</td></tr>`).join("")}</table>`;
    if (tx) {
      frames += `<h2>Signature entries</h2><table><tr><th>#</th><th>scheme</th><th>signer</th><th>msg</th><th>bytes</th></tr>
${tx.signatures.map((s, i) => `<tr><td>${i}</td><td>${SCHEMES[s.scheme] ?? s.scheme}</td><td class="mono">${esc(s.signer === "0x" ? "(empty)" : s.signer)}</td><td>${s.msg === "0x" ? "canonical sig hash" : "explicit digest"}</td><td>${size(s.signature)}</td></tr>`).join("")}</table>`;
    }
  }
  const a = explorer?.admission;
  const checks = a ? `<h2>Admission report (sidecar): ${esc(a.outcome)}${a.errorCode !== undefined ? ` (error ${a.errorCode})` : ""}</h2>
<table><tr><th>rule</th><th>frame</th><th>entity</th><th>verdict</th><th>detail</th></tr>
${a.checks.map((c) => `<tr><td>${esc(c.rule)}</td><td>${esc(c.frameIndex ?? "")}</td><td>${esc(c.entity ?? "")}</td><td class="${c.verdict === "fail" ? "fail" : c.verdict === "skipped" ? "muted" : ""}">${esc(c.verdict)}</td><td class="wrap">${esc(c.detail ?? "")}${revertNote(c.detail)}</td></tr>`).join("")}</table>` : "<h2>Admission report</h2><p class='muted'>The sidecar holds no record: this transaction did not come through eth_sendFrameTransaction.</p>";
  const events = explorer?.events.length ? `<h2>Lifecycle</h2><table>${explorer.events.map((e) => `<tr><td>${esc(new Date(e.at).toISOString())}</td><td>${esc(e.kind)}</td><td>${esc(e.status ?? "")}</td><td class="wrap">${esc(e.reason ?? "")}${e.blockNumber !== undefined ? ` block ${e.blockNumber}` : ""}</td></tr>`).join("")}</table>` : "";
  return page(`Transaction ${hash.slice(0, 10)}`, `<h1>Transaction</h1><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>${frames}${checks}${events}`);
}

/** "reverted with data 0x…" decoded to the account's reason, for people reading the page. */
function revertNote(detail?: string): string {
  const m = detail?.match(/with data (0x[0-9a-fA-F]{64})/);
  const text = m ? decodeReason(m[1] as Hex) : null;
  return text ? ` <span class="muted">(the account's reason: "${esc(text)}")</span>` : "";
}
