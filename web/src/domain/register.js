// Pure one-time-key state and ticket selection, shared by the React interface and tests.
import { nonceKeyParts } from "./format.js";

/** @import { TxRecord, WalletView } from "./api.js" */

/**
 * @typedef {"unused" | "hot" | "phone" | "flight" | "onchain" | "burned"} LeafState
 *   unused: never signed; hot: in the hot band (from hotStart), not cut; phone: exported to the ticket device, not used;
 *   flight: signed and sent, not decided; onchain: the chain consumed its key; burned: by the signer (expired, refused,
 *   an estimate, never sent), never on chain
 */

/** Each state in the spec's words, for the legend and the screen reader's summary. */
export const LEAF_WORDS = /** @type {Readonly<Record<LeafState, string>>} */ (Object.freeze({
  onchain: "used on chain", burned: "burned by the signer", flight: "in flight", phone: "on the phone", hot: "hot band, not cut", unused: "unused",
}));

/** How far along a leaf is; a leaf never moves back, so the merge keeps the higher rank. */
const RANK = /** @type {Record<LeafState, number>} */ ({ unused: 0, hot: 0, phone: 1, flight: 2, onchain: 3, burned: 3 });

/** @param {TxRecord["status"]} s @returns {LeafState} */
const recordState = (s) => (s === "Submitted" || s === "Unknown" ? "flight" : s === "Expired" || s === "Refused" ? "burned" : "onchain");

/**
 * Every leaf's state for the wallet's current epoch, leaf 0 first. Pure.
 * @param {Pick<WalletView, "leafCount" | "hotStart" | "epoch"> & { leaves?: WalletView["leaves"] }} view
 * @param {readonly Pick<TxRecord, "leaf" | "nonceKey" | "status">[]} records the lane board's; other epochs' are ignored
 * @returns {LeafState[]}
 */
export function leafStates(view, records) {
  const n = view.leafCount;
  /** @type {LeafState[]} */
  const out = Array.from({ length: n }, (_, i) => (i >= view.hotStart ? "hot" : "unused"));
  /** @param {number} leaf @param {LeafState} s @param {boolean} [fresher] a record's final state wins a tie */
  const put = (leaf, s, fresher = false) => {
    if (!Number.isInteger(leaf) || leaf < 0 || leaf >= n) return;
    const have = /** @type {LeafState} */ (out[leaf]);
    if (RANK[s] > RANK[have] || (fresher && RANK[s] === RANK[have] && RANK[s] === 3)) out[leaf] = s;
  };
  const l = view.leaves;
  if (l?.tickets) for (let i = l.tickets.from; i <= l.tickets.to; i++) put(i, "phone");
  for (const i of l?.inFlight ?? []) put(i, "flight");
  for (const i of l?.onChain ?? []) put(i, "onchain");
  for (const i of l?.burned ?? []) put(i, "burned");
  for (const r of records) {
    if (nonceKeyParts(r.nonceKey)?.epoch !== view.epoch) continue; // an older tree's lane
    put(r.leaf, recordState(r.status), true);
  }
  return out;
}

/**
 * How many leaves are in each state.
 * @param {readonly LeafState[]} states
 * @returns {Record<LeafState, number>}
 */
export function countStates(states) {
  /** @type {Record<LeafState, number>} */
  const c = { onchain: 0, burned: 0, flight: 0, phone: 0, hot: 0, unused: 0 };
  for (const s of states) c[s]++;
  return c;
}

/**
 * The next ticket the device signs: the lowest ticket still on the phone. Null when none is left, or when the device
 * cannot sign (its journal is lost: tickets.unjournaled).
 * @param {Pick<WalletView, "tickets"> & { leaves?: WalletView["leaves"] }} view
 * @param {readonly LeafState[]} states
 * @returns {number | null}
 */
export function nextTicket(view, states) {
  const band = view.leaves?.tickets;
  if (!band || view.tickets.unjournaled) return null;
  for (let i = band.from; i <= band.to; i++) if (states[i] === "phone") return i;
  return null;
}

/**
 * @typedef {{ leaf: number, state: LeafState, next: boolean }} Stub one ticket cut to the phone
 */

/**
 * The tickets cut this epoch, lowest first, each with its state; the next one marked. Pure.
 * @param {Pick<WalletView, "tickets"> & { leaves?: WalletView["leaves"] }} view
 * @param {readonly LeafState[]} states
 * @returns {Stub[]}
 */
export function stubsOf(view, states) {
  const band = view.leaves?.tickets;
  if (!band) return [];
  const next = nextTicket(view, states);
  /** @type {Stub[]} */
  const out = [];
  for (let i = band.from; i <= band.to; i++) out.push({ leaf: i, state: /** @type {LeafState} */ (states[i] ?? "phone"), next: i === next });
  return out;
}

