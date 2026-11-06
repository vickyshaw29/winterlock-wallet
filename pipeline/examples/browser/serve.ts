// Serves the in-browser example of the pipeline's core: builds dist/ (the installable bundle), then serves this page
// and dist/core.js on this machine only. The page may not open any connection (Content-Security-Policy connect-src
// 'none'): everything it shows is computed in the browser, and nothing can be sent.
//   bun examples/browser/serve.ts            # http://127.0.0.1:15190
// Written with Claude Code (AI) for Vicky.
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const build = Bun.spawnSync(["bun", "scripts/build-core.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(1);

const port = Number(process.env.WL_SDK_PORT ?? 15190);
const files: Record<string, [string, string]> = {
  "/": [path.join(import.meta.dir, "index.html"), "text/html; charset=utf-8"],
  "/main.js": [path.join(import.meta.dir, "main.js"), "text/javascript; charset=utf-8"],
  "/core.js": [path.join(ROOT, "dist/core.js"), "text/javascript; charset=utf-8"],
  "/core.js.map": [path.join(ROOT, "dist/core.js.map"), "application/json"],
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const f = files[new URL(req.url).pathname];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(Bun.file(f[0]), { headers: { "content-type": f[1], "content-security-policy": CSP, "cache-control": "no-store" } });
  },
});
console.log(`pipeline core in the browser: http://127.0.0.1:${port}`);
