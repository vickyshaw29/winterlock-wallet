// Start page: lists the backend's wallets with links to the three screens, remembers the one picked, and creates a
// wallet from the form (POST /api/wallets). Written with Claude Code (AI) for Vicky.
import { createApi } from "./api.js";
import { byId, el } from "./dom.js";
import { createWalletBody, errorText, readStatus, statusBanner, statusWords } from "./flows.js";
import { formatClock, formatWei, formatWeiExact } from "./format.js";

/** @import { WalletSummary } from "./api.js" */

const api = createApi();
const list = byId("wallets"), notice = byId("notice");
const REMEMBER = "winterlock.wallet";

/** @param {string} text @param {boolean} [bad] */
function say(text, bad = false) {
  notice.replaceChildren(el("span", { class: "mono when", text: formatClock(new Date().toISOString()) }), el("span", { class: bad ? "error" : undefined, text }));
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
  let last = null;
  try { last = localStorage.getItem(REMEMBER); } catch { /* private window */ }
  list.replaceChildren(...wallets.map((w) => {
    const q = `?wallet=${encodeURIComponent(w.address)}`;
    return el("li", {},
      el("div", { class: "kv" }, el("dt", { text: w.address.toLowerCase() === last?.toLowerCase() ? "wallet, picked last" : "wallet" }),
        el("dd", { class: "mono", text: w.address })),
      el("span", { class: "mono", title: `balance ${formatWeiExact(w.balanceWei)}`, text: `${formatWei(w.balanceWei)} · epoch ${w.epoch} · height ${w.height}` }),
      el("span", { class: "links" },
        ...[["hot-cold.html", "Hot and cold"], ["agent.html", "Agent"], ["session.html", "Session"]].map(([href, text]) =>
          el("a", { href: `${href}${q}`, text, onclick: () => pick(w.address) }))));
  }));
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
  try { parts.push(el("span", { class: "mono", text: `backend ${(await api.config()).backendUrl}` })); } catch { /* shown below */ }
  try {
    const s = readStatus(await api.status());
    if (!s) parts.push(el("span", { class: "muted", text: "chain status: not offered by this backend" }));
    else {
      for (const words of statusWords(s)) parts.push(el("span", { class: "mono", text: words }));
      if (s.fake) parts.push(el("strong", { class: "badge-fake", text: "FAKE CHAIN" }));
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

void load();
void status();
