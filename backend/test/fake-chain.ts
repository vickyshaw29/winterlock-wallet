// A fake chain, node and sidecar for the backend's tests, installed by replacing the methods of the pipeline's `node`
// and `gateway` and of the backend's `eth` (as pipeline/test/submit.test.ts does). It keeps the rules that matter:
//   - a nonce key is consumed once, at inclusion; the expiry frame stops inclusion past the deadline; state is read
//     at a given block, two below the head when the pipeline decides an outcome;
//   - the account's verify frame: keyed nonce at sequence 0 and the right epoch, one ARBITRARY entry of the right
//     length, the WOTS+ signature and Merkle path checked by the pipeline's mirror of the Yul verifier (verifyEntry),
//     and the hot rules (SENDER frames only, no data, the one target, both caps);
//   - the account's admin calls (rotate, setHotPolicy) with Account.yul's refusals, the factory's createAccount from an
//     EOA's legacy transaction, the public pool's one pending transaction per sender.
// Block timestamps follow the host clock, so the pipeline's 60 s clock check passes unless the chain is "halted": then
// the latest block is two minutes old however it is asked for (node.block, node.blockTimestamp, eth_getBlockByNumber).
// For parallel lanes (Nov 6), the sidecar's relay can be set: skandha_config and skandha_explorer_info answer from it,
// and with batching on, alt lanes wait as New until relayPass() hands up to bundleSize of them to one block.
// The calls the pipeline makes through rpc() directly (estimateCalls's two, relayConfig's two) are answered by a fake
// fetch; any other direct call throws. Nothing leaves this process. Written with Claude Code (AI) for Vicky.
import {
  decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseTransaction, recoverTransactionAddress, toHex,
  type Address, type Hex,
} from "viem";
import {
  EXPIRY_VERIFIER, EXPIRY_VERIFIER_CODE, FACTORY_ABI, NONCE_MANAGER, NONCE_MANAGER_CODE, RpcError, computeSigHash, frameGasModel,
  frameTxHash, fromWire, gateway, node, nonceManagerSlot, normalizeNodeReceipt, predictAccountAddress, proxyRuntimeCode,
  type FrameTransaction, type SimulationResult,
} from "../../pipeline/src/index.ts";
import { verifyEntry } from "../../pipeline/src/hashsig/keyring.ts";
import { ACCOUNT_ABI, eth } from "../src/chain.ts";

export const GENESIS: Hex = `0x${"1e".repeat(32)}`;
export const IMPLEMENTATION: Address = getAddress("0x00000000000000000000000000000000000a11ce");
export const FACTORY: Address = getAddress("0x00000000000000000000000000000000000fac70");
export const MARKET = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const ONE_ETH = 1_000_000_000_000_000_000n;

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const now = () => BigInt(Math.floor(Date.now() / 1000));
export const answered = (method: string, code: number, msg: string) => new RpcError(method, code, msg, undefined, "answered");
export const lost = (method: string) => new RpcError(method, undefined, "no response: The operation timed out.", undefined, "transport");
/** A revert reason as the account returns it: 32 bytes of ASCII, left-aligned. */
export const reasonWord = (reason: string) => `0x${Buffer.from(reason).toString("hex").padEnd(64, "0")}` as Hex;

export interface FakeAccount {
  root: Hex; treeSeed: Hex; height: number; epoch: number; hotStart: number;
  hotValueCap: bigint; hotFeeCap: bigint; allowedTarget: Address; owner: Address; hybrid: boolean;
}

interface Held { tx: FrameTransaction; mempool: "alt" | "public"; deadline: bigint }

/** What skandha_config and skandha_explorer_info answer: the sidecar's relay (config.ts; bundleInterval in ms). */
export interface FakeRelay {
  bundleSize: number;
  bundleInterval: number;
  maxSubmitAttempts: number;
  useropsTTL: number;
  bundlingMode: "auto" | "manual";
  testingMode?: boolean;
}
/** The sidecar's defaults (config.ts:620-635): 4 per pass, every 10 s. */
export const SIDECAR_RELAY: FakeRelay = { bundleSize: 4, bundleInterval: 10_000, maxSubmitAttempts: 3, useropsTTL: 300, bundlingMode: "auto" };
/** ethrex's own pool's refusal of a second pending frame transaction from one sender (crates/blockchain/error.rs:165). */
export const ETHREX_ONE_PER_SENDER = "A pending frame transaction from this sender is already in the pool";

