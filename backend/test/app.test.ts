// The HTTP layer: routes under /api, methods, the Host and Origin checks that keep web pages from driving this process,
// JSON bodies only, the error shape, and a real listen on 127.0.0.1 (loopback only: nothing leaves this machine).
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import type { Address } from "viem";
import { node } from "../../pipeline/src/index.ts";
import { SERVE } from "../src/app.ts";
import { eth } from "../src/chain.ts";
import { lost } from "./fake-chain.ts";
import { Harness, TARGET } from "./helpers.ts";

const loopbackFetch = globalThis.fetch; // captured before the fake chain replaces fetch

let h: Harness;
let a: Address;
beforeEach(async () => { h = await Harness.create(); a = await h.wallet(); });
afterEach(async () => { await h.destroy(); });

describe("routes", () => {
  test("unknown paths and actions are 404 with the error shape; inherited names are not actions", async () => {
    for (const [method, p] of [
      ["GET", "/nope"], ["GET", `/wallets/${a}/nope`], ["POST", `/wallets/${a}/toString`], ["GET", `/wallets/${a}/constructor`],
      ["POST", `/wallets/${a}/__proto__`], ["POST", `/wallets/${a}/send/extra`], ["GET", `/tx/0x${"11".repeat(32)}/receipt`],
    ] as const) {
      const r = await h.req(method, p, method === "POST" ? { to: TARGET } : undefined);
      expect([r.status, r.body.error]).toEqual([404, "not_found"]);
      expect(Object.keys(r.body).sort()).toEqual(["detail", "error"]);
    }
    const outside = await h.app.fetch(new Request("http://127.0.0.1:8787/wallets"));
    expect(outside.status).toBe(404);
  });

  test("the wrong method is 405; GET routes take no body, POST routes need JSON", async () => {
    expect((await h.req("GET", `/wallets/${a}/send`)).status).toBe(405);
    expect((await h.req("POST", `/wallets/${a}`, {})).status).toBe(405);
    expect((await h.req("POST", `/tx/0x${"11".repeat(32)}`, {})).status).toBe(405);
    expect((await h.req("DELETE", "/wallets")).status).toBe(405);
    const big = await h.req("POST", `/wallets/${a}/send`, JSON.stringify({ to: TARGET, data: `0x${"00".repeat(40_000)}` }));
    expect([big.status, big.body.detail]).toEqual([400, "the body is larger than 65536 bytes"]);
    const noType = await h.req("POST", `/wallets/${a}/send`, JSON.stringify({ to: TARGET }), { "content-type": "text/plain" });
    expect([noType.status, noType.body.error]).toEqual([400, "bad_request"]);
  });

  test("400 for a malformed address or hash in the path", async () => {
    for (const p of ["/wallets/0x12", "/wallets/0x12/txs", "/wallets/0x12/send", "/tx/0x12"]) {
      const r = await h.req(p.endsWith("send") ? "POST" : "GET", p, p.endsWith("send") ? { to: TARGET } : undefined);
      expect([r.status, r.body.error]).toEqual([400, "bad_request"]);
    }
  });

  test("an unexpected error is a 500 with a generic detail; the cause goes to the log only", async () => {
    const store = h.app.backend.store;
    const real = store.forWallet.bind(store);
    store.forWallet = () => { throw new TypeError("store index broken at /some/path"); };
    try {
      const r = await h.req("GET", `/wallets/${a}/txs`);
      expect([r.status, r.body]).toEqual([500, { error: "internal", detail: "internal error; the backend's log has the cause" }]);
      expect(h.logs.some((l) => l === "internal error: TypeError: store index broken at /some/path")).toBe(true);
    } finally {
      store.forWallet = real;
    }
  });

  test("GET /wallets is 502 when the node cannot be read", async () => {
    const realBalance = node.balance;
    node.balance = async () => { throw lost("eth_getBalance"); };
    try {
      const r = await h.req("GET", "/wallets");
      expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    } finally {
      node.balance = realBalance;
    }
  });
});

