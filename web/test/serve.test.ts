// serve.ts: the static files and their headers, /api/* forwarded with only the content type (the browser's Host,
// Origin and cookies dropped), and the two checks it makes for its own origin first, so it never becomes a way around
// the backend's. The handler is called directly with any Host; one test listens on loopback.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import { CSP, MAX_BODY, SERVE, createHandler, startWebServer } from "../serve.ts";

const loopbackFetch = globalThis.fetch;
type Call = { url: string; init: RequestInit };

function harness(answer?: () => Promise<Response>) {
  const calls: Call[] = [];
  const handle = createHandler({
    ownPort: () => 5173, backendUrl: "http://127.0.0.1:8787/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (answer) return answer();
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json; charset=utf-8", "set-cookie": "s=1" } });
    },
  });
  const req = (path: string, init: RequestInit = {}, host = "127.0.0.1:5173") => handle(new Request(`http://${host}${path}`, init));
  return { calls, req };
}

describe("forwarding /api/*", () => {
  test("only the content type travels: no Origin, Host, cookie, referer or authorization; path, query and body kept", async () => {
    const { calls, req } = harness();
    const res = await req("/api/wallets/0xabc/send?x=1", {
      method: "POST", body: '{"to":"0x1"}',
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173", cookie: "c=1", referer: "http://127.0.0.1:5173/hot-cold.html", authorization: "Bearer t" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/api/wallets/0xabc/send?x=1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ accept: "application/json", "content-type": "application/json" });
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"to":"0x1"}');
    const get = await req("/api/wallets");
    expect(get.status).toBe(201);
    expect(calls[1]!.init).toEqual({ method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  });

  test("its own Host and Origin only: another host name (DNS rebinding), another port or another origin is 403, never forwarded", async () => {
    const { calls, req } = harness();
    for (const host of ["attacker.example:5173", "127.0.0.1:8787", "localhost:80", "127.0.0.2:5173"]) {
      const res = await req("/api/wallets", {}, host);
      expect([host, res.status, ((await res.json()) as { error: string }).error]).toEqual([host, 403, "forbidden"]);
    }
    for (const origin of ["https://attacker.example", "null", "http://127.0.0.1:8787", "http://localhost:5174"]) {
      const res = await req("/api/wallets", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
      expect([origin, res.status]).toEqual([origin, 403]);
    }
    expect(calls).toHaveLength(0);
    expect((await req("/api/wallets", { headers: { origin: "http://localhost:5173" } }, "localhost:5173")).status).toBe(201);
    expect((await req("/", { headers: { origin: "http://127.0.0.1:5173" } })).status).toBe(200);
  });

  test("a body over the backend's limit is refused here; a backend that does not answer is 502 in the spec's shape", async () => {
    const { calls, req } = harness(async () => { throw new TypeError("Unable to connect"); });
    const big = await req("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_BODY + 1) });
    expect([big.status, await big.json()]).toEqual([400, { error: "bad_request", detail: `the body is larger than ${MAX_BODY} bytes` }]);
    expect(calls).toHaveLength(0);
    const down = await req("/api/wallets");
    expect([down.status, await down.json()]).toEqual([502, { error: "backend_unreachable", detail: "the backend at http://127.0.0.1:8787 did not answer: Unable to connect" }]);
  });

  test("a backend that fails mid-answer: 502 backend_unreachable in the spec's shape, not a broken or HTML answer", async () => {
    const cut = () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"txHash":"0x')); c.error(new Error("connection reset by the backend")); },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const { req } = harness(async () => cut());
    const res = await req("/api/wallets/0xabc/send", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([res.status, res.headers.get("content-type"), await res.json()]).toEqual([502, "application/json; charset=utf-8", {
      error: "backend_unreachable", detail: "the backend at http://127.0.0.1:8787 failed mid-answer: connection reset by the backend",
    }]);
  });

  test("/web/config names the backend for the status line", async () => {
    const { req } = harness();
    expect(await (await req("/web/config")).json()).toEqual({ backendUrl: "http://127.0.0.1:8787" });
  });
});

describe("static files", () => {
  test("pages with the CSP, scripts and the stylesheet with their types, all nosniff", async () => {
    const { req } = harness();
    const index = await req("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("content-security-policy")).toBe(CSP);
    expect(index.headers.get("x-frame-options")).toBe("DENY");
    expect(await index.text()).toContain("<title>Winterlock</title>");
    for (const [p, type] of [["/style.css", "text/css; charset=utf-8"], ["/api.js", "text/javascript; charset=utf-8"], ["/session.html", "text/html; charset=utf-8"]]) {
      const res = await req(p!);
      expect([p, res.status, res.headers.get("content-type"), res.headers.get("x-content-type-options")]).toEqual([p, 200, type, "nosniff"]);
    }
    const head = await req("/hot-cold.html", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect(CSP).toContain("connect-src 'self'"); // a page can only talk to this server
  });

  test("the self-hosted fonts as font/woff2; the CSP takes fonts and styles from this origin only, no third-party host", async () => {
    const { req } = harness();
    for (const p of ["/fonts/archivo-latin.woff2", "/fonts/besley-latin.woff2"]) {
      const res = await req(p);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([p, res.status, res.headers.get("content-type"), res.headers.get("x-content-type-options")]).toEqual([p, 200, "font/woff2", "nosniff"]);
      expect([p, new TextDecoder().decode(bytes.slice(0, 4))]).toEqual([p, "wOF2"]); // a real woff2 file, not an error page
      expect(res.headers.get("content-security-policy")).toBeNull(); // the CSP goes on pages
    }
    const parts = CSP.split("; ");
    expect(parts).toContain("font-src 'self'");
    expect(parts).toContain("style-src 'self'");
    expect(CSP).not.toMatch(/https?:|googleapis|gstatic|unsafe-inline/);
    const page = await req("/hot-cold.html");
    expect(page.headers.get("content-security-policy")).toBe(CSP);
  });

  test("nothing outside web/public, and only page, script, style and image types inside it", async () => {
    const { req } = harness();
    for (const p of ["/../serve.ts", "/%2e%2e/serve.ts", "/..%2fserve.ts", "/%2e%2e%2f%2e%2e%2fbackend/src/app.ts", "/tsconfig.json", "/nope.html", "/public/index.html", "/index.html%00.js", "/%E0%A4%A"]) {
      const res = await req(p);
      expect([p, res.status === 404 || res.status === 400]).toEqual([p, true]);
    }
    expect((await req("/index.html", { method: "POST" })).status).toBe(405);
  });
});

test("over sockets: a backend that closes mid-body is a 502 in JSON; an error inside the server is a 500 in JSON, never Bun's page", async () => {
  expect(SERVE).toEqual({ hostname: "127.0.0.1", development: false, idleTimeout: 120 });
  // a backend that sends its headers and part of the body, then closes the connection
  const backend = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(sock) { sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 400\r\n\r\n{"address":"0x'); sock.end(); } },
  });
  const web = startWebServer({ port: 0, backendUrl: `http://127.0.0.1:${backend.port}`, fetch: loopbackFetch, log: () => {} });
  try {
    const res = await loopbackFetch(`${web.url}/api/wallets`);
    expect([res.status, res.headers.get("content-type")]).toEqual([502, "application/json; charset=utf-8"]);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("backend_unreachable");
    expect(body.detail).toStartWith(`the backend at http://127.0.0.1:${backend.port} failed mid-answer: `);
  } finally {
    web.stop();
    backend.stop(true);
  }
  // anything that escapes the handler (here the request log throws) reaches Bun.serve's error handler: JSON, no stack
  const broken = startWebServer({ port: 0, backendUrl: "http://127.0.0.1:1", fetch: loopbackFetch, log: () => { throw new Error("the log is full"); } });
  try {
    const res = await loopbackFetch(`${broken.url}/api/wallets`);
    const text = await res.text();
    expect([res.status, res.headers.get("content-type"), JSON.parse(text)]).toEqual([500, "application/json; charset=utf-8", {
      error: "internal", detail: "internal error in the web server; its log has the cause",
    }]);
    expect(text).not.toContain("<");
  } finally {
    broken.stop();
  }
});

test("listens on 127.0.0.1 only, on a free port; a forged Host over the socket is refused", async () => {
  const web = startWebServer({ port: 0, backendUrl: "http://127.0.0.1:1", fetch: loopbackFetch, log: () => {} });
  try {
    expect(web.server.hostname).toBe("127.0.0.1");
    expect(web.url).toBe(`http://127.0.0.1:${web.port}`);
    expect((await loopbackFetch(`${web.url}/agent.html`)).status).toBe(200);
    const forged = await loopbackFetch(`${web.url}/api/wallets`, { headers: { host: `attacker.example:${web.port}` } });
    expect(forged.status).toBe(403);
    const down = await loopbackFetch(`${web.url}/api/wallets`);
    expect(down.status).toBe(502); // port 1: nothing listens there
  } finally {
    web.stop();
  }
});