const realNode = { ...node }, realGateway = { ...gateway }, realEth = { ...eth };
const realFetch = globalThis.fetch;

export class FakeChain {
  head = 1_000n;
  times = new Map<bigint, bigint>([[1_000n, now()]]);
  consumed = new Map<Hex, bigint>(); // nonce-manager slot -> block that consumed it
  receipts = new Map<Hex, any>(); // hash -> the node's raw receipt
  held = new Map<Hex, Held>(); // what the sidecar or the public pool holds, not yet included
  accounts = new Map<string, FakeAccount>();
  balances = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  /** each sent transaction goes into the next block (when it can); false holds them until mine() */
  autoInclude = true;
  /** a transaction offering less never lands, and expires */
  baseFee = 7n;
  halted = false;
  faucetDry = true;
  /** the sidecar refuses every frame transaction with this reason (and does not hold it) */
  altRefusal: string | null = null;
  /** what the public pool answers a second pending frame transaction of one sender (ETHREX_ONE_PER_SENDER is ethrex's) */
  publicRefusal = "txpool: one pending frame transaction per sender";
  /** the sidecar's relay, as skandha_config and skandha_explorer_info answer it; null: neither is answered */
  relay: FakeRelay | null = null;
  /** alt lanes wait as New until relayPass() relays them, at most relay.bundleSize (default 4) to a block */
  batching = false;
  /** extra pending EOA transactions the node reports */
  eoaPending = 0n;
  /** relay: skandha_config and skandha_explorer_info asked, answered or not */
  calls = { alt: [] as Hex[], public: [] as Hex[], simulate: 0, estimate: 0, faucet: 0, eoa: [] as Hex[], views: 0, relay: 0 };

  constructor() { this.balances.set(FACTORY.toLowerCase(), 0n); }

  ts(b: bigint): bigint { return this.times.get(b) ?? now(); }
  /** The latest block's timestamp: two minutes old while halted, whichever call asks (they must agree). */
  headTimestamp(): bigint { return this.halted ? now() - 120n : this.ts(this.head); }
  produce(): bigint {
    if (this.halted) return this.head;
    const prev = this.ts(this.head);
    this.head++;
    const t = now();
    this.times.set(this.head, t > prev ? t : prev);
    return this.head;
  }
  seqAt(slot: Hex, b: bigint) { const c = this.consumed.get(slot); return c !== undefined && c <= b ? 1n : 0n; }
  balance(a: string) { return this.balances.get(a.toLowerCase()) ?? 0n; }
  credit(a: string, v: bigint) { this.balances.set(a.toLowerCase(), this.balance(a) + v); }
  account(a: string) { return this.accounts.get(a.toLowerCase()); }

