// Companion page for the Winterlock MetaMask Flask Snap (snap/). It installs the local Snap in Flask, creates the
// post-quantum account through a factory call that your MetaMask account pays for, funds it, sends hash-signed
// transfers through the Snap or from MetaMask itself (the account is also a MetaMask ERC-4337 account; MetaMask posts
// its user operations to the local bundler), and lists each lane. Plain ES module, no build step. It talks to MetaMask Flask and, for
// the faucet only, to the devnet gateway; the seed and the journal of used leaves stay inside the Snap.

import { drawActivity } from "./activity.js";

export const SNAP_ID = "local:http://localhost:15191";
const DEVNET = Object.freeze({
  chainId: "0x539",
  chainName: "Alt mempool devnet",
  rpcUrls: ["https://altmempool.forshtat.com"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  blockExplorerUrls: ["https://explorer.altmempool.wtf"],
});
const EXPLORER = "https://explorer.altmempool.wtf";
const FAUCET_URL = "https://altmempoolgateway.forshtat.com/rpc";
const POLL_MS = 3_000;
const RECEIPT_POLL_MS = 2_000;
const RECEIPT_WAIT_MS = 180_000;
const FLASK_NEEDED = "MetaMask Flask is needed: local Snaps install only in Flask. In Brave, set Default Ethereum wallet to Extensions (no fallback).";
const LANES_WAIT = "Waiting for pending lanes: a MetaMask transaction now could push them out of the block.";
/** the local bundler MetaMask posts the account's user operations to (bundler/, and the Snap's BUNDLER_URL) */
const BUNDLER = "http://127.0.0.1:15192";
/** the devnet's tip floor (pipeline/src/config.ts, tipFloorFor): the Snap signs nothing below it */
const TIP_FLOOR_WEI = 3_000_000_000n;
const STATUS_WORDS = Object.freeze({ reserved: "signing", submitted: "pending", onchain: "included", burned: "burned" });
const WEI_PER_ETH = 10n ** 18n;

// ---- amounts and hex, without floats ----

/** "0.05" → 50000000000000000n. Digits and one point only, at most 18 decimals. */
export function parseEth(text) {
  const s = String(text ?? "").trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) throw new Error(`"${s}" is not an amount in ETH`);
  const frac = m[2] ?? "";
  if (frac.length > 18) throw new Error("An amount in ETH has at most 18 decimals");
  return BigInt(m[1] || "0") * WEI_PER_ETH + BigInt(frac.padEnd(18, "0"));
}

/** 50000000000000000n (or "50000000000000000", or hex) → "0.05 ETH", cut (never rounded up) to `decimals` places. */
export function formatEth(wei, decimals = 6) {
  if (wei === null || wei === undefined || wei === "") return "–";
  let w;
  try { w = BigInt(wei); } catch { return String(wei); }
  const a = w < 0n ? -w : w;
  const frac = (a % WEI_PER_ETH).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return `${w < 0n ? "-" : ""}${a / WEI_PER_ETH}${frac ? `.${frac}` : ""} ETH`;
}

export const short = (h, head = 6, tail = 4) =>
  typeof h === "string" && h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : String(h ?? "–");

const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isTxHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
function safeHref(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch { return null; }
}
/** A deadline in unix seconds (or milliseconds) as a local clock time. */
function clock(deadline) {
  const n = Number(deadline);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n > 1e12 ? n : n * 1000).toLocaleTimeString();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errText(e) {
  if (e && typeof e.message === "string" && e.message) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}
const rejected = (e) => e?.code === 4001;

// ---- MetaMask Flask and the Snap ----

const state = {
  eoa: null, // the MetaMask account, as MetaMask gives it
  eoaBalanceWei: null,
  network: null, // { chainId, ok, reason }: is MetaMask on this devnet (chain id and genesis)?
  tree: null, // winterlock_getAccount's answer
  account: null,
  accountBalanceWei: null,
  pendingAccount: null, // the predicted address of a creation not yet confirmed by the Snap
  following: 0,
  leaves: [],
  busy: null, // the flow running: "connect" | "network" | "faucet" | "create" | "fund" | "send" | "mm"
  polling: false,
  mmAdded: false, // the Snap's account is a MetaMask account (winterlock_status: metamask.added)
  bundler: null, // { ok, text }: the local bundler's health
};

