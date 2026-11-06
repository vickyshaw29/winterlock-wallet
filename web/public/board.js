// Draws the lane board from lanes.js rows: lane (nonce key), leaf, action, amount, gas, the row's status beside the
// backend's timeline steps, and under a clicked row its admission report or refusal reason, receipt, timeline and
// explorer link. Table cells stay table cells (hairlines intact); a div inside lays out their parts.
// Written with Claude Code (AI) for Vicky.
import { el } from "./dom.js";
import { formatClock, formatGas, formatOffset, formatWeiExact, shortHex, toBigInt } from "./format.js";
import { maxCostOf } from "./lanes.js";

/** @import { Row } from "./lanes.js" */

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
  const body = el("tbody");
  const table = el("table", { class: "lanes" },
    el("caption", { class: "visually-hidden", text: "Lanes: one row per transaction, newest first" }),
    el("thead", {}, el("tr", {}, ...["Lane", "Leaf", "Action", "Amount", "Gas", "Status"].map((h) => el("th", { scope: "col", text: h })))),
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
    if (rows.length === 0) {
      body.append(el("tr", {}, el("td", { colSpan: 6, class: "empty", text: opts.empty ?? "No lanes yet." })));
      return;
    }
    for (const r of rows) {
      body.append(rowEl(r));
      if (r.hash === selected) body.append(detailEl(r));
    }
    if (focused) /** @type {HTMLElement | null} */ (body.querySelector(`tr[data-hash="${CSS.escape(focused)}"]`))?.focus();
  }

  /** @param {Row} r */
  function rowEl(r) {
    const tr = el("tr", {
      class: `lane-row status-${r.status.key}${r.hash === selected ? " selected" : ""}`, tabIndex: 0, "data-hash": r.hash,
      "aria-expanded": r.hash === selected ? "true" : "false", title: "Show the admission report",
      onclick: (/** @type {MouseEvent} */ ev) => { if (!(ev.target instanceof HTMLAnchorElement || ev.target instanceof HTMLButtonElement)) select(r.hash); },
      // only the row itself: Enter or Space on its explorer link or retry button must follow that, not toggle the row
      onkeydown: (/** @type {KeyboardEvent} */ ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); select(r.hash); } },
    });
    const links = [];
    if (r.retryOf) links.push(linkButton(`retry of lane ${r.retryOfLane ?? shortHex(r.retryOf)}`, r.retryOf, "not re-signed: a fresh leaf on a fresh lane"));
    if (r.retriedAs) links.push(linkButton(`retried as lane ${r.retriedAsLane ?? shortHex(r.retriedAs)}`, r.retriedAs, ""));
    tr.append(
      el("td", { class: "mono lane", "data-label": "Lane", title: r.epoch === null ? undefined : `nonce key: epoch ${r.epoch}, leaf ${r.leaf}` }, r.lane),
      el("td", { class: "mono", "data-label": "Leaf" }, String(r.leaf), r.mode === "hot" ? el("span", { class: "tag", text: "hot" }) : null),
      el("td", { class: "action", "data-label": "Action" }, el("div", { class: "cell-flex" }, el("span", { text: r.action }),
        r.mempool ? el("span", { class: `tag${r.mempool === "public" ? " tag-public" : ""}`, text: r.mempool }) : null, ...links)),
      el("td", { class: "mono num", "data-label": "Amount", title: r.amountExact, text: r.amount }),
      el("td", { class: "mono num", "data-label": "Gas", title: "verify-frame gas", text: r.gas }),
      el("td", { class: "status-cell", "data-label": "Status" }, el("div", { class: "cell-flex" },
        el("strong", { class: `row-status row-status-${r.status.key}`, text: r.status.label }),
        r.refusal ? el("span", { class: "refusal", title: r.refusal.reason }, r.refusal.words, el("span", { class: "mono muted", text: ` (${r.refusal.reason})` })) : null,
        timelineEl(r),
        el("a", { class: "explorer", href: r.explorerUrl, target: "_blank", rel: "noopener noreferrer", text: "explorer" }))),
    );
    return tr;
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
    /** @param {Row[]} next */
    render(next) { rows = next; draw(); },
    get selected() { return selected; },
    select,
  };
}

