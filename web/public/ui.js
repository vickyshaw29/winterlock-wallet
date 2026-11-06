// What every screen shares: the wallet (?wallet=) and its account line, the lane board (the ledger) polled every 2 s, the
// Mempool switch, set-aside and lane limits, the stalled-chain banner, the ticket device's trouble, the notice line, the
// status line (the Fake chain band on 31337), the parallel-lanes plan, and the review aids ?theme= and ?motion=reduce.
// Written with Claude Code (AI) for Vicky.
import { ApiError, createApi } from "./api.js";
import { createBoard } from "./board.js";
import { byId, el, item } from "./dom.js";
import {
  LANE_LIMITS_TEXT, deviceIssue, deviceIssueOf, errorText, mempoolNotice, planFailureText, planWords, readPlan, readStatus, stalledBanner,
  statusBanner, statusWords,
} from "./flows.js";
import { formatClock, formatCount, formatWei, formatWeiExact, shortHex } from "./format.js";
import { laneRows, setAside, setAsideText } from "./lanes.js";

/** @import { Api, PlanQuery, TxRecord, WalletView } from "./api.js" */
/** @import { ChainStatus, DeviceIssue, Mempool } from "./flows.js" */

const TXS_MS = 2_000, WALLET_MS = 6_000, STATUS_MS = 10_000;
const REMEMBER = "winterlock.wallet";

/**
 * Review aids for screenshots and the booth: ?theme=dark or ?theme=light overrides the OS colour scheme (style.css reads
 * data-theme), ?motion=reduce makes every moment instant as prefers-reduced-motion does. Nothing is remembered.
 */
export function applyReviewAids() {
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (!root) return;
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const theme = q.get("theme");
  if (theme === "dark" || theme === "light") root.dataset.theme = theme;
  if (q.get("motion") === "reduce") root.classList.add("reduce-motion");
}

/** @param {string} key */
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }
/** @param {string} key @param {string} value */
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private window: fine */ } }

/**
 * The wallet a screen shows: ?wallet=, else the one picked last, else the first the backend lists.
 * @param {import("./api.js").Api} api
 * @returns {Promise<string | null>}
 */
export async function pickWallet(api) {
  const asked = new URLSearchParams(location.search).get("wallet");
  if (asked) return asked;
  const list = await api.listWallets();
  const last = recall(REMEMBER);
  return list.find((w) => w.address.toLowerCase() === last?.toLowerCase())?.address ?? list[0]?.address ?? null;
}

/**
 * @typedef {Object} Screen
 * @property {import("./api.js").Api} api
 * @property {string} address
 * @property {() => WalletView | null} wallet the latest wallet view
 * @property {() => TxRecord[]} records the latest lane board records
 * @property {() => Mempool} mempool what the Mempool switch says
 * @property {() => boolean} stalled
 * @property {() => ChainStatus | null} chain the latest GET /api/status, read (polled every 10 s); null when not offered
 * @property {() => DeviceIssue | null} deviceIssue the ticket device cannot sign (409 device_unusable, or tickets cut
 *   whose device journal is missing): the cards say so, and no cut is offered
 * @property {<T>(button: HTMLButtonElement | null, fn: () => Promise<T>, onError?: (e: unknown) => void) => Promise<T | undefined>} run
 * @property {(e: unknown, onError?: (e: unknown) => void) => void} fail a 503 raises the banner; a 409 device_unusable
 *   goes on the cards; then anything but the 503 to onError or the notice line
 * @property {(text: string, tone?: "ok" | "error") => void} notice
 * @property {() => Promise<void>} refresh
 * @property {(fn: (w: WalletView) => void) => void} onWallet
 * @property {(fn: (r: TxRecord[]) => void) => void} onRecords
 * @property {() => void} updateSendable
 * @property {() => void} stop stops the polls
 */

/**
 * "set aside for pending" into an element, with the exact total in its title.
 * @param {HTMLElement} target
 * @param {TxRecord[]} records
 * @param {WalletView | null} wallet
 */
export function drawSetAside(target, records, wallet) {
  const s = setAside(records, wallet);
  target.textContent = setAsideText(s);
  target.title = s.lanes ? `exact: ${formatWeiExact(s.totalWei)}` : "";
}

/**
 * How often the plan is asked again while a screen's query for it stays the same: the wallet view comes every 6 s, and
 * each plan makes the backend read the chain, so an unchanged screen asks at most every 30 s.
 */
