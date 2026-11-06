// The React app's server: compiled files from web/dist and the guarded /api/* proxy, on 127.0.0.1 only.
//   bun serve.ts            (WL_BACKEND_URL, default http://127.0.0.1:8787; WL_WEB_PORT, default 5173)
//   bun serve.ts --lan      also on this Mac's private network address, for a phone on YOUR OWN hotspot: every
//                           request there needs the secret code in the printed link (then a cookie). See lan.ts.
//
// The browser talks only to this server (spec: the frontend only calls the backend). The backend refuses requests that
// name another host or come from another origin, so a web page cannot drive the process that holds seeds. Forwarding
// drops the browser's Host and Origin, so this server makes the same two checks for its own origin first: without them
// a page on another origin, or a DNS-rebound host name, could reach the backend through here.
import fs from "node:fs";
import path from "node:path";
import type { Server } from "bun";

export const MAX_BODY = 64 * 1024; // the backend's own limit

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Scripts, styles, fonts and data only from this origin. Vite bundles the self-hosted source fonts into dist/assets/;
 * no third-party host or unsafe-inline allowance is needed by the production app.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface WebOptions {
  /** port on 127.0.0.1; 0 picks a free one */
  port?: number;
  /** the backend's base URL, e.g. http://127.0.0.1:8787 */
  backendUrl?: string;
  /** Static build root; defaults to dist/. Tests may supply isolated static fixtures. */
  publicDir?: string;
  /** Serve the React entry for the established page URLs only; defaults to true. */
  spa?: boolean;
  /** how /api/* reaches the backend: the backend's tests replace globalThis.fetch, so tests pass the real one */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export interface WebServer {
  server: Server<undefined>;
  port: number;
  url: string;
  backendUrl: string;
  stop: () => void;
}

/** Shared by the production server and Vite middleware, before any proxy headers are removed. */
export function allowedWebRequest(
  host: string,
  origin: string | null,
  ownHosts: readonly string[],
): boolean {
  return (
    ownHosts.includes(host) &&
    (origin === null || ownHosts.some((name) => origin === `http://${name}`))
  );
}

export const APP_ROUTES = new Set([
  "/",
  "/index.html",
  "/hot-cold.html",
  "/agent.html",
  "/session.html",
]);

const errorJson = (status: number, error: string, detail: string) =>
  new Response(JSON.stringify({ error, detail }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * The request handler, apart from listening, so tests can call it with any Host or Origin. `ownHosts` replaces the
 * default 127.0.0.1/localhost names (the LAN listener answers only to its own address).
 */
export function createHandler(
  opts: WebOptions & { ownPort: () => number; ownHosts?: () => string[] },
) {
  const backendUrl = (opts.backendUrl ?? "http://127.0.0.1:8787").replace(
    /\/+$/,
    "",
  );
  const publicDir = path.resolve(
    opts.publicDir ?? path.join(import.meta.dir, "dist"),
  );
  const spa = opts.spa ?? true;
  const forward =
    opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const own =
    opts.ownHosts ??
    (() => {
      const p = opts.ownPort();
      return [`127.0.0.1:${p}`, `localhost:${p}`];
    });

  function staticFile(pathname: string, head: boolean): Response {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return errorJson(
        400,
        "bad_request",
        "the path is not valid percent-encoding",
      );
    }
    if (spa && APP_ROUTES.has(rel)) rel = "/index.html";
    if (rel.includes("\0"))
      return errorJson(400, "bad_request", "the path holds a NUL byte");
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(publicDir, `.${rel}`);
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!file.startsWith(publicDir + path.sep) || !type)
      return errorJson(404, "not_found", `no file ${pathname}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return errorJson(404, "not_found", `no file ${pathname}`);
    }
    if (!stat.isFile())
      return errorJson(404, "not_found", `no file ${pathname}`);
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (type.startsWith("text/html"))
      Object.assign(headers, {
        "content-security-policy": CSP,
        "x-frame-options": "DENY",
      });
    return new Response(head ? null : Bun.file(file), { headers });
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    const type = req.headers.get("content-type");
    if (type) headers["content-type"] = type;
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_BODY)
        return errorJson(
          400,
          "bad_request",
          `the body is larger than ${MAX_BODY} bytes`,
        );
      init.body = body;
    }
    // Only the content type travels on: the backend sees its own host and no origin, i.e. a local caller.
    let res: Response | null = null;
    let body: ArrayBuffer;
    try {
      res = await forward(`${backendUrl}${url.pathname}${url.search}`, init);
      body = await res.arrayBuffer(); // the whole answer, or the error below: a backend may fail mid-answer
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return errorJson(
        502,
        "backend_unreachable",
        `the backend at ${backendUrl} ${res ? "failed mid-answer" : "did not answer"}: ${why}`,
      );
    }
    const out = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const resType = res.headers.get("content-type");
    if (resType) out.set("content-type", resType);
    return new Response(body, { status: res.status, headers: out });
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;
    if (!own().includes(host))
      return errorJson(
        403,
        "forbidden",
        "this server answers only requests addressed to its own host and port",
      );
    const origin = req.headers.get("origin");
    if (!allowedWebRequest(host, origin, own()))
      return errorJson(403, "forbidden", "cross-origin requests are refused");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return api(req, url);
    if (url.pathname === "/web/config")
      return Response.json(
        { backendUrl },
        { headers: { "cache-control": "no-store" } },
      );
    if (req.method !== "GET" && req.method !== "HEAD")
      return errorJson(405, "method_not_allowed", `${url.pathname} takes GET`);
    return staticFile(url.pathname, req.method === "HEAD");
  };
}

/**
 * Bun.serve's settings besides the handlers: never Bun's development error page (it shows a stack trace), and an idle
 * timeout above the backend's 60 s, so a slow answer (a wallet waits for its deploy) is not cut off here first.
 */
export const SERVE = {
  hostname: "127.0.0.1",
  development: false,
  idleTimeout: 120,
} as const;

/** Listens on 127.0.0.1 (port 0 picks a free one). */
export function startWebServer(opts: WebOptions = {}): WebServer {
  const backendUrl = (opts.backendUrl ?? "http://127.0.0.1:8787").replace(
    /\/+$/,
    "",
  );
  let port = opts.port ?? 5173;
  const log = opts.log ?? ((line: string) => console.log(line));
  const handle = createHandler({ ...opts, backendUrl, ownPort: () => port });
  const server = Bun.serve({
    ...SERVE,
    port,
    async fetch(req) {
      const t0 = Date.now();
      const res = await handle(req);
      const p = new URL(req.url).pathname;
      if (p.startsWith("/api"))
        log(`${req.method} ${p} ${res.status} ${Date.now() - t0} ms`); // never a body
      return res;
    },
    // anything that still escapes fetch: the spec's error shape, its cause in the log, never a page with a stack
    error(e) {
      try {
        log(`error: ${e.name}: ${e.message}`);
      } catch {
        /* the log is what failed */
      }
      return errorJson(
        500,
        "internal",
        "internal error in the web server; its log has the cause",
      );
    },
  });
  port = server.port ?? port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    backendUrl,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.env.WL_WEB_PORT ?? "5173");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(
      `WL_WEB_PORT must be a port number, got ${process.env.WL_WEB_PORT}`,
    );
  const built = path.join(import.meta.dir, "dist");
  if (!fs.existsSync(path.join(built, "index.html")))
    throw new Error("Build the React app first: bun run build.");
  const web = startWebServer({
    port,
    backendUrl: process.env.WL_BACKEND_URL ?? "http://127.0.0.1:8787",
  });
  console.log(`winterlock app: ${web.url}/ (backend ${web.backendUrl})`);
  const stops = [web.stop];
  if (process.argv.includes("--lan") || process.env.WL_WEB_LAN === "1") {
    const { startLanServer } = await import("./lan.ts");
    const lan = startLanServer({
      port: web.port,
      backendUrl: web.backendUrl,
      host: process.env.WL_WEB_LAN_HOST,
    });
    stops.push(lan.stop);
    console.log(
      `\nLAN mode, for your phone on YOUR OWN hotspot only (never a shared or venue Wi-Fi):\n  ${lan.link}\n` +
        "Anyone who has this link can press the wallet's buttons until you stop this server. A new code every start.",
    );
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      for (const stop of stops) stop();
      process.exit(0);
    });
}
