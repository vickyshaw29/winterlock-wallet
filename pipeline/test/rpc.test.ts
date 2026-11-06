// rpc() against a local HTTP server: which failures mean "the server refused" and which mean "nobody knows".
// Written with Claude Code (AI) for Vicky.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RPC, RpcError, gateway, normalizeNodeReceipt, receiptSucceeded, rpc, withTipFloor } from "../src/rpc.ts";
import { DEVNET, MIN_TIP_WEI } from "../src/config.ts";

type Reply = (req: Request) => Response | Promise<Response>;
let reply: Reply = () => new Response("unset");
let server: ReturnType<typeof Bun.serve>;
let url: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realGateway = DEVNET.gateway;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: (req) => reply(req) });
  url = `http://127.0.0.1:${server.port}/rpc`;
  RPC.timeoutMs = 300;
});
afterAll(() => {
  server.stop(true);
  RPC.timeoutMs = 20_000;
  (DEVNET as any).gateway = realGateway;
});

const failure = async () => {
  const e = await rpc(url, "eth_sendFrameTransaction", []).catch((x) => x);
  expect(e).toBeInstanceOf(RpcError);
  return e as RpcError;
};

describe("the tip floor (spec Fees, Nov 6)", () => {
  test("a tip below the floor is raised to it, the max fee by the same amount; a tip at or above it is kept", () => {
    // the devnet's quote on Nov 6: tip 1,999,999,993 and max fee 2,000,000,001 (8 wei of room for a 7 wei base fee)
    const quote = { maxPriorityFeePerGas: "0x773593f9", maxFeePerGas: "0x77359401" } as const;
    const floored = withTipFloor(quote, 3_000_000_000n);
    expect(BigInt(floored.maxPriorityFeePerGas)).toBe(3_000_000_000n);
    expect(BigInt(floored.maxFeePerGas)).toBe(3_000_000_008n); // the quote's 8 wei of room kept
    expect(withTipFloor(quote, 1_000_000_000n)).toBe(quote);
    expect(withTipFloor(quote, 1_999_999_993n)).toBe(quote);
    expect(withTipFloor(quote, 0n)).toBe(quote);
  });

  test("3 gwei by default on chain 1337, off on any other chain, unless WL_MIN_TIP_WEI says otherwise", () => {
    const want = process.env.WL_MIN_TIP_WEI !== undefined ? BigInt(process.env.WL_MIN_TIP_WEI) : DEVNET.chainId === 1337n ? 3_000_000_000n : 0n;
    expect(MIN_TIP_WEI).toBe(want);
  });

  test("gateway.gasPrice returns the floored quote", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x9" } }))) as unknown as typeof fetch;
    try {
      const q = await gateway.gasPrice();
      expect(BigInt(q.maxPriorityFeePerGas)).toBe(MIN_TIP_WEI > 1n ? MIN_TIP_WEI : 1n);
      expect(BigInt(q.maxFeePerGas) - BigInt(q.maxPriorityFeePerGas)).toBe(8n);
    } finally { globalThis.fetch = real; }
  });
});

test("a created network floors its own quote by its own chain: 3 gwei on 1337, none on 31337, or as given", async () => {
  const { createNetwork } = await import("../src/network.ts");
  const quote = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x9" } }))) as unknown as typeof fetch;
  const tipOf = async (o: { chainId: bigint; minTipWei?: bigint }) =>
    BigInt((await createNetwork({ ...o, nodeUrl: "http://127.0.0.1:1", gatewayUrl: "http://127.0.0.1:2/rpc", fetch: quote }).gateway.gasPrice()).maxPriorityFeePerGas);
  expect(await tipOf({ chainId: 1337n })).toBe(3_000_000_000n);
  expect(await tipOf({ chainId: 31337n })).toBe(1n);
  expect(await tipOf({ chainId: 31337n, minTipWei: 5n })).toBe(5n);
  expect(() => createNetwork({ chainId: 1n, nodeUrl: "http://a", gatewayUrl: "http://b", minTipWei: -1n })).toThrow(/minTipWei must be/);
});