  /** What the account's verify frame and the protocol would refuse, as Account.yul's reason; null when valid. */
  verifyFailure(tx: FrameTransaction, at: bigint): string | null {
    const acc = this.account(tx.sender);
    if (!acc) return "no account at the sender";
    const expiry = tx.frames[0];
    if (!expiry || expiry.target?.toLowerCase() !== EXPIRY_VERIFIER || at > BigInt(expiry.data)) return "expiry: past the deadline";
    if (tx.nonceKeys.length !== 1) return "nonce: key count";
    const key = tx.nonceKeys[0]!;
    if (key === 0n) return "nonce: legacy key";
    if (tx.nonceSeq !== 0n) return "nonce: sequence";
    if (this.seqAt(nonceManagerSlot(tx.sender, key), this.head) !== 0n) return "Nonce mismatch: key already used";
    if (Number(key >> 32n) !== acc.epoch) return "nonce: epoch";
    const leaf = Number(key & 0xffff_ffffn);
    if (leaf >= 2 ** acc.height) return "nonce: leaf range";
    const hot = leaf >= acc.hotStart;
    if (tx.signatures.length !== 1) return "sig: count";
    const e = tx.signatures[0]!;
    if (e.scheme !== 0) return "sig: entry scheme";
    if (e.msg !== "0x") return "sig: entry msg";
    const bytes = Buffer.from(e.signature.slice(2), "hex");
    if (bytes.length !== 2_146 + 32 * (acc.height + 4)) return "sig: entry length";
    if (bytes[0] !== 1) return "sig: entry version";
    const ok = verifyEntry({
      entry: new Uint8Array(bytes), msg: Buffer.from(computeSigHash(tx).slice(2), "hex"), root: Buffer.from(acc.root.slice(2), "hex"),
      treeSeed: Buffer.from(acc.treeSeed.slice(2), "hex"), height: acc.height, chainId: tx.chainId, leaf,
    });
    if (!ok.ok) return "sig: hash-based check";
    if (hot) {
      if (acc.hotValueCap === 0n) return "hot: disabled";
      if (this.maxCost(tx) > acc.hotFeeCap) return "hot: fee cap";
      let total = 0n;
      for (const f of tx.frames.slice(2)) {
        if (f.mode !== 2) return "hot: frame mode";
        if (f.data !== "0x") return "hot: frame data";
        if (f.target?.toLowerCase() !== acc.allowedTarget.toLowerCase()) return "hot: frame target";
        total += f.value;
      }
      if (total > acc.hotValueCap) return "hot: value cap";
    }
    return null;
  }

  /** TXPARAM 0x06, roughly: the fee cap times what the transaction may be charged. */
  maxCost(tx: FrameTransaction): bigint {
    const m = frameGasModel(tx);
    const limits = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
    return tx.fees.maxFeePerGas * (m.intrinsic + limits);
  }

  /** Runs the SENDER frames; with apply false nothing changes. Returns each body frame's status and a revert reason. */
  execute(tx: FrameTransaction, apply: boolean): { statuses: string[]; reason: string | null } {
    const acc = this.account(tx.sender)!;
    const statuses: string[] = [];
    let reason: string | null = null;
    let spent = 0n;
    for (const f of tx.frames.slice(2)) {
      let r: string | null = null;
      if (f.target?.toLowerCase() === tx.sender.toLowerCase() && f.data !== "0x") r = this.admin(acc, f.data, apply);
      if (!r && f.value > 0n) {
        if (this.balance(tx.sender) - spent < f.value) r = "out of funds";
        else {
          spent += f.value;
          if (apply) { this.credit(tx.sender, -f.value); this.credit(f.target!, f.value); }
        }
      }
      statuses.push(r ? "0x0" : "0x1");
      reason ??= r;
    }
    return { statuses, reason };
  }

  /** Account.yul's admin calls and their refusals. */
  admin(acc: FakeAccount, data: Hex, apply: boolean): string | null {
    let call;
    try { call = decodeFunctionData({ abi: ACCOUNT_ABI, data }); } catch { return "no such function"; }
    if (call.functionName === "rotate") {
      const [newRoot, newSeed, newHeight] = call.args as [Hex, Hex, number];
      if (BigInt(newRoot) === 0n) return "bad argument";
      if (newHeight < 1 || newHeight > 28) return "bad height";
      if (newRoot.toLowerCase() === acc.root || newSeed.toLowerCase() === acc.treeSeed) return "rotate: same tree";
      if (apply) Object.assign(acc, { root: newRoot.toLowerCase(), treeSeed: newSeed.toLowerCase(), height: newHeight, epoch: acc.epoch + 1 });
      return null;
    }
    if (call.functionName === "setHotPolicy") {
      const [hotStart, cap, feeCap, target] = call.args as [number, bigint, bigint, Address];
      if (hotStart > acc.hotStart) return "hot: band cannot shrink";
      if (hotStart === 0 || (hotStart === 1 && acc.epoch === 0)) return "hot: no cold leaf left";
      if (apply) Object.assign(acc, { hotStart, hotValueCap: cap, hotFeeCap: feeCap, allowedTarget: target });
      return null;
    }
    return "no such function";
  }

