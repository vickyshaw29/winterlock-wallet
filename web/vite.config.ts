// Vite/Tailwind build and a guarded same-origin development API.
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  APP_ROUTES,
  CSP,
  MAX_BODY,
  allowedWebRequest,
  createHandler,
} from "./serve.ts";

const port = Number(process.env.WL_WEB_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("WL_WEB_PORT must be a valid port.");
const nonce = randomBytes(18).toString("base64");
const devCsp = CSP.replace(
  "script-src 'self'",
  `script-src 'self' 'nonce-${nonce}'`,
)
  .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
  .replace(
    "connect-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
  );

function localApi(): Plugin {
  return {
    name: "winterlock-local-api",
    configureServer(server) {
      const own = [`127.0.0.1:${port}`, `localhost:${port}`];
      const handle = createHandler({
        ownPort: () => port,
        backendUrl: process.env.WL_BACKEND_URL ?? "http://127.0.0.1:8787",
      });
      server.middlewares.use(async (req, res, next) => {
        try {
          const host = req.headers.host ?? "";
          const origin =
            typeof req.headers.origin === "string" ? req.headers.origin : null;
          if (!allowedWebRequest(host, origin, own)) {
            res.writeHead(403, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            res.end(
              JSON.stringify({
                error: "forbidden",
                detail:
                  "This server accepts only its own local Host and Origin.",
              }),
            );
            return;
          }
          const url = new URL(req.url ?? "/", `http://${host}`);
          if (
            url.pathname.startsWith("/api/") ||
            url.pathname === "/api" ||
            url.pathname === "/web/config"
          ) {
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            for await (const chunk of req) {
              const part =
                typeof chunk === "string" ? Buffer.from(chunk) : chunk;
              bytes += part.length;
              if (bytes > MAX_BODY) {
                res.writeHead(400, {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                });
                res.end(
                  JSON.stringify({
                    error: "bad_request",
                    detail: `the body is larger than ${MAX_BODY} bytes`,
                  }),
                );
                return;
              }
              chunks.push(part);
            }
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            const response = await handle(
              new Request(url.href, {
                method: req.method,
                headers,
                ...(bytes
                  ? { body: new Uint8Array(Buffer.concat(chunks)).buffer }
                  : {}),
              }),
            );
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            res.end(Buffer.from(await response.arrayBuffer()));
            return;
          }
          if (APP_ROUTES.has(url.pathname))
            req.url = `/index.html${url.search}`;
          next();
        } catch {
          if (!res.headersSent)
            res.writeHead(500, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
          res.end(
            JSON.stringify({
              error: "internal",
              detail: "The local web request could not be completed.",
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    localApi(),
    react(),
    tailwindcss(),
    {
      name: "winterlock-licenses",
      generateBundle() {
        for (const [source, name] of [
          ["node_modules/@fontsource/ibm-plex-sans/LICENSE", "OFL-IBMPlexSans.txt"],
          ["node_modules/@fontsource/ibm-plex-mono/LICENSE", "OFL-IBMPlexMono.txt"],
          ["src/components/ui/LICENSE.md", "shadcn-ui.txt"],
        ] as const)
          this.emitFile({
            type: "asset",
            fileName: `licenses/${name}`,
            source: readFileSync(
              path.join(import.meta.dirname, source),
              "utf8",
            ),
          });
      },
    },
  ],
  publicDir: false,
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  html: { cspNonce: nonce },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    headers: {
      "Content-Security-Policy": devCsp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
