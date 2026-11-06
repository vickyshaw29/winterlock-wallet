// Test harness: a backend on temporary directories (never ~/.winterlock, never pipeline/.data) over the fake chain,
// with every log line and response body captured. Low tree heights keep key generation fast.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { FACTORY, FakeChain, IMPLEMENTATION } from "./fake-chain.ts";

export const BIN = process.env.WL_SIGNER_BIN ?? path.resolve(import.meta.dir, "../../signer/target/release/signer");
/** The ticket tests run the real Rust CLI: a missing binary fails loudly, never skips. */
export function requireCli(): void {
  if (!fs.existsSync(BIN)) throw new Error(`the backend's ticket tests need the Rust CLI at ${BIN}: build it with (cd signer && ~/.cargo/bin/cargo build --release)`);
}

export const EOA_KEY: Hex = `0x${"3c".repeat(32)}`; // a throwaway test key
export const EOA: Address = privateKeyToAccount(EOA_KEY).address;
export const TARGET: Address = "0x5544596212F91984C986A919C8026DF0576816f9";
/** checksummed: the backend refuses a mixed-case address whose checksum is wrong (a typo), and that is right */
export const OTHER: Address = getAddress("0x00000000000000000000000000000000000b0b00");
export const ETH = 1_000_000_000_000_000_000n;

export interface Dirs { root: string; backendDir: string; dataDir: string; eoaKeyFile: string }

export function tempDirs(): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-backend-"));
  const dirs = { root, backendDir: path.join(root, "backend"), dataDir: path.join(root, "data"), eoaKeyFile: path.join(root, "eoa.key") };
  fs.mkdirSync(dirs.dataDir, { recursive: true });
  fs.writeFileSync(dirs.eoaKeyFile, `${EOA_KEY}\n`, { mode: 0o600 });
  // The pipeline's current deployment record: new wallets take its implementation and factory. Its own seed file does
  // not exist, so it is not served as a wallet.
  fs.writeFileSync(path.join(dirs.dataDir, "deployment-1337.json"), JSON.stringify({
    chainId: "1337", verifier: "hashsig", implementation: IMPLEMENTATION, implementationCodeHash: `0x${"ab".repeat(32)}`, factory: FACTORY,
    account: "0x00000000000000000000000000000000000DEAD0", params: { root: `0x${"01".repeat(32)}`, treeSeed: `0x${"02".repeat(32)}`, height: 10 },
    tree: { seedFile: path.join(root, "no-such.seed"), generation: 0, height: 10, chains: ["1337"] },
  }));
  return dirs;
}

export function testConfig(d: Dirs, over: Partial<Config> = {}): Config {
  return {
    backendDir: d.backendDir, port: 8787, dataDir: d.dataDir, signerBin: BIN, eoaKeyFile: d.eoaKeyFile, fundWei: 20_000_000_000_000_000n,
    follow: { pollMs: 2, receiptWaitMs: 40, dropWaitMs: 3_000, timeoutMs: 1_500, confirmations: 2 },
    eoa: { gasPriceWei: 2_000_000_000n, pollMs: 2, waitMs: 2_000 },
    faucetWaitMs: 50, settleRetryMs: 20, relayCacheMs: 60_000, ...over, // relayCacheMs as loadConfig sets it
  };
}

export interface Reply { status: number; body: any; text: string }

export class Harness {
  readonly logs: string[] = [];
  readonly responses: string[] = [];
  app!: App;
  constructor(readonly chain: FakeChain, readonly dirs: Dirs, readonly cfg: Config) {}

  static async create(opts: { chain?: FakeChain; dirs?: Dirs; config?: Partial<Config>; start?: boolean } = {}): Promise<Harness> {
    const chain = opts.chain ?? new FakeChain();
    chain.install();
    const dirs = opts.dirs ?? tempDirs();
    if (!chain.balances.has(EOA.toLowerCase())) chain.credit(EOA, 10n * ETH);
    const h = new Harness(chain, dirs, testConfig(dirs, opts.config));
    h.open(opts.start ?? true);
    return h;
  }

  /** A backend process on the same directories (a restart is close() then open()). */
  open(start = true): void {
    this.app = createApp(this.cfg, { log: (line) => this.logs.push(line) });
    if (start) this.app.start();
  }

  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const init: RequestInit = { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await this.app.fetch(new Request(`http://127.0.0.1:8787/api${p}`, init));
    const text = await res.text();
    this.responses.push(text);
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
  }

  /** POST /wallets with test defaults: height 4 (16 leaves), cold leaves 1 to 11, hot leaves 12 to 15. */
  async wallet(over: Record<string, unknown> = {}): Promise<Address> {
    const r = await this.req("POST", "/wallets", { height: 4, spendLimitWei: "10000000000000000", hotStart: 12, allowedTarget: TARGET, ...over });
    if (r.status !== 200) throw new Error(`POST /wallets: ${r.status} ${r.text}`);
    return r.body.address;
  }

  /** Waits until the store shows a transaction in a final status (or the given one). */
  async settle(hash: string, want?: string, ms = 5_000): Promise<any> {
    const until = Date.now() + ms;
    for (;;) {
      const r = await this.req("GET", `/tx/${hash}`);
      if (r.status === 200 && (want ? r.body.status === want : r.body.status !== "Submitted")) return r.body;
      if (Date.now() > until) throw new Error(`${hash} is still ${r.body?.status} (wanted ${want ?? "a final status"})`);
      await Bun.sleep(5);
    }
  }

  async close(): Promise<void> { await this.app.close(); }

  async destroy(): Promise<void> {
    await this.close();
    FakeChain.uninstall();
    fs.rmSync(this.dirs.root, { recursive: true, force: true });
  }

  /** The backend journal files of a wallet's seed (cold side). */
  coldJournal(address: string, epoch = 0): any {
    const rec = JSON.parse(fs.readFileSync(path.join(this.dirs.backendDir, "wallets", `${address.toLowerCase()}.json`), "utf8"));
    return JSON.parse(fs.readFileSync(`${rec.tree.seedFile}.journal-epoch${epoch}.json`, "utf8"));
  }

  record(address: string): any {
    return JSON.parse(fs.readFileSync(path.join(this.dirs.backendDir, "wallets", `${address.toLowerCase()}.json`), "utf8"));
  }

  deviceDir(address: string) { return path.join(this.dirs.backendDir, "devices", address.toLowerCase()); }
}

/**
 * The devnet's blocks come 6 s apart, the fake chain's at once. From now on a transaction whose deadline is at most
 * `seconds` away when the chain would include it misses its block, and so expires: the demo's stuck payment
 * (firstAttemptExpirySeconds 4). A retry with the normal deadline still lands at once.
 */
export function missShortDeadlines(chain: FakeChain, seconds = 6): void {
  const include = chain.include.bind(chain);
  chain.include = (hash) => {
    const held = chain.held.get(hash);
    return held !== undefined && held.deadline - BigInt(Math.floor(Date.now() / 1000)) <= BigInt(seconds) ? false : include(hash);
  };
}

export async function until(pred: () => boolean | Promise<boolean>, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