/** The MetaMask EOA: the first connected account that is not the Winterlock account (both may be connected). */
function pickEoa(accounts) {
  const mine = state.account?.toLowerCase();
  return (accounts ?? []).find((a) => a.toLowerCase() !== mine) ?? null;
}

let latestPayment = null;
let flask = null; // the provider that announced itself as MetaMask Flask (EIP-6963); else window.ethereum
const eth = () => flask ?? globalThis.ethereum ?? null;
function need() {
  const p = eth();
  if (!p) { show("flask-missing", true); throw new Error(FLASK_NEEDED); }
  return p;
}
async function isFlask(p) {
  try { return /flask/i.test(String(await p.request({ method: "web3_clientVersion" }))); } catch { return false; }
}
const invoke = (method, params) =>
  need().request({ method: "wallet_invokeSnap", params: { snapId: SNAP_ID, request: params === undefined ? { method } : { method, params } } });

// ---- the page ----

const $ = (id) => document.getElementById(id);
function show(id, on) { $(id).hidden = !on; }
function setText(id, text, title) {
  const el = $(id);
  el.textContent = text;
  if (title === undefined || title === null) el.removeAttribute("title"); else el.title = String(title);
}
function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
/** One flow's line under its section: progress, the outcome with its explorer link, or the error. */
function say(id, text, kind = "info", href, linkText) {
  const el = $(id);
  el.hidden = !text;
  el.className = `result ${kind}`;
  el.replaceChildren(text ?? "");
  if (href) el.append(" ", link(href, linkText ?? href));
}

/** Runs one flow at a time; the buttons are off while it runs. */
async function run(kind, resultId, fn) {
  if (state.busy) return;
  state.busy = kind;
  render();
  try {
    await fn();
  } catch (e) {
    say(resultId, rejected(e) ? (kind === "send" || kind === "mm" ? "Rejected in Flask: no leaf was used." : "Rejected in Flask.") : errText(e), "error");
  } finally {
    state.busy = null;
    render();
  }
}

const lanesPending = () => state.following > 0 || state.leaves.some((l) => l.status === "submitted");

async function connect() {
  const p = need();
  if (!(await isFlask(p))) { show("flask-missing", true); throw new Error(FLASK_NEEDED); }
  show("flask-missing", false);
  say("connect-result", "Approve the Snap in Flask…");
  const installed = await p.request({ method: "wallet_requestSnaps", params: { [SNAP_ID]: {} } });
  const snap = installed?.[SNAP_ID];
  if (!snap || snap.error) throw new Error(`The Snap did not install: ${errText(snap?.error ?? "MetaMask did not answer for it")}`);
  const accounts = await p.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("MetaMask shared no account");
  state.eoa = pickEoa(accounts);
  await loadTree();
}

async function loadTree() {
  say("connect-result", "Building the key tree in the Snap…");
  const t = await invoke("winterlock_getAccount");
  state.tree = t;
  state.account = t?.account ?? null;
  state.accountBalanceWei = t?.balanceWei ?? null;
  if (state.account && state.eoa?.toLowerCase() === state.account.toLowerCase()) state.eoa = pickEoa(await need().request({ method: "eth_accounts" }));
  await checkNetwork();
  await refreshEoaBalance();
  if (state.account) await refreshStatus();
  const h = Number(t?.height);
  say("connect-result", Number.isFinite(h)
    ? `Connected. The Snap holds a tree of ${(2 ** h).toLocaleString("en-US")} one-time keys (height ${h}) for chain ${t.chainId}.`
    : "Connected.");
  startPolling();
}

/** Already connected and installed (a reload): pick up without a prompt. */
async function autoconnect() {
  const p = eth();
  if (!p || !(await isFlask(p))) { show("flask-missing", true); return; }
  try {
    const [accounts, snaps] = await Promise.all([p.request({ method: "eth_accounts" }), p.request({ method: "wallet_getSnaps" })]);
    if (!accounts?.length || !snaps?.[SNAP_ID]) { await checkNetwork(); return; }
    state.eoa = pickEoa(accounts);
  } catch {
    return; // not connected yet: the Connect button does it
  }
  await run("connect", "connect-result", loadTree);
}

