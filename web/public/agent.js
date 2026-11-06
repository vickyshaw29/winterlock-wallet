// Agent screen: a mock price and its sparkline, the rule that fires four hot tranches at once as parallel lanes (the
// plan shown before Fire), the allowance card (the most a thief could move; the ticket device's trouble), Server
// compromised, an event log, Play scene. The page runs start() on load; the tests run it on a fake document.
// Written with Claude Code (AI) for Vicky.
import { byId, el, item } from "./dom.js";
import { RULE, compromisedPayments, deviceIssueOf, errorText, fireTranches, isStalled, maxLossWei, trancheWei } from "./flows.js";
import { formatClock, formatWei, formatWeiExact, shortHex } from "./format.js";
import { changes, refusalOf, statusOf } from "./lanes.js";
import { changePct, createMockMarket, ruleFires } from "./market.js";
import { agentScene } from "./scenes.js";
import { drawSetAside, mountScreen, planView } from "./ui.js";

/** @import { SendAnswer, SendBody, TxStatus, WalletView } from "./api.js" */
/** @import { MountOptions } from "./ui.js" */

const SVG = "http://www.w3.org/2000/svg";
const SPAN_MS = 60_000, TICK_MS = 500;

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
  const log = byId("log");
  /** @type {number | null} index into the history the readout shows */
  let hover = null;
  /** lanes this screen sent, so the log reports what happens to them */
  const ours = new Set();
  /** @type {Map<string, TxStatus>} */
  const seen = new Map();
  let firstPoll = true;

  /** @param {string} text @param {boolean} [strong] */
  function logLine(text, strong = false) {
    log.prepend(el("li", {}, el("span", { class: "mono when", text: formatClock(new Date().toISOString()) }), el(strong ? "strong" : "span", { text })));
    while (log.children.length > 60) log.lastElementChild?.remove();
  }

  // ---------------------------------------------------------------- the mock market and its sparkline

  /** @param {string} name @param {Record<string, string | number>} attrs */
  function svgEl(name, attrs) {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }

  function drawMarket() {
    const now = Date.now();
    const hist = market.history.filter((x) => x.t >= now - SPAN_MS);
    const price = market.price(), change = changePct(market.history, now, RULE.windowMs);
    byId("price").textContent = price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    byId("change").textContent = `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} % in 30 s`;
    const W = Math.max(120, spark.clientWidth || 300), H = 64, pad = 5;
    spark.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const prices = hist.map((x) => x.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const x = (/** @type {number} */ t) => pad + ((t - (now - SPAN_MS)) / SPAN_MS) * (W - 2 * pad);
    const y = (/** @type {number} */ p) => H - pad - ((p - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const points = (/** @type {typeof hist} */ xs) => xs.map((q) => `${x(q.t).toFixed(1)},${y(q.price).toFixed(1)}`).join(" ");
    const windowFrom = now - RULE.windowMs;
    const recent = hist.filter((q, i) => q.t >= windowFrom || (hist[i + 1]?.t ?? 0) >= windowFrom);
    const kids = [
      svgEl("rect", { class: "spark-window", x: x(windowFrom), y: 0, width: Math.max(0, W - pad - x(windowFrom)), height: H }),
      svgEl("polyline", { class: "spark-line", points: points(hist) }),
      svgEl("polyline", { class: "spark-now", points: points(recent) }),
    ];
    const last = hist[hist.length - 1];
    if (last) kids.push(svgEl("circle", { class: "spark-last", cx: x(last.t), cy: y(last.price), r: 4 }));
    const h = hover === null ? null : hist[Math.min(hover, hist.length - 1)];
    if (h) {
      kids.push(svgEl("line", { class: "spark-cross", x1: x(h.t), x2: x(h.t), y1: 0, y2: H }));
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
  spark.addEventListener("pointermove", onPointer);
  spark.addEventListener("pointerleave", () => { hover = null; byId("spark-readout").textContent = "Hover or focus the line to read a price; the last 30 s are in the accent."; drawMarket(); });
  spark.addEventListener("focus", () => { hover = market.history.filter((x) => x.t >= Date.now() - SPAN_MS).length - 1; drawMarket(); });
  spark.addEventListener("blur", () => { hover = null; drawMarket(); });
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

  /** @param {WalletView} w */
  function drawAllowance(w) {
    byId("allowance").replaceChildren(
      item("tickets left", `${w.tickets.left} of ${w.tickets.exported}`, { mono: true }),
      item("value cap", formatWei(w.hotValueCapWei), { mono: true, title: formatWeiExact(w.hotValueCapWei) }),
      item("fee cap", formatWei(w.hotFeeCapWei), { mono: true, title: formatWeiExact(w.hotFeeCapWei) }),
      item("target", shortHex(w.allowedTarget, 6, 4), { mono: true, title: w.allowedTarget }),
    );
    const loss = maxLossWei(w);
    const maxLoss = byId("max-loss");
    maxLoss.textContent = `Max loss: ${formatWei(loss)}, to ${shortHex(w.allowedTarget)} only (tickets left times value cap plus fee cap).`;
    maxLoss.title = `exact: ${formatWeiExact(loss)}`;
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
    const results = await screen.run(fire, () => fireTranches(api, w, { tranche, mempool }));
    if (results) logFired(results, tranche, mempool);
  }
  fire.addEventListener("click", () => { logLine("Fire pressed."); return fireNow(); });

  compromised.addEventListener("click", async () => {
    const w = screen.wallet();
    if (!w) return;
    logLine("Server compromised: it sends two payments outside the hot policy.", true);
    const sent = await screen.run(compromised, () => compromisedPayments(api, w, screen.mempool()));
    if (!sent) return;
    logCompromised(sent);
    const words = sent.map((s) => (s.result.status === "fulfilled" ? "admitted" : refusalOf(s.result.reason?.body?.simulation?.violations)?.words ?? errorText(s.result.reason)));
    screen.notice(`Server compromised: ${words.join("; ")}.`);
  });

  const mempoolInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[name="mempool"]')]);
  play.addEventListener("click", () => screen.run(play, () => agentScene(api, screen.address, {
    step: (text) => { screen.notice(`Scene: ${text}`); logLine(`Scene: ${text}`); },
    mempool: (m) => { for (const i of mempoolInputs) i.checked = i.value === m; },
    trigger: () => { armed.checked = false; dropPrice(); logLine(`Rule fired: the mock price fell more than ${RULE.dropPct} % in 30 s.`, true); },
    fired: (results, tranche) => logFired(results, tranche, "alt"),
    compromised: logCompromised,
  }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error")));

  screen.onWallet(drawAllowance);
  screen.onRecords((records) => {
    drawSetAside(byId("agent-set-aside"), records, screen.wallet());
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
