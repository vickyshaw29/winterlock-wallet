// Isolated real backend + Rust signer, in-process fake RPC, and the production web server.
// No data from a developer wallet and no reachable chain endpoint is used.
import "../test/setup.ts";
import { Harness, missShortDeadlines } from "../../backend/test/helpers.ts";
import { startWebServer } from "../serve.ts";
const harness = await Harness.create();
missShortDeadlines(harness.chain);
const web = startWebServer({
  port: 5190,
  publicDir: `${import.meta.dir}/../dist`,
  spa: true,
  log: () => {},
  fetch: async (url, init) => harness.app.fetch(new Request(url, init)),
});
console.log(`React browser test server: ${web.url}; isolated fake RPC only.`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    web.stop();
    await harness.destroy();
    process.exit(0);
  });
