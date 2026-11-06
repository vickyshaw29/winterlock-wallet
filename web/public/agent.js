// Agent screen: a mock price and its sparkline, the rule that fires four hot tranches at once as parallel lanes (the
// plan shown before Fire), the allowance card (the most a thief could move; the ticket device's trouble), Server
// compromised, an event log, Play scene. The page runs start() on load; the tests run it on a fake document.
// Written with Claude Code (AI) for Vicky.
// In the Ledger direction (.claude/briefs/ui-directions/1-ledger.md, sections 3, 5 and 7): the sparkline is an Ink line
// on a Stock strip with the last 30 s under a hatched band; the allowance shows the count and a stub strip of the
// agent's tickets from real data (the wallet view's leaves and the lane board's records, register.js); Max loss is a
// ledger total; the event log is a day book, lane and ticket numbers in Serial red, with no motion. Two moments:
// Fire lifts the next four stubs as one perforated block, and Server compromised rules the Max loss total again.
import { byId, el, item } from "./dom.js";
import { RULE, compromisedPayments, deviceIssueOf, errorText, fireTranches, isStalled, maxLossWei, trancheWei } from "./flows.js";
import { formatClock, formatWei, formatWeiExact, shortHex } from "./format.js";
import { changes, refusalOf, statusOf } from "./lanes.js";
import { changePct, createMockMarket, ruleFires } from "./market.js";
import { createStubStrip, leafStates, reducedMotion, rollNumber, stubsOf } from "./register.js";
import { agentScene } from "./scenes.js";
import { drawSetAside, mountScreen, planView } from "./ui.js";

/** @import { SendAnswer, SendBody, TxRecord, TxStatus, WalletView } from "./api.js" */
/** @import { MountOptions } from "./ui.js" */

const SVG = "http://www.w3.org/2000/svg";
const SPAN_MS = 60_000, TICK_MS = 500;
/** The sparkline strip in px: its height, the clear room above the line for the band's label, the other margins. */
const SPARK = Object.freeze({ h: 72, top: 22, bottom: 6, side: 6 });
export const READOUT = "Hover or focus the line to read a price.";

/**
 * The serials in a day-book entry: a lane, a short 0x number standing alone ("lane 0x3fa", "0x3f0, 0x3f1"; never an
 * address, which is longer or shortened with "…"), and the number after "ticket" ("ticket 1012").
 */
const SERIALS = /\b0x[0-9a-fA-F]{1,12}(?![\w…])|(?<=\b[Tt]ickets? )\d+\b/g;

/**
 * A day-book entry in parts: lane and ticket numbers are serials the key tree printed, so they are printed in Serial
 * red, as on the ledger and the stubs; the rest is Ink. Joined, the parts are the text unchanged. Pure.
 * @param {string} text
 * @returns {{ text: string, serial: boolean }[]}
 */
export function dayBookParts(text) {
  /** @type {{ text: string, serial: boolean }[]} */
  const out = [];
  let at = 0;
  for (const m of text.matchAll(SERIALS)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start), serial: false });
    out.push({ text: m[0], serial: true });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), serial: false });
  return out;
}

/**
 * The allowance's count, "10 of 16" (tickets left of those cut: the backend's numbers, as on the account line), and the
 * note under it. No note while the ticket device cannot sign: the warning under it says why. Pure.
 * @param {Pick<WalletView, "tickets">} w
 * @param {boolean} deviceTrouble
 * @returns {{ n: string, of: string, note: string | null }}
 */
export function allowanceCount(w, deviceTrouble) {
  const t = w.tickets;
  const note = deviceTrouble ? null
    : t.exported === 0 ? "No tickets cut yet: the cold device cuts them, and Play scene does so first."
      : `tickets left of those cut; ${t.used} used or burned`;
  return { n: String(t.left), of: ` of ${t.exported}`, note };
}

/**
 * The stubs the next tranches use: the lowest tickets still on the phone, in the strip's order, since the device
 * signs its lowest unused ticket first.
 * @param {HTMLElement} list the stub strip
 * @param {number} n
 * @returns {HTMLElement[]}
 */
export function nextStubs(list, n) {
  return /** @type {HTMLElement[]} */ ([...list.children]).filter((li) => li.classList.contains("is-phone")).slice(0, n);
}

/**
 * Fire's moment (1-ledger.md, section 5): the next stubs are perforated as one block and lift together, up and away,
 * while their lanes are written on the ledger. A clone of them lifts, hidden from screen readers, so the strip itself
 * never moves; its next draw shows them in flight. Skipped, returning false, under reduced motion, where
 * element.animate is missing (older browsers, the tests' fake DOM), with no stub to lift, or with the strip off screen.
 * @param {HTMLElement} list the stub strip
 * @param {number} n
 * @returns {boolean} whether it played
 */
