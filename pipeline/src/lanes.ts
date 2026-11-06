// Parallel lanes: one lane's cost, a plan for n lanes at once, a sidecar's relay settings, what each refusal means.
// Written with Claude Code (AI) for Vicky.
//
// What one pending lane holds of the account's balance, and a plan for n lanes sent at once: money, relay passes, time.
//
// A lane is one nonce key with a transaction pending. The devnet's sidecar holds one pending transaction per
// (sender, key) and puts no per-sender cap on keyed lanes the account pays for itself, with no stake needed
// (vendor/mempool-workshop-sidecar, packages/executor/src: MempoolService/service.ts:374-407,
// MempoolService/reputation.ts:87-95,138-143). What the lanes still share:
//   - money: each pending lane owes its maximum gas cost (payer) and its frames' value (sender), and for a self-paying
//     account the sum over every pending lane must fit the balance (MempoolService/obligations.ts:5-33,
//     service.ts:409-478);
//   - relay throughput: at most bundleSize New lanes per pass, one pass every bundleInterval, highest tip first, then
//     in admission order (config.ts:628,635; FrameTxMempoolEntry.compareByCost);
//   - reputation: a THROTTLED account keeps at most 4 pending, keyed lanes included, and about 110 admissions without
//     an inclusion throttle it (MempoolService/reputation.ts:114-129, entities/ReputationEntry.ts:60-68);
//   - one journal writer, and a finite band of leaves.
// The public (ethrex) pool should hold this account to one pending transaction, because its verify frame reads the
// sender's storage (ethrex at 9aa3645d, blockchain.rs and mempool.rs); not yet probed on the devnet.
import { hexToBytes, toHex, type Hex } from "viem";
import { frameGasModel } from "./estimate.ts";
import { rpc } from "./rpc.ts";
import type { FrameTransaction } from "./codec/FrameTx.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ what one lane holds

export interface LaneCost {
  /** ethrex's total_gas_limit: max(intrinsic + Σ execution + Σ state, mandatory + floor + Σ state) */
  gasLimit: bigint;
  maxFeePerGas: bigint;
  /** gasLimit × maxFeePerGas: ethrex's maxCost (TXPARAM 0x06), the most the payer can be charged for gas */
  gasCostWei: bigint;
  /** the top-level frames' value, which EIP-8141 debits from the sender */
  valueWei: bigint;
  /** gasCostWei + valueWei: what the sidecar holds against a self-paying account while the lane is pending */
  totalWei: bigint;
}

const allZero = (h: Hex) => /^0x(00)*$/i.test(h);

/**
 * One lane's cost as ethrex bills it (crates/common/types/transaction.rs at 9aa3645d: total_gas_limit and max_cost),
 * on frameGasModel's byte pricing, plus the frames' value, which the sidecar adds for a self-paying sender
 * (obligations.ts). A signature entry of zero bytes only is a placeholder and is priced as non-zero bytes (16 gas
 * each, not 4): before signing this is an upper bound, and on a signed transaction it is exact.
 */
export function laneCost(tx: FrameTransaction): LaneCost {
  if (tx.blobVersionedHashes.length) throw new Error("laneCost does not price blobs");
  const priced: FrameTransaction = {
    ...tx,
    signatures: tx.signatures.map((s) =>
      allZero(s.signature) ? { ...s, signature: toHex(new Uint8Array(hexToBytes(s.signature).length).fill(0xff)) } : s),
  };
  const m = frameGasModel(priced);
  const execution = tx.frames.reduce((sum, f) => sum + f.limits.execution, 0n);
  const state = tx.frames.reduce((sum, f) => sum + f.limits.state, 0n);
  const standard = m.intrinsic + execution + state;
  const floor = m.mandatory + m.floor + state; // the floor branch pays its state gas on top, never inside the floor
  const gasLimit = standard > floor ? standard : floor;
  const gasCostWei = gasLimit * tx.fees.maxFeePerGas;
  const valueWei = tx.frames.reduce((sum, f) => sum + f.value, 0n);
  return { gasLimit, maxFeePerGas: tx.fees.maxFeePerGas, gasCostWei, valueWei, totalWei: gasCostWei + valueWei };
}

