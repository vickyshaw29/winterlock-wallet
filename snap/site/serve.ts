// Serves the Snap's companion page and an explicit allowlist of shared UI assets on 127.0.0.1, port 15190 by default:
// the origin the Snap answers (snap.manifest.json, endowment:rpc allowedOrigins). A strict
// Content-Security-Policy: scripts and styles from this origin, connections only to the devnet node and gateway.
//   bun snap/site/serve.ts            (WL_SNAP_SITE_PORT, default 15190), then open http://localhost:15190
import path from "node:path";

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://altmempoolgateway.forshtat.com https://altmempool.forshtat.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/workspace.css": { file: "workspace.css", type: "text/css; charset=utf-8" },
  "/theme.css": { file: "theme.css", type: "text/css; charset=utf-8" },
  "/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
  "/activity.js": { file: "activity.js", type: "text/javascript; charset=utf-8" },
  "/fonts/archivo-latin.woff2": { file: "fonts/archivo-latin.woff2", type: "font/woff2" },
  "/fonts/besley-latin.woff2": { file: "fonts/besley-latin.woff2", type: "font/woff2" },
  "/fonts/OFL-Archivo.txt": { file: "fonts/OFL-Archivo.txt", type: "text/plain; charset=utf-8" },
  "/fonts/OFL-Besley.txt": { file: "fonts/OFL-Besley.txt", type: "text/plain; charset=utf-8" },
};

const HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8", ...extra } });

/** Starts the server; port 0 picks a free one. */
export function startSite(port: number = Number(process.env.WL_SNAP_SITE_PORT ?? "15190")) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`WL_SNAP_SITE_PORT must be a port number, got ${port}`);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed", { allow: "GET, HEAD" });
      const hit = FILES[new URL(req.url).pathname];
      if (!hit) return text(404, "not found");
      return new Response(Bun.file(path.join(import.meta.dir, hit.file)), { headers: { ...HEADERS, "content-type": hit.type } });
    },
  });
}

if (import.meta.main) {
  const server = startSite();
  console.log(`Winterlock Snap page: http://localhost:${server.port}`);
}
