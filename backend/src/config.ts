// The backend's settings, from the environment (backend/README.md lists each variable). Reading them touches no file.
// Written with Claude Code (AI) for Vicky.
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../../pipeline/src/index.ts";

export interface Config {
  /** wallets, backend seeds, ticket devices, the hashsig cache and the transaction store */
  backendDir: string;
  port: number;
  /** the pipeline's deployment records (as pipeline/scripts/lib/wallet.ts) */
  dataDir: string;
  /** the Rust hashsig CLI, for ticket cuts and hot signatures */
  signerBin: string;
  /** the funded EOA that calls the factory and tops up new wallets */
  eoaKeyFile: string;
  /** what the EOA sends a new wallet when the faucet left it below this */
  fundWei: bigint;
  /** following transactions; tests shorten these */
  follow: { pollMs: number; receiptWaitMs: number; dropWaitMs: number; timeoutMs: number; confirmations: number };
  /** the EOA's legacy transactions: a fixed gas price (as deploy-account.ts), polled until mined */
  eoa: { gasPriceWei: bigint; pollMs: number; waitMs: number };
  /** how long to wait for a faucet payment to show before the EOA funds instead */
  faucetWaitMs: number;
  /**
   * how long to wait before settling a journal again after the node could not be read, and between looks at a
   * rotation left without an outcome (Vicky's default 7: every 30 s, until the chain decides it)
   */
  settleRetryMs: number;
  /**
   * how long one read of the sidecar's relay settings (skandha_config and skandha_explorer_info) serves the lanes plan:
   * 60 s, so a screen asking for a plan every few seconds does not read them each time
   */
  relayCacheMs: number;
}

const REPO = path.resolve(import.meta.dir, "../..");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = os.homedir();
  const port = Number(env.WL_BACKEND_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`WL_BACKEND_PORT must be a port number, got ${env.WL_BACKEND_PORT}`);
  const fund = env.WL_FUND_WEI ?? "20000000000000000"; // 0.02 ETH
  if (!/^(0|[1-9]\d*)$/.test(fund)) throw new Error(`WL_FUND_WEI must be a decimal number of wei, got ${fund}`);
  return {
    backendDir: path.resolve(env.WL_BACKEND_DIR ?? path.join(home, ".winterlock", "backend")),
    port,
    dataDir: path.resolve(env.WL_DATA_DIR ?? path.join(REPO, "pipeline", ".data")),
    signerBin: path.resolve(env.WL_SIGNER_BIN ?? path.join(REPO, "signer", "target", "release", "signer")),
    eoaKeyFile: path.resolve(env.WL_EOA_KEY_FILE ?? path.join(home, ".winterlock", "devnet-eoa.key")),
    fundWei: BigInt(fund),
    follow: {
      pollMs: DEFAULTS.pollMs, receiptWaitMs: DEFAULTS.receiptWaitMs, dropWaitMs: DEFAULTS.dropWaitMs,
      timeoutMs: DEFAULTS.followTimeoutMs, confirmations: DEFAULTS.confirmations,
    },
    eoa: { gasPriceWei: 2_000_000_000n, pollMs: 3_000, waitMs: 120_000 },
    faucetWaitMs: 30_000,
    settleRetryMs: 30_000,
    relayCacheMs: 60_000,
  };
}