/** Is MetaMask on this devnet? Chain id 1337, and, once the Snap has said it, the same genesis block. */
async function checkNetwork() {
  const p = eth();
  if (!p) return;
  try {
    const chainId = await p.request({ method: "eth_chainId" });
    if (chainId !== DEVNET.chainId) {
      state.network = { chainId, ok: false, reason: `MetaMask is on chain ${parseInt(chainId, 16)}, not the devnet: press Add devnet to Flask.` };
      return;
    }
    const genesis = state.tree?.genesis;
    if (genesis) {
      const block0 = await p.request({ method: "eth_getBlockByNumber", params: ["0x0", false] });
      if (String(block0?.hash).toLowerCase() !== String(genesis).toLowerCase()) {
        state.network = { chainId, ok: false, reason: `MetaMask's chain 1337 is another chain (genesis ${short(block0?.hash, 10, 6)}, the devnet's is ${short(genesis, 10, 6)}). In MetaMask, set that network's RPC URL to ${DEVNET.rpcUrls[0]}.` };
        return;
      }
    }
    state.network = { chainId, ok: true, reason: "" };
  } catch (e) {
    state.network = { chainId: null, ok: false, reason: `Could not read MetaMask's network: ${errText(e)}` };
  }
}

async function refreshEoaBalance() {
  if (!state.eoa || !state.network?.ok) { state.eoaBalanceWei = null; return; }
  try {
    state.eoaBalanceWei = BigInt(await need().request({ method: "eth_getBalance", params: [state.eoa, "latest"] }));
  } catch {
    state.eoaBalanceWei = null;
  }
}

async function addDevnet() {
  const p = need();
  say("connect-result", "Approve the devnet in Flask…");
  await p.request({ method: "wallet_addEthereumChain", params: [DEVNET] });
  await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: DEVNET.chainId }] });
  await checkNetwork();
  await refreshEoaBalance();
  if (state.network?.ok) say("connect-result", "MetaMask is on the devnet.");
  else say("connect-result", state.network?.reason ?? "MetaMask is not on the devnet.", "error");
}

/** Every MetaMask transaction (create, fund) must go to this devnet, never to whatever network MetaMask shows. */
async function ensureDevnet() {
  await checkNetwork();
  if (state.network?.ok) return;
  if (state.network?.chainId !== DEVNET.chainId) {
    const p = need();
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: DEVNET.chainId }] });
    } catch (e) {
      if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
      await p.request({ method: "wallet_addEthereumChain", params: [DEVNET] }); // not known to MetaMask yet
    }
    await checkNetwork();
  }
  if (!state.network?.ok) throw new Error(state.network?.reason || "MetaMask is not on the devnet.");
}

async function faucet() {
  if (!state.eoa) throw new Error("Connect Flask first: the faucet pays your MetaMask account.");
  say("connect-result", "Asking the faucet…");
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_explorer_faucet", params: [state.eoa] }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`The faucet answered HTTP ${res.status} with no JSON.`);
  if (body.error) throw new Error(`Faucet: ${errText(body.error)}`);
  const r = body.result;
  if (isTxHash(r)) say("connect-result", "Faucet paid:", "info", txUrl(r), short(r, 10, 6));
  else say("connect-result", `Faucet answered: ${typeof r === "string" ? r : JSON.stringify(r)}`);
}

async function waitReceipt(hash, hint) {
  const until = Date.now() + RECEIPT_WAIT_MS;
  while (Date.now() < until) {
    const r = await need().request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) return r;
    await sleep(RECEIPT_POLL_MS);
  }
  throw new Error(`Not mined after ${RECEIPT_WAIT_MS / 1000} s. ${hint}`);
}

async function createAccount() {
  if (!state.eoa || !state.tree) throw new Error("Connect Flask first.");
  if (lanesPending()) throw new Error(LANES_WAIT);
  await ensureDevnet();
  say("account-result", "The Snap is preparing the factory call…");
  const prep = await invoke("winterlock_prepareAccount", { owner: state.eoa.toLowerCase() });
  if (!isAddress(prep?.address) || !isAddress(prep?.factory) || !/^0x[0-9a-fA-F]*$/.test(String(prep?.data))) {
    throw new Error("The Snap's winterlock_prepareAccount answer is not { factory, data, address, gas }.");
  }
  state.pendingAccount = prep.address;
  say("account-result", "Confirm account creation in Flask…");
  const tx = { from: state.eoa, to: prep.factory, data: prep.data, ...(prep.gas ? { gas: prep.gas } : {}), ...(await devnetFees()) };
  const hash = await need().request({ method: "eth_sendTransaction", params: [tx] });
  say("account-result", "Creation sent, waiting for its block:", "info", txUrl(hash), short(hash, 10, 6));
  const receipt = await waitReceipt(hash, `When the explorer shows ${short(hash, 10, 6)} included, press Check account.`);
  if (receipt.status !== "0x1") throw new Error(`The creation transaction ${hash} failed on chain (status ${receipt.status}).`);
  say("account-result", "Created. The Snap is checking the account's code and root…", "info", txUrl(hash), short(hash, 10, 6));
  await useAccount(prep.address);
  say("account-result", "Account ready. Created by", "info", txUrl(hash), short(hash, 10, 6));
}

