// The lane board's state, from the backend's transaction records (GET /api/wallets/:address/txs): one row per lane,
// newest first, with its status and status timeline in the spec's words, retry links, and the "set aside for pending"
// line. No DOM: board.js draws the rows.
// Written with Claude Code (AI) for Vicky.
import { formatCount, formatGas, formatWei, formatWeiExact, nonceKeyParts, shortHex } from "./format.js";

/** @import { TxRecord, TxStatus, WalletView } from "./api.js" */

/**
 * @typedef {"sent" | "admitted" | "pending" | "key" | "included" | "reverted" | "expired" | "retried" | "refused" | "unknown"} StepKey
 * @typedef {{ key: StepKey, label: string, at: number, block: number | null }} Step at: ms after the lane's first step
 * @typedef {{ key: "admitted" | "included" | "reverted" | "expired" | "refused" | "unknown", label: string, final: boolean }} RowStatus
 */

/**
 * @typedef {Object} Row
 * @property {string} hash
 * @property {string} lane the nonce key, 0x hex
 * @property {number | null} epoch
 * @property {number} leaf
 * @property {"keyed" | "hot"} mode
 * @property {string} action
 * @property {string} amount at most six significant decimals
 * @property {string} amountExact the exact amount, for the cell's title
 * @property {string} gas the verify frame's gas, "—" while unknown
 * @property {RowStatus} status
 * @property {Step[]} steps
 * @property {boolean} pending
 * @property {"alt" | "public" | null} mempool
 * @property {string} explorerUrl
 * @property {string | null} retryOf hash of the expired lane this one retries
 * @property {string | null} retriedAs hash of the lane that retried this one
 * @property {string | null} retryOfLane
 * @property {string | null} retriedAsLane
 * @property {string[]} reasons why it was refused, or what is not known (detail, then the simulation's violations)
 * @property {Refusal | null} refusal the account's refusal in the screens' words
 * @property {TxRecord} record
 */

/** @typedef {{ words: string, reason: string }} Refusal words: "exceeds value cap"; reason: "account: hot: value cap" */

/** Account.yul's hot-policy refusals (its fail reasons) in the screens' words. */
const ACCOUNT_WORDS = /** @type {Record<string, string>} */ ({
  "hot: value cap": "exceeds value cap", "hot: frame target": "target not allowed", "hot: fee cap": "exceeds fee cap",
  "hot: disabled": "hot tickets off: value cap 0", "hot: frame data": "calldata not allowed", "hot: frame mode": "frame mode not allowed",
});

/**
 * Why the account refused a transaction, in the screens' words, from the account's revert reason among the
 * violations the backend reports ("account: hot: value cap"); null when the account gave none the screens know.
 * @param {readonly string[] | null | undefined} violations
 * @returns {Refusal | null}
 */
export function refusalOf(violations) {
  for (const v of violations ?? []) {
    const words = ACCOUNT_WORDS[/^account: (.+)$/.exec(v)?.[1] ?? ""];
    if (words) return { words, reason: v };
  }
  return null;
}

/** Lanes that may still land: their worst case stays set aside. */
export const PENDING = /** @type {readonly TxStatus[]} */ (["Submitted", "Unknown"]);

/**
 * The row's status in the spec's words (admitted, included, expired, refused, burned).
 * @param {TxRecord} rec
 * @returns {RowStatus}
 */
export function statusOf(rec) {
  switch (rec.status) {
    case "Submitted": {
      const first = rec.timeline[0]?.status ?? "";
      return { key: "admitted", label: first.startsWith("Submitted (") ? "sent, answer lost" : "admitted", final: false };
    }
    case "OnChain": return { key: "included", label: "included", final: true };
    case "Reverted": return { key: "reverted", label: "included, a frame reverted", final: true };
    case "Included": return { key: "included", label: "included, no receipt yet", final: true };
    case "Expired": return { key: "expired", label: "expired, leaf burned", final: true };
    case "Refused": return { key: "refused", label: "refused, leaf burned", final: true };
    case "Unknown": return { key: "unknown", label: "unknown, still in flight", final: false };
    default: return { key: "unknown", label: String(rec.status), final: false };
  }
}

