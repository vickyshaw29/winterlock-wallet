// Session screen: the 6 by 6 dapp grid (each click one hot send of 0 wei on its own lane), the move counter, the session
// sheet that grants tickets (the plan shown before Grant; no grant while the device journal is lost), tickets_exhausted
// shown, Play scene. The page runs start() on load; the tests run it on a fake document.
// Written with Claude Code (AI) for Vicky.
import { ApiError } from "./api.js";
import { byId, el, item } from "./dom.js";
import { SESSION_REQUEST, cutTickets, errorText, grantCount, moveBody, send, uncutHotLeaves } from "./flows.js";
import { formatWei, formatWeiExact, shortHex } from "./format.js";
import { statusOf } from "./lanes.js";
import { sessionScene } from "./scenes.js";
import { drawSetAside, mountScreen, planView } from "./ui.js";

/** @import { SendAnswer, WalletView } from "./api.js" */
/** @import { MountOptions } from "./ui.js" */

/**
 * Mounts the shared parts and wires the grid and the session sheet. Null when there is no wallet to show.
 * @param {MountOptions} [opts]
 */
export async function start(opts = {}) {
  const screen = await mountScreen({ empty: "No lanes yet. Grant the session, then play moves.", ...opts });
  if (!screen) return null;
  const { api, address } = screen;
  const grid = byId("grid"), sheet = byId("sheet"), grant = byId("grant", HTMLButtonElement), play = byId("play", HTMLButtonElement);
  /** cell index -> the move's transaction hash */
  const cellTx = new Map();
  let moves = 0, declined = false;
  /** @type {HTMLButtonElement[]} */
  const cells = [];

  for (let i = 0; i < 36; i++) {
    const label = `${String.fromCharCode(65 + (i % 6))}${Math.floor(i / 6) + 1}`;
    const cell = el("button", { type: "button", class: "cell", text: label, "aria-label": `move ${label}` });
    cell.addEventListener("click", () => move(i, cell));
    cells.push(cell);
    grid.append(cell);
  }

  /**
   * A move's answer on its cell: admitted (the cell holds the lane), refused (its ticket burned), or not sent.
   * @param {number} i
   * @param {HTMLButtonElement} cell
   * @param {SendAnswer | null} answer
   * @param {unknown} error
   */
  function markCell(i, cell, answer, error) {
    delete cell.dataset.state;
    if (answer) {
      moves++;
      byId("moves").textContent = String(moves);
      cellTx.set(i, answer.txHash.toLowerCase());
      cell.dataset.state = "admitted";
      cell.title = `lane ${answer.nonceKeys[0]}, ticket ${answer.leaf}: admitted`;
      screen?.notice(`Move ${cell.textContent}: ticket ${answer.leaf} on lane ${answer.nonceKeys[0]}, admitted.`);
    } else if (error instanceof ApiError) {
      const hash = error.body?.txHash;
      if (error.code === "refused" && hash) { cellTx.set(i, String(hash).toLowerCase()); cell.dataset.state = "refused"; }
      if (error.status !== 503) {
        screen?.notice(error.code === "tickets_exhausted"
          ? `Move ${cell.textContent} not sent: the session's tickets have run out.`
          : `Move ${cell.textContent}: ${errorText(error)}`, "error");
      }
    }
    lockCells();
  }

  /**
   * One click, one move: through screen.run, so a stalled chain raises the banner and turns sending off.
   * @param {number} i
   * @param {HTMLButtonElement} cell
   */
  async function move(i, cell) {
    const w = screen?.wallet();
    if (!screen || !w) return;
    cell.dataset.state = "sending";
    lockCells();
    /** @type {unknown} */
    let error = null;
    const r = await screen.run(null, () => send(api, address, moveBody(w, screen.mempool())), (e) => { error = e; });
    markCell(i, cell, r ?? null, error);
  }

  /** What Grant would cut: none while the ticket device cannot sign (a grant is a cut), else grantCount. */
  const grantable = (/** @type {WalletView} */ w) => (screen.deviceIssue() ? 0 : grantCount(w));

  /** The parallel-lanes plan for the grant: every granted ticket pending at once, a move of 0 wei each. */
  const plan = planView(api, address, byId("grant-plan"), (w) => {
    const n = grantable(w);
    return declined || n === 0 ? null : { n, mode: "hot", valueWei: "0", to: w.allowedTarget };
  }, { tickets: { holder: "in the session", none: "No tickets in the session yet: Grant cuts them." } });

  /** @param {WalletView} w */
  function drawWallet(w) {
    const issue = screen?.deviceIssue() ?? null;
    const n = grantable(w);
    byId("request").replaceChildren(
      item("actions", String(SESSION_REQUEST), { mono: true }),
      item("value each", "0 ETH", { mono: true }),
      item("contract", shortHex(w.allowedTarget, 6, 4), { mono: true, title: w.allowedTarget }),
      item("expiry", "2 h, proposed (Level B)"),
    );
    grant.textContent = n > 0 ? `Grant ${n} ticket${n === 1 ? "" : "s"}` : "Grant tickets";
    grant.disabled = n === 0;
    const uncut = uncutHotLeaves(w);
    byId("grant-note").textContent = issue
      ? `${issue.text}. Until then no grant: it would cut tickets, and a new journal would re-sign used ones.`
      : n === 0
        ? "The hot band has no uncut leaf left: rotate on the cold device to start a new band."
        : n < SESSION_REQUEST ? `The hot band has ${uncut} uncut ${uncut === 1 ? "leaf" : "leaves"}, so the grant is ${n}, not ${SESSION_REQUEST}.` : `Cuts ${n} tickets for this session.`;
    sheet.hidden = declined || (!issue && w.tickets.left > 0 && n === 0);
    byId("left").textContent = `${w.tickets.left} of ${w.tickets.exported}`;
    byId("caps").replaceChildren(
      item("value per move", "0 ETH", { mono: true }),
      item("account value cap", formatWei(w.hotValueCapWei), { mono: true, title: formatWeiExact(w.hotValueCapWei) }),
      item("fee cap", formatWei(w.hotFeeCapWei), { mono: true, title: formatWeiExact(w.hotFeeCapWei) }),
    );
    const leftNote = byId("left-note");
    leftNote.hidden = !!issue; // the device's own line says it, on this card
    leftNote.textContent = w.tickets.exported > 0 && w.tickets.left === 0
      ? "The tickets have run out: the next move is refused."
      : "tickets left; the chain burns each one on use";
    void plan.update(w);
  }

  /** A cell that holds a move stays played; one whose move was refused, expired or never sent can be played again. */
  function lockCells() {
    for (const c of cells) c.disabled = ["sending", "admitted", "included"].includes(c.dataset.state ?? "");
  }

  grant.addEventListener("click", async () => {
    const w = screen.wallet();
    if (!w) return;
    const n = grantable(w);
    if (n === 0) return; // off already; never a cut while the device cannot sign
    const r = await screen.run(grant, () => cutTickets(api, address, n));
    if (r) screen.notice(`Granted ${r.count} ticket${r.count === 1 ? "" : "s"}: leaves ${r.from} to ${r.to}.`);
  });
  byId("decline").addEventListener("click", () => {
    declined = true;
    sheet.hidden = true;
    const w = screen.wallet();
    if (w) void plan.update(w); // nothing left to plan
    screen.notice("Session declined: no ticket cut.");
  });

  /** the scene's move k takes the k-th cell that holds no move yet */
  play.addEventListener("click", () => {
    const free = cells.map((c, i) => /** @type {const} */ ([c, i])).filter(([c]) => !["sending", "admitted", "included"].includes(c.dataset.state ?? ""));
    return screen.run(play, () => sessionScene(api, address, {
      mempool: screen.mempool(),
      step: (text) => screen.notice(`Scene: ${text}`),
      moved: (k, o) => { const f = free[k]; if (f) markCell(f[1], f[0], o.answer, o.error); },
    }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error"));
  });

  screen.onWallet(drawWallet);
  screen.onRecords((records) => {
    drawSetAside(byId("session-set-aside"), records, screen.wallet());
    const byHash = new Map(records.map((r) => [r.txHash.toLowerCase(), r]));
    let included = 0, refused = 0;
    for (const [i, hash] of cellTx) {
      const rec = byHash.get(hash), cell = cells[i];
      if (!rec || !cell) continue;
      const st = statusOf(rec);
      cell.dataset.state = st.key === "reverted" ? "included" : st.key === "unknown" ? "admitted" : st.key;
      cell.title = `lane ${rec.nonceKey}, ticket ${rec.leaf}: ${st.label}`;
      if (st.key === "included" || st.key === "reverted") included++;
      if (st.key === "refused" || st.key === "expired") refused++;
    }
    lockCells();
    byId("moves-in").textContent = String(included);
    byId("moves-out").textContent = String(refused);
  });

  return { screen, stop: screen.stop };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
