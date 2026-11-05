import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { loadConfig } from "./config.js";
import { StepError } from "./output.js";
import { rpc } from "./rpc.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; delayMs?: (attempt: number) => number }
): Promise<T> {
  const delay = opts.delayMs ?? (() => 150 + Math.random() * 300);
  let last: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      if (attempt < opts.retries) await sleep(delay(attempt));
    }
  }
  throw last;
}

export async function getBalance(address: Address): Promise<bigint> {
  return BigInt(await rpc(loadConfig().gatewayUrl, "eth_getBalance", [address, "latest"]));
}

export async function getCode(address: Address): Promise<Hex> {
  return await rpc(loadConfig().gatewayUrl, "eth_getCode", [address, "latest"]);
}

/** Sends a legacy transaction through the gateway, which forwards it to ethrex. Re-reads the pending nonce on every attempt, so shared keys survive collisions. */
export async function sendLegacy(
  key: Hex,
  tx: { to: Address | null; value?: bigint; data?: Hex; gas?: bigint },
  retries = 10
): Promise<Hex> {
  const cfg = loadConfig();
  const account = privateKeyToAccount(key);
  return retry(async () => {
    const nonce = Number(await rpc(cfg.gatewayUrl, "eth_getTransactionCount", [account.address, "pending"]));
    const raw = await account.signTransaction({
      chainId: cfg.chainId, nonce, to: tx.to, value: tx.value ?? 0n, data: tx.data ?? "0x",
      gas: tx.gas ?? cfg.legacyGasLimit, gasPrice: cfg.legacyGasPriceWei, type: "legacy",
    });
    return (await rpc(cfg.gatewayUrl, "eth_sendRawTransaction", [raw])) as Hex;
  }, { retries });
}

export async function waitMined(hash: Hex): Promise<any> {
  const cfg = loadConfig();
  const deadline = Date.now() + cfg.txTimeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await rpc(cfg.gatewayUrl, "eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(2000);
  }
  throw new StepError("TX_NOT_MINED", `Transaction ${hash} was not mined within ${cfg.txTimeoutSec}s`, {
    hint: "the devnet may be stalled; check the explorer and retry",
  });
}

/** Asks the node's faucet (`skandha_explorer_faucet`) to send ETH to `to`, and waits for the transfer to be mined. */
export async function fundFromFaucet(to: Address): Promise<Hex> {
  let result: { txHash: Hex };
  try {
    result = await rpc(loadConfig().gatewayUrl, "skandha_explorer_faucet", [to]);
  } catch (e) {
    if (!(e instanceof StepError) || e.code === "RPC_UNREACHABLE") throw e;
    throw new StepError("FUNDING_FAILED", `The faucet refused ${to}: ${e.message}`, {
      hint: e.code === "RPC_-32601"
        ? "this node has no faucet; ask the workshop host to fund the address"
        : "each address can ask once an hour; use the Faucet button in the explorer with another address, or ask the host",
    });
  }
  const receipt = await waitMined(result.txHash);
  if (receipt.status !== "0x1") throw new StepError("FUNDING_FAILED", `Funding transfer ${result.txHash} reverted`);
  return result.txHash;
}

export async function getStorageAt(address: Address, slot: Hex): Promise<Hex> {
  return await rpc(loadConfig().gatewayUrl, "eth_getStorageAt", [address, slot, "latest"]);
}

/** A block header and its transaction hashes. `slotNumber` is the beacon slot (EIP-7843) that EIP-8272 measures age in. */
export async function getBlock(number: "latest" | Hex): Promise<{ number: Hex; slotNumber: Hex; [k: string]: unknown }> {
  return await rpc(loadConfig().gatewayUrl, "eth_getBlockByNumber", [number, false]);
}