export function liftStubs(list, n) {
  const stubs = nextStubs(list, n);
  if (stubs.length === 0 || reducedMotion() || typeof list.animate !== "function") return false;
  const boxes = stubs.map((s) => s.getBoundingClientRect());
  const first = /** @type {DOMRect} */ (boxes[0]), strip = list.getBoundingClientRect();
  if (first.bottom < 0 || first.top > innerHeight) return false;
  const width = boxes.reduce((sum, b) => sum + b.width, 0);
  const clones = stubs.map((s) => {
    const c = /** @type {HTMLElement} */ (s.cloneNode(true));
    c.classList.remove("m-fresh", "m-stamped"); // a clone never replays the strip's own moments
    return c;
  });
  const block = el("ol", { class: "stubs lift", "aria-hidden": "true" }, ...clones);
  block.inert = true;
  // one row, where the first stub is, kept inside the strip; through the CSSOM (a style attribute would break the CSP)
  Object.assign(block.style, {
    position: "fixed", left: `${Math.max(strip.left, Math.min(first.left, strip.right - width))}px`, top: `${first.top}px`,
    width: `${width}px`, gridTemplateColumns: boxes.map((b) => `${b.width}px`).join(" "), margin: "0", zIndex: "20", pointerEvents: "none",
  });
  document.body.append(block);
  const done = () => block.remove();
  block.animate([
    { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
    { transform: "translate(2px, -6px) rotate(-1deg)", opacity: 1, offset: 0.26 },
    { transform: "translate(24px, -72px) rotate(-4deg)", opacity: 0 },
  ], { duration: 500, easing: "cubic-bezier(.2,.7,.2,1)" }).finished.then(done, done);
  return true;
}

/**
 * Plays a moment class once: added now, removed when its animation ends.
 * @param {Element} node
 * @param {string} cls
 */
function playOnce(node, cls) {
  node.classList.add(cls);
  node.addEventListener("animationend", () => node.classList.remove(cls), { once: true });
}

/**
 * Mounts the shared parts, starts the mock market and wires this screen's controls. Null when there is no wallet.
 * @param {MountOptions} [opts]
 */
export async function start(opts = {}) {
  const screen = await mountScreen({ empty: "No lanes yet. Fire, or arm the rule and drop the mock price.", ...opts });
  if (!screen) return null;
  const { api } = screen;
  const market = createMockMarket({ now: Date.now() });
  const spark = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (byId("spark")));
  const armed = byId("armed", HTMLInputElement), fire = byId("fire", HTMLButtonElement);
  const compromised = byId("compromised", HTMLButtonElement), play = byId("play", HTMLButtonElement);
  const log = byId("log"), logEmpty = byId("log-empty");
  const stubList = byId("stubs", HTMLOListElement);
  const strip = createStubStrip(stubList);
  /** @type {number | null} index into the history the readout shows */
  let hover = null;
  /** lanes this screen sent, so the log reports what happens to them */
  const ours = new Set();
  /** @type {Map<string, TxStatus>} */
  const seen = new Map();
  let firstPoll = true;
  /** set by an action that spends or cuts tickets: the next new count rolls like a numbering machine */
  let rollCount = false;
  /** set by Server compromised: the next new Max loss figure rules its total again */
  let ruleAgain = false;

  /** @param {string} text @param {boolean} [strong] */
  function logLine(text, strong = false) {
    const entry = dayBookParts(text).map((p) => (p.serial ? el("span", { class: "sn", text: p.text }) : p.text));
    log.prepend(el("li", {}, el("span", { class: "when num", text: formatClock(new Date().toISOString()) }), el(strong ? "strong" : "span", {}, ...entry)));
    while (log.children.length > 60) log.lastElementChild?.remove();
    logEmpty.hidden = true;
  }

  // ---------------------------------------------------------------- the mock market and its sparkline

  /** @param {string} name @param {Record<string, string | number>} attrs */
  function svgEl(name, attrs) {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }

  // the hatch for the last 30 s: diagonal Print lines, a pattern (never a gradient), made once
  const defs = svgEl("defs", {});
  const hatch = svgEl("pattern", { id: "spark-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hatch.append(svgEl("line", { class: "spark-hatch-line", x1: 0, y1: 0, x2: 0, y2: 6 }));
  defs.append(hatch);

  function drawMarket() {
    const now = Date.now();
    const hist = market.history.filter((x) => x.t >= now - SPAN_MS);
    const price = market.price(), change = changePct(market.history, now, RULE.windowMs);
    byId("price").textContent = price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    byId("change").textContent = `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} % in 30 s`;
    const W = Math.max(120, spark.clientWidth || 300), H = SPARK.h;
    spark.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const prices = hist.map((x) => x.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const x = (/** @type {number} */ t) => SPARK.side + ((t - (now - SPAN_MS)) / SPAN_MS) * (W - 2 * SPARK.side);
    const y = (/** @type {number} */ p) => H - SPARK.bottom - ((p - lo) / (hi - lo || 1)) * (H - SPARK.top - SPARK.bottom);
    const points = (/** @type {typeof hist} */ xs) => xs.map((q) => `${x(q.t).toFixed(1)},${y(q.price).toFixed(1)}`).join(" ");
    const from = x(now - RULE.windowMs);
    const band = SPARK.top - 6; // the band starts just above the line's room; its label sits in the clear strip above
    const label = svgEl("text", { class: "spark-label", x: from + 4, y: 13 });
    label.textContent = "last 30 s";
    const kids = [
      defs,
      svgEl("rect", { class: "spark-window", x: from, y: band, width: Math.max(0, W - from), height: H - band, fill: "url(#spark-hatch)" }),
      svgEl("line", { class: "spark-edge", x1: from, x2: from, y1: band, y2: H }),
      label,
      svgEl("polyline", { class: "spark-line", points: points(hist) }),
    ];
    const last = hist[hist.length - 1];
    if (last) kids.push(svgEl("circle", { class: "spark-last", cx: x(last.t), cy: y(last.price), r: 4 }));
    const h = hover === null ? null : hist[Math.min(hover, hist.length - 1)];
    if (h) {
      kids.push(svgEl("line", { class: "spark-cross", x1: x(h.t), x2: x(h.t), y1: band, y2: H }));
      kids.push(svgEl("circle", { class: "spark-hover", cx: x(h.t), cy: y(h.price), r: 4 }));
      byId("spark-readout").textContent = `${h.price.toFixed(2)} at ${formatClock(new Date(h.t).toISOString())} (mock)`;
    }
    spark.replaceChildren(...kids);
    spark.setAttribute("aria-label", `Mock ETH price over the last 60 s: ${lo.toFixed(2)} to ${hi.toFixed(2)}, now ${price.toFixed(2)}`);
  }

  /** @param {PointerEvent} ev */
  function onPointer(ev) {
    const r = spark.getBoundingClientRect(), now = Date.now();
    const hist = market.history.filter((x) => x.t >= now - SPAN_MS);
    const t = now - SPAN_MS + ((ev.clientX - r.left) / Math.max(1, r.width)) * SPAN_MS;
    let best = 0;
    hist.forEach((q, i) => { if (Math.abs(q.t - t) < Math.abs((hist[best]?.t ?? 0) - t)) best = i; });
    hover = best;
    drawMarket();
  }
  const unhover = () => { hover = null; byId("spark-readout").textContent = READOUT; drawMarket(); };
  spark.addEventListener("pointermove", onPointer);
  spark.addEventListener("pointerleave", unhover);
  spark.addEventListener("focus", () => { hover = market.history.filter((x) => x.t >= Date.now() - SPAN_MS).length - 1; drawMarket(); });
  spark.addEventListener("blur", unhover);
  spark.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const n = market.history.filter((x) => x.t >= Date.now() - SPAN_MS).length;
    hover = Math.max(0, Math.min(n - 1, (hover ?? n - 1) + (ev.key === "ArrowLeft" ? -1 : 1)));
    drawMarket();
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    market.tick(now);
    drawMarket();
    if (armed.checked && ruleFires(market.history, now, RULE)) {
      armed.checked = false; // fires once per arming
      logLine(`Rule fired: the mock price fell more than ${RULE.dropPct} % in 30 s.`, true);
      void fireNow();
    }
  }, TICK_MS);
  /** the mock price falls 3 %: with the rule armed, the next tick fires it */
  const dropPrice = () => { market.drop(3, Date.now()); drawMarket(); logLine("Mock price dropped 3 %."); };
  byId("drop").addEventListener("click", dropPrice);
  drawMarket();

  // ---------------------------------------------------------------- the allowance, the tranches, the compromised server

  /** The parallel-lanes plan for what Fire sends, each tranche its own lane; none while the device cannot sign. */
  const plan = planView(api, screen.address, byId("fire-plan"), (w) => (screen.deviceIssue() ? null : {
    n: RULE.tranches, mode: "hot", valueWei: String(trancheWei(w) ?? BigInt(w.hotValueCapWei)), to: w.allowedTarget,
  }), { tickets: { holder: "with the agent", none: "No tickets left with the agent: cut some on the cold device." } });

  /**
   * The agent's tickets as stubs, each with its state, from the wallet view's leaves merged with the fresher records.
   * A refresh draws twice in a row (the view, then the records); the strip leaves a stub that did not change alone, so
   * a stamp the first draw started is not cut short by the second.
   * @param {WalletView} w
   * @param {TxRecord[]} records
   */
  function drawStubs(w, records) {
    strip.draw(stubsOf(w, leafStates(w, records)), String(w.epoch));
  }

  /**
   * The count, "10 of 16": it rolls only when an action on this screen moved it, never on a plain poll.
   * @param {WalletView} w
   */
  function drawCount(w) {
    const c = allowanceCount(w, !!screen?.deviceIssue());
    const n = byId("agent-count-n");
    const changed = (n.dataset.v ?? n.textContent) !== c.n;
    rollNumber(n, c.n, rollCount && changed);
    if (changed) rollCount = false;
    byId("agent-count-of").textContent = c.of;
    const note = byId("agent-count-note");
    note.hidden = c.note === null;
    note.textContent = c.note ?? "";
  }

  /**
   * Max loss as a ledger total: the figure under a single rule, drawn again once Server compromised has burned tickets.
   * @param {WalletView} w
   */
  function drawMaxLoss(w) {
    const loss = maxLossWei(w);
    const box = byId("max-loss"), fig = byId("max-loss-fig");
    const changed = box.dataset.v !== undefined && box.dataset.v !== String(loss);
    box.dataset.v = String(loss);
    fig.textContent = formatWei(loss);
    box.title = `exact: ${formatWeiExact(loss)}`;
    byId("max-loss-note").textContent = `to ${shortHex(w.allowedTarget)} only: tickets left times value cap plus fee cap`;
    if (changed && ruleAgain) { ruleAgain = false; playOnce(box, "m-rule"); }
  }

  /** @param {WalletView} w */
  function drawAllowance(w) {
    drawCount(w);
    byId("allowance").replaceChildren(
      item("value cap", formatWei(w.hotValueCapWei), { num: true, title: formatWeiExact(w.hotValueCapWei) }),
      item("fee cap", formatWei(w.hotFeeCapWei), { num: true, title: formatWeiExact(w.hotFeeCapWei) }),
      item("target", shortHex(w.allowedTarget, 6, 4), { num: true, title: w.allowedTarget }),
    );
    drawMaxLoss(w);
    drawStubs(w, screen?.records() ?? []);
    const t = trancheWei(w);
    byId("rule-text").textContent = t === null
      ? `If price falls more than ${RULE.dropPct} % in 30 s, buy in ${RULE.tranches} tranches. The balance cannot cover them now.`
      : `If price falls more than ${RULE.dropPct} % in 30 s, buy in ${RULE.tranches} tranches of ${formatWei(t)}.`;
    const issue = screen?.deviceIssue() ?? null;
    byId("fire-hint").textContent = issue
      ? `No tranche can be signed: ${issue.text}.`
      : w.tickets.left < RULE.tranches
        ? `${w.tickets.left} ticket${w.tickets.left === 1 ? "" : "s"} left: tranches without one are refused. Cut more on the cold device.`
        : `Each tranche is one ticket on its own lane, at most the value cap (${formatWei(w.hotValueCapWei)}).`;
    fire.disabled = t === null;
    void plan.update(w);
  }

  /** Fire's moment, at the moment of sending: the next stubs lift, and the count may roll when the view comes back. */
  function tearTranches() {
    rollCount = true;
    if (!screen?.deviceIssue()) liftStubs(stubList, RULE.tranches);
  }

  /**
   * A 503 among the answers raises the stalled banner and turns sending off; a 409 device_unusable goes on the card.
   * @param {PromiseSettledResult<unknown>[]} results
   */
  function failFrom(results) {
    const stop = results.find((r) => r.status === "rejected" && (isStalled(r.reason) || deviceIssueOf(r.reason)));
    if (stop) screen?.fail(/** @type {PromiseRejectedResult} */ (stop).reason);
  }

  /**
   * The event log for the tranches.
   * @param {PromiseSettledResult<SendAnswer>[]} results
   * @param {bigint} tranche
   * @param {"alt" | "public"} mempool
   */
  function logFired(results, tranche, mempool) {
    logLine(`Fired ${results.length} tranches of ${formatWei(tranche)} at once as parallel lanes (${mempool} mempool).`);
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        ours.add(r.value.txHash.toLowerCase());
        logLine(`Tranche ${i + 1}: ticket ${r.value.leaf} on lane ${r.value.nonceKeys[0]}, admitted.`);
      } else {
        logLine(`Tranche ${i + 1}: ${errorText(r.reason)}`, true);
      }
    });
    failFrom(results);
  }

  /**
   * The event log for the compromised server's two payments, with the account's reasons.
   * @param {{ body: SendBody, result: PromiseSettledResult<SendAnswer> }[]} sent
   */
  function logCompromised(sent) {
    for (const { body, result } of sent) {
      const what = body.to.toLowerCase() === screen?.wallet()?.allowedTarget.toLowerCase()
        ? `${formatWei(body.valueWei)} to the allowed target` : `${formatWei(body.valueWei)} to ${shortHex(body.to)}, a new address`;
      if (result.status === "fulfilled") {
        ours.add(result.value.txHash.toLowerCase());
        logLine(`Compromised payment of ${what}: admitted on lane ${result.value.nonceKeys[0]}, the account did not refuse it.`, true);
        continue;
      }
      const e = /** @type {import("./api.js").ApiError} */ (result.reason);
      if (e?.code === "refused") {
        if (e.body?.txHash) ours.add(String(e.body.txHash).toLowerCase());
        const refusal = refusalOf(e.body?.simulation?.violations);
        logLine(`Compromised payment of ${what}: refused by the account, ${refusal ? `${refusal.words} (${refusal.reason})` : e.detail}; ticket ${e.body?.leaf} burned.`, true);
      } else {
        logLine(`Compromised payment of ${what}: ${errorText(e)}`, true);
      }
    }
    failFrom(sent.map((s) => s.result));
  }

  async function fireNow() {
    const w = screen?.wallet();
    if (!screen || !w) return;
    const tranche = trancheWei(w);
    if (tranche === null) { logLine("Not fired: the balance cannot cover the tranches and their fee caps."); return; }
    const mempool = screen.mempool();
    if (!screen.stalled()) tearTranches(); // run() refuses while the chain is stalled: then nothing lifts
    const results = await screen.run(fire, () => fireTranches(api, w, { tranche, mempool }));
    if (results) logFired(results, tranche, mempool);
  }
  fire.addEventListener("click", () => { logLine("Fire pressed."); return fireNow(); });

  compromised.addEventListener("click", async () => {
    const w = screen.wallet();
    if (!w) return;
    logLine("Server compromised: it sends two payments outside the hot policy.", true);
    // set before sending, so the view that shows the burned tickets rules the total again, however soon it comes
    ruleAgain = rollCount = !screen.stalled();
    const sent = await screen.run(compromised, () => compromisedPayments(api, w, screen.mempool()));
    if (!sent) { ruleAgain = rollCount = false; return; }
    logCompromised(sent);
    const words = sent.map((s) => (s.result.status === "fulfilled" ? "admitted" : refusalOf(s.result.reason?.body?.simulation?.violations)?.words ?? errorText(s.result.reason)));
    screen.notice(`Server compromised: ${words.join("; ")}.`);
  });

  const mempoolInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="mempool"]')]);
  play.addEventListener("click", () => {
    rollCount = !screen.stalled(); // the scene may cut tickets first: the count rolls up
    return screen.run(play, () => agentScene(api, screen.address, {
      step: (text) => { screen.notice(`Scene: ${text}`); logLine(`Scene: ${text}`); },
      mempool: (m) => { for (const i of mempoolInputs) i.checked = i.value === m; },
      trigger: () => { armed.checked = false; dropPrice(); logLine(`Rule fired: the mock price fell more than ${RULE.dropPct} % in 30 s.`, true); tearTranches(); },
      fired: (results, tranche) => logFired(results, tranche, "alt"),
      compromised: (sent) => { ruleAgain = rollCount = true; logCompromised(sent); },
    }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error"));
  });

  screen.onWallet(drawAllowance);
  screen.onRecords((records) => {
    drawSetAside(byId("agent-set-aside"), records, screen.wallet());
    const w = screen.wallet();
    if (w) drawStubs(w, records);
    for (const { rec, from } of changes(seen, records)) {
      if (firstPoll || !ours.has(rec.txHash.toLowerCase())) continue;
      if (from === null && (rec.status === "Submitted" || rec.status === "Refused")) continue; // logged when it was sent
      const block = rec.receipt ? ` in block ${Number(BigInt(rec.receipt.blockNumber))}` : "";
      logLine(`Lane ${rec.nonceKey} (ticket ${rec.leaf}): ${statusOf(rec).label}${block}.`, rec.status !== "OnChain");
    }
    firstPoll = false;
  });

  return { screen, stop: () => { clearInterval(ticker); screen.stop(); } };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
