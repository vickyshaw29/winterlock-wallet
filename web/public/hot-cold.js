// Hot and cold screen (spec, Use cases), in the Ledger direction (design note 1-ledger.md): the cold device's book (the
// key register, the tree's facts, its four forms, which fold below 600 px) and the phone's next ticket (its serial, the
// allowed target, the amount, the caps, the machine line), the count and the stub strip, over the lane board; Play scene.
// Written with Claude Code (AI) for Vicky.
//   A ticket tears off when the device has spent it: Pay or the stuck payment answered (admitted, or refused with its
//   leaf burned), each hot payment of Play scene, and the retry the backend sends by itself after an expiry. The count
//   and the serial roll on the redraw right after; on a plain poll they just change.
import { ApiError } from "./api.js";
import { byId, el, item } from "./dom.js";
import {
  STUCK, checkHotAmount, coldTransferBody, cutTickets, errorText, payBody, rotateRoot, send, setPolicy, stuckBody, uncutHotLeaves,
} from "./flows.js";
import { formatCount, formatWei, formatWeiExact, isAddress, parseEth, shortHex, weiToEthInput } from "./format.js";
import { createRegister, createStubStrip, leafStates, nextTicket, rollNumber, stubsOf, tearTicket } from "./register.js";
import { hotColdScene } from "./scenes.js";
import { drawSetAside, mountScreen } from "./ui.js";

/** @import { Api, TxRecord, WalletView } from "./api.js" */
/** @import { DeviceIssue } from "./flows.js" */
/** @import { LeafState } from "./register.js" */
/** @import { MountOptions } from "./ui.js" */

/** Below 600 px the cold device's four forms fold into sections, closed on a phone (Vicky, Nov 6). */
export const FOLD_QUERY = "(max-width: 599px)";
/** How long after an action its redraw rolls the count and the serial (the action's refresh lands well inside it). */
const ROLL_MS = 4_000;

/** @param {number} n */
const leaves = (n) => `${n} hot ${n === 1 ? "leaf" : "leaves"}`;

/**
 * The lane a leaf signs on: its nonce key, (epoch << 32) | leaf (spec, Shared interfaces 3).
 * @param {number} epoch
 * @param {number} leaf
 */
export const laneOf = (epoch, leaf) => `0x${((BigInt(epoch) << 32n) | BigInt(leaf)).toString(16)}`;

/**
 * Hot leaves the cold device can still cut. The backend cuts contiguously from where the device's band ends (the
 * epoch's first cut from the lowest free hot leaf), so these are the untouched hot-band leaves after the band. A view
 * without `leaves` (an older backend) falls back to the totals, flows.uncutHotLeaves.
 * @param {Pick<WalletView, "leafCount" | "hotStart" | "tickets"> & { leaves?: WalletView["leaves"] }} w
 * @param {readonly LeafState[]} states from leafStates
 */
export function uncutOf(w, states) {
  if (!w.leaves) return uncutHotLeaves(w);
  const from = w.leaves.tickets ? w.leaves.tickets.to + 1 : w.hotStart;
  let n = 0;
  for (let i = from; i < states.length; i++) if (states[i] === "hot") n++;
  return n;
}

/**
 * @typedef {Object} TicketFace what the ticket prints
 * @property {string} serial the next ticket's leaf, or why there is none
 * @property {boolean} empty no ticket to sign: the serial is printed in Print, not red
 * @property {{ lane: string, chainId: number | null, wallet: string } | null} machine the machine line's three groups
 * @property {string} words the machine line for a screen reader, or the line printed instead of it
 */

/**
 * What the ticket prints: the ticket the device signs next (its lowest still on the phone, as the backend picks it),
 * its lane, the chain and the wallet; or why no ticket can be signed. Pure.
 * @param {Pick<WalletView, "address" | "epoch" | "tickets"> & { leaves?: WalletView["leaves"] }} w
 * @param {readonly LeafState[]} states from leafStates
 * @param {DeviceIssue | null} issue the ticket device cannot sign
 * @param {number | null} chainId from GET /api/status (screen.chain()); null when not known
 * @returns {TicketFace}
 */
