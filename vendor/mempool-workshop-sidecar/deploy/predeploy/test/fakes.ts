import type { Abi } from "viem";
import type {
  Address,
  ArtifactStore,
  ChainPort,
  Hex,
  JournalFile,
  JournalStore,
  TxArtifact,
  TxRequest,
  TxResult,
} from "../src/types";

export const DEPLOYER = "0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0" as Address;

export type SentTx = TxRequest & { gas: bigint; gasPrice: bigint };

/** In-memory chain. Contract creations get addresses 0x…01, 0x…02, … and non-empty code. */
export class FakeChain implements ChainPort {
  chainId = 1337;
  account = DEPLOYER;
  estimate = 100_000n;
  blockLimit = 60_000_000n;
  price = 1_000_000n;
  estimateError: string | null = null;
  revertNext = false;
  /** Transactions sent from the deployer outside this tool; tests set it to simulate that. */
  extraNonce = 0;
  readonly sent: SentTx[] = [];
  readonly codes = new Map<string, Hex>();
  readonly balances = new Map<string, bigint>();
  readonly reads = new Map<string, unknown>();
  private counter = 0;

  async getCode(address: Address): Promise<Hex> {
    return this.codes.get(address.toLowerCase()) ?? "0x";
  }
  async getBalance(address: Address): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async transactionCount(): Promise<number> {
    return this.sent.length + this.extraNonce;
  }
  async gasPrice(): Promise<bigint> {
    return this.price;
  }
  async blockGasLimit(): Promise<bigint> {
    return this.blockLimit;
  }
  async estimateGas(_tx: TxRequest): Promise<bigint> {
    if (this.estimateError) throw new Error(this.estimateError);
    return this.estimate;
  }
  async sendAndWait(tx: SentTx): Promise<TxResult> {
    this.sent.push(tx);
    const hash = `0x${"ab".repeat(31)}${this.sent.length.toString(16).padStart(2, "0")}` as Hex;
    if (this.revertNext) {
      this.revertNext = false;
      return { hash, status: "reverted", contractAddress: null, gasUsed: 0n };
    }
    let contractAddress: Address | null = null;
    if (tx.to === null) {
      contractAddress = `0x${(++this.counter).toString(16).padStart(40, "0")}` as Address;
      this.codes.set(contractAddress.toLowerCase(), "0x6001");
    }
    return { hash, status: "success", contractAddress, gasUsed: tx.gas };
  }
  async read(address: Address, _abi: Abi, functionName: string): Promise<unknown> {
    const key = `${address.toLowerCase()}:${functionName}`;
    if (!this.reads.has(key)) throw new Error(`FakeChain: no canned read for ${key}`);
    return this.reads.get(key);
  }
  /** Canned answer for read(address, _, functionName). */
  setRead(address: Address, functionName: string, value: unknown): void {
    this.reads.set(`${address.toLowerCase()}:${functionName}`, value);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  private readonly items = new Map<string, TxArtifact>();
  read(protocol: string, hash: Hex): TxArtifact {
    const found = this.items.get(`${protocol}/${hash}`);
    if (!found) throw new Error(`MemoryArtifacts: missing ${protocol}/${hash}`);
    return found;
  }
  write(protocol: string, artifact: TxArtifact): void {
    this.items.set(`${protocol}/${artifact.hash}`, artifact);
  }
}

export class MemoryJournal implements JournalStore {
  file: JournalFile = { chainId: 1337, protocols: {} };
  load(chainId: number): JournalFile {
    return structuredClone({ ...this.file, chainId });
  }
  save(file: JournalFile): void {
    this.file = structuredClone(file);
  }
}

export function makeArtifact(overrides: Partial<TxArtifact> & Pick<TxArtifact, "hash">): TxArtifact {
  return {
    from: "0x36928500Bc1dCd7af6a2B4008875CC336b927D57",
    to: null,
    value: "0x0",
    blockNumber: 1,
    input: "0x6080",
    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    constructorArgs: "0x",
    contractName: "Token",
    compiler: "v0.4.18",
    runtimeCodeHash: null,
    ...overrides,
  };
}

export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
