// A network the send path talks to: its chain id, its explorer and its two RPC clients (Nov 6, so a browser page or a
// Snap can hold its own networks, side by side, with nothing global between them).
// Written with Claude Code (AI) for Vicky.
//
// Every function of the send path takes an optional network and falls back to defaultNetwork: DEVNET (from the WL_*
// variables) with the module-level gateway and node, the same objects the backend's and pipeline's tests mock. So Node
// code that passes no network behaves exactly as before.
import { DEVNET, explorerTxUrl } from "./config.ts";
import { createGateway, createNode, gateway, node, type GatewayClient, type NodeClient, type RpcTransport } from "./rpc.ts";

export interface Network {
  readonly chainId: bigint;
  readonly gateway: GatewayClient;
  readonly node: NodeClient;
  explorerTxUrl(hash: string): string;
}

/** DEVNET and the module-level clients, read at every use (tests repoint DEVNET and mock the clients' methods). */
export const defaultNetwork: Network = Object.freeze({
  get chainId() { return DEVNET.chainId; },
  gateway,
  node,
  explorerTxUrl: (hash: string) => explorerTxUrl(hash),
});

export interface NetworkOptions extends RpcTransport {
  chainId: bigint;
  /** ethrex node: eth_* reads, ethrex_simulateFrameTransaction, the public mempool */
  nodeUrl: string;
  /** sidecar gateway: eth_sendFrameTransaction, status, receipts, gas price */
  gatewayUrl: string;
  /** default https://explorer.altmempool.wtf */
  explorerUrl?: string;
}

const EXPLORER = "https://explorer.altmempool.wtf";
/** A created network's RPC timeout when none is given: fixed here, not RPC.timeoutMs, so nothing global reaches it. */
export const NETWORK_TIMEOUT_MS = 20_000;

/** A network of its own: fixed URLs, chain id and timeout, its own clients. Nothing global is read or changed. */
export function createNetwork(o: NetworkOptions): Network {
  if (typeof o.chainId !== "bigint" || o.chainId <= 0n || o.chainId >= 1n << 256n) throw new Error(`chainId must be a positive bigint below 2^256, got ${String(o.chainId)}`);
  for (const [name, url] of [["nodeUrl", o.nodeUrl], ["gatewayUrl", o.gatewayUrl], ["explorerUrl", o.explorerUrl ?? EXPLORER]] as const) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(url).protocol); } catch { /* not a URL */ }
    if (!ok) throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(url)}`);
  }
  const explorerUrl = new URL(o.explorerUrl ?? EXPLORER);
  if (explorerUrl.search || explorerUrl.hash) throw new Error(`explorerUrl must have no query or fragment: transaction links are built as <explorerUrl>/tx/<hash>`);
  if (o.fetch !== undefined && typeof o.fetch !== "function") throw new Error("fetch must be a function");
  const timeoutMs = o.timeoutMs ?? NETWORK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`);
  const transport: RpcTransport = { ...(o.fetch ? { fetch: o.fetch } : {}), timeoutMs };
  const explorer = (o.explorerUrl ?? EXPLORER).replace(/\/+$/, "");
  return Object.freeze({
    chainId: o.chainId,
    gateway: createGateway(o.gatewayUrl, transport),
    node: createNode(o.nodeUrl, transport),
    explorerTxUrl: (hash: string) => `${explorer}/tx/${hash}`,
  });
}
