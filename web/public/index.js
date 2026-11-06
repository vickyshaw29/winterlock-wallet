// Start page (Ledger direction): the backend's wallets as account lines with links to the three screens, the one picked
// remembered, and the create form (POST /api/wallets). Runs start() on load; the tests run it on a fake document.
// Written with Claude Code (AI) for Vicky.
import { createApi } from "./api.js";
import { byId, el, item } from "./dom.js";
import { createWalletBody, errorText, readStatus, statusBanner, statusWords } from "./flows.js";
import { formatClock, formatWei, formatWeiExact, shortHex } from "./format.js";
import { applyReviewAids } from "./ui.js";

/** @import { Api, WalletSummary } from "./api.js" */

const REMEMBER = "winterlock.wallet";
const SCREENS = /** @type {const} */ ([["hot-cold.html", "Hot and cold"], ["agent.html", "Agent"], ["session.html", "Session"]]);

/**
 * One wallet as an account line: its address, balance, epoch and height as facts (labels in Print, figures in Ink),
 * then a link to each screen. Each link's name says which wallet it opens, for a screen reader's list of links.
 * @param {WalletSummary} w
 * @param {boolean} picked the wallet picked last, which the screens open with
 * @param {(address: string) => void} onPick
 */
export function walletLine(w, picked, onPick) {
  const q = `?wallet=${encodeURIComponent(w.address)}`;
  return el("li", { class: picked ? "picked" : undefined },
    el("dl", { class: "summary" },
      item(picked ? "wallet, picked last" : "wallet", w.address, { num: true }),
      item("balance", formatWei(w.balanceWei), { num: true, title: `balance ${formatWeiExact(w.balanceWei)}` }),
      item("epoch", String(w.epoch), { num: true }),
      item("height", String(w.height), { num: true })),
    el("p", { class: "links" }, ...SCREENS.map(([href, text]) =>
      el("a", { href: `${href}${q}`, text, "aria-label": `${text}, wallet ${shortHex(w.address, 6, 4)}`, onclick: () => onPick(w.address) }))));
}

/**
 * Lists the wallets, draws the status line and wires the create form.
 * @param {{ api?: Api }} [opts] the page uses the same-origin client; the tests pass their own
 */
export async function start(opts = {}) {
  applyReviewAids(); // ?theme=dark|light, ?motion=reduce
  const api = opts.api ?? createApi();
  const list = byId("wallets"), notice = byId("notice");

  /** @param {string} text @param {boolean} [bad] */
  function say(text, bad = false) {
    notice.replaceChildren(el("span", { class: "when", text: formatClock(new Date().toISOString()) }), el("span", { class: bad ? "error" : undefined, text }));
  }

  /** @param {string} address */
  function pick(address) {
    try { localStorage.setItem(REMEMBER, address); } catch { /* private window */ }
    for (const a of document.querySelectorAll("a[data-keep-wallet]")) {
      if (a instanceof HTMLAnchorElement) a.href = `${a.getAttribute("href")?.split("?")[0]}?wallet=${encodeURIComponent(address)}`;
    }
  }

  /** @param {WalletSummary[]} wallets */
  function draw(wallets) {
    if (wallets.length === 0) {
      list.replaceChildren(el("li", { class: "muted", text: "No wallet yet: create one." }));
      return;
    }
    /** @type {string | null} */
    let last = null;
    try { last = localStorage.getItem(REMEMBER); } catch { /* private window */ }
    list.replaceChildren(...wallets.map((w) => walletLine(w, w.address.toLowerCase() === last?.toLowerCase(), pick)));
    const remembered = wallets.find((w) => w.address.toLowerCase() === last?.toLowerCase()) ?? wallets[0];
    if (remembered) pick(remembered.address);
  }

  async function load() {
    try { draw(await api.listWallets()); } catch (e) {
      list.replaceChildren(el("li", { class: "error", text: `The backend could not list wallets: ${errorText(e)}` }));
    }
  }

  async function status() {
    const parts = [];
    try { parts.push(el("span", { text: `backend ${(await api.config()).backendUrl}` })); } catch { /* shown below */ }
    try {
      const s = readStatus(await api.status());
      if (!s) parts.push(el("span", { class: "muted", text: "chain status: not offered by this backend" }));
      else {
        for (const words of statusWords(s)) parts.push(el("span", { text: words }));
        if (s.fake) parts.push(el("strong", { class: "badge-fake", text: "Fake chain" })); // practice data only
        const stalled = statusBanner(s);
        if (stalled) parts.push(el("span", { class: "error", text: stalled }));
      }
    } catch (e) { parts.push(el("span", { class: "error", text: errorText(e) })); }
    byId("status").replaceChildren(...parts);
  }

  byId("create-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = byId("create", HTMLButtonElement);
    const value = (/** @type {string} */ id) => byId(id, HTMLInputElement).value;
    btn.disabled = true;
    say("Creating: a new seed, its tree, and the account by the backend's EOA. This waits for a mined transaction.");
    try {
      const body = createWalletBody({ height: value("c-height"), valueCap: value("c-cap"), feeCap: value("c-fee"), allowedTarget: value("c-target"), hotStart: value("c-start") });
      const r = await api.createWallet(body);
      pick(r.address);
      say(`Created ${r.address} at epoch ${r.epoch}${r.funded ? ", funded" : ", not funded yet: fund it another way"}.`);
      await load();
    } catch (e) {
      say(errorText(e), true);
    } finally {
      btn.disabled = false;
    }
  });

  await Promise.all([load(), status()]);
  return { load };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