/**
 * The timeline: the backend's steps, each in its own words with its time after the first, the latest marked. The
 * row's status is drawn beside it, never written over a step (an expiry that was retried keeps "retried").
 * @param {Row} r
 */
function timelineEl(r) {
  const ol = el("ol", { class: "steps", "aria-label": "timeline" });
  r.steps.forEach((s, i) => {
    const latest = i === r.steps.length - 1;
    ol.append(el("li", { class: `step step-${s.key}${latest ? " current" : ""}`, title: s.block !== null ? `block ${s.block}` : undefined },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "step-label", text: s.label }),
      el("span", { class: "mono when", text: i === 0 ? "" : formatOffset(s.at) })));
  });
  return ol;
}

/**
 * What a clicked row shows: the refusal reason or the admission report first, then the rest of the record.
 * @param {Row} r
 */
function detailEl(r) {
  const rec = r.record;
  const sections = [];
  if (r.reasons.length) {
    sections.push(el("div", { class: "reason" }, el("h4", { text: rec.status === "Refused" ? "Refused because" : rec.status === "OnChain" ? "Notes" : "Why" }),
      el("ul", {}, ...r.reasons.map((x) => el("li", { class: "mono", text: x })))));
  }
  const adm = rec.admission;
  if (adm) {
    sections.push(el("div", {}, el("h4", { text: "Admission report" }), el("p", { class: "mono", text: adm.summary }),
      el("ul", { class: "checks" }, ...adm.checks.map((c) => el("li", { class: `check check-${c.verdict}` },
        el("span", { class: "mono verdict", text: c.verdict }), el("span", { class: "mono", text: c.rule }),
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
      el("p", { class: "mono", text: `block ${Number(BigInt(receipt.blockNumber))}, ${receipt.status}${receipt.gasUsed ? `, gas used ${formatGas(receipt.gasUsed)}` : ""}` }),
      frames.length ? el("ol", { class: "frames", start: 0 }, ...frames.map((f, i) => el("li", { class: "mono",
        text: `frame ${i} ${["expiry", "verify"][i] ?? "sender"}: ${f.status}, ${formatGas(toBigInt(f.gasUsed?.execution))} gas` }))) : null));
  }
  sections.push(el("div", {}, el("h4", { text: "Timeline" }),
    el("ol", { class: "raw-timeline" }, ...rec.timeline.map((t) => el("li", {}, el("span", { class: "mono when", text: formatClock(t.at) }), el("span", { text: t.status }))))));
  const maxCost = maxCostOf(rec);
  sections.push(el("dl", { class: "facts" },
    ...[["transaction", rec.txHash], ["lane (nonce key)", rec.nonceKey], ["leaf", String(rec.leaf)], ["mode", rec.mode], ["mempool", rec.mempool ?? "unknown"],
      ["to", rec.to ?? "unknown"], ["verify gas", formatGas(rec.simulation?.verifyGas ?? null)], ["deadline", rec.deadline ? formatClock(rec.deadline) : "—"],
      ...(maxCost === null ? [] : [["max cost (the backend's)", formatWeiExact(maxCost)]])]
      .map(([k, v]) => el("div", { class: "kv" }, el("dt", { text: k }), el("dd", { class: "mono", text: v })))));
  sections.push(el("p", {}, el("a", { href: r.explorerUrl, target: "_blank", rel: "noopener noreferrer", text: "Open in the explorer" }),
    el("span", { class: "muted", text: " (its history is in memory: a restart clears it)" })));
  return el("tr", { class: "detail-row" }, el("td", { colSpan: 6 }, el("div", { class: "detail" }, ...sections)));
}
