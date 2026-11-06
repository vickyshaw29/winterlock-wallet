// Hot and cold screen: the cold pane (tree, hot policy, cuts, rotate, offline; no cut while the device journal is lost)
// and the phone pane (tickets, pay within the cap, the stuck payment whose 4-second first deadline should miss its
// block), over the shared lane board; Play scene. The page runs start() on load; the tests run it on a fake document.
// Written with Claude Code (AI) for Vicky.
import { byId, item } from "./dom.js";
import {
  STUCK, checkHotAmount, coldTransferBody, cutTickets, errorText, payBody, rotateRoot, send, setPolicy, stuckBody, uncutHotLeaves,
} from "./flows.js";
import { formatWei, formatWeiExact, isAddress, parseEth, shortHex, weiToEthInput } from "./format.js";
import { hotColdScene } from "./scenes.js";
import { drawSetAside, mountScreen } from "./ui.js";

/** @import { WalletView } from "./api.js" */
/** @import { MountOptions } from "./ui.js" */

/** @param {number} n */
const leaves = (n) => `${n} hot ${n === 1 ? "leaf" : "leaves"}`;

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
  /** fields a person has typed in keep their text when the wallet view refreshes */
  const dirty = new Set();
  for (const i of [policy.value, policy.fee, policy.target, policy.start, cutCount, rotateHeight]) i.addEventListener("input", () => dirty.add(i));
  /** @param {HTMLInputElement} i @param {string} v */
  const prefill = (i, v) => { if (!dirty.has(i) && document.activeElement !== i) i.value = v; };

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

  /** @param {WalletView} w */
  function drawCold(w) {
    const hotLeaves = Math.max(0, w.leafCount - w.hotStart);
    const facts = [
      item("height", String(w.height), { mono: true }),
      item("epoch", String(w.epoch), { mono: true }),
      item("leaves used", `${w.leavesUsed} of ${w.leafCount}`, { mono: true }),
      item("hot band", hotLeaves ? `leaves ${w.hotStart} to ${w.leafCount - 1} (${hotLeaves})` : "none", { mono: true }),
      item("root", shortHex(w.root, 6, 6), { mono: true, title: w.root }),
    ];
    if (w.rotationPending) facts.push(item("rotation", "pending"));
    byId("tree-summary").replaceChildren(...facts);
    prefill(policy.value, weiToEthInput(w.hotValueCapWei));
    prefill(policy.fee, weiToEthInput(w.hotFeeCapWei));
    prefill(policy.target, w.allowedTarget);
    prefill(policy.start, String(w.hotStart));
    drawCut(w);
    prefill(rotateHeight, String(w.height));
  }

  /**
   * Tickets for the phone: how many hot leaves are left to cut; no cut at all while the device cannot sign.
   * @param {WalletView} w
   */
  function drawCut(w) {
    const issue = screen?.deviceIssue() ?? null;
    const uncut = uncutHotLeaves(w);
    byId("cut-left").textContent = issue
      ? `${issue.text}. Until then no cut: a new journal would re-sign used tickets.`
      : `${leaves(uncut)} not cut yet; ${w.tickets.exported} cut this epoch. Each ticket is one leaf's secrets and path, no seed.`;
    cutBtn.disabled = !!issue;
    cutCount.disabled = !!issue;
    cutCount.max = String(Math.max(1, Math.min(64, uncut)));
    prefill(cutCount, String(Math.max(1, Math.min(10, uncut))));
  }

  /** @param {WalletView} w */
  function drawPhone(w) {
    byId("ticket-count").textContent = `${w.tickets.left} of ${w.tickets.exported}`;
    const note = byId("ticket-note");
    note.hidden = !!screen?.deviceIssue(); // the device's own line says it, under the count
    note.textContent = w.tickets.exported === 0
      ? "no tickets yet: cut some on the cold device"
      : `tickets left of those cut; ${w.tickets.used} used or burned`;
    payTo.value = w.allowedTarget;
    payCap.textContent = `Hot value cap ${formatWei(w.hotValueCapWei)} per payment, fee cap ${formatWei(w.hotFeeCapWei)}.`;
    payCap.title = `exact: value cap ${formatWeiExact(w.hotValueCapWei)}, fee cap ${formatWeiExact(w.hotFeeCapWei)}`;
    if (!payAmount.value) payAmount.value = weiToEthInput(BigInt(w.hotValueCapWei) / 10n || 1n);
    checkAmount();
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

  screen.onWallet((w) => { drawCold(w); drawPhone(w); });
  screen.onRecords((records) => drawSetAside(byId("phone-set-aside"), records, screen.wallet()));

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
    const r = await screen.run(payBtn, () => send(api, address, payBody({ wallet: w, valueWei: wei, mempool: screen.mempool() })));
    if (r) screen.notice(`Paid ${formatWei(wei)} with ticket ${r.leaf} on lane ${r.nonceKeys[0]}: admitted.`);
    checkAmount();
  });

  stuckBtn.addEventListener("click", async () => {
    const w = screen.wallet(), wei = checkAmount();
    if (!w || wei === null) return;
    const r = await screen.run(stuckBtn, () => send(api, address, stuckBody({ wallet: w, valueWei: wei, mempool: screen.mempool() })));
    if (r) screen.notice(`Stuck payment on lane ${r.nonceKeys[0]} (ticket ${r.leaf}): its first deadline is ${STUCK.firstAttemptExpirySeconds} s, shorter than one 6 s block, so it should miss its block and expire, its ticket burned; then one retry goes out on a fresh lane with the normal deadline.`);
    checkAmount();
  });

  const mempoolInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="mempool"]')]);
  const play = button("play");
  play.addEventListener("click", () => screen.run(play, () => hotColdScene(api, address, {
    step: (text) => screen.notice(`Scene: ${text}`),
    offline: setOffline,
    mempool: (m) => { for (const i of mempoolInputs) i.checked = i.value === m; },
  }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error")));

  return { screen, stop: screen.stop };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
