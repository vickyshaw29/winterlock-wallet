// Ordinary EOA transactions (legacy and EIP-1559, chain 31337 only): parsing, admission checks and their effects.
// Written with Claude Code (AI) for Vicky.
// Contract creation is refused: the implementation and the factory are already in genesis.
import { getAddress, hexToBytes, keccak256, parseTransaction, serializeTransaction, type Address, type Hex } from "viem";
import { Meter, StateMeter } from "./accountModel.ts";
import { BLOCK_GAS_LIMIT, CHAIN_ID } from "./constants.ts";
import { ProtocolRefusal, callFailure, executeCall, type BlockCtx, type ModelOpts } from "./frameTx.ts";
import { recoverSigner } from "./sidecarRules.ts";
import type { Log } from "./factoryModel.ts";
import type { WorldState } from "./state.ts";

export interface EoaTx {
  raw: Hex;
  hash: Hex;
  from: Address;
  type: "legacy" | "eip1559";
  nonce: bigint;
  to: Address | null;
  value: bigint;
  data: Hex;
  gas: bigint;
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  v: bigint;
  r: Hex;
  s: Hex;
  yParity: number;
}

/** Parses a signed EOA transaction and recovers its sender. Throws ProtocolRefusal. */
export function parseEoaTx(raw: Hex): EoaTx {
  let p: ReturnType<typeof parseTransaction>;
  try { p = parseTransaction(raw); } catch (e) { throw new ProtocolRefusal(-32602, `invalid raw transaction: ${(e as Error).message.split("\n")[0]}`); }
  if (p.type !== "legacy" && p.type !== "eip1559") throw new ProtocolRefusal(-32000, `fakechain does not model ${p.type} transactions (legacy and EIP-1559 only)`);
  if (p.chainId === undefined) throw new ProtocolRefusal(-32000, "only replay-protected (EIP-155) transactions are accepted");
  if (BigInt(p.chainId) !== CHAIN_ID) throw new ProtocolRefusal(-32000, `invalid chain id: this is chain ${CHAIN_ID}, the transaction is for chain ${p.chainId}`);
  if (!p.r || !p.s) throw new ProtocolRefusal(-32602, "the transaction is not signed");
  const { r, s, v, yParity, ...unsigned } = p;
  const parity = p.type === "legacy" ? Number(v! - 35n - 2n * CHAIN_ID) : Number(yParity);
  const from = recoverSigner(keccak256(serializeTransaction(unsigned as Parameters<typeof serializeTransaction>[0])), parity, BigInt(r), BigInt(s));
  if (!from || (parity !== 0 && parity !== 1)) throw new ProtocolRefusal(-32000, "invalid transaction signature");
  return {
    raw, hash: keccak256(raw), from, type: p.type, nonce: BigInt(p.nonce ?? 0), to: p.to ? getAddress(p.to) : null, value: p.value ?? 0n,
    data: (p.data ?? "0x") as Hex, gas: p.gas ?? 0n, gasPrice: p.type === "legacy" ? p.gasPrice ?? 0n : null,
    maxFeePerGas: p.type === "eip1559" ? p.maxFeePerGas ?? 0n : null, maxPriorityFeePerGas: p.type === "eip1559" ? p.maxPriorityFeePerGas ?? 0n : null,
    v: v ?? BigInt(parity), r, s, yParity: parity,
  };
}

export const maxPrice = (tx: EoaTx) => tx.gasPrice ?? tx.maxFeePerGas!;
export const eoaPrice = (tx: EoaTx, baseFee: bigint) => {
  if (tx.gasPrice !== null) return tx.gasPrice;
  const tip = baseFee + tx.maxPriorityFeePerGas!;
  return tx.maxFeePerGas! < tip ? tx.maxFeePerGas! : tip;
};
export function intrinsicGas(data: Hex): bigint {
  let g = 21_000n;
  for (const b of hexToBytes(data)) g += b === 0 ? 4n : 16n;
  return g;
}

/** ethrex's price_bump_percent for an ordinary transaction replacing a pooled one (assumed default 10). */
export const EOA_PRICE_BUMP_PERCENT = 10n;
const tip = (tx: EoaTx) => tx.gasPrice ?? tx.maxPriorityFeePerGas!;
/**
 * ethrex's check_replacement_bid (crates/blockchain/mempool.rs on the devnet's branch): the fee cap and the tip must
 * both rise, and each by at least the bump, else MempoolError::UnderpricedReplacement.
 */
export function isBumpedReplacement(pooled: EoaTx, tx: EoaTx): boolean {
  const bumped = (old: bigint, now: bigint) => now >= (old * (100n + EOA_PRICE_BUMP_PERCENT)) / 100n;
  if (maxPrice(tx) <= maxPrice(pooled) || tip(tx) <= tip(pooled)) return false;
  return bumped(maxPrice(pooled), maxPrice(tx)) && bumped(tip(pooled), tip(tx));
}

/**
 * The public pool's checks, against the latest state and the next nonce the pool expects from this sender. `pooled` is
 * the pending transaction with this sender and nonce, if any: this one replaces it only with a fee bump.
 */
