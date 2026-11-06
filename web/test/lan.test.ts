// LAN mode: private addresses only, the secret code on every request, the cookie flow, and the local server unchanged.
// Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import { COOKIE, createLanHandler, isPrivateIPv4, newCode, privateAddress, startLanServer } from "../lan.ts";
import { createHandler } from "../serve.ts";

const HOST = "192.168.43.7", PORT = 15173, CODE = newCode();
const forwarded: string[] = [];
const fakeBackend = async (input: string) => { forwarded.push(input); return Response.json({ ok: true }); };
const lan = createLanHandler({ host: HOST, portOf: () => PORT, code: CODE, backendUrl: "http://127.0.0.1:18787", fetch: fakeBackend });
const at = (path: string, headers: Record<string, string> = {}) =>
  lan(new Request(`http://${HOST}:${PORT}${path}`, { headers: { host: `${HOST}:${PORT}`, ...headers } }));
const withCookie = (code = CODE) => ({ cookie: `other=1; ${COOKIE}=${code}` });

describe("LAN mode", () => {
  test("only private IPv4 addresses", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.20.10.2", "172.31.255.254", "192.168.43.1"]) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "127.0.0.1", "169.254.1.1", "1.2.3", "256.1.1.1", "192.168.1.1x", ""]) expect(isPrivateIPv4(ip)).toBe(false);
    expect(privateAddress({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any], en0: [{ address: "172.20.10.3", family: "IPv4", internal: false } as any] })).toBe("172.20.10.3");
    expect(privateAddress({ en0: [{ address: "8.8.4.4", family: "IPv4", internal: false } as any] })).toBeNull();
  });

  test("refuses to listen on a public address or a short code", () => {
    expect(() => startLanServer({ host: "8.8.8.8" })).toThrow("not a private network address");
    expect(() => startLanServer({ host: HOST, code: "short" })).toThrow("at least 24");
  });

  test("every request without the code is 401: pages, files and the API", async () => {
    for (const p of ["/", "/hot-cold.html", "/style.css", "/api/status", "/api/wallets"]) expect((await at(p)).status).toBe(401);
    expect((await at("/", withCookie(newCode()))).status).toBe(401);
    expect((await at("/?k=wrong-code-wrong-code-wrong")).status).toBe(401);
    expect(forwarded).toEqual([]); // nothing reached the backend
  });

  test("the link's code becomes an HttpOnly, SameSite=Strict cookie, and the code leaves the URL", async () => {
    const res = await at(`/hot-cold.html?k=${CODE}&wallet=0xabc`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hot-cold.html?wallet=0xabc");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${COOKIE}=${CODE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("with the cookie, pages load and /api is forwarded to the backend on 127.0.0.1", async () => {
    expect((await at("/", withCookie())).status).toBe(200);
    const api = await at("/api/status", withCookie());
    expect(api.status).toBe(200);
    expect(forwarded.at(-1)).toBe("http://127.0.0.1:18787/api/status");
  });

  test("answers only to its own host and origin, even with the cookie", async () => {
    expect((await at("/", { ...withCookie(), host: `127.0.0.1:${PORT}` })).status).toBe(403);
    expect((await at("/", { ...withCookie(), host: `evil.example:${PORT}` })).status).toBe(403);
    expect((await at("/api/status", { ...withCookie(), origin: "http://evil.example" })).status).toBe(403);
    expect((await at("/api/status", { ...withCookie(), origin: `http://${HOST}:${PORT}` })).status).toBe(200);
  });

  test("the local server is unchanged: no code needed on 127.0.0.1", async () => {
    const local = createHandler({ ownPort: () => PORT, backendUrl: "http://127.0.0.1:18787", fetch: fakeBackend });
    const res = await local(new Request(`http://127.0.0.1:${PORT}/`, { headers: { host: `127.0.0.1:${PORT}` } }));
    expect(res.status).toBe(200);
  });
});
