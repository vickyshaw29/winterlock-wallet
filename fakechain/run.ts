// Launches a local FAKE devnet in one process: flags, a fresh temp data directory, WL_* pointed at it, then the chain.
// Written with Claude Code (AI) for Vicky.
// The environment is set before anything loads the pipeline, which reads its endpoints once, when first loaded.
//   bun fakechain/run.ts [--port 8545] [--block-time 6] [--height 10] [--public-per-sender 1]
//                        [--base-fee 7] [--bundle-interval 10] [--proxy-holdback on|off] [--enforce-gas-price]
import fs from "node:fs";
import path from "node:path";
import { makeDataDir } from "./src/dataDir.ts";

const USAGE = `fakechain: a local FAKE devnet for the Winterlock pipeline (not ethrex, not the sidecar).
  --port N               127.0.0.1 port for the node (/), the sidecar (/rpc) and the explorer (/explorer); default 8545
  --block-time S         seconds between blocks, at least 1; default 6, as the devnet
  --height H             tree height of the first account, 5 to 12; default 10 (what lib/wallet.ts assumes)
  --public-per-sender N  pending frame transactions per sender in the public pool; default 1
  --base-fee WEI         fixed base fee per gas; default 7, the devnet's
  --bundle-interval S    seconds between the sidecar's relay and reconcile passes; default 10, the sidecar's
  --proxy-holdback on|off  EIP-150: the proxy's DELEGATECALL keeps 1/64 of the gas; default on
  --enforce-gas-price    do not relay a transaction priced below the gas price quote (the sidecar's enforceGasPrice)`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value\n\n${USAGE}`);
  return v;
};
const known = new Set(["--port", "--block-time", "--height", "--public-per-sender", "--base-fee", "--bundle-interval", "--proxy-holdback", "--enforce-gas-price"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i]!)) throw new Error(`unknown argument ${argv[i]}\n\n${USAGE}`);
  if (argv[i] !== "--enforce-gas-price") i++;
}
const num = (name: string, fallback: string, min: number, max: number, integer = true) => {
  const v = Number(flag(name, fallback));
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`--${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  return v;
};
const port = num("port", "8545", 1, 65_535);
const blockTime = num("block-time", "6", 1, 3_600, false);
// Below 5 the 16-leaf hot band leaves no cold leaf (hotStart = 2^h - 16); above 12 keygen slows and verify gas is unmeasured.
const height = num("height", "10", 5, 12);
const publicPerSender = num("public-per-sender", "1", 1, 1_000);
const baseFee = BigInt(num("base-fee", "7", 0, 1e15));
const bundleInterval = num("bundle-interval", "10", 0.2, 3_600, false);
const holdback = flag("proxy-holdback", "on");
if (holdback !== "on" && holdback !== "off") throw new Error("--proxy-holdback must be on or off");

// A fresh directory per run, in the OS temp dir: never inside the repo, never under ~/.winterlock (checked before it is
// created, symlinks resolved).
const dataDir = makeDataDir();
const node = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  WL_CHAIN_ID: "31337",
  WL_NODE_URL: node,
  WL_GATEWAY_URL: `${node}/rpc`,
  WL_EXPLORER_URL: `${node}/explorer`,
  WL_DATA_DIR: path.join(dataDir, "pipeline-data"),
  WL_BACKEND_DIR: path.join(dataDir, "backend"),
  WL_EOA_KEY_FILE: path.join(dataDir, "eoa.key"),
  WL_SEED_FILE: path.join(dataDir, "seeds", "account-1.seed"),
});

try {
  const { launch } = await import("./src/launch.ts");
  await launch({ port, blockTime, height, publicPerSender, baseFee, bundleInterval, proxyHoldback: holdback === "on", enforceGasPrice: argv.includes("--enforce-gas-price"), dataDir });
} catch (e) {
  // A failed start leaves nothing behind: the folder holds the throwaway EOA key.
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(`[fakechain] start failed, removed ${dataDir}: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}