/** The backend's timeline lines (store.ts, submit.ts waitForInclusion) and the step each one is. */
const RULES = /** @type {[RegExp, StepKey, string][]} */ ([
  [/^Submitted \(/, "sent", "sent, answer lost"],
  [/^Submitted$/, "admitted", "admitted"],
  [/^sidecar: (New|Pending|Submitted)$/, "pending", "pending"],
  [/^chain: key used by block (\d+)/, "key", "key used"],
  [/^(?:chain: )?OnChain(?: in block (\d+))?/, "included", "included"],
  [/^(?:chain: )?Reverted(?: in block (\d+))?/, "reverted", "included, reverted"],
  [/^(?:chain: )?Included(?: by block (\d+))?/, "included", "included"],
  [/^(?:chain: )?Expired/, "expired", "expired, leaf burned"],
  [/^retried as /, "retried", "retried on a fresh lane"],
  [/^Refused/, "refused", "refused"],
  [/^Unknown/, "unknown", "unknown"],
]);

/** "settled after a restart: OnChain" and "from the journal at start: Expired" name an outcome. */
const RESTART = /^(?:settled after a restart|from the journal at start): (OnChain|Reverted|Included|Expired|Refused)\b/;
const FINAL_STEP = /** @type {Record<string, StepKey>} */ ({ OnChain: "included", Reverted: "reverted", Included: "included", Expired: "expired", Refused: "refused" });
const STEP_LABEL = /** @type {Record<StepKey, string>} */ ({
  sent: "sent, answer lost", admitted: "admitted", pending: "pending", key: "key used", included: "included", reverted: "included, reverted",
  expired: "expired, leaf burned", retried: "retried on a fresh lane", refused: "refused", unknown: "unknown",
});

/**
 * One timeline line as a step, or null for a line the board does not show (it stays in the row's detail).
 * @param {string} line
 * @returns {{ key: StepKey, label: string, block: number | null } | null}
 */
export function stepOf(line) {
  const restart = RESTART.exec(line);
  if (restart) {
    const key = FINAL_STEP[/** @type {string} */ (restart[1])] ?? "unknown";
    return { key, label: STEP_LABEL[key], block: null };
  }
  for (const [re, key, label] of RULES) {
    const m = re.exec(line);
    if (m) return { key, label, block: m[1] && /^\d+$/.test(m[1]) ? Number(m[1]) : null };
  }
  return null;
}

/**
 * The status timeline: the first time each step was seen, in order, ms after the lane's first line. A final status
 * the timeline does not name (a lane only a journal knows) is added at the record's last change.
 * @param {TxRecord} rec
 * @returns {Step[]}
 */
export function stepsOf(rec) {
  const t0 = Date.parse(rec.timeline[0]?.at ?? rec.createdAt);
  /** @type {Step[]} */
  const steps = [];
  for (const { status, at } of rec.timeline) {
    const s = stepOf(status);
    if (!s) continue;
    const have = steps.find((x) => x.key === s.key);
    if (have) { have.block ??= s.block; continue; }
    steps.push({ ...s, at: Math.max(0, Date.parse(at) - t0) });
  }
  const st = statusOf(rec);
  const want = /** @type {StepKey | null} */ (st.final ? (rec.status === "Reverted" ? "reverted" : st.key) : null);
  if (want && !steps.some((x) => x.key === want)) {
    steps.push({ key: want, label: STEP_LABEL[want], at: Math.max(0, Date.parse(rec.updatedAt) - t0), block: blockOf(rec) });
  }
  const inc = steps.find((x) => x.key === "included" || x.key === "reverted");
  if (inc && inc.block === null) inc.block = blockOf(rec);
  return steps;
}

/** @param {TxRecord} rec */
function blockOf(rec) {
  const b = rec.receipt?.blockNumber;
  return b ? Number(BigInt(b)) : null;
}

/**
 * What the lane does, in a few words.
 * @param {TxRecord} rec
 */
export function actionOf(rec) {
  if (rec.kind === "rotate") return "rotate root";
  if (rec.kind === "hot-policy") return "set hot policy";
  if (rec.kind === null) return "lane from a script";
  const to = shortHex(rec.to);
  return rec.mode === "hot" ? `hot ticket to ${to}` : `pay ${to}`;
}

/**
 * The board's rows, newest first (by when each lane was signed); the ties broken by hash, so the order never flickers.
 * @param {TxRecord[]} records
 * @returns {Row[]}
 */
export function laneRows(records) {
  const sorted = [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.txHash < b.txHash ? -1 : 1));
  const laneOf = new Map(sorted.map((r) => [r.txHash.toLowerCase(), r.nonceKey]));
  return sorted.map((rec) => {
    const parts = nonceKeyParts(rec.nonceKey);
    const reasons = [rec.status !== "OnChain" && rec.detail ? rec.detail : null, ...(rec.simulation?.violations ?? [])].filter(/** @returns {x is string} */ (x) => !!x);
    return {
      hash: rec.txHash,
      lane: rec.nonceKey,
      epoch: parts?.epoch ?? null,
      leaf: rec.leaf,
      mode: rec.mode,
      action: actionOf(rec),
      amount: rec.valueWei === null ? "—" : formatWei(rec.valueWei),
      amountExact: rec.valueWei === null ? "not known: a lane from a script" : formatWeiExact(rec.valueWei),
      gas: formatGas(rec.simulation?.verifyGas ?? null),
      status: statusOf(rec),
      steps: stepsOf(rec),
      pending: PENDING.includes(rec.status),
      mempool: rec.mempool,
      explorerUrl: rec.explorerUrl,
      retryOf: rec.retryOf,
      retriedAs: rec.retriedAs,
      retryOfLane: rec.retryOf ? laneOf.get(rec.retryOf.toLowerCase()) ?? null : null,
      retriedAsLane: rec.retriedAs ? laneOf.get(rec.retriedAs.toLowerCase()) ?? null : null,
      reasons: [...new Set(reasons)],
      refusal: rec.status === "Refused" ? refusalOf(rec.simulation?.violations) : null,
      record: rec,
    };
  });
}

