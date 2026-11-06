// Draws the lane board as a ruled ledger (design note 1-ledger.md, section 4) from lanes.js rows, with the cancellation
// stamp on every final line and the voucher under a clicked one.
// Written with Claude Code (AI) for Vicky.
// Each line: lane (nonce key) and leaf as red serials, action, amount (decimal points aligned; a double rule when
// included, a strike when no money moved), gas, and the status beside the backend's timeline steps; on a final line the
// stamp, "burned, in block N" from the chain or "burned, by the signer". The voucher: refusal reason or admission
// report, receipt, timeline, facts, explorer link. A rotation rules the ledger off between epochs.
// The moments, each once per lane and never on load: a lane that appears is written (the ledger line); a lane that
// becomes final gets its stamp landing and its rule drawn. CSS makes them instant under prefers-reduced-motion.
// Table cells stay table cells (hairlines intact); a div inside lays out their parts.
import { el } from "./dom.js";
import { formatClock, formatGas, formatOffset, formatWeiExact, shortHex, toBigInt } from "./format.js";
import { amountMark, epochRule, maxCostOf, splitAmount, stampOf, tiltOf } from "./lanes.js";

/** @import { Row } from "./lanes.js" */

/** The longest lane the lane column fits at its usual width: an epoch-0 lane of a tree up to height 20 (0xfffff). */
export const LANE_FITS = 7;

/**
 * @param {HTMLElement} root
 * @param {{ onSelect?: (hash: string | null) => void, empty?: string }} [opts]
 */