/** The Snap checks the address's code and root on chain before it signs anything for it. */
async function useAccount(address) {
  if (!isAddress(address)) throw new Error("No account address to check.");
  const r = await invoke("winterlock_useAccount", { address: address.toLowerCase() });
  state.account = r?.account ?? address.toLowerCase();
  state.accountBalanceWei = r?.balanceWei ?? null;
  state.pendingAccount = null;
  await refreshStatus();
  startPolling();
}

async function fund() {
  if (!state.account) throw new Error("Create the account first.");
  if (lanesPending()) throw new Error(LANES_WAIT);
  const wei = parseEth($("fund-amount").value);
  if (wei <= 0n) throw new Error("The amount must be above 0.");
  await ensureDevnet();
  say("account-result", `Confirm the ${formatEth(wei, 18)} transfer in Flask…`);
  const hash = await need().request({ method: "eth_sendTransaction", params: [{ from: state.eoa, to: state.account, value: `0x${wei.toString(16)}`, gas: "0x186a0", ...(await devnetFees()) }] });
  say("account-result", "Funding sent, waiting for its block:", "info", txUrl(hash), short(hash, 10, 6));
  const receipt = await waitReceipt(hash, "The balance updates when it lands.");
  if (receipt.status !== "0x1") throw new Error(`The funding transaction ${hash} failed on chain (status ${receipt.status}).`);
  say("account-result", "Funded:", "info", txUrl(hash), short(hash, 10, 6));
  await refreshStatus();
}

async function send() {
  if (!state.account) throw new Error("Create the account first.");
  const to = $("send-to").value.trim();
  if (!isAddress(to)) throw new Error("To must be an address: 0x and 40 hex digits.");
  if (to.toLowerCase() === state.account.toLowerCase()) throw new Error("A send to the account itself is an admin call: pick another address.");
  const wei = parseEth($("send-amount").value);
  say("send-result", "Confirm in Flask: the Winterlock Snap names the leaf it will use…");
  const r = await invoke("winterlock_send", { to: to.toLowerCase(), valueWei: wei.toString() });
  if (Number.isInteger(r?.leaf) && isTxHash(r?.txHash) && /^0x[0-9a-fA-F]+$/.test(String(r?.nonceKey))) latestPayment = { txHash: r.txHash, leaf: r.leaf, nonceKey: r.nonceKey };
  const href = safeHref(r?.explorerUrl) ?? (isTxHash(r?.txHash) ? txUrl(r.txHash) : null);
  const deadline = clock(r?.deadline);
  say("send-result", `Submitted on leaf ${r?.leaf}, nonce key ${r?.nonceKey}${deadline ? `, deadline ${deadline}` : ""}:`, "info", href, short(r?.txHash, 10, 6));
  await refreshStatus();
}

/**
 * Fee fields for a MetaMask transaction on the devnet: the 3 gwei tip and twice the base fee on top. Flask cannot
 * estimate fees on this custom network (its confirmation stays disabled, Nov 6), and its ERC-4337 path refuses a send
 * without them, so every transaction the page asks for carries them.
 */
async function devnetFees() {
  const head = await need().request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  const base = BigInt(head?.baseFeePerGas ?? "0x0");
  return { maxPriorityFeePerGas: `0x${TIP_FLOOR_WEI.toString(16)}`, maxFeePerGas: `0x${(2n * base + TIP_FLOOR_WEI).toString(16)}` };
}

