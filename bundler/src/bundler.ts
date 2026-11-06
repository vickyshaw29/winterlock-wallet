// The local bundler MetaMask Flask sends Winterlock user operations to (Nov 6, approved by Vicky). It is not an
// ERC-4337 bundler: there is no EntryPoint and no bundle. Each user operation carries one signed frame transaction
// in its signature field (pipeline/src/userop.ts); this server checks that the transaction is exactly what the user
// operation describes, sends it to the alt mempool, and follows it on chain to answer MetaMask's receipt polls.
//
// What it guarantees:
//   - It holds no key and signs nothing. A transaction it sends was signed by the Snap, for this user operation.
//   - Nothing is sent unless checkUserOpTx passes: same sender, nonce key at sequence 0, every SENDER frame equal to a
//     call in callData, the user's fees exactly, gas inside the envelope MetaMask showed, a deadline still ahead.
//   - One transaction per (sender, nonce key). A second, different transaction on a key it already carries is refused
//     and logged: it would mean one leaf signed twice.
//   - Outcomes come from protocol state, as in the pipeline (waitForInclusion): "success: false" only for a
//     transaction proven unable to land (Expired: its key unused in a block past the deadline) or included with a
//     failed frame (Reverted). An included transaction is never reported failed, so MetaMask never invites a resend.
//   - Every record is stored before the transaction is sent, and followed again after a restart.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import {
  FLASK_ENTRYPOINT, OutcomeUnknown, RpcError, UserOpError, checkUserOpTx, deadlineOf, frameTxHash, nonceKeyOf, parseUserOp,
  quantity, receiptSucceeded, simulationVerdict, txOfSignature, waitForInclusion, type FrameTxReceipt, type Network, type Outcome,
} from "../../pipeline/src/index.ts";

/** A JSON-RPC error with the code MetaMask shows. */
export class BundlerError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
/** ERC-7769's code for a user operation refused in simulation or by the mempool */
const REJECTED = -32500;

export type OpState = "sending" | "sent" | "refused" | Outcome;

export interface OpRecord {
  hash: Hex;
  /** the user operation as MetaMask sent it */
  userOp: Record<string, string>;
  entryPoint: Address;
  sender: Address;
  nonceKey: Hex;
  deadline: number;
  receivedAt: number;
  state: OpState;
  altHashes: Hex[];
  /** for OnChain, Reverted and Expired: the block that decided it */
  block?: { number: Hex; hash: Hex | null };
  gasUsed?: Hex;
  gasCost?: Hex;
  note?: string;
}

export interface OpStore { load(): OpRecord[]; save(ops: OpRecord[]): void }

/** One JSON file, replaced atomically on every change. */
export function fileStore(file: string): OpStore {
  return {
    load: () => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as OpRecord[]) : []),
    save: (ops) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(ops, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}
export const memoryStore = (): OpStore & { ops: OpRecord[] } => {
  const s = { ops: [] as OpRecord[], load: () => s.ops.map((o) => ({ ...o })), save: (ops: OpRecord[]) => { s.ops = ops.map((o) => ({ ...o })); } };
  return s;
};

export interface BundlerOptions {
  network: Network;
  store: OpStore;
  log?: (line: string) => void;
  /** follow transactions on chain after sending (default true); tests may drive follow() themselves */
  follow?: boolean;
  /** polling for the pipeline's follow (default 3 s) */
  pollMs?: number;
  /** wait before following again after an unknown outcome (default 30 s) */
  retryMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lower = <T extends string>(s: T) => s.toLowerCase() as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL: OpState[] = ["OnChain", "Reverted", "Expired", "refused"];

export class Bundler {
  readonly ops = new Map<Hex, OpRecord>();
  private readonly byKey = new Map<string, Hex>();
  private readonly following = new Set<Hex>();
  private readonly net: Network;
  private readonly log: (line: string) => void;
  /** sends run one at a time, so the one-transaction-per-key check and the record cannot race */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly o: BundlerOptions) {
    this.net = o.network;
    this.log = o.log ?? ((l) => console.log(l));
    for (const r of o.store.load()) {
      this.ops.set(r.hash, r);
      this.byKey.set(this.keyId(r.sender, BigInt(r.nonceKey)), r.hash);
    }
  }

  /** Follows every record without a final outcome, e.g. after a restart. */
  resume() {
    for (const r of this.ops.values()) if (!FINAL.includes(r.state)) void this.follow(r.hash);
  }
  stop() { this.stopped = true; }

  private keyId = (sender: Address, key: bigint) => `${lower(sender)}:${key.toString(16)}`;
  private persist() { this.o.store.save([...this.ops.values()]); }

