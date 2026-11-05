import { ETHERSCAN_MIN_INTERVAL_MS } from "./config";
import type { Address, Hex } from "./types";

export interface RawTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  /** Hex quantity. */
  value: Hex;
  blockNumber: number;
}

export interface SourceMeta {
  contractName: string;
  compilerVersion: string;
  /** "0x" when the constructor takes no arguments. */
  constructorArguments: Hex;
}

export interface CreationInfo {
  contractAddress: Address;
  contractCreator: Address;
  txHash: Hex;
  blockNumber: number;
  /** Set when the contract was created by another contract (a factory). */
  contractFactory: Address | null;
}

/** The parts of Etherscan that `fetch` uses. Tests substitute a fake. */
export interface EtherscanApi {
  getTransaction(hash: Hex): Promise<RawTx>;
  getReceiptContractAddress(hash: Hex): Promise<Address | null>;
  getSourceMeta(address: Address): Promise<SourceMeta>;
  getRuntimeCode(address: Address): Promise<Hex>;
  getContractCreation(address: Address): Promise<CreationInfo>;
}

export interface EtherscanOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
  baseUrl?: string;
}

/** Etherscan API V2, Ethereum mainnet (chainid=1). Rate-limited, retries on "rate limit". */
export class EtherscanClient implements EtherscanApi {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private lastCall = -Infinity;

  constructor(private readonly apiKey: string, options: EtherscanOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? ETHERSCAN_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseUrl = options.baseUrl ?? "https://api.etherscan.io/v2/api";
  }

  private async call(params: Record<string, string>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = this.now();

      // The API key is part of this URL: never put the URL in an error message, log line or artifact.
      const query = new URLSearchParams({ chainid: "1", ...params, apikey: this.apiKey });
      const response = await this.fetchFn(`${this.baseUrl}?${query}`);
      if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
      const body = (await response.json()) as {
        status?: string;
        message?: string;
        result?: unknown;
        error?: { message?: string };
      };

      if (typeof body.result === "string" && /rate limit/i.test(body.result)) {
        if (attempt >= this.maxRetries) {
          throw new Error(`Etherscan rate limit persisted after ${attempt + 1} attempts`);
        }
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      if (body.error) throw new Error(`Etherscan error: ${body.error.message ?? "unknown"}`);
      if (body.status === "0") {
        throw new Error(`Etherscan ${params.action} failed: ${body.message}: ${String(body.result)}`);
      }
      return body.result;
    }
  }

  async getTransaction(hash: Hex): Promise<RawTx> {
    const result = (await this.call({
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: hash,
    })) as { from: Address; to: Address | null; input: Hex; value: Hex; blockNumber: Hex } | null;
    if (!result) throw new Error(`Etherscan: transaction ${hash} not found`);
    return {
      hash,
      from: result.from,
      to: result.to,
      input: result.input,
      value: result.value,
      blockNumber: Number(BigInt(result.blockNumber)),
    };
  }

  async getReceiptContractAddress(hash: Hex): Promise<Address | null> {
    const result = (await this.call({
      module: "proxy",
      action: "eth_getTransactionReceipt",
      txhash: hash,
    })) as { contractAddress: Address | null } | null;
    if (!result) throw new Error(`Etherscan: receipt for ${hash} not found`);
    return result.contractAddress ?? null;
  }

  async getSourceMeta(address: Address): Promise<SourceMeta> {
    const result = (await this.call({
      module: "contract",
      action: "getsourcecode",
      address,
    })) as Array<{ ContractName: string; CompilerVersion: string; ConstructorArguments: string }>;
    const entry = result?.[0];
    if (!entry || entry.ContractName === "") {
      throw new Error(`Etherscan: source for ${address} is not verified`);
    }
    return {
      contractName: entry.ContractName,
      compilerVersion: entry.CompilerVersion,
      constructorArguments: `0x${entry.ConstructorArguments}` as Hex,
    };
  }

  async getRuntimeCode(address: Address): Promise<Hex> {
    return (await this.call({
      module: "proxy",
      action: "eth_getCode",
      address,
      tag: "latest",
    })) as Hex;
  }

  async getContractCreation(address: Address): Promise<CreationInfo> {
    const result = (await this.call({
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: address,
    })) as Array<{
      contractAddress: Address;
      contractCreator: Address;
      txHash: Hex;
      blockNumber: string;
      contractFactory: string;
    }>;
    const entry = result?.[0];
    if (!entry) throw new Error(`Etherscan: no creation record for ${address}`);
    return {
      contractAddress: entry.contractAddress,
      contractCreator: entry.contractCreator,
      txHash: entry.txHash,
      blockNumber: Number(entry.blockNumber),
      contractFactory: entry.contractFactory ? (entry.contractFactory as Address) : null,
    };
  }
}
