// node.call (the account's views) and node.transactionByHash (the public pool's refusal rule) against a local server:
// the request each one makes and what it returns. Nothing leaves this machine.
// Written with Claude Code (AI) for Vicky.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RpcError, node } from "../src/rpc.ts";
import { DEVNET } from "../src/config.ts";

let seen: any[] = [];
let result: unknown = null;
let server: ReturnType<typeof Bun.serve>;
const realNode = DEVNET.node;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as { id: number };
      seen.push(body);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  (DEVNET as any).node = `http://127.0.0.1:${server.port}`;
});
afterAll(() => { server.stop(true); (DEVNET as any).node = realNode; });

describe("reads for the backend (Nov 6)", () => {
  test("node.call is eth_call at the latest block", async () => {
    seen = [];
    result = `0x${"00".repeat(31)}0a`;
    const to = "0x00000000000000000000000000000000000000a1" as const;
    expect(await node.call(to, "0xebf0c717")).toBe(result as `0x${string}`);
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: "0xebf0c717" }, "latest"] }]);
  });

  test("node.transactionByHash is eth_getTransactionByHash; null means the node holds no such transaction", async () => {
    seen = [];
    result = null;
    const hash = `0x${"ab".repeat(32)}` as const;
    expect(await node.transactionByHash(hash)).toBeNull();
    expect(seen.map((b) => [b.method, b.params])).toEqual([["eth_getTransactionByHash", [hash]]]);
    result = { hash };
    expect(await node.transactionByHash(hash)).toEqual({ hash });
  });

  test("a node that cannot be reached is an RpcError, never a null", async () => {
    (DEVNET as any).node = "http://127.0.0.1:1";
    try {
      expect(await node.transactionByHash(`0x${"cd".repeat(32)}`).catch((e) => e)).toBeInstanceOf(RpcError);
    } finally {
      (DEVNET as any).node = `http://127.0.0.1:${server.port}`;
    }
  });
});