export function ticketFace(w, states, issue, chainId) {
  if (issue) return { serial: "none", empty: true, machine: null, words: "No ticket can be signed until the device journal is recovered." };
  if (w.tickets.exported === 0) return { serial: "none yet", empty: true, machine: null, words: "No ticket yet: cut some on the cold device." };
  // a backend without the leaves field does not say which ticket is next: no serial is guessed
  if (!w.leaves) return { serial: "—", empty: false, machine: null, words: "This backend does not say which ticket is next." };
  const next = nextTicket(w, states);
  if (next === null) return { serial: "none left", empty: true, machine: null, words: "No ticket left: cut some on the cold device." };
  const lane = laneOf(w.epoch, next);
  const chain = chainId === null ? "" : `, chain ${chainId}`;
  return {
    serial: String(next), empty: false, machine: { lane, chainId, wallet: w.address },
    words: `This ticket pays on lane ${lane}${chain}, from wallet ${shortHex(w.address, 6, 4)}.`,
  };
}

// ------------------------------------------------------------------ the machine line's symbols

const SVG = "http://www.w3.org/2000/svg";
/**
 * The two symbols of the line printed at the foot of a cheque, drawn as bars (no self-hosted font has them): on-us
 * closes the lane and the wallet, transit brackets the chain. [x, y, width, height] in a 14-high box.
 */
const SYMBOLS = {
  onUs: { box: "0 0 12 14", bars: [[0, 4, 3, 6], [5, 0, 2, 14], [9, 4, 3, 6]] },
  transit: { box: "0 0 10 14", bars: [[0, 0, 2.5, 14], [5, 1, 5, 5], [5, 8, 5, 5]] },
};

/** @param {keyof typeof SYMBOLS} kind */
function symbol(kind) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", SYMBOLS[kind].box);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  for (const [x, y, w, h] of SYMBOLS[kind].bars) {
    const r = document.createElementNS(SVG, "rect");
    r.setAttribute("x", String(x)); r.setAttribute("y", String(y)); r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
    s.append(r);
  }
  return s;
}

/**
 * The machine line: ⑈lane⑈  ⑆chain⑆  wallet⑈, printed wide; a screen reader gets the sentence instead.
 * @param {HTMLElement} line
 * @param {TicketFace} face
 */
function drawMachine(line, face) {
  if (!face.machine) { line.replaceChildren(el("span", { class: "machine-empty", text: face.words })); return; }
  const m = face.machine;
  const parts = [el("span", { "aria-hidden": "true" }, symbol("onUs"), m.lane, symbol("onUs"))];
  if (m.chainId !== null) parts.push(el("span", { "aria-hidden": "true" }, symbol("transit"), String(m.chainId), symbol("transit")));
  parts.push(el("span", { "aria-hidden": "true", title: m.wallet }, shortHex(m.wallet, 6, 4), symbol("onUs")));
  parts.push(el("span", { class: "visually-hidden", text: face.words }));
  line.replaceChildren(...parts);
}

/**
 * Plays a moment class once (the note's m-* classes): removed when its animation ends.
 * @param {Element} node
 * @param {string} cls
 */
function moment(node, cls) {
  node.classList.add(cls);
  node.addEventListener("animationend", () => node.classList.remove(cls), { once: true });
}

/** Whether a failed hot send still spent its ticket: the backend's 422 (refused, the leaf burned). @param {unknown} e */
const burnedBy = (e) => e instanceof ApiError && e.status === 422;

/**
 * Mounts the shared parts and wires this screen's controls. Null when there is no wallet to show.
 * @param {MountOptions} [opts]
 */
