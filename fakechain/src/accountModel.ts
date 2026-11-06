// Account.yul modelled in TypeScript, check by check, with its own 32-byte revert strings; it runs no EVM code.
// Written with Claude Code (AI) for Vicky.
// Covers verifyFrame, hotPolicy, the admin functions, the views and initialize, in Account.yul's order.
//
// The WOTS+ and Merkle steps (hashsig_verify) are the pipeline's own off-chain mirror, verifyEntry. Gas follows the
// measured model (pipeline/src/config.ts GRIND, the spec's Day-0 notes): see VERIFY_GAS.
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import { verifyEntry } from "../../pipeline/src/hashsig/keyring.ts";
import { wotsVerifySteps } from "../../pipeline/src/wots.ts";

// ------------------------------------------------------------------ revert strings and selectors
/** Every reason Account.yul's fail() can give; a test checks this list against the Yul source. */
export const REASONS = [
  "not initialized", "nonce: key count", "nonce: legacy key", "nonce: sequence", "nonce: epoch", "nonce: leaf range",
  "sig: count", "sig: owner scheme", "sig: owner msg", "sig: owner", "sig: entry scheme", "sig: entry msg",
  "sig: entry length", "sig: entry version", "sig: entry slot", "sig: hash-based check",
  "hot: disabled", "hot: fee cap", "hot: frame mode", "hot: frame data", "hot: frame target", "hot: value overflow", "hot: value cap",
  "bad argument", "rotate: same tree", "epoch overflow", "hybrid: no owner", "hot: band cannot shrink", "hybrid: owner needed",
  "no such function", "already initialized", "short calldata", "bad height", "hot: no cold leaf left",
] as const;
export type Reason = (typeof REASONS)[number];

/** The selectors Account.yul dispatches on. */
export const SELECTORS = {
  rotate: 0x6c6f2d65, setHybrid: 0xfd7f4621, setHotPolicy: 0x58aaa077, setOwner: 0x13af4035, initialize: 0x5dfc452b,
  root: 0xebf0c717, treeSeed: 0x6f9875b4, height: 0x0ef26743, epoch: 0x900cf0cf, hotStart: 0x2ea7cf20,
  hotValueCap: 0x682ba990, hotFeeCap: 0x3a36be2b, allowedTarget: 0x73a8c682, owner: 0x8da5cb5b, hybridRequired: 0xb7d66406,
} as const;