export function checkEoaAdmission(tx: EoaTx, state: WorldState, pendingNonce: bigint, baseFee: bigint, pooled: EoaTx | null = null): void {
  if (tx.to === null) throw new ProtocolRefusal(-32000, "fakechain does not model contract creation: the account implementation and the factory are already in genesis");
  if (tx.nonce < state.nonce(tx.from)) throw new ProtocolRefusal(-32000, `nonce too low: next nonce ${state.nonce(tx.from)}, tx nonce ${tx.nonce}`);
  if (pooled && !isBumpedReplacement(pooled, tx)) throw new ProtocolRefusal(-32000, "Attempted to replace a pooled transaction with an underpriced transaction");
  if (!pooled && tx.nonce !== pendingNonce) throw new ProtocolRefusal(-32000, `nonce too high: next nonce ${pendingNonce}, tx nonce ${tx.nonce} (fakechain queues no future nonces)`);
  const intrinsic = intrinsicGas(tx.data);
  if (tx.gas < intrinsic) throw new ProtocolRefusal(-32000, `intrinsic gas too low: have ${tx.gas}, want ${intrinsic}`);
  if (tx.gas > BLOCK_GAS_LIMIT) throw new ProtocolRefusal(-32000, `exceeds block gas limit ${BLOCK_GAS_LIMIT}`);
  if (tx.maxPriorityFeePerGas !== null && tx.maxPriorityFeePerGas > tx.maxFeePerGas!) throw new ProtocolRefusal(-32000, "max priority fee per gas higher than max fee per gas");
  if (maxPrice(tx) < baseFee) throw new ProtocolRefusal(-32000, `max fee per gas less than block base fee: address ${tx.from}, maxFeePerGas: ${maxPrice(tx)}, baseFee: ${baseFee}`);
  const cost = tx.gas * maxPrice(tx) + tx.value;
  if (state.balance(tx.from) < cost) throw new ProtocolRefusal(-32000, `insufficient funds for gas * price + value: balance ${state.balance(tx.from)}, tx cost ${cost}`);
}

export interface EoaOutcome { status: 0 | 1; gasUsed: bigint; logs: Log[]; reason?: string; post: WorldState; price: bigint }

/** Gas pool shared by execution and state gas: an EOA transaction (or eth_call) has one gas limit for both. */
export class SharedStateMeter extends StateMeter {
  constructor(private readonly meter: Meter) { super(0n); }
  override charge(n: bigint) { this.used += n; this.meter.charge(Number(n)); }
}

/** The transaction applied to `state` (not changed); null when it cannot be included now (nonce or funds). */
export function applyEoaTx(tx: EoaTx, state: WorldState, ctx: BlockCtx, opts: ModelOpts): EoaOutcome | null {
  if (tx.to === null || tx.nonce !== state.nonce(tx.from)) return null;
  const price = eoaPrice(tx, ctx.baseFee);
  if (maxPrice(tx) < ctx.baseFee || state.balance(tx.from) < tx.gas * maxPrice(tx) + tx.value) return null;
  const paid = state.clone();
  paid.setNonce(tx.from, tx.nonce + 1n);
  paid.addBalance(tx.from, -tx.gas * price);
  const intrinsic = intrinsicGas(tx.data);
  const meter = new Meter(Number(tx.gas - intrinsic));
  const work = paid.clone();
  let status: 0 | 1 = 1, logs: Log[] = [], reason: string | undefined, gasUsed: bigint;
  try {
    logs = executeCall({
      state: work, original: state, from: tx.from, to: tx.to, value: tx.value, data: hexToBytes(tx.data), meter, stateMeter: new SharedStateMeter(meter),
      ctx, opts, access: new Set([tx.from.toLowerCase(), tx.to.toLowerCase(), ctx.coinbase.toLowerCase()]), warm: new Map(),
    }).logs;
    gasUsed = intrinsic + BigInt(meter.used);
  } catch (e) {
    const f = callFailure(e);
    status = 0;
    reason = f.reason;
    gasUsed = f.outOfGas ? tx.gas : intrinsic + BigInt(Math.min(meter.used, meter.budget));
  }
  const post = status === 1 ? work : paid;
  post.addBalance(tx.from, (tx.gas - gasUsed) * price);
  post.addBalance(ctx.coinbase, gasUsed * (price - ctx.baseFee));
  return { status, gasUsed, logs, ...(reason ? { reason } : {}), post, price };
}

/**
 * What eth_estimateGas answers for a plain call from an EOA: the least gas at which the call, run on `state` as it would
 * be included, succeeds (the proxy's 63/64 holdback included); or why it fails at any gas.
 */
export function estimateEoaGas(state: WorldState, ctx: BlockCtx, opts: ModelOpts, call: { from: Address; to: Address; value: bigint; data: Hex }): { gas: bigint } | { reason: string } {
  const run = (gas: bigint) => applyEoaTx({
    raw: "0x", hash: "0x", from: call.from, type: "eip1559", nonce: state.nonce(call.from), to: call.to, value: call.value, data: call.data, gas,
    gasPrice: null, maxFeePerGas: ctx.baseFee, maxPriorityFeePerGas: 0n, v: 0n, r: "0x", s: "0x", yParity: 0,
  }, state, ctx, opts);
  const top = run(BLOCK_GAS_LIMIT);
  if (!top) return { reason: `${call.from} cannot pay for the call` };
  if (top.status !== 1) return { reason: top.reason ?? "execution reverted" };
  for (let gas = top.gasUsed, i = 0; i < 64; i++, gas += gas / 64n + 1n) if (run(gas)?.status === 1) return { gas };
  return { reason: "no gas limit below the block's lets the call succeed" };
}
