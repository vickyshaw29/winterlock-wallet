// rpc() against a local HTTP server: which failures mean "the server refused" and which mean "nobody knows".
// Written with Claude Code (AI) for Vicky.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RPC, RpcError, gateway, normalizeNodeReceipt, receiptSucceeded, rpc } from "../src/rpc.ts";
import { DEVNET } from "../src/config.ts";

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
