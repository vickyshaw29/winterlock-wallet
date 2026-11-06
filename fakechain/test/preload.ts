// Test preload: points every WL_* variable at a free 127.0.0.1 port and a temp folder before any test loads the pipeline.
// Written with Claude Code (AI) for Vicky.
// Then it loads fakechain's guard: local endpoints only, and a fetch that cannot leave this machine.
import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
const port = probe.port;
probe.stop(true);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fakechain-test-"));
Object.assign(process.env, {
  WL_CHAIN_ID: "31337",
  WL_NODE_URL: `http://127.0.0.1:${port}`,
  WL_GATEWAY_URL: `http://127.0.0.1:${port}/rpc`,
  WL_EXPLORER_URL: `http://127.0.0.1:${port}/explorer`,
  WL_DATA_DIR: path.join(root, "pipeline-data"),
  // lib/wallet.ts would otherwise derive a default seed path under ~/.winterlock
  WL_SEED_FILE: path.join(root, "seeds", "unused.seed"),
  FAKECHAIN_TEST_PORT: String(port),
  FAKECHAIN_TEST_ROOT: root,
});
await import("../src/guard.ts");
// The whole test run's files (throwaway seeds, journals, keys) go when the run ends.
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
