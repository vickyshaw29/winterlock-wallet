// The HTTP routes of Shared interfaces 5, all under /api, on 127.0.0.1 only. No framework: one fetch handler.
// Written with Claude Code (AI) for Vicky.
//   - this process holds seeds and can send money, so a web page must not be able to drive it: requests must name
//     this host (no DNS rebinding), cross-origin requests are refused, and bodies must be JSON (which a page on
//     another origin cannot send without a CORS preflight this server never approves).
//   - request logs carry the method, path, status and time, never a body.
import type { Server } from "bun";
import { Backend, type Deps } from "./backend.ts";
import type { Config } from "./config.ts";
import { HttpError, errorResponse, json } from "./http.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_BODY = 64 * 1024;
const NOT_OURS = "this backend answers only requests addressed to 127.0.0.1 or localhost on its own port";

/**
 * Bun.serve's settings besides the handlers (review, Nov 6): never Bun's development error page, which shows a stack
 * trace, and an idle timeout of 60 s instead of Bun's 10 s, so a slow read of the chain is not cut off.
 */
export const SERVE = { hostname: "127.0.0.1", development: false, idleTimeout: 60 } as const;

/** The body as JSON, at most MAX_BODY bytes: counted in bytes, and refused from its Content-Length before it is read. */
async function readJson(req: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(400, "bad_request", "send the body as JSON, with content-type application/json");
  const tooBig = () => new HttpError(400, "bad_request", `the body is larger than ${MAX_BODY} bytes`);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw tooBig();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) throw tooBig();
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, "bad_request", "the body is not JSON"); }
}

export interface App {
  backend: Backend;
  fetch: (req: Request) => Promise<Response>;
  start: () => void;
  /** listens on 127.0.0.1 at the configured port (0 picks a free one) */
  listen: () => Server<undefined>;
  close: () => Promise<void>;
}

export function createApp(cfg: Config, deps: Deps = {}): App {
  const backend = new Backend(cfg, deps);
  let port = cfg.port;
  let server: Server<undefined> | null = null;
  const own = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function route(req: Request, url: URL): Promise<Response> {
    if (!own().has(url.host)) throw new HttpError(403, "forbidden", NOT_OURS);
    const origin = req.headers.get("origin");
    if (origin !== null && ![...own()].some((h) => origin === `http://${h}`)) throw new HttpError(403, "forbidden", "cross-origin requests are refused");

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") throw new HttpError(404, "not_found", `no route ${url.pathname}`);
    const [, area, id, action, ...rest] = parts;
    const method = req.method;
    const only = (m: string) => { if (method !== m) throw new HttpError(405, "method_not_allowed", `${url.pathname} takes ${m}`); };

    if (area === "status" && id === undefined) { only("GET"); return json(200, await backend.status()); }
    if (area === "wallets" && id === undefined) {
      if (method === "GET") return json(200, await backend.listWallets());
      only("POST");
      return backend.createWallet(await readJson(req));
    }
    if (area === "wallets" && id !== undefined && rest.length === 0) {
      if (!ADDRESS.test(id)) throw new HttpError(400, "bad_request", `${id.slice(0, 64)} is not an address`);
      if (action === undefined) { only("GET"); return json(200, await backend.walletView(id)); }
      if (action === "txs") { only("GET"); return json(200, backend.walletTxs(id)); }
      const posts = { send: backend.send, rotate: backend.rotate, "hot-policy": backend.hotPolicy, tickets: backend.tickets };
      // own keys only: "toString" or "constructor" must not reach Object.prototype
      if (Object.hasOwn(posts, action)) {
        only("POST");
        return posts[action as keyof typeof posts].call(backend, id, await readJson(req));
      }
    }
    // parallel lanes: a plan for n lanes at once, read only (query: n, mode, valueWei, to, expirySeconds)
    if (area === "wallets" && id !== undefined && action === "lanes" && rest.length === 1 && rest[0] === "plan") {
      if (!ADDRESS.test(id)) throw new HttpError(400, "bad_request", `${id.slice(0, 64)} is not an address`);
      only("GET");
      return json(200, await backend.lanesPlan(id, url.searchParams));
    }
    if (area === "tx" && id !== undefined && action === undefined) {
      if (!HASH.test(id)) throw new HttpError(400, "bad_request", `${id.slice(0, 80)} is not a transaction hash`);
      only("GET");
      return json(200, await backend.txView(id.toLowerCase()));
    }
    throw new HttpError(404, "not_found", `no route ${method} ${url.pathname}`);
  }

  async function fetch(req: Request): Promise<Response> {
    const t0 = Date.now();
    let res: Response, where = "(no URL)";
    try {
      let url: URL;
      // a missing or malformed Host header leaves no URL to parse: such a request is not addressed to this backend
      try { url = new URL(req.url); } catch { throw new HttpError(403, "forbidden", NOT_OURS); }
      where = url.pathname;
      res = await route(req, url);
    } catch (e) {
      res = errorResponse(backend.toHttp(e));
    }
    backend.log(`${req.method} ${where} ${res.status} ${Date.now() - t0} ms`);
    return res;
  }

  return {
    backend,
    fetch,
    start: () => backend.start(),
    listen: () => {
      // error: anything that still escapes fetch is the generic 500 JSON, its cause logged, never a page with a stack
      server = Bun.serve({ ...SERVE, port: cfg.port, fetch, error: (e) => errorResponse(backend.toHttp(e)) });
      port = server.port ?? cfg.port;
      return server;
    },
    close: async () => {
      server?.stop(true);
      await backend.close();
    },
  };
}
