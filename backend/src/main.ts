// Starts the backend on 127.0.0.1 (see backend/README.md for the environment it reads).
// Written with Claude Code (AI) for Vicky.
//   bun src/main.ts
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const app = createApp(cfg);
app.start();
const server = app.listen();
console.log(`winterlock backend: http://127.0.0.1:${server.port}/api (data in ${cfg.backendDir})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.stop(true); process.exit(0); }); // the kernel releases every journal lock
}