/** fail(reason): mstore(0, reason) revert(0, 32): the ASCII text left-aligned in one word. */
export function reasonWord(reason: string): Hex {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(reason).slice(0, 32));
  return toHex(b);
}
/** The text back out of 32 bytes of revert data, or null when it is not one of the account's reasons. */
export function decodeReason(data: Hex | undefined): string | null {
  if (!data || data.length !== 66) return null;
  const text = new TextDecoder().decode(hexToBytes(data)).replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

export class Revert extends Error {
  constructor(readonly reason: string, readonly data: Hex = reasonWord(reason)) { super(reason); }
}
/** A call ran past its gas. `kind` says which budget: execution or the frame's state limit. */
export class OutOfGas extends Error {
  constructor(readonly kind: "execution" | "state" = "execution") { super(kind === "state" ? "out of state gas" : "out of gas"); }
}
const fail = (reason: Reason): never => { throw new Revert(reason); };

/** Gas meter: a charge past the budget stops the call, as the EVM does. */
export class Meter {
  used = 0;
  constructor(readonly budget: number) {}
  charge(n: number) {
    this.used += n;
    if (this.used > this.budget) throw new OutOfGas();
  }
}
/** State gas (EIP-8037) comes from the frame's state limit only; past it the frame reverts. */
export class StateMeter {
  used = 0n;
  constructor(readonly budget: bigint) {}
  charge(n: bigint) {
    this.used += n;
    if (this.used > this.budget) throw new OutOfGas("state");
  }
}

// ------------------------------------------------------------------ config word (storage slot 2)
const M32 = 0xffffffffn, M160 = (1n << 160n) - 1n;
export const cfg = {
  owner: (c: bigint) => c & M160,
  height: (c: bigint) => (c >> 160n) & 0xffn,
  epoch: (c: bigint) => (c >> 168n) & M32,
  flags: (c: bigint) => (c >> 200n) & 0xffn,
  hotStart: (c: bigint) => (c >> 208n) & M32,
};
export const packConfig = (owner: bigint, h: bigint, epoch: bigint, flags: bigint, hotStart: bigint) =>
  owner | (h << 160n) | (epoch << 168n) | (flags << 200n) | (hotStart << 208n);
export const addressWord = (a: string) => BigInt(a);
export const wordAddress = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}` as Address;

// ------------------------------------------------------------------ gas model of the verify frame
/**
 * The cold verify frame as measured on account 2 through its proxy (simulate-verify-gas.ts, Nov 6; pipeline/src/config.ts
 * GRIND): 54,630 + 66.09 x WOTS+ chain steps, largest residual 252. The brief's earlier estimate was 54,466 + 66.06 x
 * steps (hashsig_verify alone measured 24,070 + 66.06 x steps). 121 more for the hybrid owner entry, 6,623 more on a hot
 * leaf (Day-0 estimates). Split into what the proxy spends before its DELEGATECALL and what the account spends, so a
 * failing check costs what ran before it, and the 63/64 rule applies to the account's part only.
 * The fit was taken at height 10, whose path has 14 levels: another height adds or drops `pathLevel + entryWord` per
 * level (the path part scales with height + 4).
 */
export const VERIFY_GAS = {
  /** the height account 2's fit was measured at */
  measuredHeight: 10,
  /** one more path hash in hashsig_verify: HashSigVerifier's measure() at heights 4, 10 and 12, two messages, Nov 6 */
  pathLevel: 190,
  /** one more 32-byte word of the entry for the account's SIGDATACOPY: 3 to copy, about 3 of memory (estimate) */
  entryWord: 6,
  /** frame entry, the proxy's opcodes and its cold DELEGATECALL (PROXY_PRE_CALL in pipeline/src/config.ts) */
  proxyPreCall: 3_124,
  /** the account's reads and checks before hashsig_verify: 54,630 - 24,070 - 3,124 - 20,000 */
  accountChecks: 7_436,
  hybridChecks: 121,
  verifierBase: 24_070,
  verifierPerStep: 66.09,
  hotPolicy: 6_623,
  /** a nonce key's first use, charged inside APPROVE on the devnet revision */
  freshKey: 20_000,
} as const;
/** hashsig_verify at a tree height: the measured fit, with (height + 4) path levels where the fit had 14. */
export const hashsigGas = (steps: number, height: number) =>
  Math.round(VERIFY_GAS.verifierBase + VERIFY_GAS.verifierPerStep * steps) + VERIFY_GAS.pathLevel * (height - VERIFY_GAS.measuredHeight);

/**
 * Gas the account's code may use under the proxy. EIP-150: a CALL-family opcode passes on at most all but 1/64 of the
 * gas left after its own cost, and the EIP-1167 proxy asks for all of it (GAS, DELEGATECALL).
 */
export function calleeBudget(frameLimit: number, preCall: number, holdback: boolean): number {
  const available = frameLimit - preCall;
  if (available <= 0) return 0;
  return holdback ? available - Math.floor(available / 64) : available;
}

// ------------------------------------------------------------------ the transaction as the verify frame sees it
/** What TXPARAM, FRAMEPARAM, SIGPARAM, SIGDATACOPY and CHAINID return for this transaction. */
export interface TxView {
  nonceKeys: bigint[];
  nonceSeq: bigint;
  /** TXPARAM 0x08 */
  sigHash: Hex;
  /** TXPARAM 0x06, the transaction's maximum cost */
  maxCost: bigint;
  chainId: bigint;
  /** TXPARAM 0x0A */
  currentFrame: number;
  frames: { mode: number; target: Address; dataLength: number; value: bigint }[];
  /** resolvedSigner is SIGPARAM 0x00; null where that read halts (ARBITRARY) */
  signatures: { scheme: number; msgEmpty: boolean; resolvedSigner: Address | null; bytes: Uint8Array }[];
}
export interface Storage { sload(slot: bigint): bigint }

export interface Approval { hot: boolean; leaf: number; steps: number }

/** verifyFrame(): returns at APPROVE(3); throws Revert at a fail() and OutOfGas when the meter runs dry. */
export function verifyFrame(tx: TxView, s: Storage, meter: Meter): Approval {
  let charged = 0;
  const charge = (n: number) => { charged += n; meter.charge(n); };

  // 2. Storage: three cold SLOADs; the hot-policy words are read only for a hot leaf.
  charge(2_100);
  const root = s.sload(0n);
  if (root === 0n) fail("not initialized");
  charge(4_200);
  const treeSeed = s.sload(1n);
  const config = s.sload(2n);
  const height = Number(cfg.height(config));

  // 3. Nonce mode: one fresh key at sequence 0, named (epoch << 32) | leaf.
  const check = () => charge(40);
  check(); if (tx.nonceKeys.length !== 1) fail("nonce: key count");
  const key = tx.nonceKeys[0]!;
  check(); if (key === 0n) fail("nonce: legacy key");
  check(); if (tx.nonceSeq !== 0n) fail("nonce: sequence");
  check(); if (key >> 32n !== cfg.epoch(config)) fail("nonce: epoch");
  const leaf = Number(key & M32);
  check(); if (!(leaf < 2 ** height)) fail("nonce: leaf range");
  const hot = !(BigInt(leaf) < cfg.hotStart(config));

  // 4. Signature shape: [owner ECDSA,] hash-based entry. Hot tickets carry no classical key.
  let count = 1;
  if ((cfg.flags(config) & 1n) === 1n && !hot) count = 2;
  check(); if (tx.signatures.length !== count) fail("sig: count");
  if (count === 2) {
    const e0 = tx.signatures[0]!;
    if (e0.scheme !== 1) fail("sig: owner scheme"); // checked before the signer read, which halts on ARBITRARY
    if (!e0.msgEmpty) fail("sig: owner msg");
    if ((e0.resolvedSigner === null ? -1n : addressWord(e0.resolvedSigner)) !== cfg.owner(config)) fail("sig: owner");
  }
  const p = tx.signatures[count - 1]!;
  check(); if (p.scheme !== 0) fail("sig: entry scheme");
  check(); if (!p.msgEmpty) fail("sig: entry msg");
  const entryLen = p.bytes.length;
  check(); if (entryLen !== 2146 + 32 * (height + 4)) fail("sig: entry length");
  const entry = p.bytes; // SIGDATACOPY of exactly entryLen bytes
  check(); if (entry[0] !== 1) fail("sig: entry version");
  check(); if (entry[1]! > 15) fail("sig: entry slot");

  // 5 to 8. hashsig_verify: its gas depends on the message alone, so a forgery costs what a valid entry costs.
  const entryWords = VERIFY_GAS.entryWord * (height - VERIFY_GAS.measuredHeight); // SIGDATACOPY of a longer or shorter entry
  charge(VERIFY_GAS.accountChecks + entryWords + (count === 2 ? VERIFY_GAS.hybridChecks : 0) - charged);
  const steps = wotsVerifySteps(tx.sigHash);
  charge(hashsigGas(steps, height));
  const ok = verifyEntry({
    entry, msg: hexToBytes(tx.sigHash), root: wordBytes(root), treeSeed: wordBytes(treeSeed), height, chainId: tx.chainId, leaf,
  }).ok;
  if (!ok) fail("sig: hash-based check");

  // 9. Hot tickets: only plain value transfers to the one allowed target, under both caps.
  if (hot) hotPolicy(tx, s, meter);

  // 10. APPROVE(0x3): the fresh key's first use is paid inside it.
  meter.charge(VERIFY_GAS.freshKey);
  return { hot, leaf, steps };
}

function hotPolicy(tx: TxView, s: Storage, meter: Meter) {
  const bodyFrames = Math.max(0, tx.frames.length - tx.currentFrame - 1);
  const total = VERIFY_GAS.hotPolicy + 60 * Math.max(0, bodyFrames - 1);
  let charged = 0;
  const charge = (n: number) => { charged += n; meter.charge(n); };
  charge(2_100);
  const valueCap = s.sload(3n);
  if (valueCap === 0n) fail("hot: disabled"); // a zero cap is the kill switch
  charge(2_120);
  if (tx.maxCost > s.sload(4n)) fail("hot: fee cap"); // the transaction's maximum cost
  charge(2_100);
  const target = s.sload(5n);
  let sum = 0n;
  for (let i = tx.currentFrame + 1; i < tx.frames.length; i++) {
    charge(60);
    const f = tx.frames[i]!;
    if (f.mode !== 2) fail("hot: frame mode"); // SENDER only, no DEFAULT
    if (f.dataLength !== 0) fail("hot: frame data"); // no calldata
    if (addressWord(f.target) !== target) fail("hot: frame target");
    const next = (sum + f.value) % (1n << 256n);
    if (next < sum) fail("hot: value overflow");
    sum = next;
  }
  if (sum > valueCap) fail("hot: value cap");
  charge(Math.max(0, total - charged));
}

const wordBytes = (w: bigint) => hexToBytes(`0x${w.toString(16).padStart(64, "0")}`);

// ------------------------------------------------------------------ calls into the account (SENDER frames, EOAs, eth_call)
/**
 * Storage access for one call, with warm and cold reads and SSTORE costs (EIP-2929, EIP-2200; zero to non-zero also
 * charges 97,920 state gas, EIP-8037). Writes go to `write` at once; the caller drops them if the call reverts.
 */
export class StorageCtx implements Storage {
  constructor(
    private readonly current: (slot: bigint) => bigint,
    private readonly original: (slot: bigint) => bigint,
    private readonly write: (slot: bigint, v: bigint) => void,
    private readonly warm: Set<bigint>,
    private readonly meter: Meter,
    private readonly state: StateMeter,
  ) {}
  sload(slot: bigint): bigint {
    this.meter.charge(this.warm.has(slot) ? 100 : 2_100);
    this.warm.add(slot);
    return this.current(slot);
  }
  sstore(slot: bigint, v: bigint) {
    // EIP-2200's sentry: with 2,300 gas or less left (the call stipend), SSTORE fails the call with out of gas.
    if (this.meter.budget - this.meter.used <= 2_300) throw new OutOfGas();
    if (!this.warm.has(slot)) { this.meter.charge(2_100); this.warm.add(slot); }
    const cur = this.current(slot), orig = this.original(slot);
    if (v === cur || cur !== orig) this.meter.charge(100);
    else {
      this.meter.charge(2_900);
      if (orig === 0n) this.state.charge(97_920n);
    }
    this.write(slot, v);
  }
}

export interface CallResult { returnData: Hex }
const word = (data: Uint8Array, i: number) => {
  let v = 0n;
  for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(data[4 + 32 * i + j] ?? 0);
  return v;
};
const ret = (v: bigint): CallResult => ({ returnData: `0x${v.toString(16).padStart(64, "0")}` });
const STOP: CallResult = { returnData: "0x" };

/** The runtime's dispatch for any caller other than the entry point: selfCall when the caller is the account itself. */
export function accountCall(data: Uint8Array, selfCaller: boolean, s: StorageCtx, meter: Meter): CallResult {
  meter.charge(150); // dispatch
  return selfCaller ? selfCall(data, s, meter) : publicCall(data, s, meter);
}

function selector(data: Uint8Array) { return ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0; }
function needArgs(data: Uint8Array, n: number) { if (data.length < 4 + 32 * n) fail("short calldata"); }
function argAddress(v: bigint) { if (v >> 160n) fail("bad argument"); return v; }
function argUint32(v: bigint) { if (v >> 32n) fail("bad argument"); return v; }
function argBool(v: bigint) { if (v > 1n) fail("bad argument"); return v; }
/** 1 to 28: the uint32 leaf index (slot << height) | leaf needs height + 4 <= 32. */
function argHeight(v: bigint) { if (v === 0n || v > 28n) fail("bad height"); return v; }
/** hotStart 0 makes every leaf hot, and so does 1 at epoch 0 (leaf 0 cannot sign): admin calls need a cold leaf. */
function requireColdLeaf(hotStart: bigint, epoch: bigint) {
  if (hotStart === 0n || (hotStart === 1n && epoch === 0n)) fail("hot: no cold leaf left");
}

/** SENDER frames of the account itself: the admin functions. */
function selfCall(data: Uint8Array, s: StorageCtx, meter: Meter): CallResult {
  if (data.length < 4) return STOP; // the account paying itself
  switch (selector(data)) {
    case SELECTORS.rotate: {
      needArgs(data, 3);
      const newRoot = word(data, 0);
      if (newRoot === 0n) fail("bad argument");
      const newHeight = argHeight(word(data, 2));
      // Re-installing the current tree under the next epoch would reopen every leaf it has already used.
      if (newRoot === s.sload(0n) || word(data, 1) === s.sload(1n)) fail("rotate: same tree");
      const config = s.sload(2n);
      const epoch = cfg.epoch(config) + 1n;
      if (epoch > M32) fail("epoch overflow");
      s.sstore(0n, newRoot);
      s.sstore(1n, word(data, 1));
      s.sstore(2n, packConfig(cfg.owner(config), newHeight, epoch, cfg.flags(config), cfg.hotStart(config)));
      return STOP;
    }
    case SELECTORS.setHybrid: {
      needArgs(data, 1);
      const on = argBool(word(data, 0));
      const config = s.sload(2n);
      if (on === 1n && cfg.owner(config) === 0n) fail("hybrid: no owner");
      const flags = (cfg.flags(config) & 0xfen) | on;
      s.sstore(2n, packConfig(cfg.owner(config), cfg.height(config), cfg.epoch(config), flags, cfg.hotStart(config)));
      return STOP;
    }
    case SELECTORS.setHotPolicy: {
      needArgs(data, 4);
      const hotStart = argUint32(word(data, 0));
      const target = argAddress(word(data, 3));
      const config = s.sload(2n);
      // Raising hotStart would turn tickets already handed to a hot device into cold leaves, which have no caps.
      if (hotStart > cfg.hotStart(config)) fail("hot: band cannot shrink");
      requireColdLeaf(hotStart, cfg.epoch(config));
      s.sstore(2n, packConfig(cfg.owner(config), cfg.height(config), cfg.epoch(config), cfg.flags(config), hotStart));
      s.sstore(3n, word(data, 1));
      s.sstore(4n, word(data, 2));
      s.sstore(5n, target);
      return STOP;
    }
    case SELECTORS.setOwner: {
      needArgs(data, 1);
      const newOwner = argAddress(word(data, 0));
      const config = s.sload(2n);
      if (newOwner === 0n && (cfg.flags(config) & 1n) === 1n) fail("hybrid: owner needed"); // turn hybrid off first
      s.sstore(2n, packConfig(newOwner, cfg.height(config), cfg.epoch(config), cfg.flags(config), cfg.hotStart(config)));
      return STOP;
    }
    default:
      return publicCall(data, s, meter);
  }
}

/** Views, initialize (once), plain ETH receipt. */
function publicCall(data: Uint8Array, s: StorageCtx, meter: Meter): CallResult {
  if (data.length === 0) return STOP; // plain ETH receipt
  if (data.length < 4) fail("no such function");
  switch (selector(data)) {
    case SELECTORS.initialize: return initialize(data, s);
    case SELECTORS.root: return ret(s.sload(0n));
    case SELECTORS.treeSeed: return ret(s.sload(1n));
    case SELECTORS.height: return ret(cfg.height(s.sload(2n)));
    case SELECTORS.epoch: return ret(cfg.epoch(s.sload(2n)));
    case SELECTORS.hotStart: return ret(cfg.hotStart(s.sload(2n)));
    case SELECTORS.hotValueCap: return ret(s.sload(3n));
    case SELECTORS.hotFeeCap: return ret(s.sload(4n));
    case SELECTORS.allowedTarget: return ret(s.sload(5n));
    case SELECTORS.owner: return ret(cfg.owner(s.sload(2n)));
    case SELECTORS.hybridRequired: return ret(cfg.flags(s.sload(2n)) & 1n);
    default: return fail("no such function");
  }
}

/** Called by the factory in the call that creates the proxy. Epoch 0, hybrid off. */
function initialize(data: Uint8Array, s: StorageCtx): CallResult {
  if (s.sload(0n) !== 0n) fail("already initialized");
  needArgs(data, 8);
  const newRoot = word(data, 0);
  if (newRoot === 0n) fail("bad argument");
  const newHeight = argHeight(word(data, 2));
  const newOwner = argAddress(word(data, 3));
  const hotStart = argUint32(word(data, 4));
  requireColdLeaf(hotStart, 0n);
  const target = argAddress(word(data, 7));
  s.sstore(0n, newRoot);
  s.sstore(1n, word(data, 1));
  s.sstore(2n, packConfig(newOwner, newHeight, 0n, 0n, hotStart));
  s.sstore(3n, word(data, 5));
  s.sstore(4n, word(data, 6));
  s.sstore(5n, target);
  return STOP;
}
