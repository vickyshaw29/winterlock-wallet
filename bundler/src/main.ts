// The Winterlock bundler's HTTP server: JSON-RPC on 127.0.0.1 only, for MetaMask Flask (bundler.ts).
//   bun src/main.ts                 listens on http://127.0.0.1:15192/rpc
// WL_BUNDLER_PORT, WL_CHAIN_ID, WL_NODE_URL, WL_BUNDLER_SIDECAR_URL (default: the miner's own sidecar, which relays;
// the public gateway admits but often has no peers, Nov 6), WL_EXPLORER_URL, WL_BUNDLER_DATA (where records live).
// Written with Claude Code (AI) for Vicky.
import path from "node:path";
import { createPipeline, currentChain } from "../../pipeline/src/index.ts";
import { Bundler, answer, fileStore } from "./bundler.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
const port = Number(env("WL_BUNDLER_PORT", "15192"));
const chainId = BigInt(env("WL_CHAIN_ID", "1337"));
const nodeUrl = env("WL_NODE_URL", "https://altmempool.forshtat.com");
const sidecarUrl = env("WL_BUNDLER_SIDECAR_URL", "https://altmempool.forshtat.com/rpc");
const explorerUrl = env("WL_EXPLORER_URL", "https://explorer.altmempool.wtf");
const p = createPipeline({ chainId, nodeUrl, gatewayUrl: sidecarUrl, explorerUrl });

// The node must be on the chain the records are for; the records file is per chain and genesis.
const chain = await currentChain(p.network);
if (chain.chainId !== chainId) throw new Error(`the node answers chain ${chain.chainId}, not ${chainId}`);
await p.checkSystemContracts();
const dataDir = env("WL_BUNDLER_DATA", path.join(import.meta.dir, "..", ".data"));
const store = fileStore(path.join(dataDir, `ops-${chainId}-${chain.genesisHash.slice(2, 10)}.json`));
const bundler = new Bundler({ network: p.network, store, log: (l) => console.log(`${new Date().toISOString().slice(11, 19)} ${l}`) });
bundler.resume();

// MetaMask calls from its extension service worker, a page may call it too; nothing here is secret (it only relays
// signed transactions and reports their outcomes), so any origin may read. Chrome's private-network preflight asks
// for the last header when a public origin calls 127.0.0.1.
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-private-network": "true",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: 512 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ chainId: chainId.toString(), genesis: chain.genesisHash, sidecar: sidecarUrl, ops: [...bundler.ops.values()].map((o) => ({ hash: o.hash, state: o.state, nonceKey: o.nonceKey, deadline: o.deadline })) });
    }
    if (req.method !== "POST" || (url.pathname !== "/rpc" && url.pathname !== "/")) return json({ error: "POST JSON-RPC to /rpc" }, 404);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const methods = (Array.isArray(body) ? body : [body]).map((r: any) => r?.method).join(", ");
    if (!/eth_getUserOperationReceipt/.test(methods)) console.log(`${new Date().toISOString().slice(11, 19)} <- ${methods}`);
    return json(await answer(bundler, body));
  },
});
console.log(`Winterlock bundler on http://127.0.0.1:${port}/rpc, chain ${chainId} (genesis ${chain.genesisHash.slice(0, 10)}…), sending to ${sidecarUrl}`);