export async function start(opts = {}) {
  const screen = await mountScreen({ empty: "No lanes yet. Cut tickets on the cold device, then pay from the phone.", ...opts });
  if (!screen) return null;
  const { api, address } = screen;
  const input = (/** @type {string} */ id) => byId(id, HTMLInputElement);
  const button = (/** @type {string} */ id) => byId(id, HTMLButtonElement);
  const coldPane = byId("cold-pane"), coldFields = byId("cold-fields", HTMLFieldSetElement);
  const offline = input("offline");
  const policy = { value: input("policy-value"), fee: input("policy-fee"), target: input("policy-target"), start: input("policy-start") };
  const cutCount = input("cut-count"), cutBtn = button("cut"), rotateHeight = input("rotate-height");
  const payTo = input("pay-to"), payAmount = input("pay-amount"), payBtn = button("pay"), stuckBtn = button("stuck");
  const payCap = byId("pay-cap"), payProblem = byId("pay-problem");
  const ticket = byId("ticket"), serial = byId("ticket-serial"), machine = byId("machine");
  const countN = byId("count-n"), countOf = byId("count-of");
  const register = createRegister(byId("register"));
  const strip = createStubStrip(byId("stubs", HTMLOListElement));
  /** fields a person has typed in keep their text when the wallet view refreshes */
  const dirty = new Set();
  for (const i of [policy.value, policy.fee, policy.target, policy.start, cutCount, rotateHeight]) i.addEventListener("input", () => dirty.add(i));
  /** @param {HTMLInputElement} i @param {string} v */
  const prefill = (i, v) => { if (!dirty.has(i) && document.activeElement !== i) i.value = v; };

  // ---------------------------------------------------------------- the four forms fold on a phone (answer 5)
  const folds = [...document.querySelectorAll("details.fold")];
  const foldQuery = typeof matchMedia === "function" ? matchMedia(FOLD_QUERY) : null; // none in the tests' fake DOM
  const narrow = () => foldQuery?.matches === true;
  /**
   * Below 600 px the sections open and close, and start closed on a phone; wider, they are always open and their
   * headings are plain headings (out of the tab order, a click does nothing), so the laptop is unchanged.
   * @param {boolean} first the page just loaded
   */
  function fold(first) {
    for (const d of folds) {
      const summary = d.querySelector("summary");
      if (summary) summary.tabIndex = narrow() ? 0 : -1;
      if (!narrow()) d.setAttribute("open", "");
      else if (first) d.removeAttribute("open");
    }
  }
  fold(true);
  foldQuery?.addEventListener?.("change", () => fold(false));
  for (const d of folds) d.querySelector("summary")?.addEventListener("click", (ev) => { if (!narrow()) ev.preventDefault(); });

  // ---------------------------------------------------------------- spending a ticket: the tear, then the roll
  let rollUntil = 0;
  /** A ticket was spent: it tears off now, and the count and the serial roll on the redraw that follows. */
  function spent() {
    rollUntil = Date.now() + ROLL_MS;
    try { tearTicket(ticket); } catch { /* a moment never stops a payment */ }
  }

  /** @param {boolean} on */
  function setOffline(on) {
    offline.checked = on;
    coldPane.classList.toggle("offline", on);
    coldFields.dataset.offline = String(on);
    screen?.updateSendable();
  }
  offline.addEventListener("change", () => {
    setOffline(offline.checked);
    screen.notice(offline.checked ? "Cold device offline: the phone keeps paying from its tickets." : "Cold device online.");
  });

  /** @param {WalletView} w @param {LeafState[]} states */
  function drawCold(w, states) {
    register.draw(states, String(w.epoch)); // the book is the epoch: a rotation draws a fresh one, with no moment
    const hotLeaves = Math.max(0, w.leafCount - w.hotStart);
    const facts = [
      item("height", String(w.height), { num: true }),
      item("epoch", String(w.epoch), { num: true }),
      item("leaves used", `${w.leavesUsed} of ${formatCount(w.leafCount)}`, { num: true }),
      item("hot band", hotLeaves ? `leaves ${w.hotStart} to ${w.leafCount - 1} (${hotLeaves})` : "none", { num: true }),
      item("root", shortHex(w.root, 6, 6), { num: true, title: w.root }),
    ];
    if (w.rotationPending) facts.push(item("rotation", "pending"));
    byId("tree-summary").replaceChildren(...facts);
    prefill(policy.value, weiToEthInput(w.hotValueCapWei));
    prefill(policy.fee, weiToEthInput(w.hotFeeCapWei));
    prefill(policy.target, w.allowedTarget);
    prefill(policy.start, String(w.hotStart));
    drawCut(w, states);
    prefill(rotateHeight, String(w.height));
  }

  /**
   * Tickets for the phone: how many hot leaves are left to cut; no cut at all while the device cannot sign.
   * @param {WalletView} w @param {LeafState[]} states
   */
  function drawCut(w, states) {
    const issue = screen?.deviceIssue() ?? null;
    const uncut = uncutOf(w, states);
    byId("cut-left").textContent = issue
      ? `${issue.text}. Until then no cut: a new journal would re-sign used tickets.`
      : `${leaves(uncut)} not cut yet; ${w.tickets.exported} cut this epoch. Each ticket is one leaf's secrets and path, no seed.`;
    cutBtn.disabled = !!issue;
    cutCount.disabled = !!issue;
    cutCount.max = String(Math.max(1, Math.min(64, uncut)));
    prefill(cutCount, String(Math.max(1, Math.min(10, uncut))));
  }

  /** @type {string | null} the cap line last printed: a new one (a policy included) is reprinted */
  let capText = null;
  /** @type {string | null} what the machine line last drew, so a poll does not rebuild it */
  let machineKey = null;

  /** @param {WalletView} w @param {LeafState[]} states */
  function drawPhone(w, states) {
    const issue = screen?.deviceIssue() ?? null;
    const roll = Date.now() < rollUntil; // an action's redraw, not a plain poll
    rollNumber(countN, String(w.tickets.left), roll);
    countOf.textContent = ` of ${w.tickets.exported}`;
    const note = byId("ticket-note");
    note.hidden = !!issue; // the device's own line says it, under the count
    note.textContent = w.tickets.exported === 0
      ? "no tickets yet: cut some on the cold device"
      : `tickets left of those cut; ${w.tickets.used} used or burned`;
    strip.draw(stubsOf(w, states), String(w.epoch));

    const face = ticketFace(w, states, issue, screen?.chain()?.chainId ?? null); // the status line's chain
    ticket.classList.toggle("empty", face.empty);
    rollNumber(serial, face.serial, roll);
    const key = JSON.stringify(face);
    if (key !== machineKey) { machineKey = key; drawMachine(machine, face); }

    payTo.value = w.allowedTarget;
    const cap = `Hot value cap ${formatWei(w.hotValueCapWei)} per payment, fee cap ${formatWei(w.hotFeeCapWei)}.`;
    if (cap !== capText) {
      payCap.textContent = cap;
      if (capText !== null) moment(payCap, "m-reprint"); // the caps live in the account: reprinted once it changed them
      capText = cap;
    }
    payCap.title = `exact: value cap ${formatWeiExact(w.hotValueCapWei)}, fee cap ${formatWeiExact(w.hotFeeCapWei)}`;
    if (!payAmount.value) payAmount.value = weiToEthInput(BigInt(w.hotValueCapWei) / 10n || 1n);
    checkAmount();
  }

  /** Both panes from the latest wallet view and lane records (the records are fresher: polled every 2 s). */
  function draw() {
    const w = screen?.wallet();
    if (!w) return;
    const states = leafStates(w, screen?.records() ?? []);
    drawCold(w, states);
    drawPhone(w, states);
  }

  /** Inline cap check: the Pay and stuck buttons stay off while the amount is not one a ticket may send. */
  function checkAmount() {
    const w = screen?.wallet();
    if (!w) return null;
    const c = checkHotAmount(payAmount.value, w);
    payProblem.hidden = c.ok;
    payProblem.textContent = c.ok ? "" : c.error;
    payAmount.setAttribute("aria-invalid", String(!c.ok));
    payBtn.disabled = !c.ok;
    stuckBtn.disabled = !c.ok;
    return c.ok ? c.wei : null;
  }
  payAmount.addEventListener("input", checkAmount);

  /** @type {Set<string> | null} lanes already on the board; null until the first records */
  let seen = null;
  /**
   * The backend's own retry after an expiry is a ticket the device spent by itself: a new hot lane that is a retry
   * tears the ticket as Pay does (never on the first records, which are the page's starting state).
   * @param {TxRecord[]} records
   */
  function watchRetries(records) {
    if (seen === null) { if (records.length) seen = new Set(records.map((r) => r.txHash)); return; }
    const was = seen;
    if (records.some((r) => r.mode === "hot" && r.retryOf && !was.has(r.txHash))) spent();
    seen = new Set(records.map((r) => r.txHash));
  }

  screen.onWallet(draw);
  screen.onRecords((records) => {
    drawSetAside(byId("phone-set-aside"), records, screen.wallet());
    watchRetries(records);
    draw();
  });

  /** A failed hot send: a 422 spent its ticket (refused, leaf burned), so it tears; the notice says why, as always. */
  const hotFailed = (/** @type {unknown} */ e) => { if (burnedBy(e)) spent(); screen.notice(errorText(e), "error"); };

  byId("transfer-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const to = input("transfer-to").value.trim(), wei = parseEth(input("transfer-amount").value);
    const problem = byId("transfer-problem");
    problem.hidden = isAddress(to) && wei !== null && wei > 0n;
    problem.textContent = !isAddress(to) ? "an address, 0x and 40 hex digits" : "an amount in ETH, more than 0";
    if (!problem.hidden || wei === null) return;
    const r = await screen.run(button("transfer"), () => send(api, address, coldTransferBody({ to, valueWei: wei, mempool: screen.mempool() })));
    if (r) screen.notice(`Sent ${formatWei(wei)} from the cold device on lane ${r.nonceKeys[0]} (leaf ${r.leaf}): admitted.`);
  });

  byId("policy-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await screen.run(button("policy-set"), () => setPolicy(api, address, {
      hotStart: policy.start.value, valueCap: policy.value.value, feeCap: policy.fee.value, allowedTarget: policy.target.value,
    }));
    if (r) {
      for (const i of [policy.value, policy.fee, policy.target, policy.start]) dirty.delete(i);
      screen.notice(`Set policy sent on a cold leaf: ${shortHex(r.txHash)}. The caps change when it is included.`);
    }
  });

  byId("cut-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const issue = screen.deviceIssue();
    if (issue) { screen.notice(`${issue.text}. Until then no cut.`, "error"); return; } // Enter in the count field, say
    const count = Number(cutCount.value);
    const r = await screen.run(cutBtn, () => cutTickets(api, address, count));
    if (r) {
      dirty.delete(cutCount);
      rollUntil = Date.now() + ROLL_MS; // the count rolls up; the register and the stubs play their own moments
      screen.notice(`Cut ${r.count} ticket${r.count === 1 ? "" : "s"} to the phone: leaves ${r.from} to ${r.to}.`);
    }
  });

  let armedUntil = 0;
  byId("rotate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = button("rotate");
    if (Date.now() > armedUntil) { // two clicks: the warning stands between them
      armedUntil = Date.now() + 6_000;
      btn.textContent = "Confirm: rotate root";
      btn.classList.add("armed");
      setTimeout(() => { if (Date.now() >= armedUntil) { btn.textContent = "Rotate root"; btn.classList.remove("armed"); } }, 6_100);
      return;
    }
    armedUntil = 0;
    btn.textContent = "Rotate root";
    btn.classList.remove("armed");
    const r = await screen.run(btn, () => rotateRoot(api, address, Number(rotateHeight.value)));
    if (r) screen.notice(`Rotation sent: ${shortHex(r.txHash)}. The wallet moves to epoch ${r.epoch} once the chain shows root ${shortHex(r.newRoot)}.`);
  });

  byId("pay-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const w = screen.wallet(), wei = checkAmount();
    if (!w || wei === null) return;
    const r = await screen.run(payBtn, () => send(api, address, payBody({ wallet: w, valueWei: wei, mempool: screen.mempool() })), hotFailed);
    if (r) {
      spent();
      screen.notice(`Paid ${formatWei(wei)} with ticket ${r.leaf} on lane ${r.nonceKeys[0]}: admitted.`);
    }
    checkAmount();
  });

  stuckBtn.addEventListener("click", async () => {
    const w = screen.wallet(), wei = checkAmount();
    if (!w || wei === null) return;
    const r = await screen.run(stuckBtn, () => send(api, address, stuckBody({ wallet: w, valueWei: wei, mempool: screen.mempool() })), hotFailed);
    if (r) {
      spent();
      screen.notice(`Stuck payment on lane ${r.nonceKeys[0]} (ticket ${r.leaf}): its first deadline is ${STUCK.firstAttemptExpirySeconds} s, shorter than one 6 s block, so it should miss its block and expire, its ticket burned; then one retry goes out on a fresh lane with the normal deadline.`);
    }
    checkAmount();
  });

  /**
   * The scene's client: the same API, except that each hot payment the scene sends tears the ticket off as Pay does,
   * and the page redraws at once so the count and the serial follow the scene.
   * @type {Api}
   */
  const sceneApi = {
    ...api,
    send: async (a, body) => {
      try {
        const r = await api.send(a, body);
        if (body.mode === "hot") { spent(); void screen.refresh(); }
        return r;
      } catch (e) {
        if (body.mode === "hot" && burnedBy(e)) { spent(); void screen.refresh(); }
        throw e;
      }
    },
  };
  const mempoolInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="mempool"]')]);
  const play = button("play");
  play.addEventListener("click", () => screen.run(play, () => hotColdScene(sceneApi, address, {
    step: (text) => screen.notice(`Scene: ${text}`),
    offline: setOffline,
    mempool: (m) => { for (const i of mempoolInputs) i.checked = i.value === m; },
  }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error")));

  return { screen, stop: screen.stop };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