/** What the sidecar counts for one pending lane: its maximum gas cost plus its frames' value (laneCost). */
export const laneMaxCostWei = (tx: FrameTransaction): bigint => laneCost(tx).totalWei;

// ------------------------------------------------------------------ the relay

export interface RelayConfig {
  /** New lanes relayed per pass */
  bundleSize: number;
  /** seconds between passes */
  bundleIntervalSeconds: number;
  /** relays of a lane that never lands before the sidecar cancels it */
  maxSubmitAttempts: number;
  /** seconds after which a pending entry may be replaced with no fee bump */
  useropsTTLSeconds: number;
  /** "auto" relays every pass, "manual" relays nothing by itself; null when skandha_explorer_info named none */
  bundlingMode: string | null;
  /** testingMode: up to 10 per bundle, relayed on demand only */
  testingMode: boolean;
  /** true when skandha_config could not be read, or named no usable numbers, and the sidecar's defaults stand in */
  assumed: boolean;
  /** what could not be read, and anything read that changes the numbers */
  notes: string[];
}

/** The sidecar's defaults (config.ts:620-635): 4 per pass, every 10 s, cancelled after 3 relays, replaceable after 300 s. */
export const RELAY_DEFAULTS = { bundleSize: 4, bundleIntervalSeconds: 10, maxSubmitAttempts: 3, useropsTTLSeconds: 300 } as const;
/** testingMode's bundle size (executor.ts:225-227). */
const TESTING_MODE_BUNDLE = 10;

/**
 * A sidecar's relay settings: skandha_config (bundleSize, bundleInterval in ms, maxSubmitAttempts, useropsTTL,
 * flags.testingMode, modules/skandha.ts:86-146) and skandha_explorer_info (bundlingMode, modules/explorer.ts:95). When
 * skandha_config cannot be read, or names no usable bundleSize and bundleInterval, the defaults (4, 10 s) stand in with
 * assumed true. Never throws.
 *
 * Both report configured values, and the live ones can differ: testingMode relays up to 10 per bundle and only on
 * demand (executor.ts:221-227), and debug_bundler_setBundleInterval, which anyone can call on the shared devnet,
 * changes the live interval (BundlingService/service.ts:151-156) while skandha_config keeps answering the old one.
 */
export async function relayConfig(url: string): Promise<RelayConfig> {
  const notes: string[] = [];
  const [cfgAnswer, infoAnswer] = await Promise.allSettled([rpc<unknown>(url, "skandha_config"), rpc<unknown>(url, "skandha_explorer_info")]);
  let cfg: Record<string, unknown> | null = null;
  // rpc's errors name their method ("skandha_config: no response: …")
  if (cfgAnswer.status === "rejected") notes.push(message(cfgAnswer.reason));
  else if (cfgAnswer.value && typeof cfgAnswer.value === "object") cfg = cfgAnswer.value as Record<string, unknown>;
  else notes.push(`skandha_config answered ${String(JSON.stringify(cfgAnswer.value)).slice(0, 80)}`);

  const whole = (v: unknown, min: number) => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : null);
  const bundleSize = whole(cfg?.bundleSize, 1);
  const intervalMs = typeof cfg?.bundleInterval === "number" && Number.isFinite(cfg.bundleInterval) && cfg.bundleInterval > 0 ? cfg.bundleInterval : null;
  const read = bundleSize !== null && intervalMs !== null;
  if (cfg && !read) notes.push("skandha_config named no usable bundleSize and bundleInterval");
  const testingMode = !!cfg && typeof cfg.flags === "object" && cfg.flags !== null && (cfg.flags as Record<string, unknown>).testingMode === true;
  if (testingMode) notes.push(`testingMode: up to ${TESTING_MODE_BUNDLE} lanes per bundle, relayed only on demand`);

  let bundlingMode: string | null = null;
  if (infoAnswer.status === "rejected") notes.push(message(infoAnswer.reason));
  else {
    const mode = (infoAnswer.value as { bundlingMode?: unknown } | null)?.bundlingMode;
    if (typeof mode === "string") bundlingMode = mode;
    else notes.push("skandha_explorer_info named no bundlingMode");
  }
  return {
    bundleSize: testingMode ? TESTING_MODE_BUNDLE : read ? bundleSize! : RELAY_DEFAULTS.bundleSize,
    bundleIntervalSeconds: read ? intervalMs! / 1000 : RELAY_DEFAULTS.bundleIntervalSeconds,
    maxSubmitAttempts: (read ? whole(cfg?.maxSubmitAttempts, 0) : null) ?? RELAY_DEFAULTS.maxSubmitAttempts,
    useropsTTLSeconds: (read ? whole(cfg?.useropsTTL, 0) : null) ?? RELAY_DEFAULTS.useropsTTLSeconds,
    bundlingMode, testingMode, assumed: !read, notes,
  };
}

