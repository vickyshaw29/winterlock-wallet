// Test preload for the scene scripts: every chain endpoint points at loopback port 1 before any module reads it.
// Written with Claude Code (AI) for Vicky.
// Chain 1337 is the backend's fake chain. Nothing in these tests may leave this machine.
process.env.WL_NODE_URL = "http://127.0.0.1:1";
process.env.WL_GATEWAY_URL = "http://127.0.0.1:1";
process.env.WL_CHAIN_ID = "1337";
process.env.WL_EXPLORER_URL = "https://explorer.altmempool.wtf";
delete process.env.PQ_SEED;
delete process.env.WL_BACKEND_DIR;
delete process.env.WL_BACKEND_URL;
delete process.env.WL_DATA_DIR;
delete process.env.WL_EOA_KEY_FILE;