/** Is the local bundler up, on this chain? */
async function checkBundler() {
  try {
    const res = await fetch(`${BUNDLER}/health`, { cache: "no-store" });
    const h = await res.json();
    state.bundler = h?.chainId === "1337"
      ? { ok: true, text: `Bundler: running at ${BUNDLER}, ${Array.isArray(h.ops) ? h.ops.length : 0} user operation(s) so far` }
      : { ok: false, text: `Bundler at ${BUNDLER} is on chain ${h?.chainId}, not 1337` };
  } catch {
    state.bundler = { ok: false, text: "Bundler: not running. Start it: cd bundler && bun src/main.ts" };
  }
}

/** Adds the Snap's account to MetaMask (Flask asks to confirm), then connects it to this page. */
async function addToMetaMask() {
  if (!state.account) throw new Error("Create the account first.");
  await ensureDevnet();
  if (!state.mmAdded) {
    say("mm-result", "Confirm the new account in Flask…");
    await need().request({ method: "wallet_invokeKeyring", params: { snapId: SNAP_ID, request: { method: "keyring_createAccount", params: { options: {} } } } });
    await refreshStatus();
  }
  say("mm-result", "In Flask, edit the accounts, tick the Winterlock account (keep your funding account), then connect…");
  await need().request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  const accounts = await need().request({ method: "eth_accounts" });
  if (!accounts.some((a) => a.toLowerCase() === state.account.toLowerCase())) throw new Error("The Winterlock account is not connected to this page: press the button again and tick it.");
  state.eoa = pickEoa(accounts) ?? state.eoa;
  say("mm-result", `The Winterlock account ${short(state.account, 10, 6)} is a MetaMask account, connected here.`);
}

/**
 * A plain eth_sendTransaction from the Winterlock account, with the fee fields (devnetFees). Flask asks the Snap to
 * prepare and sign a user operation and posts it to the local bundler; it answers once the bundler reports inclusion.
 */
async function sendFromMetaMask() {
  if (!state.account) throw new Error("Create the account first.");
  if (!state.mmAdded) throw new Error("Press Add to MetaMask first.");
  await checkBundler();
  if (!state.bundler?.ok) throw new Error(state.bundler?.text ?? "The bundler is not running.");
  const to = $("mm-to").value.trim();
  if (!isAddress(to)) throw new Error("To must be an address: 0x and 40 hex digits.");
  if (to.toLowerCase() === state.account.toLowerCase()) throw new Error("A send to the account itself is an admin call: pick another address.");
  const wei = parseEth($("mm-amount").value);
  await ensureDevnet();
  const accounts = await need().request({ method: "eth_accounts" });
  const from = accounts.find((a) => a.toLowerCase() === state.account.toLowerCase());
  if (!from) throw new Error("The Winterlock account is not connected to this page: press Add to MetaMask.");
  const tx = { from, to: to.toLowerCase(), value: `0x${wei.toString(16)}`, ...(await devnetFees()) };
  say("mm-result", "Confirm in Flask. It then asks the Snap to sign one fresh leaf, and waits for the bundler's receipt…");
  const hash = await need().request({ method: "eth_sendTransaction", params: [tx] });
  say("mm-result", "Included, sent from MetaMask:", "info", txUrl(hash), short(hash, 10, 6));
  await refreshStatus();
}

async function refreshStatus() {
  const s = await invoke("winterlock_status");
  state.mmAdded = Boolean(s?.metamask?.added);
  if (s?.account) state.account = s.account;
  if (s && "balanceWei" in s) state.accountBalanceWei = s.balanceWei;
  const f = s?.following;
  state.following = Array.isArray(f) ? f.length : Number(f) || 0;
  state.leaves = Array.isArray(s?.leaves) ? s.leaves : [];
}

/** Every 3 s once connected: the balances and the Snap's lanes. Each status call also keeps the Snap alive. */
function startPolling() {
  if (state.polling) return;
  state.polling = true;
  const tick = async () => {
    try {
      if (state.busy !== "send") { // a send's dialog may be open: don't queue behind it
        await refreshEoaBalance();
        if (state.account) await refreshStatus();
        await checkBundler();
        $("poll").textContent = `Read at ${new Date().toLocaleTimeString()}, every ${POLL_MS / 1000} s.`;
      }
    } catch (e) {
      $("poll").textContent = `Could not read the Snap: ${errText(e)}`;
    } finally {
      render();
      setTimeout(tick, POLL_MS);
    }
  };
  setTimeout(tick, POLL_MS);
}