  /** Puts a transaction in the next block if it can land there; false otherwise (it stays held, or expires). */
  include(hash: Hex): boolean {
    const h = this.held.get(hash);
    if (!h) return false;
    const at = now();
    if (at > h.deadline || h.tx.fees.maxFeePerGas < this.baseFee || this.verifyFailure(h.tx, at)) return false;
    const block = this.head + 1n;
    const { statuses } = this.execute(h.tx, true);
    this.consumed.set(nonceManagerSlot(h.tx.sender, h.tx.nonceKeys[0]!), block);
    this.receipts.set(hash, {
      blockNumber: hex(block), status: "0x1", payer: h.tx.sender, cumulativeGasUsed: "0x30d40", gasUsed: "0x30d40",
      frameReceipts: [{ status: "0x1", gasUsed: "0xbeb" }, { status: "0x1", gasUsed: "0xea60" }, ...statuses.map((s) => ({ status: s, gasUsed: "0x64" }))]
        .map((f) => ({ ...f, stateGasUsed: "0x0", logs: [] })),
    });
    this.held.delete(hash);
    return true;
  }

  /** Includes every held transaction that can still land. */
  mine(): Hex[] { return [...this.held.keys()].filter((h) => this.include(h)); }

  /** every frame transaction a mempool accepted to hold, in order */
  sent: FrameTransaction[] = [];

  hold(tx: FrameTransaction, mempool: Held["mempool"]): Hex {
    const hash = frameTxHash(tx);
    this.sent.push(tx);
    this.held.set(hash, { tx, mempool, deadline: BigInt(tx.frames[0]!.data) });
    if (this.autoInclude && !(this.batching && mempool === "alt")) this.include(hash);
    return hash;
  }

  /**
   * One relay pass (parallel lanes): at most relay.bundleSize (default 4) held alt lanes, highest tip first and then
   * in admission order, as the sidecar picks them (BundlingService; FrameTxMempoolEntry.compareByCost), go into one new
   * block. A lane that cannot land (past its deadline, under the base fee) stays held. Returns those that landed.
   */
  relayPass(): Hex[] {
    const tip = (e: Held) => e.tx.fees.maxPriorityFeePerGas;
    const picked = [...this.held.entries()]
      .filter(([, e]) => e.mempool === "alt")
      .sort(([, a], [, b]) => (tip(b) > tip(a) ? 1 : tip(b) < tip(a) ? -1 : 0)) // stable: equal tips keep admission order
      .slice(0, this.relay?.bundleSize ?? 4)
      .map(([h]) => h);
    const landed = picked.filter((h) => this.include(h));
    if (landed.length) this.produce(); // the block they went into
    return landed;
  }

  simulate(tx: FrameTransaction): SimulationResult {
    this.calls.simulate++;
    const base = { prefixShape: "SelfVerify", payer: tx.sender, maxCost: hex(this.maxCost(tx)), gasUsed: "0x30d40" as Hex };
    const why = this.verifyFailure(tx, now());
    if (why) {
      return {
        ...base, canonicalMempoolValid: false, canonicalMempoolViolation: "VERIFY frame 1 reverted", executionStatus: "reverted",
        executionError: "frame 1 reverted", revertData: reasonWord(why),
        frames: [{ gasUsed: "0xbeb", succeeded: true }, { gasUsed: "0xd6d8", succeeded: false }],
      };
    }
    const run = this.execute(tx, false);
    const frames = [{ gasUsed: "0xbeb" as Hex, succeeded: true }, { gasUsed: "0xea60" as Hex, succeeded: true }, ...run.statuses.map((s) => ({ gasUsed: "0x64" as Hex, succeeded: s === "0x1" }))];
    if (run.reason) {
      return { ...base, canonicalMempoolValid: true, canonicalMempoolViolation: null, executionStatus: "reverted", executionError: `frame ${2 + run.statuses.indexOf("0x0")} reverted`, revertData: reasonWord(run.reason), frames };
    }
    return { ...base, canonicalMempoolValid: true, canonicalMempoolViolation: null, executionStatus: "success", executionError: null, revertData: null, frames };
  }