// ------------------------------------------------------------------ a plan for n lanes

/** One lane from New to OnChain on the miner's sidecar, measured on Nov 5 (spec, Day-0 relay finding). */
export const ONE_LANE_SECONDS = 28;
/** What a THROTTLED entity may keep pending, keyed lanes included (MempoolService/constants.ts). */
export const THROTTLED_PENDING = 4;

export interface LanePlanInput {
  /** lanes sent at once */
  n: number;
  /** what one new lane will hold: laneMaxCostWei of a transaction built like it */
  perLaneCostWei: bigint;
  /** what the account's lanes already pending hold */
  pendingCostWei: bigint;
  balanceWei: bigint;
  relay: Pick<RelayConfig, "bundleSize" | "bundleIntervalSeconds" | "assumed"> & Partial<Pick<RelayConfig, "bundlingMode" | "notes">>;
  /** each lane's deadline, in seconds after it is signed */
  expirySeconds: number;
}

export interface LanePlan {
  /** the balance covers setAsideWei */
  affordable: boolean;
  /** the lanes already pending plus n new ones: what the sidecar would hold against the balance */
  setAsideWei: bigint;
  /** how far the balance falls short of setAsideWei; 0 when affordable */
  shortfallWei: bigint;
  /** relay passes the n lanes need: ceil(n / bundleSize) */
  passes: number;
  /** an estimate: ONE_LANE_SECONDS (measured for one lane on Nov 5) plus one relay interval per further pass */
  etaSeconds: number;
  warnings: string[];
}

/** n lanes at once: whether the balance covers them with what is already pending, and how long the relay takes. */
export function planLanes(p: LanePlanInput): LanePlan {
  if (!Number.isInteger(p.n) || p.n < 1) throw new Error(`n must be a whole number of lanes, at least 1; got ${p.n}`);
  for (const [name, v] of [["perLaneCostWei", p.perLaneCostWei], ["pendingCostWei", p.pendingCostWei], ["balanceWei", p.balanceWei]] as const) {
    if (v < 0n) throw new Error(`${name} must not be negative; got ${v}`);
  }
  if (!Number.isInteger(p.relay.bundleSize) || p.relay.bundleSize < 1) throw new Error(`the relay's bundleSize must be a whole number, at least 1; got ${p.relay.bundleSize}`);
  if (!(p.relay.bundleIntervalSeconds > 0)) throw new Error(`the relay's interval must be above 0 s; got ${p.relay.bundleIntervalSeconds}`);
  if (!Number.isInteger(p.expirySeconds) || p.expirySeconds < 1) throw new Error(`expirySeconds must be a whole number, at least 1; got ${p.expirySeconds}`);

  const setAsideWei = p.pendingCostWei + BigInt(p.n) * p.perLaneCostWei;
  const shortfallWei = setAsideWei > p.balanceWei ? setAsideWei - p.balanceWei : 0n;
  const passes = Math.ceil(p.n / p.relay.bundleSize);
  const etaSeconds = ONE_LANE_SECONDS + p.relay.bundleIntervalSeconds * (passes - 1);
  const warnings: string[] = [];
  if (p.relay.assumed) {
    const why = p.relay.notes?.[0];
    warnings.push(`the sidecar's relay settings were not read${why ? ` (${why})` : ""}: assumed its defaults, ${p.relay.bundleSize} lanes per pass every ${p.relay.bundleIntervalSeconds} s`);
  }
  if (etaSeconds > p.expirySeconds) {
    warnings.push(`the last of ${passes} relay passes is due about ${etaSeconds} s after the send (an estimate), past the ${p.expirySeconds} s deadline: its lanes may expire before they are relayed; send fewer lanes at once, or give them a longer expiry`);
  }
  if (p.relay.bundlingMode === "manual") {
    warnings.push("the sidecar's bundling mode is manual: it relays nothing by itself, so the lanes stay New until someone sends a bundle");
  }
  return { affordable: shortfallWei === 0n, setAsideWei, shortfallWei, passes, etaSeconds, warnings };
}