/**
 * @typedef {Object} SetAside
 * @property {number} lanes pending lanes
 * @property {bigint} valuesWei what they send
 * @property {number} reported pending lanes whose record carries maxCostWei
 * @property {bigint} maxCostWei the maximum cost the backend reports for those lanes: what the sidecar sets aside for
 *   their fees while they are pending
 * @property {bigint} feeBoundWei the hot fee cap once per other pending hot lane: the most the account lets its fees reach
 * @property {bigint} totalWei values plus maxCostWei plus feeBoundWei
 * @property {number} unbounded the other pending lanes, whose worst-case fee the API does not report (keyed, script lanes)
 */

/**
 * A record's maximum cost when the backend reports it (decimal wei), else null.
 * @param {TxRecord} r
 */
export function maxCostOf(r) {
  return typeof r.maxCostWei === "string" && /^\d+$/.test(r.maxCostWei) ? BigInt(r.maxCostWei) : null;
}

/**
 * The worst-case cost of the pending lanes, from what the API returns: each lane's value, plus its maximum cost when
 * the record carries it (maxCostWei: the sidecar's set-aside is every pending lane's max cost plus its value, spec Nov
 * 6), else the hot fee cap for a hot lane (the account refuses a hot transaction whose maximum fee is above it). A keyed
 * lane without maxCostWei is counted apart, its fee never guessed.
 * @param {TxRecord[]} records
 * @param {Pick<WalletView, "hotFeeCapWei"> | null} wallet
 * @returns {SetAside}
 */
export function setAside(records, wallet) {
  let lanes = 0, reported = 0, unbounded = 0, values = 0n, costs = 0n, fees = 0n;
  for (const r of records) {
    if (!PENDING.includes(r.status)) continue;
    lanes++;
    if (r.valueWei !== null) values += BigInt(r.valueWei);
    const cost = maxCostOf(r);
    if (cost !== null) { reported++; costs += cost; }
    else if (r.mode === "hot" && wallet && r.valueWei !== null) fees += BigInt(wallet.hotFeeCapWei);
    else unbounded++;
  }
  return { lanes, valuesWei: values, reported, maxCostWei: costs, feeBoundWei: fees, totalWei: values + costs + fees, unbounded };
}

/**
 * The line under the board: "set aside for pending: 0.0402 ETH on 2 lanes (values, plus the hot fee cap for each of 2
 * tickets: an upper bound)"; when records carry maxCostWei it says those lanes count the maximum cost the backend reports.
 * @param {SetAside} s
 */
export function setAsideText(s) {
  if (s.lanes === 0) return "set aside for pending: nothing, no lane in flight";
  const lanes = `${s.lanes} lane${s.lanes === 1 ? "" : "s"}`;
  const hot = s.lanes - s.unbounded - s.reported;
  const parts = [`set aside for pending: ${formatWei(s.totalWei)} on ${lanes}`];
  if (s.reported > 0 && s.reported === s.lanes) {
    parts.push(`(${s.lanes === 1 ? "its value" : "each lane's value"} plus the maximum cost the backend reports: what the sidecar sets aside)`);
  } else if (s.reported > 0) {
    const tickets = hot > 0 ? `; ${hot === 1 ? "1 ticket" : `${hot} tickets`} at value plus the hot fee cap, an upper bound` : "";
    parts.push(`(${s.reported} at value plus the maximum cost the backend reports, what the sidecar sets aside${tickets})`);
  } else if (hot > 0) parts.push(`(values, plus the hot fee cap for ${hot === 1 ? "the ticket" : `each of ${hot} tickets`}: an upper bound)`);
  else parts.push("(values only)");
  if (s.unbounded > 0) parts.push(`plus the fees of ${s.unbounded} keyed lane${s.unbounded === 1 ? "" : "s"}, which the API does not report`);
  return parts.join(" ");
}

