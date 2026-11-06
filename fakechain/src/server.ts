// The fake chain over HTTP on 127.0.0.1 only: the node's JSON-RPC at /, the sidecar's at /rpc, the explorer at /explorer.
// Written with Claude Code (AI) for Vicky.
import "./guard.ts";
import { numberToHex } from "viem";
import { explorerResponse } from "./explorer.ts";
import { nodeMethods, sidecarMethods, toRpcError, type Method } from "./methods.ts";
import type { FakeChain } from "./chain.ts";
import type { Sidecar } from "./sidecar.ts";

/** A bigint left in a result would break JSON.stringify; send it as a quantity instead. */
const json = (body: unknown) => new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? numberToHex(v) : v)), { headers: { "content-type": "application/json" } });

async function jsonRpc(req: Request, methods: Record<string, Method>, log: (s: string) => void): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const one = async (r: unknown) => {
    const call = r as { id?: unknown; method?: unknown; params?: unknown } | null;
    const id = call?.id ?? null;
    if (!call || typeof call !== "object" || typeof call.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    const fn = methods[call.method];
    if (!fn) return { jsonrpc: "2.0", id, error: { code: -32601, message: `the method ${call.method} does not exist/is not available` } };
    try {
      const result = await fn(Array.isArray(call.params) ? call.params : []);
      return { jsonrpc: "2.0", id, result: result ?? null };
    } catch (e) {
      const error = toRpcError(e);
      if (error.code === -32603) log(`internal error in ${call.method}: ${error.data !== undefined ? JSON.stringify(error.data) : (e as Error)?.stack ?? e}`);
      return { jsonrpc: "2.0", id, error };
    }
  };
  return json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
}

export function serve(chain: FakeChain, sidecar: Sidecar, port: number, log: (s: string) => void = console.error) {
  const node = nodeMethods(chain), side = sidecarMethods(chain, sidecar);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && (url.pathname === "/" || url.pathname === "")) return jsonRpc(req, node, log);
      if (req.method === "POST" && (url.pathname === "/rpc" || url.pathname === "/rpc/")) return jsonRpc(req, side, log);
      if (req.method === "GET" && url.pathname.startsWith("/explorer")) return explorerResponse(url, chain, sidecar);
      if (req.method === "GET" && url.pathname === "/") {
        return new Response("fakechain: a local FAKE devnet (not ethrex). JSON-RPC: POST / (node), POST /rpc (sidecar). Explorer: GET /explorer\n");
      }
      return new Response("not found\n", { status: 404 });
    },
  });
}