function render() {
  const busy = Boolean(state.busy);
  const connected = Boolean(state.eoa && state.tree);
  const pending = lanesPending();
  const net = state.network;
  $("connect").disabled = busy;
  $("add-devnet").disabled = busy;
  $("faucet").disabled = busy || !state.eoa;
  setText("eoa", state.eoa ?? "not connected");
  if (!state.eoa) setText("eoa-balance", "–");
  else if (!net?.ok) setText("eoa-balance", "switch Flask to the devnet");
  else setText("eoa-balance", formatEth(state.eoaBalanceWei), state.eoaBalanceWei === null ? undefined : formatEth(state.eoaBalanceWei, 18));
  setText("network", !net ? "–" : net.ok ? `${DEVNET.chainName} (chain 1337)` : net.reason);
  const t = state.tree;
  const h = Number(t?.height);
  setText("tree", t && Number.isFinite(h) ? `height ${h}, ${(2 ** h).toLocaleString("en-US")} leaves` : "–");
  setText("root", t?.root ? short(t.root, 10, 8) : "–", t?.root);
  setText("chain", t?.chainId ? String(t.chainId) : "–");

  show("no-account", !state.account);
  show("has-account", Boolean(state.account));
  $("create").disabled = busy || !connected || pending;
  show("check-account", Boolean(state.pendingAccount) && !state.account);
  $("check-account").disabled = busy;
  if (state.account) {
    const a = $("account-link");
    a.href = `${EXPLORER}/address/${state.account}`;
    a.textContent = state.account;
    const b = state.accountBalanceWei;
    setText("account-balance", formatEth(b), b === null || b === undefined ? undefined : formatEth(b, 18));
  }
  $("fund").disabled = busy || pending;
  show("lanes-wait", connected && pending);
  $("send").disabled = busy || !state.account;
  $("mm-add").disabled = busy || !state.account;
  $("mm-add").textContent = state.mmAdded ? "Connect to this page" : "Add to MetaMask";
  $("mm-send").disabled = busy || !state.account || !state.mmAdded || !state.bundler?.ok;
  setText("bundler", state.bundler?.text ?? "Bundler: –");
  renderSetup(connected, busy);
  renderLanes();
}

// Presentation follows the existing connection/account state. It performs no wallet or network request.
function renderSetup(connected, busy) {
  const account = Boolean(state.account);
  const balanceKnown = state.accountBalanceWei !== null && state.accountBalanceWei !== undefined;
  const zeroBalance = account && balanceKnown && BigInt(state.accountBalanceWei) === 0n;
  setText("connection-state", connected ? "Flask connected" : "Flask required");
  setText("s2", account ? "Your Winterlock account" : "Create your account");
  const active = !connected ? "connect" : !account ? "account" : "send";
  for (const phase of document.querySelectorAll("[data-phase]")) {
    const name = phase.dataset.phase;
    phase.classList.toggle("active", name === active);
    phase.classList.toggle("done", name === "connect" ? connected : name === "account" ? account : false);
    if (name === active) phase.setAttribute("aria-current", "step"); else phase.removeAttribute("aria-current");
  }
  const labels = {
    connect: ["connect", connected ? "Reconnect Flask" : "Connect Flask", "Connecting to Flask…"],
    create: ["create", "Create account using Flask", "Preparing account…"],
    fund: ["fund", "Fund from Flask", "Funding account…"],
    send: ["send", "Send with Winterlock Snap", "Submitting payment…"],
    faucet: ["faucet", "Get 1 test ETH", "Requesting test ETH…"],
    network: ["add-devnet", "Add devnet to Flask", "Setting up devnet…"],
  };
  for (const [kind, [id, idle, working]] of Object.entries(labels)) {
    const button = $(id);
    button.textContent = state.busy === kind ? working : idle;
    if (state.busy === kind) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
  }
  if (zeroBalance) $("send").disabled = true;
  setText("send-readiness", !account ? "Create and fund your Winterlock account before sending." : zeroBalance ? "Add ETH from Flask to cover your payment and transaction fees." : !balanceKnown ? "Balance unavailable. Review the funds and fees in Flask before confirming." : "Ready to send. The Winterlock Snap signs this payment.");
  $("send-readiness").classList.toggle("ready", account && balanceKnown && !zeroBalance && !busy);
  const current = state.leaves.find((l) => l.txHash === latestPayment?.txHash)
    ?? (!latestPayment ? state.leaves.find((l) => l.status === "submitted") : null);
  const shown = current ?? latestPayment;
  if (shown) {
    const status = current?.status ?? "submitted";
    const stateKey = status === "onchain" ? "included" : status === "burned" ? "refused" : "admitted";
    const heading = status === "onchain" ? "Lane included" : status === "burned" ? "Ticket burned" : status === "reserved" ? "Signing in the Snap" : "Payment pending";
    const href = safeHref(current?.explorerUrl) ?? (isTxHash(shown.txHash) ? txUrl(shown.txHash) : null);
    drawActivity($("snap-activity"), { state: stateKey, heading, leaf: shown.leaf, lane: String(shown.nonceKey ?? "—"),
      steps: status === "onchain" ? ["Submitted", "Included"] : status === "burned" ? ["Burned"] : status === "reserved" ? ["Signing"] : ["Submitted", "Pending"],
      note: current?.note ? String(current.note) : undefined, href: href ?? undefined });
  } else drawActivity($("snap-activity"), null);
}

