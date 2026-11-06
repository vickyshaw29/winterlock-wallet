// LAN mode for the screens: a second listener on this Mac's private network address, so a phone on YOUR OWN hotspot
// can open the screens. Every request there needs the secret code from the printed link: the first visit trades it
// for an HttpOnly, SameSite=Strict cookie and redirects to the same page without the code. The backend stays on
// 127.0.0.1; only this proxy is reachable from the network, and it forwards /api/* exactly as the local one does.
// Written with Claude Code (AI) for Vicky.
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { createHandler, SERVE, type WebOptions } from "./serve.ts";

export const COOKIE = "wl_lan";
/** Half a day: a demo session, not a standing login. */
const COOKIE_MAX_AGE = 43_200;

/** RFC 1918 private IPv4 (home Wi-Fi; an iPhone hotspot gives 172.20.10.x, an Android one 192.168.43.x). */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The first private IPv4 address of a non-internal network interface, or null. */
export function privateAddress(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string | null {
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && isPrivateIPv4(i.address)) return i.address;
  }
  return null;
}

/** 24 random bytes, base64url: 32 characters. */
export const newCode = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

const json = (status: number, error: string, detail: string) =>
  new Response(JSON.stringify({ error, detail }), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export interface LanHandlerOptions extends Omit<WebOptions, "port"> { host: string; portOf: () => number; code: string }

/** Host first, then the code (from the link once, then the cookie), then the ordinary handler for this host only. */
export function createLanHandler(opts: LanHandlerOptions) {
  const ownHost = () => `${opts.host}:${opts.portOf()}`;
  const inner = createHandler({ ...opts, ownPort: opts.portOf, ownHosts: () => [ownHost()] });
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if ((req.headers.get("host") ?? url.host) !== ownHost()) return json(403, "forbidden", "this server answers only requests addressed to its own host and port");
    const given = url.searchParams.get("k");
    if (given !== null) {
      if (!same(given, opts.code)) return json(401, "unauthorized", "that code is not this server's: open the link serve.ts printed");
      url.searchParams.delete("k");
      return new Response(null, {
        status: 303,
        headers: {
          location: `${url.pathname}${url.search}`,
          "set-cookie": `${COOKIE}=${opts.code}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
          "cache-control": "no-store", "referrer-policy": "no-referrer",
        },
      });
    }
    const cookie = cookieOf(req);
    if (cookie === null || !same(cookie, opts.code)) return json(401, "unauthorized", "open the link with the code that serve.ts printed");
    return inner(req);
  };
}

export interface LanServer { host: string; port: number; url: string; link: string; stop: () => void }

/** Listens on a private address only (the first one found, or `host`), with a fresh code unless one is given. */
export function startLanServer(opts: WebOptions & { host?: string; code?: string }): LanServer {
  const host = opts.host || privateAddress();
  if (!host) throw new Error("this Mac has no private IPv4 address: connect it to your phone's hotspot first");
  if (!isPrivateIPv4(host)) throw new Error(`${host} is not a private network address; LAN mode listens only on one`);
  const code = opts.code ?? newCode();
  if (code.length < 24) throw new Error("the LAN code must be at least 24 characters");
  let port = opts.port ?? 5173;
  const log = opts.log ?? ((line: string) => console.log(line));
  const handle = createLanHandler({ ...opts, host, portOf: () => port, code });
  const server = Bun.serve({
    ...SERVE,
    hostname: host,
    port,
    async fetch(req) {
      const res = await handle(req);
      const p = new URL(req.url).pathname;
      if (p.startsWith("/api")) log(`[lan] ${req.method} ${p} ${res.status}`); // never a body, never the code
      return res;
    },
    error(e) {
      try { log(`[lan] error: ${e.name}: ${e.message}`); } catch { /* the log is what failed */ }
      return json(500, "internal", "internal error in the web server; its log has the cause");
    },
  });
  port = server.port ?? port;
  const url = `http://${host}:${port}`;
  return { host, port, url, link: `${url}/?k=${code}`, stop: () => server.stop(true) };
}