  async handle(method: string, params: unknown): Promise<unknown> {
    const args = Array.isArray(params) ? params : [];
    switch (method) {
      case "eth_chainId": return quantity(this.net.chainId);
      case "eth_supportedEntryPoints": return [FLASK_ENTRYPOINT];
      case "eth_estimateUserOperationGas":
        throw new BundlerError(METHOD_NOT_FOUND, "Winterlock user operations carry their gas limits from the Snap; there is nothing to estimate");
      case "eth_sendUserOperation": {
        const run = this.queue.then(() => this.send(args[0], args[1]));
        this.queue = run.catch(() => undefined);
        return run;
      }
      case "eth_getUserOperationReceipt": return this.receipt(args[0]);
      case "eth_getUserOperationByHash": return this.byHash(args[0]);
      default: throw new BundlerError(METHOD_NOT_FOUND, `${method} is not supported by the Winterlock bundler`);
    }
  }

  private async send(rawOp: unknown, entryPoint: unknown): Promise<Hex> {
    if (typeof entryPoint !== "string" || lower(entryPoint) !== FLASK_ENTRYPOINT) {
      throw new BundlerError(INVALID_PARAMS, `entry point must be ${FLASK_ENTRYPOINT}, what MetaMask Flask sends`);
    }
    let op, tx;
    try {
      op = parseUserOp(rawOp);
      tx = txOfSignature(op.signature);
      checkUserOpTx(op, tx, { chainId: this.net.chainId, now: Math.floor(Date.now() / 1000) });
    } catch (e) {
      if (e instanceof UserOpError) throw new BundlerError(INVALID_PARAMS, `refused, nothing sent: ${e.message}`);
      throw e;
    }
    const hash = lower(frameTxHash(tx));
    const nonceKey = nonceKeyOf(op.nonce);
    if (this.ops.has(hash)) return hash; // MetaMask sent it again: the same transaction, nothing new
    const id = this.keyId(op.sender, nonceKey);
    const other = this.byKey.get(id);
    if (other) {
      this.log(`ALERT: a second, different transaction on ${op.sender} nonce key 0x${nonceKey.toString(16)} (first ${other}, now ${hash}): one leaf signed twice? Refused.`);
      throw new BundlerError(INVALID_PARAMS, `nonce key 0x${nonceKey.toString(16)} already carries transaction ${other}; refused, nothing sent`);
    }

    // The node's dry run of exactly this transaction. A clear "invalid" refuses it; an unreadable node does not.
    try {
      const verdict = simulationVerdict(await this.net.node.simulate(tx));
      if (!verdict.ok) throw new BundlerError(REJECTED, `refused by the node's dry run, nothing sent: ${verdict.reason}`);
    } catch (e) {
      if (e instanceof BundlerError) throw e;
      if (e instanceof RpcError && e.refused) throw new BundlerError(REJECTED, `refused by the node's dry run, nothing sent: ${e.message}`);
      this.log(`dry run of ${hash} unreadable (${message(e)}); sending anyway, the chain decides`);
    }

    const rec: OpRecord = {
      hash, userOp: rawOp as Record<string, string>, entryPoint: FLASK_ENTRYPOINT, sender: op.sender, nonceKey: quantity(nonceKey),
      deadline: deadlineOf(tx), receivedAt: Date.now(), state: "sending", altHashes: [],
    };
    this.ops.set(hash, rec);
    this.byKey.set(id, hash);
    this.persist(); // stored before it leaves: after a crash it is followed by its key

    try {
      const returned = lower(await this.net.gateway.send(tx));
      if (returned !== hash) rec.altHashes.push(returned);
    } catch (e) {
      const held = await this.net.gateway.status(hash).then((s) => s !== null, () => undefined);
      if (e instanceof RpcError && e.refused && held === false) {
        rec.state = "refused";
        rec.note = message(e);
        this.persist();
        this.log(`${hash} refused by the sidecar: ${message(e)}`);
        throw new BundlerError(REJECTED, `refused by the alt mempool: ${message(e)}`);
      }
      rec.note = `send outcome unknown (${message(e)}); followed by its key`;
    }
    rec.state = "sent";
    this.persist();
    this.log(`${hash} sent: ${op.sender} key 0x${nonceKey.toString(16)}, deadline ${rec.deadline}`);
    if (this.o.follow !== false) void this.follow(hash);
    return hash;
  }

  /** Follows one record until protocol state decides it; never gives up while the process runs. */
  async follow(hash: Hex): Promise<void> {
    if (this.following.has(hash)) return;
    this.following.add(hash);
    try {
      while (!this.stopped) {
        const rec = this.ops.get(hash)!;
        if (FINAL.includes(rec.state)) return;
        try {
          if (rec.state === "Included") {
            // key used, no receipt read yet: keep looking for it, never report failure
            const receipt = await this.findReceipt(rec);
            if (receipt) { await this.decide(rec, receiptSucceeded(receipt) ? "OnChain" : "Reverted", receipt, BigInt(receipt.blockNumber)); return; }
            await sleep(this.o.retryMs ?? 30_000);
            continue;
          }
          const r = await this.waitForInclusion(rec);
          await this.decide(rec, r.outcome, r.receipt, r.decidedAt);
          if ((rec.state as OpState) !== "Included") return; // decide() changed it
        } catch (e) {
          this.log(`${hash}: ${e instanceof OutcomeUnknown ? "no outcome yet" : "follow failed"} (${message(e)}); following again`);
          await sleep(this.o.retryMs ?? 30_000);
        }
      }
    } finally {
      this.following.delete(hash);
    }
  }

