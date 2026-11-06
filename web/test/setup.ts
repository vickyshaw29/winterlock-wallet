// Test preload: every endpoint the pipeline could reach points at loopback port 1, on chain 1337 (the backend's fake
// chain), before any module reads them. Nothing in these tests may leave this machine.
// Written with Claude Code (AI) for Vicky.
process.env.WL_NODE_URL = "http://127.0.0.1:1";
process.env.WL_GATEWAY_URL = "http://127.0.0.1:1";
process.env.WL_CHAIN_ID = "1337";
process.env.WL_EXPLORER_URL = "https://explorer.altmempool.wtf";
delete process.env.PQ_SEED;
delete process.env.WL_BACKEND_DIR;
delete process.env.WL_DATA_DIR;
delete process.env.WL_EOA_KEY_FILE;
