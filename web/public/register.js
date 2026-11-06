// The key register and the stub strip (design note 1-ledger.md, sections 1 and 5): the wallet's book of numbered leaves,
// one cell per leaf, each coloured from real data, and the strip of tickets cut from it to the phone, each with its
// state; plus the ticket tear, the moment a hot payment is sent.
// Written with Claude Code (AI) for Vicky.
//   leafStates(view, records) is pure: the wallet view's leaves (GET /api/wallets/:address, from the cold journal and
//     the ticket device's journal) merged with the lane board's records, which are fresher (polled every 2 s, the view
//     every 6 s). A leaf only ever moves forward (unused, then on the phone, then in flight, then used on chain or
//     burned), so the merge keeps the furthest state either source has seen.
//   createRegister and createStubStrip draw those states; a cell or stub that changed since the last draw of the same
//     book (epoch) plays its moment once. The first draw of a book plays nothing: nothing moves on load.
// The ticket device signs its lowest unused ticket (pipeline LeafJournal.reserveNext over the device's band), so the
// next ticket is the lowest ticket still on the phone.
import { el } from "./dom.js";
import { formatCount, nonceKeyParts } from "./format.js";

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

/** Whether the viewer asked for less motion (the OS setting, or ?motion=reduce); false where matchMedia is missing. */
export function reducedMotion() {
  if (typeof document !== "undefined" && document.documentElement?.classList?.contains("reduce-motion")) return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The moment class a cell plays when its state changes: a cut (hot band to the phone) runs a dashed perforation round
 * it before it fills red; any other change presses it in.
 * @param {LeafState} from @param {LeafState} to
 */
const cellMoment = (from, to) => (to === "phone" && (from === "hot" || from === "unused") ? "m-cut" : "m-fill");

/**
 * Plays a moment class once: added now, removed when its animation ends (it stays, harmless, where none runs).
 * @param {Element} node
 * @param {string} cls
 */
function play(node, cls) {
  node.classList.add(cls);
  node.addEventListener("animationend", () => node.classList.remove(cls), { once: true });
}

/**
 * The register: one cell per leaf in a 64-column grid, leaf 0 at the top left, with a legend. draw(states, book) colours
 * the cells; book names the tree (say its epoch), and a new book draws fresh with no moment.
 * @param {HTMLElement} root
 * @param {{ legend?: boolean, label?: string }} [opts] label: what the register is called for a screen reader
 */
export function createRegister(root, opts = {}) {
  const grid = el("div", { class: "register", role: "img" });
  /** @type {HTMLElement[]} */
  const parts = [grid];
  if (opts.legend !== false) {
    parts.push(el("ul", { class: "legend", "aria-hidden": "true" },
      ...(/** @type {LeafState[]} */ (["onchain", "burned", "flight", "phone", "hot", "unused"])).map((s) =>
        el("li", {}, el("i", { class: `leaf-cell is-${s}` }), LEAF_WORDS[s]))));
  }
  root.replaceChildren(...parts);
  /** @type {HTMLElement[]} */
  let cells = [];
  /** @type {LeafState[]} */
  let last = [];
  /** @type {string | null} */
  let book = null;

  return {
    /**
     * @param {readonly LeafState[]} states every leaf's, from leafStates
     * @param {string} bookKey the tree they belong to (its epoch); a new one draws without moments
     */
    draw(states, bookKey) {
      const fresh = book !== bookKey || cells.length !== states.length;
      if (cells.length !== states.length) {
        cells = states.map(() => el("i", { class: "leaf-cell" }));
        grid.replaceChildren(...cells);
      }
      states.forEach((s, i) => {
        const cell = /** @type {HTMLElement} */ (cells[i]);
        const was = /** @type {LeafState | undefined} */ (last[i]);
        const want = `leaf-cell is-${s}`;
        if (fresh) { if (cell.className !== want) cell.className = want; } // a new book: no moment
        else if (was !== s) { cell.className = want; play(cell, cellMoment(was ?? "unused", s)); }
        // unchanged: left alone, so a moment still playing finishes
      });
      last = [...states];
      book = bookKey;
      const c = countStates(states);
      grid.setAttribute("aria-label", `${opts.label ?? "Key tree register"}, ${formatCount(states.length)} leaves: ` +
        (/** @type {LeafState[]} */ (["onchain", "burned", "flight", "phone", "hot", "unused"])).map((s) => `${c[s]} ${LEAF_WORDS[s]}`).join(", ") + ".");
    },
  };
}

/** A stub's words for a screen reader. @param {Stub} s */
const stubWords = (s) => (s.next ? "next ticket" : s.state === "phone" ? "on the phone" : LEAF_WORDS[s.state]);

/** A stub's class: its state, and "next" on the ticket the device signs next. @param {Stub} s */
const stubClass = (s) => `stub is-${s.state}${s.next ? " next" : ""}`;

/**
 * The stub strip: the tickets cut to the phone, each a stub with its leaf number in red, the next one ringed, used ones
 * framed (in flight: a dashed Ink frame; used on chain: a violet stamp frame; burned by the signer: a dashed violet one).
 * draw(stubs, book): stubs that are new since the last draw of the same book print in, left to right, 35 ms apart; a
 * stub that just became used on chain or burned gets its frame stamped.
 * Each stub keeps its element while the book stays the same, and a stub that did not change is not touched: a screen
 * draws twice in a row (from the wallet view, then from the records), and the second draw must not cut short a moment
 * the first one started.
 * @param {HTMLOListElement | HTMLUListElement} list
 */
export function createStubStrip(list) {
  /** @type {Map<number, { li: HTMLElement, words: HTMLElement, cls: string }>} the stubs shown, in the strip's order */
  let shown = new Map();
  /** @type {Map<number, LeafState>} */
  let last = new Map();
  /** @type {string | null} */
  let book = null;
  return {
    /**
     * @param {readonly Stub[]} stubs from stubsOf
     * @param {string} bookKey the tree they belong to (its epoch)
     */
    draw(stubs, bookKey) {
      const fresh = book !== bookKey;
      let printed = 0;
      list.hidden = stubs.length === 0;
      // the stubs shown stay in place only while they are the first of the new list, in order (a cut adds stubs after
      // them); anything else (a new book, a strip that shrank) is drawn again from nothing
      const leaves = [...shown.keys()];
      if (fresh || leaves.length > stubs.length || leaves.some((leaf, i) => stubs[i]?.leaf !== leaf)) {
        shown = new Map();
        list.replaceChildren();
      }
      for (const s of stubs) {
        const was = last.get(s.leaf);
        const cls = stubClass(s);
        const have = shown.get(s.leaf);
        if (have) {
          if (have.cls === cls) continue; // unchanged: left alone, so a moment still playing finishes
          have.li.className = cls;
          have.cls = cls;
          have.words.textContent = `, ${stubWords(s)}`;
          if (was !== s.state && (s.state === "onchain" || s.state === "burned")) play(have.li, "m-stamped");
          continue;
        }
        const words = el("span", { class: "visually-hidden", text: `, ${stubWords(s)}` });
        const li = el("li", { class: cls }, el("span", { text: String(s.leaf) }), words);
        shown.set(s.leaf, { li, words, cls });
        list.append(li);
        if (fresh) continue; // a new book: no moment
        if (was === undefined) {
          // printed in, left to right: a stagger through the CSSOM (a style attribute would break the page's CSP)
          if (li.style) li.style.animationDelay = `${35 * printed++}ms`;
          play(li, "m-fresh");
        } else if (was !== s.state && (s.state === "onchain" || s.state === "burned")) play(li, "m-stamped");
      }
      last = new Map(stubs.map((s) => [s.leaf, s.state]));
      book = bookKey;
    },
  };
}

/**
 * The tear: the ticket lifts off along its perforation and fades up and away, and the next one rises under it. One
 * Web Animations call on a clone of the ticket (ids and inputs removed, hidden from screen readers), so the real form
 * never moves and stays usable. Skipped, returning false, under reduced motion, where element.animate is missing
 * (older browsers, the tests' fake DOM), or when the ticket is off screen. Call it when the hot payment is sent.
 * @param {HTMLElement} ticket
 * @returns {boolean} whether it played
 */
export function tearTicket(ticket) {
  if (reducedMotion() || typeof ticket.animate !== "function" || typeof ticket.cloneNode !== "function") return false;
  const box = ticket.getBoundingClientRect();
  if (box.bottom < 0 || box.top > (typeof innerHeight === "number" ? innerHeight : 0)) return false;
  const ghost = /** @type {HTMLElement} */ (ticket.cloneNode(true));
  ghost.removeAttribute("id");
  for (const n of ghost.querySelectorAll("[id]")) n.removeAttribute("id");
  const from = ticket.querySelectorAll("input"), to = ghost.querySelectorAll("input");
  to.forEach((n, i) => { n.value = from[i]?.value ?? ""; n.removeAttribute("name"); n.tabIndex = -1; });
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.classList.add("ghost");
  Object.assign(ghost.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, margin: "0", zIndex: "20", pointerEvents: "none" });
  document.body.append(ghost);
  const done = () => ghost.remove();
  ghost.animate([
    { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
    { transform: "translate(3px, -7px) rotate(-1.6deg)", opacity: 1, offset: 0.26 },
    { transform: "translate(44px, -80px) rotate(-6deg)", opacity: 0 },
  ], { duration: 500, easing: "cubic-bezier(.3,.6,.2,1)" }).finished.then(done, done);
  ticket.animate([{ transform: "translateY(12px)", opacity: 0.15 }, { transform: "translateY(0)", opacity: 1 }],
    { duration: 280, delay: 150, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
  return true;
}

/**
 * The roll: a number changes like a numbering machine's wheel, the old figure up and out, the new one in from below
 * (the ticket count, the next ticket's serial). The node holds only the number's text; give it class "roll" in the
 * page. Without animate, under reduced motion, or when asked not to animate, the text just changes.
 * @param {HTMLElement} node
 * @param {string} text
 * @param {boolean} [animate] false on a plain redraw (a poll), true on the action that moved the number
 */
export function rollNumber(node, text, animate = true) {
  const was = node.dataset.v ?? node.textContent ?? "";
  node.dataset.v = text;
  if (was === text) { if (node.textContent !== text) node.textContent = text; return; }
  const out = el("span", { text: was, "aria-hidden": "true", class: "roll-out" });
  const inn = el("span", { text });
  if (!animate || reducedMotion() || typeof out.animate !== "function") { node.textContent = text; return; }
  node.replaceChildren(inn, out);
  const opts = { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" };
  const done = () => { out.remove(); };
  out.animate([{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }], opts).finished.then(done, done);
  inn.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], opts);
}