describe("rpc failures", () => {
  test("HTTP 200 with a JSON-RPC error: answered, a refusal", async () => {
    reply = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "validation prefix execution gas sum exceeds MAX_VERIFY_GAS" } });
    const e = await failure();
    expect([e.failure, e.code, e.refused]).toEqual(["answered", -32602, true]);
  });

  test("HTTP 200 with an internal error (-32603): answered, but a server bug, not a refusal", async () => {
    reply = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } });
    const e = await failure();
    expect([e.failure, e.refused]).toEqual(["answered", false]);
  });

  test("a proxy's 502: unknown", async () => {
    reply = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const e = await failure();
    expect([e.failure, e.code, e.refused]).toEqual(["http", 502, false]);
  });

  test("a 500 carrying a JSON-RPC error body is still not a deliberate answer", async () => {
    reply = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } }, 500);
    expect((await failure()).refused).toBe(false);
  });

  test("our timeout: transport, unknown", async () => {
    reply = async () => { await Bun.sleep(1_000); return json({ jsonrpc: "2.0", id: 1, result: "0x1" }); };
    const e = await failure();
    expect([e.failure, e.refused]).toEqual(["transport", false]);
  });

  test("nothing listening: transport", async () => {
    const e = await rpc("http://127.0.0.1:1/rpc", "eth_blockNumber").catch((x) => x);
    expect([e.failure, e.refused]).toEqual(["transport", false]);
  });

  test("a body that is not JSON-RPC: malformed", async () => {
    reply = () => new Response("ok");
    expect((await failure()).failure).toBe("malformed");
    reply = () => json({ jsonrpc: "2.0", id: 1 });
    expect((await failure()).failure).toBe("malformed");
  });

  test("a null result is a result", async () => {
    reply = () => json({ jsonrpc: "2.0", id: 1, result: null });
    expect(await rpc(url, "eth_getTransactionReceipt", [])).toBeNull();
  });
});

describe("the sidecar's status call", () => {
  test("'Frame transaction not found' means it holds no such transaction: null", async () => {
    (DEVNET as any).gateway = url;
    reply = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Frame transaction not found" } });
    expect(await gateway.status(`0x${"ab".repeat(32)}`)).toBeNull();
  });

  test("a status it holds", async () => {
    (DEVNET as any).gateway = url;
    reply = () => json({ jsonrpc: "2.0", id: 1, result: { status: "Submitted" } });
    expect(await gateway.status(`0x${"ab".repeat(32)}`)).toBe("Submitted");
  });

  test("no answer is not 'not held': it throws", async () => {
    (DEVNET as any).gateway = url;
    reply = () => new Response("bad gateway", { status: 502 });
    await expect(gateway.status(`0x${"ab".repeat(32)}`)).rejects.toBeInstanceOf(RpcError);
  });
});

describe("receipts in one vocabulary", () => {
  const raw = (frame: string, tx = "0x1") => ({ blockNumber: "0x1", status: tx, payer: "0x00000000000000000000000000000000000000a1", cumulativeGasUsed: "0x1", frameReceipts: [{ status: "0x1", gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }, { status: frame, gasUsed: "0x1", stateGasUsed: "0x0", logs: [] }] });
  test("node bytes and sidecar words map to success, reverted, skipped", () => {
    expect(normalizeNodeReceipt(raw("0x2")).frameReceipts[1]!.status).toBe("skipped");
    expect(normalizeNodeReceipt(raw("0x0")).frameReceipts[1]!.status).toBe("reverted");
    expect(normalizeNodeReceipt({ ...raw("reverted"), status: "success" }).frameReceipts[1]!.status).toBe("reverted");
  });
  test("success needs the transaction and every frame", () => {
    expect(receiptSucceeded(normalizeNodeReceipt(raw("0x1")))).toBe(true);
    expect(receiptSucceeded(normalizeNodeReceipt(raw("0x0")))).toBe(false);
    expect(receiptSucceeded(normalizeNodeReceipt(raw("0x2")))).toBe(false);
    expect(receiptSucceeded(normalizeNodeReceipt(raw("0x1", "0x0")))).toBe(false);
  });
  test("an unknown status is an error, never a guess", () => {
    expect(() => normalizeNodeReceipt(raw("0x3"))).toThrow("unknown frame status");
  });
});