export const PLAN_EVERY_MS = 30_000;

/**
 * @typedef {Object} PlanDrawing what the plan element shows under its heading
 * @property {string} line
 * @property {boolean} muted the plan is not offered or could not be read
 * @property {string | undefined} title the backend's own words for a failure, as the line's tooltip
 * @property {string[]} warnings in the screen's words
 */

/**
 * The parallel-lanes plan for a burst a page is about to send (GET /api/wallets/:address/lanes/plan): "N lanes: P relay
 * passes, about S s; set aside X of balance Y" and its warnings in the screen's words (planWarningText), never the
 * API's. update(w) takes the page's query (null: nothing to plan, the element is hidden) and asks for it only when it
 * differs from the last one asked, or when that answer is PLAN_EVERY_MS old; otherwise it draws the answer it has. The
 * tickets cut and left count as part of the query: a cut or a spent ticket changes the plan's warnings at once.
 * Only the latest update draws. It never turns a button off: the backend decides.
 * @param {Api} api
 * @param {string} address
 * @param {HTMLElement} target
 * @param {(w: WalletView) => PlanQuery | null} query
 * @param {{ tickets?: import("./flows.js").TicketWords, everyMs?: number }} [opts] tickets: where this screen's tickets are
 */
export function planView(api, address, target, query, opts = {}) {
  const everyMs = opts.everyMs ?? PLAN_EVERY_MS;
  let drawn = 0;
  /** @type {{ key: string, at: number, drawing: Promise<PlanDrawing> } | null} the last query asked, when, and its answer */
  let last = null;
  /** @param {PlanQuery} q @param {WalletView} w @returns {Promise<PlanDrawing>} */
  const ask = async (q, w) => {
    try {
      const plan = readPlan(await api.lanesPlan(address, q));
      if (!plan) return { line: "not offered by this backend", muted: true, title: undefined, warnings: [] };
      const words = planWords(plan, q.n, w.balanceWei, opts.tickets);
      return { line: words.line, muted: false, title: undefined, warnings: words.warnings };
    } catch (e) {
      return { line: planFailureText(e), muted: true, title: errorText(e), warnings: [] };
    }
  };
  return {
    /** @param {WalletView} w */
    async update(w) {
      const q = query(w);
      const mine = ++drawn;
      if (!q) { target.hidden = true; target.replaceChildren(); return; }
      const key = JSON.stringify([q.n, q.mode, q.valueWei, q.to, w.tickets.exported, w.tickets.left]);
      if (!last || last.key !== key || Date.now() - last.at >= everyMs) last = { key, at: Date.now(), drawing: ask(q, w) };
      const d = await last.drawing;
      if (mine !== drawn) return; // a later update is drawing
      /** @type {Node[]} */
      const parts = [el("p", { class: d.muted ? "muted" : "num", text: d.line, title: d.title })];
      if (d.warnings.length) parts.push(el("ul", { class: "plan-warnings" }, ...d.warnings.map((x) => el("li", { text: x }))));
      target.replaceChildren(el("h4", { text: "Parallel-lanes plan" }), ...parts);
      target.hidden = false;
    },
  };
}

/**
 * @typedef {Object} MountOptions
 * @property {string} [empty] the lane board's line while it has no lane
 * @property {import("./api.js").Api} [api] the pages use the same-origin client; the tests pass their own
 * @property {boolean} [poll] false: no polling (the tests refresh by hand)
 */

/**
 * Mounts the shared parts on a screen page and starts polling. Null when there is no wallet to show.
 * @param {MountOptions} [opts]
 * @returns {Promise<Screen | null>}
 */