function renderLanes() {
  const body = $("lanes");
  const cell = (content, className) => {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.append(content);
    return td;
  };
  if (!state.leaves.length) {
    const td = cell("No sends yet.", "empty");
    td.colSpan = 4;
    const tr = document.createElement("tr");
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(...state.leaves.map((l) => {
    const tr = document.createElement("tr");
    const st = document.createElement("span");
    st.className = `st st-${String(l.status).replace(/[^a-z]/g, "")}`;
    st.textContent = STATUS_WORDS[l.status] ?? String(l.status ?? "unknown");
    const notes = [];
    if (l.status === "submitted" && l.deadline) notes.push(`deadline ${clock(l.deadline)}`);
    if (l.note) notes.push(String(l.note));
    if (notes.length) st.title = notes.join("; ");
    const status = cell(st);
    if (l.via === "MetaMask") {
      const via = document.createElement("span");
      via.className = "why";
      via.textContent = "from MetaMask";
      status.append(via);
    }
    if (l.status === "burned" && l.note) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = String(l.note);
      status.append(why);
    }
    const href = safeHref(l.explorerUrl) ?? (isTxHash(l.txHash) ? txUrl(l.txHash) : null);
    const tx = href ? link(href, short(l.txHash ?? href, 10, 6)) : "–";
    tr.append(cell(String(l.leaf)), cell(String(l.nonceKey ?? "–")), status, cell(tx));
    return tr;
  }));
}

function init() {
  // EIP-6963: in a browser with several wallets (Brave's own, say), talk to Flask, not whichever won window.ethereum.
  addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (d?.info?.rdns === "io.metamask.flask" && d.provider) flask = d.provider;
  });
  dispatchEvent(new Event("eip6963:requestProvider"));

  $("connect").addEventListener("click", () => run("connect", "connect-result", connect));
  $("add-devnet").addEventListener("click", () => run("network", "connect-result", addDevnet));
  $("faucet").addEventListener("click", () => run("faucet", "connect-result", faucet));
  $("create").addEventListener("click", () => run("create", "account-result", createAccount));
  $("check-account").addEventListener("click", () => run("create", "account-result", async () => {
    say("account-result", "The Snap is checking the account's code and root…");
    await useAccount(state.pendingAccount);
    say("account-result", "Account ready.");
  }));
  $("fund-form").addEventListener("submit", (ev) => { ev.preventDefault(); run("fund", "account-result", fund); });
  $("send-form").addEventListener("submit", (ev) => { ev.preventDefault(); run("send", "send-result", send); });
  $("mm-add").addEventListener("click", () => run("mm", "mm-result", addToMetaMask));
  $("mm-form").addEventListener("submit", (ev) => { ev.preventDefault(); run("mm", "mm-result", sendFromMetaMask); });
  checkBundler().finally(render);

  const p = eth();
  if (p?.on) {
    p.on("chainChanged", () => { checkNetwork().then(refreshEoaBalance).finally(render); });
    p.on("accountsChanged", (accounts) => { state.eoa = pickEoa(accounts); refreshEoaBalance().finally(render); });
  }
  render();
  autoconnect().finally(render);
}

if (typeof document !== "undefined") init();