  /** eth_estimateFrameTransactionGas: gas used per frame; state gas only inside cumulativeGasUsed (estimate.ts). */
  estimate(wire: any) {
    this.calls.estimate++;
    const tx = fromWire(wire);
    const why = this.verifyFailure(tx, now());
    if (why) throw answered("eth_estimateFrameTransactionGas", -32000, `verify frame reverted: ${why}`);
    const body = tx.frames[2]!;
    const acc = this.account(tx.sender)!;
    let used = 100n, state = 0n;
    if (body.target?.toLowerCase() === tx.sender.toLowerCase() && body.data !== "0x") {
      used = 30_000n;
      const call = decodeFunctionData({ abi: ACCOUNT_ABI, data: body.data });
      if (call.functionName === "setHotPolicy") {
        const [, cap, fee, target] = call.args as [number, bigint, bigint, Address];
        const fresh = [acc.hotValueCap === 0n && cap !== 0n, acc.hotFeeCap === 0n && fee !== 0n, BigInt(acc.allowedTarget) === 0n && BigInt(target) !== 0n];
        state = 97_920n * BigInt(fresh.filter(Boolean).length);
      }
    } else if (!this.account(body.target!) && this.balance(body.target!) === 0n && body.value > 0n) {
      used = 3_000n;
      state = 183_600n;
    }
    const execution = [3_051n, 60_000n, used];
    const m = frameGasModel(tx);
    return { frames: execution.map((e) => ({ execution: hex(e), state: "0x0" })), cumulativeGasUsed: hex(m.floored(m.intrinsic + execution.reduce((s, x) => s + x, 0n)) + state) };
  }