// ------------------------------------------------------------------ refusals

export type RefusalCode =
  | "key_busy" | "same_slot" | "duplicate" | "over_budget" | "evicted_for_balance" | "key_used" | "sequence_ahead"
  | "prefix_over_cap" | "dropped" | "expired" | "throttled" | "banned" | "account_refused" | "out_of_gas"
  | "public_one_per_sender" | "unknown";

export interface RefusalExplained {
  code: RefusalCode;
  /** what the message says about the lane, in plain words */
  laneState: string;
  /** what to do about it */
  hint: string;
}

/** The account's revert data, 32 bytes of left-aligned ASCII (Account.yul fail), as its text; null when it is not that. */
export function accountReason(data: string | null | undefined): string | null {
  if (!data || !/^0x([0-9a-fA-F]{2})+$/.test(data)) return null;
  const bytes = hexToBytes(data as Hex);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end);
  return text.length && text.every((b) => b >= 0x20 && b < 0x7f) ? new TextDecoder().decode(text) : null;
}

/** What to do about the account's own reasons (account/yul/Account.yul). */
const ACCOUNT_HINTS: Record<string, string> = {
  "hot: value cap": "the lane sends more than the hot value cap: send less, or raise the cap from a cold leaf (POST /hot-policy)",
  "hot: fee cap": "the lane's maximum cost is above the hot fee cap: a lower fee, or a higher cap set from a cold leaf",
  "hot: frame target": "hot tickets may pay only the allowed target",
  "hot: frame data": "hot tickets carry no calldata",
  "hot: frame mode": "hot tickets use SENDER frames only",
  "hot: disabled": "the hot value cap is 0, the kill switch: hot tickets are off until a cold leaf sets a cap",
  "nonce: sequence": "the account takes sequence 0 on a fresh key, nothing else",
  "nonce: epoch": "the key names another epoch: a rotation landed, so build on the new tree",
  "sig: hash-based check": "the WOTS+ signature or its Merkle path does not verify against the account's root",
};

/** The account's own refusal, from its reason (or none), in the shape explainRefusal answers. */
export function explainAccountReason(reason: string | null, frame?: number): RefusalExplained {
  const where = frame === undefined ? "" : ` (validation frame ${frame})`;
  return {
    code: "account_refused",
    laneState: reason ? `refused by the account${where}: "${reason}"` : `refused by the account${where}, with no reason`,
    hint: (reason && ACCOUNT_HINTS[reason]) ??
      "the account's own rule (Account.yul) refused it, and its leaf is burned: change the transaction, never just the fee",
  };
}

const CHECK_THE_CHAIN = "check the chain, not the status: the nonce key decides. Pay again only once the lane is proven Expired, and only on a fresh leaf";
/** Frame 0 of every transaction the builder makes is the expiry frame; its verifier reverts with no data (revert(0,0)). */
const EXPIRY_FRAME = "validation frame 0, the expiry frame, reverted";
const EXPIRED_HINT = "the leaf is burned: retry on a fresh leaf with a later deadline, never on this leaf and never with a fee bump";

/**
 * What a refusal or a drop says about the lane, for the exact messages the devnet's sidecar and ethrex give
 * (vendor/mempool-workshop-sidecar; ethrex 9aa3645d). Matches anywhere in the text, so a message wrapped by the
 * pipeline or the backend ("leaf 5: refused at submission: eth_sendFrameTransaction: … (-32602)") is still known.
 */
