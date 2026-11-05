import type { Abi } from "viem";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface TxRequest {
  to: Address | null;
  data: Hex;
  value: bigint;
}

export interface TxResult {
  hash: Hex;
  status: "success" | "reverted";
  contractAddress: Address | null;
  gasUsed: bigint;
}

/** Everything the engine needs from a chain. Implemented by chain-viem.ts (real) and test/fakes.ts. */
export interface ChainPort {
  readonly chainId: number;
  /** Address that sends every transaction. */
  readonly account: Address;
  getCode(address: Address): Promise<Hex>;
  getBalance(address: Address): Promise<bigint>;
  /** Transaction count (nonce) of `account`, at the latest block. */
  transactionCount(): Promise<number>;
  gasPrice(): Promise<bigint>;
  blockGasLimit(): Promise<bigint>;
  estimateGas(tx: TxRequest): Promise<bigint>;
  sendAndWait(tx: TxRequest & { gas: bigint; gasPrice: bigint }): Promise<TxResult>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

/** One fetched mainnet contract-creation transaction, stored under artifacts/<protocol>/<hash>.json. */
export interface TxArtifact {
  hash: Hex;
  from: Address;
  to: Address | null;
  /** Hex quantity, e.g. "0x0". */
  value: Hex;
  blockNumber: number;
  /** Full creation input: init code followed by constructor arguments. */
  input: Hex;
  contractAddress: Address | null;
  /** Constructor arguments alone ("0x" when there are none). A suffix of `input`. */
  constructorArgs: Hex;
  contractName: string;
  compiler: string;
  /** keccak256 of the mainnet runtime code, or null if the contract has no code. */
  runtimeCodeHash: Hex | null;
}

export interface StepContext {
  deployer: Address;
  /** Devnet address of a contract created earlier in this protocol or in a dependency. */
  address(name: string): Address;
  send(tx: TxRequest): Promise<TxResult>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
  /**
   * Registers a devnet address under `name`, the way a `create` step does automatically from
   * its receipt - for a contract a custom step deployed some other way (e.g. computed off a
   * CREATE2 factory call, whose receipt never carries a `contractAddress`). Visible to
   * `ctx.address(name)` immediately, including later in the same step. If the contract has a
   * meaningful real mainnet address of its own (not just a devnet-only artifact), pass
   * `mainnetAddress` too, so later constructor-argument rewriting or `patches` that reference it
   * resolve correctly.
   */
  record(name: string, address: Address, mainnetAddress?: Address): void;
}

export interface PatchSpec {
  /** Mainnet address whose 20-byte literal appears in the creation init code. */
  find: Address;
  /** Exact number of occurrences expected. A mismatch throws, so a wrong count can never
   *  silently under- or over-patch. */
  count: number;
}

export interface CreateStep {
  id: string;
  kind: "create";
  /** Mainnet creation transaction hash. */
  tx: Hex;
  /** Name under which the created contract is recorded. */
  as: string;
  /** Replace 32-byte head words of the constructor arguments, by word index. Static types only. */
  argWords?: Record<number, Hex>;
  /** Replace mainnet address literals baked into the creation init code itself (e.g. a
   *  pre-`immutable` Solidity address constant) with their devnet counterparts. Unlike
   *  `argWords`/the constructor-argument rewrite, this touches the init code, never the
   *  constructor arguments - a patch target must already have a devnet mapping (deployed in an
   *  earlier step) or the step fails loudly. */
  patches?: PatchSpec[];
}

export interface CustomStep {
  id: string;
  kind: "custom";
  run(ctx: StepContext): Promise<void>;
}

export type Step = CreateStep | CustomStep;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyContext {
  deployer: Address;
  address(name: string): Address;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

export interface Protocol {
  name: string;
  dependsOn: string[];
  steps: Step[];
  verify(ctx: VerifyContext): Promise<CheckResult[]>;
}

export interface ProtocolState {
  stepsDone: string[];
  /** Recorded name -> devnet address. */
  contracts: Record<string, Address>;
  /** Lower-case mainnet address -> devnet address, for address rewriting. */
  mainnetToDevnet: Record<string, Address>;
}

export interface JournalFile {
  chainId: number;
  protocols: Record<string, ProtocolState>;
  /** The deployer's transaction count after the last completed step; guards against outside sends. */
  deployerNonce?: number;
}

export interface ArtifactStore {
  read(protocol: string, hash: Hex): TxArtifact;
  write(protocol: string, artifact: TxArtifact): void;
}

export interface JournalStore {
  load(chainId: number): JournalFile;
  save(file: JournalFile): void;
}