describe("only this host, only this origin", () => {
  test("a request addressed to another host name is refused (DNS rebinding)", async () => {
    const r = await h.app.fetch(new Request("http://attacker.example:8787/api/wallets"));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("forbidden");
    expect((await h.app.fetch(new Request("http://localhost:8787/api/wallets"))).status).toBe(200);
    expect((await h.app.fetch(new Request("http://127.0.0.1:9999/api/wallets"))).status).toBe(403); // another port
  });

  test("a cross-origin request is refused before it can sign anything; the same origin is served", async () => {
    const cross = await h.app.fetch(new Request(`http://127.0.0.1:8787/api/wallets/${a}/send`, {
      method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify({ to: TARGET, valueWei: "1" }),
    }));
    expect(cross.status).toBe(403);
    expect(h.chain.sent.length).toBe(0);
    expect(Object.keys(h.coldJournal(a).leaves)).toEqual([]);
    const same = await h.app.fetch(new Request("http://127.0.0.1:8787/api/wallets", { headers: { origin: "http://127.0.0.1:8787" } }));
    expect(same.status).toBe(200);
  });

  test("listen binds 127.0.0.1 and answers there", async () => {
    await h.close();
    h.cfg.port = 0; // a free port
    h.open();
    const server = h.app.listen();
    try {
      expect(server.hostname).toBe("127.0.0.1");
      const res = await loopbackFetch(`http://127.0.0.1:${server.port}/api/wallets`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(((await res.json()) as { address: string }[]).map((w) => w.address)).toEqual([a]);
    } finally {
      server.stop(true);
    }
  });

  test("no Host or a malformed one is a JSON 403, never Bun's development page with a stack trace (D)", async () => {
    await h.close();
    h.cfg.port = 0;
    h.open();
    const server = h.app.listen();
    try {
      expect([server.development, SERVE.idleTimeout]).toEqual([false, 60]);
      for (const head of ["GET /api/wallets HTTP/1.0\r\n", "GET /api/wallets HTTP/1.1\r\nHost: exa mple\r\n", "GET /api/wallets HTTP/1.1\r\nHost: [::1\r\n"]) {
        const out = await raw(server.port!, `${head}Connection: close\r\n\r\n`);
        expect(out).toStartWith("HTTP/1.1 403");
        expect(out).toContain('{"error":"forbidden","detail":"this backend answers only requests addressed to 127.0.0.1 or localhost on its own port"}');
        expect(out).not.toMatch(/<html|at fetch|\.ts:\d+/i);
      }
      // HTTP/1.1 with no Host at all never reaches the handler: Bun refuses it itself, with no body
      expect(await raw(server.port!, "GET /api/wallets HTTP/1.1\r\nConnection: close\r\n\r\n")).toStartWith("HTTP/1.1 400 Bad Request\r\n");
      // a declared Content-Length over the limit is answered at once, before any of the body arrives
      const host = `127.0.0.1:${server.port}`;
      const declared = await raw(server.port!, `POST /api/wallets/${a}/send HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`);
      expect(declared).toStartWith("HTTP/1.1 400");
      expect(declared).toContain("the body is larger than 65536 bytes");
    } finally {
      server.stop(true);
    }
  });

  test("the body limit counts bytes, not characters (D)", async () => {
    const wide = JSON.stringify({ to: TARGET, data: "€".repeat(30_000) }); // about 30,000 characters, 90,000 bytes
    expect(wide.length).toBeLessThan(65_536);
    const r = await h.req("POST", `/wallets/${a}/send`, wide);
    expect([r.status, r.body.detail]).toEqual([400, "the body is larger than 65536 bytes"]);
    const declared = await h.req("POST", `/wallets/${a}/send`, JSON.stringify({ to: TARGET }), { "content-length": "1000000" });
    expect([declared.status, declared.body.detail]).toEqual([400, "the body is larger than 65536 bytes"]);
    expect(h.chain.sent.length).toBe(0);
  });
});

describe("GET /api/status (G)", () => {
  test("chain id, head, the head's age, stalled and fake", async () => {
    const r = await h.req("GET", "/status");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["chainId", "fake", "head", "headAgeSeconds", "stalled"]);
    expect([r.body.chainId, r.body.head, r.body.stalled, r.body.fake]).toEqual([1337, Number(h.chain.head), false, false]);
    expect(Math.abs(r.body.headAgeSeconds)).toBeLessThanOrEqual(2);
    // a head two minutes old: stalled, as the 503 rule has it
    h.chain.times.set(h.chain.head, BigInt(Math.floor(Date.now() / 1000)) - 120n);
    const stale = (await h.req("GET", "/status")).body;
    expect([stale.stalled, stale.headAgeSeconds >= 120]).toEqual([true, true]);
    // the local fake chain answers chain id 31337
    const realIdentity = eth.chainIdentity;
    eth.chainIdentity = async () => ({ chainId: 31337n, genesisHash: `0x${"aa".repeat(32)}` });
    try {
      expect((await h.req("GET", "/status")).body).toMatchObject({ chainId: 31337, fake: true });
    } finally {
      eth.chainIdentity = realIdentity;
    }
    expect((await h.req("POST", "/status", {})).status).toBe(405);
  });

  test("502 when the node cannot be read", async () => {
    const realBlock = node.block;
    node.block = async () => { throw lost("eth_getBlockByNumber"); };
    try {
      const r = await h.req("GET", "/status");
      expect([r.status, r.body.error]).toEqual([502, "rpc_failed"]);
    } finally {
      node.block = realBlock;
    }
  });

  test("a halted fake chain: GET /status says stalled, as the send's 503 does; its two clocks agree (Nov 6 fix)", async () => {
    h.chain.halted = true;
    const s = (await h.req("GET", "/status")).body;
    expect([s.stalled, s.headAgeSeconds >= 120, s.head]).toEqual([true, true, Number(h.chain.head)]);
    expect((await node.block("latest")).timestamp).toBe(await node.blockTimestamp());
    expect((await node.block(h.chain.head)).timestamp).toBe(await node.blockTimestamp()); // the head, by number or by tag
    const send = await h.req("POST", `/wallets/${a}/send`, { to: TARGET, valueWei: "1" });
    expect([send.status, send.body.error]).toEqual([503, "chain_stalled"]);
    h.chain.halted = false;
    expect((await h.req("GET", "/status")).body.stalled).toBe(false);
  });
});

/** One raw HTTP exchange on loopback, for requests a Request object cannot make (no Host, a malformed one). */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    const done = () => { clearTimeout(timer); s.destroy(); resolve(out); };
    s.on("data", (d) => { out += d.toString(); if (/\r\n\r\n/.test(out) && (/content-length: 0\r\n/i.test(out) || out.trimEnd().endsWith("}"))) done(); });
    s.on("close", done);
    s.on("error", done);
    const timer = setTimeout(done, 2_000);
  });
}