  /** The EOA's legacy transactions: createAccount on the factory, or a value transfer. */
  async eoaTransaction(raw: Hex): Promise<Hex> {
    const tx = parseTransaction(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as any });
    const nonce = this.nonces.get(from.toLowerCase()) ?? 0n;
    if (BigInt(tx.nonce ?? 0) !== nonce) throw answered("eth_sendRawTransaction", -32000, `nonce too low: ${tx.nonce} < ${nonce}`);
    const hash = keccak256(raw);
    this.calls.eoa.push(hash);
    let ok = true;
    if (tx.to?.toLowerCase() === FACTORY.toLowerCase()) ok = this.createAccount(tx.data!);
    const value = tx.value ?? 0n;
    if (ok && value > 0n) { this.credit(from, -value); this.credit(tx.to!, value); }
    this.credit(from, -(BigInt(tx.gas ?? 0n) / 2n) * (tx.gasPrice ?? 0n)); // some gas
    this.nonces.set(from.toLowerCase(), nonce + 1n);
    // mined at once: the backend's EOA poll reads receipts, not block numbers
    this.receipts.set(hash, { blockNumber: hex(this.produce()), status: ok ? "0x1" : "0x0", cumulativeGasUsed: "0x5208", gasUsed: "0x5208" });
    return hash;
  }

  createAccount(data: Hex): boolean {
    const { functionName, args } = decodeFunctionData({ abi: FACTORY_ABI, data });
    if (functionName !== "createAccount") return false;
    const [root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt] = args as any;
    const address = predictAccountAddress(FACTORY, IMPLEMENTATION, { root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt });
    if (this.account(address)) return true;
    if (BigInt(root) === 0n || height < 1 || height > 28 || hotStart === 0 || hotStart === 1) return false; // initialize's refusals
    this.addAccount(address, { root: root.toLowerCase(), treeSeed: treeSeed.toLowerCase(), height, epoch: 0, hotStart, hotValueCap, hotFeeCap, allowedTarget, owner, hybrid: false });
    return true;
  }

  addAccount(address: Address, a: FakeAccount) { this.accounts.set(address.toLowerCase(), a); }

  views(account: Address, data: Hex): Hex {
    this.calls.views++;
    const acc = this.account(account);
    if (!acc) return "0x";
    const { functionName } = decodeFunctionData({ abi: ACCOUNT_ABI, data });
    const v: Record<string, bigint> = {
      root: BigInt(acc.root), treeSeed: BigInt(acc.treeSeed), height: BigInt(acc.height), epoch: BigInt(acc.epoch), hotStart: BigInt(acc.hotStart),
      hotValueCap: acc.hotValueCap, hotFeeCap: acc.hotFeeCap, allowedTarget: BigInt(acc.allowedTarget), hybridRequired: acc.hybrid ? 1n : 0n,
    };
    if (!(functionName in v)) throw answered("eth_call", 3, "execution reverted");
    return word(v[functionName]!);
  }

  status(h: Hex): string | null {
    if (this.receipts.has(h) && BigInt(this.receipts.get(h).blockNumber) <= this.head) return "OnChain";
    const e = this.held.get(h);
    return e ? (this.ts(this.head) > e.deadline ? "Cancelled" : "New") : null;
  }

  /** The sidecar's admission record: every rule passed, or the refusal's rule. */
  admission(h: Hex): any {
    if (this.calls.alt.includes(h) && !this.held.has(h) && !this.receipts.has(h) && this.altRefusal) {
      return { admission: { outcome: "rejected", errorCode: -32602, checks: [{ rule: "BUDGET-001", verdict: "fail", detail: this.altRefusal }] } };
    }
    if (!this.calls.alt.includes(h)) return null;
    return { admission: { outcome: this.receipts.has(h) ? "included" : "accepted", checks: [{ rule: "PREFIX-001", verdict: "pass" }, { rule: "SIG-001", verdict: "pass" }] } };
  }

  /** Replaces node, gateway, eth and the direct-RPC fetch with this chain. */
  install(): this {
    const self = this;
    Object.assign(node, {
      code: async (a: Address) => {
        const k = a.toLowerCase();
        if (k === NONCE_MANAGER) return NONCE_MANAGER_CODE;
        if (k === EXPIRY_VERIFIER) return EXPIRY_VERIFIER_CODE;
        if (k === IMPLEMENTATION.toLowerCase()) return "0x6080604052";
        if (k === FACTORY.toLowerCase()) return "0x6080604052";
        return self.account(k) ? proxyRuntimeCode(IMPLEMENTATION) : "0x";
      },
      balance: async (a: Address) => self.balance(a),
      nonce: async (a: Address, tag = "pending") => (self.nonces.get(a.toLowerCase()) ?? 0n) + (tag === "pending" ? self.eoaPending : 0n),
      storage: async (a: Address, slot: Hex) => word(a.toLowerCase() === NONCE_MANAGER ? self.seqAt(slot, self.head) : 0n),
      storageAt: async (a: Address, slot: Hex, b: bigint) => word(a.toLowerCase() === NONCE_MANAGER ? self.seqAt(slot, b) : 0n),
      blockNumber: async () => self.produce(),
      block: async (b: bigint | "latest") => {
        const n = b === "latest" ? self.head : b;
        return { number: n, timestamp: n === self.head ? self.headTimestamp() : self.ts(n) };
      },
      blockTimestamp: async () => self.headTimestamp(),
      receipt: async (h: Hex) => {
        const r = self.receipts.get(h.toLowerCase() as Hex);
        return r && BigInt(r.blockNumber) <= self.head ? normalizeNodeReceipt(r) : null;
      },
      simulate: async (tx: FrameTransaction) => self.simulate(tx),
      sendRawPublic: async (tx: FrameTransaction) => {
        const hash = frameTxHash(tx);
        const pending = [...self.held.values()].some((e) => e.mempool === "public" && e.tx.sender.toLowerCase() === tx.sender.toLowerCase() && now() <= e.deadline);
        if (pending) throw answered("eth_sendRawTransaction", -32000, self.publicRefusal);
        self.calls.public.push(hash);
        return self.hold(tx, "public");
      },
      transactionByHash: async (h: Hex) => (self.held.has(h) || self.receipts.has(h) ? { hash: h } : null),
      call: async (to: Address, data: Hex) => {
        if (to.toLowerCase() === FACTORY.toLowerCase()) {
          const { functionName, args } = decodeFunctionData({ abi: FACTORY_ABI, data });
          if (functionName === "implementation") return word(BigInt(IMPLEMENTATION));
          if (functionName === "predictAddress") {
            const [root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt] = args as any;
            return word(BigInt(predictAccountAddress(FACTORY, IMPLEMENTATION, { root, treeSeed, height, owner, hotStart, hotValueCap, hotFeeCap, allowedTarget, salt })));
          }
        }
        return self.views(to, data);
      },
    });
    Object.assign(gateway, {
      gasPrice: async () => ({ maxFeePerGas: hex(MARKET.maxFeePerGas), maxPriorityFeePerGas: hex(MARKET.maxPriorityFeePerGas) }),
      send: async (tx: FrameTransaction) => {
        const hash = frameTxHash(tx);
        self.calls.alt.push(hash);
        if (self.altRefusal) throw answered("eth_sendFrameTransaction", -32602, self.altRefusal);
        return self.hold(tx, "alt");
      },
      status: async (h: Hex) => self.status(h),
      receipt: async () => { throw answered("eth_getFrameTransactionReceipt", -32000, "transaction receipt not found"); },
      faucet: async (a: Address) => {
        self.calls.faucet++;
        if (self.faucetDry) throw answered("skandha_explorer_faucet", -32000, "faucet is empty");
        self.credit(a, ONE_ETH);
        return { txHash: keccak256(toHex(`faucet ${a} ${self.calls.faucet}`)), amount: ONE_ETH.toString() };
      },
      explorerRecord: async (h: Hex) => self.admission(h),
    });
    Object.assign(eth, {
      sendRawTransaction: (raw: Hex) => self.eoaTransaction(raw),
      chainIdentity: async () => ({ chainId: 1337n, genesisHash: GENESIS }),
    });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
      if (body.method === "eth_getBlockByNumber" && body.params?.[0] === "latest") {
        return reply({ number: hex(self.head), timestamp: hex(self.headTimestamp()), baseFeePerGas: hex(self.baseFee) });
      }
      // relayConfig (parallel lanes): answered only once a test sets the relay, as the sidecar's modules/skandha.ts and
      // modules/explorer.ts answer them; otherwise they fall through to the throw below, a sidecar that cannot be asked.
      // Every ask is counted, answered or not.
      if (body.method === "skandha_config" || body.method === "skandha_explorer_info") self.calls.relay++;
      if (body.method === "skandha_config" && self.relay) {
        const r = self.relay;
        return reply({
          chainId: 1337, flags: { testingMode: r.testingMode ?? false, redirectRpc: false },
          bundleSize: r.bundleSize, bundleInterval: r.bundleInterval, maxSubmitAttempts: r.maxSubmitAttempts, useropsTTL: r.useropsTTL,
        });
      }
      if (body.method === "skandha_explorer_info" && self.relay) {
        return reply({ protocolVersion: 1, chainId: 1337, bundlingMode: self.relay.bundlingMode, p2pEnabled: false });
      }
      if (body.method === "eth_estimateFrameTransactionGas") {
        try { return reply(self.estimate(body.params[0])); } catch (e) {
          const r = e as RpcError;
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: r.code, message: r.message } }), { status: 200 });
        }
      }
      throw new Error(`a direct RPC call ${body.method} the fake chain does not answer: fake it in the test`);
    }) as typeof fetch;
    return this;
  }

  static uninstall(): void {
    Object.assign(node, realNode);
    Object.assign(gateway, realGateway);
    Object.assign(eth, realEth);
    globalThis.fetch = realFetch;
  }
}

/** The EOA's address for a key, for funding it in the fake. */
export const addressOf = (a: string) => getAddress(a);
export { encodeFunctionData };