/**
 * Changes between two polls, for event logs: lanes that are new, and lanes whose status changed.
 * @param {Map<string, TxStatus>} before hash -> status from the last poll (updated in place)
 * @param {TxRecord[]} records
 * @returns {{ rec: TxRecord, from: TxStatus | null }[]}
 */
export function changes(before, records) {
  /** @type {{ rec: TxRecord, from: TxStatus | null }[]} */
  const out = [];
  for (const rec of records) {
    const key = rec.txHash.toLowerCase();
    const from = before.get(key) ?? null;
    if (from !== rec.status) out.push({ rec, from });
    before.set(key, rec.status);
  }
  return out;
}

// ------------------------------------------------------------------ the ledger's marks (design note 1-ledger.md, section 4)

/**
 * The rule under a lane's amount: "final", a double rule (included, the money moved); "single" (included, no receipt
 * read yet, so whether the value moved is open); "void", a strike (refused or expired, or included with a frame
 * reverted: the key was used, the value did not move); null while the lane is pending.
 * @param {TxRecord} rec
 * @returns {"final" | "single" | "void" | null}
 */
export function amountMark(rec) {
  switch (rec.status) {
    case "OnChain": return "final";
    case "Included": return "single";
    case "Reverted": case "Expired": case "Refused": return "void";
    default: return null;
  }
}

/**
 * @typedef {Object} Stamp the cancellation stamp on a final lane
 * @property {"chain" | "signer"} by the chain consumed the nonce key, or the signer journaled the leaf as burned
 * @property {number | null} block the block that consumed the key, when known
 * @property {string} words the stamp's second line: "in block 408,215", "on chain", "by the signer"
 */

/**
 * The stamp a final lane carries: "burned, in block N" when the chain consumed its key (included, reverted or included
 * with no receipt: the key is used either way), "burned, by the signer" when it never reached the chain (expired,
 * refused). Null while the lane may still land. The block is the timeline's (included, else "key used by block N"),
 * else the receipt's (stepsOf fills it in).
 * @param {Pick<Row, "status" | "steps">} row
 * @returns {Stamp | null}
 */
export function stampOf(row) {
  if (!row.status.final) return null;
  if (row.status.key === "expired" || row.status.key === "refused") return { by: "signer", block: null, words: "by the signer" };
  const block = row.steps.find((s) => (s.key === "included" || s.key === "reverted") && s.block !== null)?.block
    ?? row.steps.find((s) => s.key === "key")?.block ?? null;
  return { by: "chain", block, words: block === null ? "on chain" : `in block ${formatCount(block)}` };
}

/**
 * The stamp's fixed angle, 0 to 6 (the CSS classes tilt-0 to tilt-6, from -4 to +2 degrees), from the leaf number: a
 * column of stamps looks hand-stamped but never random, and a lane's stamp never moves between draws.
 * @param {number} leaf
 */
export function tiltOf(leaf) {
  return ((leaf * 37) % 7 + 7) % 7;
}

/**
 * A row's amount ("0.0025 ETH", "1,000 wei", "—") as its figure and unit, and how many decimals the figure has, so the
 * board can pad each figure with hidden zeros and line the decimal points up.
 * @param {string} amount
 * @returns {{ fig: string, unit: string, decimals: number }}
 */
export function splitAmount(amount) {
  const m = /^(.*?) (ETH|wei)$/.exec(amount);
  const fig = m ? /** @type {string} */ (m[1]) : amount;
  const dot = fig.indexOf(".");
  return { fig, unit: m ? /** @type {string} */ (m[2]) : "", decimals: dot < 0 ? 0 : fig.length - dot - 1 };
}

/**
 * The line a rotation rules the ledger off with, above the first lane of an older epoch: "Epoch 0 closed by the
 * rotation in block N. Lanes below this line belong to the old tree." The block is the closed epoch's rotation lane's
 * (its stamp's), when the board holds it. Null when row i is not the first of an older epoch.
 * @param {Row[]} rows newest first
 * @param {number} i
 * @returns {string | null}
 */
export function epochRule(rows, i) {
  const row = rows[i], above = rows[i - 1];
  if (!row || !above || row.epoch === null || above.epoch === null || row.epoch >= above.epoch) return null;
  const rotation = rows.find((r) => r.epoch === row.epoch && r.record.kind === "rotate" && stampOf(r)?.by === "chain");
  const block = rotation ? stampOf(rotation)?.block ?? null : null;
  const by = block === null ? "by a rotation" : `by the rotation in block ${formatCount(block)}`;
  return `Epoch ${row.epoch} closed ${by}. Lanes below this line belong to the old tree.`;
}