  private waitForInclusion(rec: OpRecord) {
    return waitForInclusion(rec.hash, {
      sender: rec.sender, nonceKey: BigInt(rec.nonceKey), deadline: rec.deadline, altHashes: rec.altHashes,
      pollMs: this.o.pollMs, network: this.net,
    });
  }

  private async findReceipt(rec: OpRecord): Promise<FrameTxReceipt | null> {
    for (const h of [rec.hash, ...rec.altHashes]) {
      const r = (await this.net.node.receipt(h).catch(() => null)) ?? (await this.net.gateway.receipt(h).catch(() => null));
      if (r) return r;
    }
    return null;
  }

  private async decide(rec: OpRecord, outcome: Outcome, receipt: FrameTxReceipt | null, decidedAt: bigint) {
    const at = receipt ? BigInt(receipt.blockNumber) : decidedAt;
    const block = await this.net.node.request<{ hash?: Hex; baseFeePerGas?: Hex } | null>("eth_getBlockByNumber", [quantity(at), false]).catch(() => null);
    rec.state = outcome;
    rec.block = { number: quantity(at), hash: block?.hash ?? null };
    if (receipt) {
      const used = BigInt(receipt.gasUsed ?? receipt.cumulativeGasUsed);
      const op = parseUserOp(rec.userOp);
      const base = BigInt(block?.baseFeePerGas ?? "0x0");
      const price = base + op.maxPriorityFeePerGas < op.maxFeePerGas ? base + op.maxPriorityFeePerGas : op.maxFeePerGas;
      rec.gasUsed = quantity(used);
      rec.gasCost = quantity(used * price);
    }
    this.persist();
    this.log(`${rec.hash}: ${outcome} at block ${at}`);
  }

  private receipt(hash: unknown) {
    if (typeof hash !== "string") throw new BundlerError(INVALID_PARAMS, "expected a user operation hash");
    const rec = this.ops.get(lower(hash as Hex));
    if (!rec) return null;
    // Pending, sending, or included with no receipt yet: no answer, MetaMask keeps waiting.
    if (rec.state !== "OnChain" && rec.state !== "Reverted" && rec.state !== "Expired" && rec.state !== "refused") return null;
    const success = rec.state === "OnChain";
    return {
      userOpHash: rec.hash, entryPoint: rec.entryPoint, sender: rec.sender, nonce: rec.userOp.nonce,
      paymaster: "0x0000000000000000000000000000000000000000",
      actualGasCost: rec.gasCost ?? "0x0", actualGasUsed: rec.gasUsed ?? "0x0", success, logs: [],
      reason: success ? undefined : rec.state === "Reverted" ? "a frame of the included transaction failed" : rec.state === "Expired" ? "expired: its key was unused past the deadline; the leaf is burned" : rec.note,
      receipt: {
        transactionHash: rec.hash, transactionIndex: "0x0", blockHash: rec.block?.hash ?? null, blockNumber: rec.block?.number ?? null,
        from: rec.sender, to: rec.sender, cumulativeGasUsed: rec.gasUsed ?? "0x0", gasUsed: rec.gasUsed ?? "0x0", logs: [],
        logsBloom: `0x${"00".repeat(256)}`, status: success ? "0x1" : "0x0",
      },
    };
  }

  private byHash(hash: unknown) {
    if (typeof hash !== "string") throw new BundlerError(INVALID_PARAMS, "expected a user operation hash");
    const rec = this.ops.get(lower(hash as Hex));
    if (!rec) return null;
    const included = rec.state === "OnChain" || rec.state === "Reverted";
    return { userOperation: rec.userOp, entryPoint: rec.entryPoint, transactionHash: included ? rec.hash : null, blockHash: included ? rec.block?.hash ?? null : null, blockNumber: included ? rec.block?.number ?? null : null };
  }
}

/** One JSON-RPC request or a batch, answered with JSON-RPC results or errors. */
export async function answer(b: Bundler, body: unknown): Promise<unknown> {
  const one = async (req: any) => {
    const id = req?.id ?? null;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    try {
      return { jsonrpc: "2.0", id, result: (await b.handle(req.method, req.params)) ?? null };
    } catch (e) {
      const code = e instanceof BundlerError ? e.code : -32603;
      return { jsonrpc: "2.0", id, error: { code, message: message(e) } };
    }
  };
  if (Array.isArray(body)) return body.length && body.length <= 20 ? Promise.all(body.map(one)) : { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch of 1 to 20 requests" } };
  return one(body);
}