export function createBoard(root, opts = {}) {
  /** @type {string | null} */
  let selected = null;
  /** @type {Row[]} */
  let rows = [];
  let drawn = "";
  /** hash -> whether the lane was final at the last render: what the moments compare against */
  const seen = new Map();
  let primed = false; // the first render only learns the lanes: nothing moves on load
  /** lanes whose moment the next draw plays: written (new on the board), stamped (just became final) */
  const writing = new Set(), landing = new Set();
  /** @type {ReturnType<typeof setInterval> | null} ticks the live "expiry in N s" of pending lanes */
  let ticker = null;

  const body = el("tbody");
  const table = el("table", { class: "lanes" },
    el("caption", { class: "visually-hidden", text: "Lanes: one line per transaction, newest first. Select a line for its admission report." }),
    el("colgroup", {}, ...["w-lane", "w-leaf", "", "w-amount", "w-gas", "w-status"].map((c) => el("col", { class: c || undefined }))),
    el("thead", {}, el("tr", {}, ...["Lane", "Leaf", "Action", "Amount", "Gas", "Status"].map((h, i) => el("th", { scope: "col", class: i === 3 || i === 4 ? "r" : undefined, text: h })))),
    body);
  root.replaceChildren(el("div", { class: "table-wrap" }, table));

  /** @param {string | null} hash */
  function select(hash) {
    selected = selected === hash ? null : hash;
    draw(true);
    opts.onSelect?.(selected);
  }

  /** @param {boolean} [force] */
  function draw(force = false) {
    const sig = `${selected}|${rows.map((r) => `${r.hash}:${r.record.status}:${r.record.updatedAt}`).join(",")}`;
    if (!force && sig === drawn) return; // nothing changed since the last poll: keep focus and scroll where they are
    drawn = sig;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.hash : undefined;
    body.replaceChildren();
    // after a rotation a lane carries its epoch above the leaf (0x1000003f7, not 0x3f7): the lane column widens to fit
    table.classList.toggle("long-lanes", rows.some((r) => r.lane.length > LANE_FITS));
    if (rows.length === 0) {
      body.append(el("tr", {}, el("td", { colSpan: 6, class: "empty", text: opts.empty ?? "No lanes yet." })));
    } else {
      // every ETH figure padded with hidden zeros to the longest fraction, so the decimal points line up
      const decimals = Math.max(0, ...rows.map((r) => splitAmount(r.amount)).filter((a) => a.unit === "ETH").map((a) => a.decimals));
      rows.forEach((r, i) => {
        const rule = epochRule(rows, i);
        if (rule) body.append(el("tr", { class: "ruled" }, el("td", { colSpan: 6, text: rule })));
        body.append(rowEl(r, decimals));
        if (r.hash === selected) body.append(detailEl(r));
      });
    }
    writing.clear();
    landing.clear();
    if (focused) /** @type {HTMLElement | null} */ (body.querySelector(`tr[data-hash="${CSS.escape(focused)}"]`))?.focus();
    tick();
  }

  /**
   * The live expiry counts, once a second: only while a pending lane's deadline is ahead; the ticker stops by itself
   * when every one is behind, and on stop(). It keeps the spans of the latest draw, so it needs nothing else.
   */
  function tick() {
    stopTicker();
    const spans = [...body.querySelectorAll("[data-deadline]")];
    const ahead = () => spans.some((s) => Number(s.getAttribute("data-deadline")) * 1000 > Date.now());
    if (!ahead()) return;
    ticker = setInterval(() => {
      for (const s of spans) s.textContent = expiryText(Number(s.getAttribute("data-deadline")));
      if (!ahead()) stopTicker();
    }, 1_000);
  }
  function stopTicker() { if (ticker) clearInterval(ticker); ticker = null; }

  /**
   * @param {Row} r
   * @param {number} decimals the longest ETH fraction on the board
   */
  function rowEl(r, decimals) {
    const tr = el("tr", {
      class: `lane-row status-${r.status.key}${r.hash === selected ? " selected" : ""}${writing.has(r.hash) ? " m-writing" : ""}`,
      tabIndex: 0, "data-hash": r.hash, "aria-expanded": r.hash === selected ? "true" : "false", title: "Show the admission report",
      onclick: (/** @type {MouseEvent} */ ev) => { if (!(ev.target instanceof HTMLAnchorElement || ev.target instanceof HTMLButtonElement)) select(r.hash); },
      // only the row itself: Enter or Space on its explorer link or retry button must follow that, not toggle the row
      onkeydown: (/** @type {KeyboardEvent} */ ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); select(r.hash); } },
    });
    const links = [];
    if (r.retryOf) links.push(linkButton(`retry of lane ${r.retryOfLane ?? shortHex(r.retryOf)}`, r.retryOf, "not re-signed: a fresh leaf on a fresh lane"));
    if (r.retriedAs) links.push(linkButton(`retried as lane ${r.retriedAsLane ?? shortHex(r.retriedAs)}`, r.retriedAs, ""));
    const stamp = stampOf(r);
    tr.append(
      el("td", { class: "lane", "data-label": "Lane", title: r.epoch === null ? undefined : `nonce key: epoch ${r.epoch}, leaf ${r.leaf}` },
        el("span", { class: "sn", text: r.lane })),
      el("td", { class: "leaf", "data-label": "Leaf" }, el("span", { class: "sn", text: String(r.leaf) }), r.mode === "hot" ? el("span", { class: "tag hot", text: "hot" }) : null),
      el("td", { class: "action", "data-label": "Action" }, el("div", { class: "cell-flex" }, el("span", { text: r.action }),
        r.mempool ? el("span", { class: `tag${r.mempool === "public" ? " tag-public" : ""}`, text: r.mempool }) : null, ...links)),
      el("td", { class: "amount num", "data-label": "Amount", title: r.amountExact }, amountEl(r, decimals)),
      el("td", { class: "gas num", "data-label": "Gas", title: "verify-frame gas", text: r.gas }),
      el("td", { class: "status-cell", "data-label": "Status" }, el("div", { class: "st" },
        el("div", { class: "st-main" },
          el("p", { class: "st-words" }, el("strong", { class: `row-status row-status-${r.status.key}`, text: r.status.label }),
            el("a", { class: "explorer", href: r.explorerUrl, target: "_blank", rel: "noopener noreferrer", text: "explorer" })),
          r.refusal ? el("p", { class: "refusal", title: r.refusal.reason }, r.refusal.words, el("span", { class: "code", text: ` (${r.refusal.reason})` })) : null,
          timelineEl(r)),
        stamp ? el("div", { class: "st-mark" }, stampEl(r, stamp)) : null)),
    );
    return tr;
  }

  /**
   * The amount: its figure, hidden zeros up to the board's longest fraction, the unit; the rule (or the strike) under
   * the figure, drawn in the draw where the lane became final.
   * @param {Row} r
   * @param {number} decimals
   */
  function amountEl(r, decimals) {
    const { fig, unit, decimals: have } = splitAmount(r.amount);
    const missing = unit === "ETH" ? decimals - have : 0;
    const pad = missing > 0 ? `${have === 0 ? "." : ""}${"0".repeat(missing)}` : "";
    const mark = amountMark(r.record);
    const words = mark === "final" ? "included: the money moved" : mark === "void" ? "no money moved" : mark === "single" ? "included, no receipt yet" : "pending";
    return el("span", { class: ["amt", mark, mark && landing.has(r.hash) ? "m-draw" : null].filter(Boolean).join(" "), "aria-label": `${r.amount}, ${words}` },
      el("span", { class: "fig", text: fig }), pad ? el("span", { class: "pad", "aria-hidden": "true", text: pad }) : null,
      unit ? " " : null, unit ? el("span", { class: "unit", text: unit }) : null);
  }

  /**
   * @param {Row} r
   * @param {import("./lanes.js").Stamp} s
   */
  function stampEl(r, s) {
    const title = s.by === "chain"
      ? "The chain consumed this lane's nonce key: the leaf can never sign again."
      : "It never reached the chain: the signer journals the leaf as burned and never signs with it again.";
    return el("span", { class: `stamp tilt-${tiltOf(r.leaf)}${landing.has(r.hash) ? " m-landing" : ""}`, title }, "burned", " ", el("small", { text: s.words }));
  }

  /**
   * @param {string} text
   * @param {string} hash
   * @param {string} title
   */
  function linkButton(text, hash, title) {
    return el("button", { type: "button", class: "link", title: title || undefined, text, onclick: () => { selected = null; select(hash); focusRow(hash); } });
  }

  /** @param {string} hash */
  function focusRow(hash) {
    body.querySelector(`tr[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  return {
    /**
     * New rows from a poll. The first call only learns the lanes; after it, a lane not seen before is written and a
     * lane that became final is stamped, once each.
     * @param {Row[]} next
     */
    render(next) {
      for (const r of next) {
        const was = seen.get(r.hash);
        if (primed && was === undefined) writing.add(r.hash);
        if (primed && r.status.final && was !== true) landing.add(r.hash);
        seen.set(r.hash, r.status.final);
      }
      primed = true;
      rows = next;
      draw();
    },
    get selected() { return selected; },
    select,
    /** stops the live expiry counts */
    stop: stopTicker,
  };
}

/**
 * "expiry in 84 s" for a pending lane's deadline (unix seconds), as the ring in its timeline; "expiry passed" once the
 * deadline is behind (the backend then decides it from the chain).
 * @param {number} deadline
 */
export function expiryText(deadline) {
  const s = Math.ceil(deadline - Date.now() / 1000);
  if (s <= 0) return "expiry passed";
  return s < 120 ? `expiry in ${s} s` : `expiry in ${Math.round(s / 60)} min`;
}

/**
 * The timeline: the backend's steps, each in its own words with its time after the first, the latest marked; then, on
 * a pending lane with a deadline, the live expiry as a ring. The row's status is drawn beside it, never written over a
 * step (an expiry that was retried keeps "retried").
 * @param {Row} r
 */
function timelineEl(r) {
  const ol = el("ol", { class: "steps", "aria-label": "timeline" });
  // "key used" repeats what the stamp says once an included step follows it; it stays when it is the only chain step
  const landed = r.steps.some((s) => s.key === "included" || s.key === "reverted");
  const shown = r.steps.filter((s) => !(landed && s.key === "key"));
  shown.forEach((s, i) => {
    const latest = i === shown.length - 1;
    ol.append(el("li", { class: `step step-${s.key}${latest ? " current" : ""}`, title: s.block !== null ? `block ${s.block}` : undefined },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "step-label", text: s.label }),
      i === 0 ? null : el("span", { class: "when", text: formatOffset(s.at) })));
  });
  const deadline = r.record.deadline;
  if (r.pending && typeof deadline === "number") {
    ol.append(el("li", { class: "wait" }, el("span", { class: "dot", "aria-hidden": "true" }), el("span", { "data-deadline": String(deadline), text: expiryText(deadline) })));
  }
  return ol;
}

/**
 * The voucher under a clicked line: the refusal reason or the admission report first, then the rest of the record.
 * @param {Row} r
 */
function detailEl(r) {
  const rec = r.record;
  const sections = [];
  if (r.reasons.length) {
    sections.push(el("div", { class: "reason" }, el("h4", { text: rec.status === "Refused" ? "Refused because" : rec.status === "OnChain" ? "Notes" : "Why" }),
      el("ul", {}, ...r.reasons.map((x) => el("li", { text: x })))));
  }
  const adm = rec.admission;
  if (adm) {
    sections.push(el("div", {}, el("h4", { text: "Admission report" }), el("p", { text: adm.summary }),
      el("ul", { class: "checks" }, ...adm.checks.map((c) => el("li", { class: `check check-${c.verdict}` },
        el("span", { class: "verdict", text: c.verdict }), el("span", { text: c.rule }),
        c.frameIndex !== undefined ? el("span", { class: "muted", text: `frame ${c.frameIndex}` }) : null,
        c.detail ? el("span", { text: c.detail }) : null)))));
  } else {
    sections.push(el("div", {}, el("h4", { text: "Admission report" }),
      el("p", { class: "muted", text: rec.mempool === "public" ? "none: the public mempool keeps no admission record" : "none yet (the sidecar keeps it in memory; a restart drops it)" })));
  }
  const receipt = rec.receipt;
  if (receipt) {
    const frames = receipt.frameReceipts ?? [];
    sections.push(el("div", {}, el("h4", { text: "Receipt" }),
      el("p", { class: "num", text: `block ${Number(BigInt(receipt.blockNumber))}, ${receipt.status}${receipt.gasUsed ? `, gas used ${formatGas(receipt.gasUsed)}` : ""}` }),
      frames.length ? el("ol", { class: "frames num", start: 0 }, ...frames.map((f, i) => el("li", {
        text: `frame ${i} ${["expiry", "verify"][i] ?? "sender"}: ${f.status}, ${formatGas(toBigInt(f.gasUsed?.execution))} gas` }))) : null));
  }
  sections.push(el("div", {}, el("h4", { text: "Timeline" }),
    el("ol", { class: "raw-timeline" }, ...rec.timeline.map((t) => el("li", {}, el("span", { class: "when", text: formatClock(t.at) }), el("span", { text: t.status }))))));
  const maxCost = maxCostOf(rec);
  sections.push(el("dl", { class: "facts" },
    ...[["transaction", rec.txHash], ["lane (nonce key)", rec.nonceKey], ["leaf", String(rec.leaf)], ["mode", rec.mode], ["mempool", rec.mempool ?? "unknown"],
      ["to", rec.to ?? "unknown"], ["verify gas", formatGas(rec.simulation?.verifyGas ?? null)], ["deadline", rec.deadline ? formatClock(rec.deadline) : "—"],
      ...(maxCost === null ? [] : [["max cost (the backend's)", formatWeiExact(maxCost)]])]
      .map(([k, v]) => el("div", { class: "kv" }, el("dt", { text: k }), el("dd", { class: "num", text: v })))));
  sections.push(el("p", {}, el("a", { href: r.explorerUrl, target: "_blank", rel: "noopener noreferrer", text: "Open in the explorer" }),
    el("span", { class: "muted", text: " (its history is in memory: a restart clears it)" })));
  return el("tr", { class: "detail-row" }, el("td", { colSpan: 6 }, el("div", { class: "detail" }, ...sections)));
}