export function explainRefusal(text: string): RefusalExplained {
  let m: RegExpMatchArray | null;
  const known = (code: RefusalCode, laneState: string, hint: string): RefusalExplained => ({ code, laneState, hint });

  // Drops wrap the reason they were dropped for, so they come first (BundlingService/reconciliation.ts:456). A drop
  // whose re-simulation found the expiry frame reverting is an expiry: past its deadline the lane can never land.
  if ((m = text.match(/revalidation failed as of block (\d+)(?::\s*([\s\S]+))?/))) {
    const inner = m[2] ? explainRefusal(m[2]) : null;
    if (inner?.code === "expired") {
      return known("expired", `expired at block ${m[1]}: the deadline passed before the lane was relayed, and the sidecar dropped it (${EXPIRY_FRAME})`, EXPIRED_HINT);
    }
    const why = inner ? ` (${inner.code === "unknown" ? m[2]!.trim() : inner.laneState})` : "";
    return known("dropped", `dropped at block ${m[1]}: the sidecar's re-simulation failed${why}`, CHECK_THE_CHAIN);
  }
  if ((m = text.match(/relayed (\d+) times without being included/))) { // BundlingService/service.ts:340
    return known("dropped", `dropped: relayed ${m[1]} times without being included in a block`, CHECK_THE_CHAIN);
  }
  // ethrex's public pool (crates/blockchain/error.rs:165, MempoolError::FrameTxSenderAlreadyPending)
  if (/A pending frame transaction from this sender is already in the pool/.test(text)) {
    return known("public_one_per_sender", "public mempool: one pending frame transaction per sender, and this account already has one",
      "send parallel lanes to the alt mempool, which holds one pending transaction per nonce key, or wait for the pending one to land");
  }
  // MempoolService/service.ts:399-404
  if ((m = text.match(/nonce key (0x[0-9a-fA-F]+) is already held by pending transaction (0x[0-9a-fA-F]+)/)) || /is already held by pending transaction/.test(text)) {
    return known("key_busy", m ? `key busy: nonce key ${m[1]} is held by pending transaction ${m[2]}` : "key busy: another pending transaction holds this nonce key",
      "one pending transaction per (sender, key): wait for that one to end. This account's lanes each take a fresh key, so a second signer on the same leaves is the likely cause");
  }
  if (/cannot be replaced: fee too low/.test(text)) { // service.ts:509-511
    return known("same_slot", "same slot: another transaction on the same key and sequence is pending, and this one is no replacement the sidecar takes",
      "a signer bug for a one-time key: one leaf signed two messages. Never bump the fee, which would sign it a third time; stop and check the journal");
  }
  if (/already known/i.test(text)) { // service.ts:498-500
    return known("duplicate", "duplicate: the mempool already holds these exact bytes", "nothing was lost: follow the lane by its hash");
  }
  // service.ts:431-432
  if ((m = text.match(/(0x[0-9a-fA-F]{40}) cannot cover its pending frame transactions: they would owe (\d+) wei \((\d+) for this one\), its balance is (\d+) wei/)) ||
      /cannot cover its pending frame transactions/.test(text)) {
    return known("over_budget",
      m ? `over budget: ${m[1]}'s pending lanes and this one would owe ${m[2]} wei (${m[3]} for this one), and its balance is ${m[4]} wei` : "over budget: the pending lanes and this one would owe more than the balance",
      "fund the account, or wait for pending lanes to land; the lanes plan checks the set-aside before any leaf is used");
  }
  // service.ts:473
  if ((m = text.match(/(0x[0-9a-fA-F]{40}) can no longer cover its pending frame transactions as of block (\d+)(?:: balance (\d+) wei)?/)) || /can no longer cover/.test(text)) {
    return known("evicted_for_balance",
      m ? `evicted for balance: at block ${m[2]} ${m[1]}'s balance${m[3] ? ` (${m[3]} wei)` : ""} no longer covered its pending lanes, and the newest New ones were cancelled` : "evicted for balance: the balance no longer covered the pending lanes",
      `fund the account. ${CHECK_THE_CHAIN}`);
  }
  // ethrex's TxValidationError::NonceMismatch { expected: the key's sequence on chain, actual: the transaction's }
  // (crates/vm/levm/src/vm.rs at 9aa3645d); Day-0 saw "Nonce mismatch: expected 1, got 0" for a key used once.
  if ((m = text.match(/Nonce mismatch: expected (\d+), got (\d+)/))) {
    const chain = BigInt(m[1]!), tx = BigInt(m[2]!);
    if (chain > tx) {
      return known("key_used", `key already used: the key's sequence on chain is ${chain}, the transaction's ${tx}`,
        "an earlier transaction on this key was included, so its leaf is spent: send on a fresh leaf and key, never on this one again");
    }
    if (chain < tx) {
      return known("sequence_ahead", `sequence ahead: the transaction's sequence ${tx} is past the key's ${chain} on chain`,
        "a keyed lane carries one transaction at a time, so the previous sequence on this key must land first (this account always sends sequence 0 on a fresh key)");
    }
  }
  // UserOpValidation/utils/validationPrefix.ts:291; ethrex's own variants end the same way (crates/blockchain/error.rs)
  if ((m = text.match(/= (\d+) exceeds MAX_VERIFY_GAS (\d+)/)) || /exceeds MAX_VERIFY_GAS/.test(text)) {
    return known("prefix_over_cap",
      m ? `prefix over the cap: the verify prefix declares ${m[1]} gas with its signature costs, above MAX_VERIFY_GAS ${m[2]}` : "prefix over the cap: the verify prefix and its signature costs exceed MAX_VERIFY_GAS (100,000)",
      "declare at most 90,000 for the verify frame: with the expiry frame's 5,000 and the entry's 100 the prefix stays under 100,000 (the builder refuses more before any leaf is used)");
  }
  // MempoolService/reputation.ts:117,126; ReputationService.ts:166; BundlingService/service.ts:418-423
  if ((m = text.match(/(\w+) (0x[0-9a-fA-F]{40}) is throttled/)) || /is throttled/.test(text)) {
    return known("throttled", `reputation: the sidecar throttles ${m ? `the ${m[1]} ${m[2]}` : "an entity of this lane"}, which may then keep at most ${THROTTLED_PENDING} transactions pending`,
      `send at most ${THROTTLED_PENDING} lanes at once until inclusions restore its reputation (about 110 admissions without an inclusion throttle it, and it recovers slowly)`);
  }
  if ((m = text.match(/(0x[0-9a-fA-F]{40}) is banned/)) || /is banned/.test(text)) {
    return known("banned", `reputation: the sidecar bans ${m ? m[1] : "an entity of this lane"}`,
      "this sidecar refuses everything from it until its reputation recovers: wait, or send through another node");
  }
  // UserOpValidation/validators/frameTx.ts:224-229: "reverted with data 0x…", or "reverted" when the frame returned none.
  // Frame 0 is the expiry frame, whose verifier reverts with no data once block.timestamp is past the deadline; the
  // account's verify frame is frame 1 and reverts with its 32-byte reason.
  if ((m = text.match(/validation frame (\d+): reverted(?: with data (0x[0-9a-fA-F]*))?/))) {
    const data = m[2] && m[2] !== "0x" ? m[2] : null;
    if (Number(m[1]) === 0 && data === null) {
      return known("expired", `expired: the deadline passed before the lane was held or relayed (${EXPIRY_FRAME})`, EXPIRED_HINT);
    }
    return explainAccountReason(accountReason(data), Number(m[1]));
  }
  if ((m = text.match(/validation frame (\d+): ran out of gas/))) {
    return known("out_of_gas", `validation frame ${m[1]} ran out of gas`,
      "the verify frame needed more than it declared. The signer grinds each message to fit 90,000; a message the cost model misjudged is refused here and its leaf burned: send again on a fresh leaf");
  }
  return known("unknown", "a message this explainer does not know", "read the message itself");
}