export async function mountScreen(opts = {}) {
  const api = opts.api ?? createApi();
  applyReviewAids();
  const banner = byId("banner"), head = byId("wallet-head"), notices = byId("notice"), status = byId("status");
  const setAsideEl = byId("set-aside"), issueEl = byId("device-issue");
  byId("lane-limits").textContent = LANE_LIMITS_TEXT;
  /** @type {WalletView | null} */
  let wallet = null;
  /** @type {DeviceIssue | null} */
  let issue = null;
  /** @type {TxRecord[]} */
  let records = [];
  /** @type {string | null} */
  let stalled = null;
  /** @type {ChainStatus | null} */
  let chain = null;
  let statusOffered = true;
  /** @type {string | null} */
  let statusError = null;
  /** @type {string | null} */
  let backendUrl = null;
  /** @type {string | null} */
  let pollError = null;
  /** @type {((w: WalletView) => void)[]} */
  const walletFns = [];
  /** @type {((r: TxRecord[]) => void)[]} */
  const recordFns = [];

  drawStatus();
  api.config().then((c) => { backendUrl = c.backendUrl; drawStatus(); }, () => {});

  /** @type {string | null} */
  let address;
  try {
    address = await pickWallet(api);
  } catch (e) {
    head.replaceChildren(el("p", { class: "error", text: `The backend could not list wallets: ${errorText(e)}` }));
    return null;
  }
  if (!address) {
    head.replaceChildren(el("p", {}, "No wallet yet. ", el("a", { href: "./", text: "Create one on the start page" }), "."));
    return null;
  }
  remember(REMEMBER, address);
  for (const a of document.querySelectorAll("a[data-keep-wallet]")) {
    if (a instanceof HTMLAnchorElement) a.href = `${a.getAttribute("href")?.split("?")[0]}?wallet=${encodeURIComponent(address)}`;
  }

  const board = createBoard(byId("lanes"), { empty: opts.empty ?? "No lanes yet: every transaction this wallet sends shows here." });
  const mempoolInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="mempool"]')]);
  for (const i of mempoolInputs) i.addEventListener("change", () => notice(mempoolNotice(mempool())));
  byId("banner-retry", HTMLButtonElement).addEventListener("click", () => setStalled(null));

  /**
   * The ticket device's trouble on the card, and the pages' cards drawn again so none offers a cut. Set from every
   * wallet view (tickets.unjournaled; a view without it clears it) and from every 409 device_unusable.
   * @param {DeviceIssue | null} next
   * @param {boolean} [redraw] the wallet listeners run again (not when a fresh view is about to reach them)
   */
  function setIssue(next, redraw = true) {
    const changed = (issue?.text ?? null) !== (next?.text ?? null);
    issue = next;
    issueEl.hidden = !issue;
    issueEl.textContent = issue?.text ?? "";
    if (changed && redraw && wallet) for (const f of walletFns) f(wallet);
  }

  /** @returns {Mempool} */
  function mempool() { return mempoolInputs.find((i) => i.checked)?.value === "public" ? "public" : "alt"; }

  /** @param {string | null} text */
  function setStalled(text) {
    stalled = text;
    banner.hidden = !text;
    byId("banner-text").textContent = text ?? "";
    updateSendable();
  }

  /** Sending is off while the chain is stalled or no wallet view has loaded; a pane may turn itself off (offline). */
  function updateSendable() {
    for (const fs of document.querySelectorAll("fieldset[data-sends]")) {
      if (fs instanceof HTMLFieldSetElement) fs.disabled = !!stalled || !wallet || fs.dataset.offline === "true";
    }
  }

  /** @param {string} text @param {"ok" | "error"} [tone] */
  function notice(text, tone = "ok") {
    notices.replaceChildren(el("span", { class: "when", text: formatClock(new Date().toISOString()) }), el("span", { class: tone === "error" ? "error" : undefined, text }));
  }

  function drawHead() {
    if (!wallet) return;
    const w = wallet;
    head.replaceChildren(el("dl", { class: "summary" },
      item("wallet", shortHex(w.address, 6, 4), { num: true, title: w.address }),
      item("balance", formatWei(w.balanceWei), { num: true, lead: true, title: formatWeiExact(w.balanceWei) }),
      item("epoch", String(w.epoch), { num: true }),
      item("leaves used", `${w.leavesUsed} of ${formatCount(w.leafCount)}`, { num: true }),
      item("lanes in flight", String(w.lanesInFlight), { num: true }),
      item("tickets", `${w.tickets.left} of ${w.tickets.exported}`, { num: true }),
      w.rotationPending ? item("rotation", "pending: sends wait") : null));
  }

  function drawStatus() {
    const parts = [el("span", { text: `backend ${backendUrl ?? "(via this server)"}` })];
    if (chain) {
      for (const words of statusWords(chain)) parts.push(el("span", { text: words }));
      // practice data only: an Ink band carries the warning (the band, not capitals)
      if (chain.fake) parts.push(el("strong", { class: "badge-fake", text: "Fake chain" }));
    } else if (!statusOffered) {
      parts.push(el("span", { class: "muted", text: "chain status: not offered by this backend" }));
    }
    if (statusError) parts.push(el("span", { class: "error", text: statusError }));
    if (pollError) parts.push(el("span", { class: "error", text: pollError }));
    status.replaceChildren(...parts);
  }

  async function loadWallet() {
    try {
      wallet = await api.wallet(/** @type {string} */ (address));
      pollError = null;
      setIssue(deviceIssue(wallet), false); // the view decides: tickets.unjournaled, or none
      drawHead();
      updateSendable();
      for (const f of walletFns) f(wallet);
    } catch (e) {
      pollError = `wallet: ${errorText(e)}`;
      const d = deviceIssueOf(e); // a device the backend cannot open fails the view itself
      if (d) setIssue(d);
      if (!wallet) head.replaceChildren(el("p", { class: "error", text: `This wallet could not be read: ${errorText(e)}` }));
    }
    drawStatus();
  }

  async function loadRecords() {
    try {
      records = await api.txs(/** @type {string} */ (address));
      pollError = null;
      board.render(laneRows(records));
      drawSetAside(setAsideEl, records, wallet);
      for (const f of recordFns) f(records);
    } catch (e) {
      pollError = `lane board: ${errorText(e)}`;
    }
    drawStatus();
  }

  /** GET /api/status: null while a backend without it answers 404, so it is asked again on every poll. */
  async function loadStatus() {
    try {
      const s = await api.status();
      statusError = null;
      statusOffered = s !== null;
      chain = readStatus(s);
      const text = statusBanner(chain);
      if (text && !stalled) setStalled(text);
      if (chain?.stalled === false && stalled) setStalled(null);
    } catch (e) {
      statusError = `chain status: ${errorText(e)}`;
    }
    drawStatus();
  }

  /** @type {ReturnType<typeof setTimeout>[]} one per poll, the latest */
  const timers = [];
  let stopped = false;
  /**
   * @param {() => Promise<void>} f
   * @param {number} ms
   */
  function every(f, ms) {
    const i = timers.length;
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) await f();
      if (!stopped) timers[i] = setTimeout(loop, ms);
    };
    timers.push(setTimeout(loop, ms));
  }

  /** The wallet first: the set-aside line needs its hot fee cap. */
  async function refresh() { await loadWallet(); await loadRecords(); }

  /**
   * What a failed action does: a 409 device_unusable goes on the cards at once (the refresh after it confirms or clears
   * it); a 503 (the chain is stalled) raises the banner and turns sending off; any other error goes to onError when
   * given, else to the notice line.
   * @param {unknown} e
   * @param {(e: unknown) => void} [onError]
   */
  function fail(e, onError) {
    const d = deviceIssueOf(e);
    if (d) setIssue(d);
    const text = stalledBanner(e);
    if (text) setStalled(text);
    else if (onError) onError(e);
    else notice(errorText(e), "error");
  }

  /**
   * Runs one action, the only way the screens send: refused while the chain is stalled; its button off while it
   * runs; a failure goes to fail(). Undefined when it failed.
   * @template T
   * @param {HTMLButtonElement | null} button
   * @param {() => Promise<T>} fn
   * @param {(e: unknown) => void} [onError]
   * @returns {Promise<T | undefined>}
   */
  async function run(button, fn, onError) {
    if (stalled) { notice(stalled, "error"); return undefined; }
    if (button) button.disabled = true;
    try {
      return await fn();
    } catch (e) {
      // the button back on before fail(): a card fail() draws again may turn it off (no cut while the device is unusable)
      if (button) button.disabled = false;
      button = null;
      fail(e, onError);
      return undefined;
    } finally {
      if (button) button.disabled = false;
      void refresh();
    }
  }

  updateSendable();
  await Promise.all([refresh(), loadStatus()]);
  if (opts.poll !== false) {
    every(loadRecords, TXS_MS);
    every(loadWallet, WALLET_MS);
    every(loadStatus, STATUS_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  }

  return {
    api, address,
    wallet: () => wallet,
    records: () => records,
    mempool,
    stalled: () => !!stalled,
    chain: () => chain,
    deviceIssue: () => issue,
    run, fail, notice, refresh,
    onWallet: (f) => { walletFns.push(f); if (wallet) f(wallet); },
    onRecords: (f) => { recordFns.push(f); f(records); },
    updateSendable,
    stop: () => { stopped = true; for (const t of timers) clearTimeout(t); board.stop(); },
  };
}

export { ApiError };
