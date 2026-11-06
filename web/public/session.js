// Session screen (Ledger direction, design note 1-ledger.md): the dapp's 6 by 6 board of punch positions (each click one
// hot send of 0 wei on its own lane), the move tally, the session sheet that grants tickets (the plan shown before Grant;
// no grant while the device journal is lost), the card with its count and stub strip, Play scene. Runs start() on load;
// the tests run it on a fake document. Written with Claude Code (AI) for Vicky.
//   A cell's states (data-state): none (no move yet), sending, admitted (in flight), included, refused, expired. Its
//   moments, each once, on the action or the change it answers and never on load: punched when its move is sent; its
//   ticket's leaf printed under the hole when admitted; a violet ring when included; a slash when refused or expired.
import { ApiError } from "./api.js";
import { byId, el, item } from "./dom.js";
import { SESSION_REQUEST, cutTickets, errorText, grantCount, moveBody, send, uncutHotLeaves } from "./flows.js";
import { formatWei, formatWeiExact, shortHex } from "./format.js";
import { statusOf } from "./lanes.js";
import { createStubStrip, leafStates, reducedMotion, rollNumber, stubsOf } from "./register.js";
import { sessionScene } from "./scenes.js";
import { drawSetAside, mountScreen, planView } from "./ui.js";

/** @import { SendAnswer, TxRecord, WalletView } from "./api.js" */
/** @import { MountOptions } from "./ui.js" */

/** The board's columns, printed over the top; rows are numbered 1 to 6 down the side. */
const COLS = "ABCDEF";

/** States in which a cell holds a move: it cannot be played again. Refused and expired cells can (a fresh ticket). */
const HOLDS = ["sending", "admitted", "included"];

/**
 * Plays a moment class once on a part of a cell: added now, removed when its animation ends. Skipped under reduced
 * motion, where the state's look changes at once. Where no animation runs (the tests' fake DOM) the class just stays.
 * @param {Element} node
 * @param {string} cls m-punch, m-print, m-ring or m-void
 */
export function moment(node, cls) {
  if (reducedMotion()) return;
  node.classList.add(cls);
  node.addEventListener("animationend", () => node.classList.remove(cls), { once: true });
}

/**
 * The state a lane's record puts its cell in: a reverted move still used its ticket on chain (included); an unknown one
 * is still in flight (admitted).
 * @param {TxRecord} rec
 */
export function cellState(rec) {
  const key = statusOf(rec).key;
  return key === "reverted" ? "included" : key === "unknown" ? "admitted" : key;
}

/**
 * Mounts the shared parts and wires the board and the session sheet. Null when there is no wallet to show.
 * @param {MountOptions} [opts]
 */
export async function start(opts = {}) {
  const screen = await mountScreen({ empty: "No lanes yet. Grant the session, then play moves.", ...opts });
  if (!screen) return null;
  const { api, address } = screen;
  const grid = byId("grid"), sheet = byId("sheet"), grant = byId("grant", HTMLButtonElement), play = byId("play", HTMLButtonElement);
  const strip = createStubStrip(byId("stubs", HTMLOListElement));
  /** cell index -> the move's transaction hash */
  const cellTx = new Map();
  let moves = 0, declined = false;
  /** the next wallet draw rolls the ticket count: a move or a grant just moved it (a poll alone never rolls it) */
  let rollNext = false;
  /** @type {HTMLButtonElement[]} */
  const cells = [];
  /** the punch position (the circle) and the ticket printed under it, per cell */
  /** @type {HTMLElement[]} */
  const holes = [];
  /** @type {HTMLElement[]} */
  const tickets = [];
  /** "A1" to "F6", what the notices call each cell */
  /** @type {string[]} */
  const labels = [];

  // The printed heads are for the eye; a screen reader hears each button's own label, "move A1".
  const head = (/** @type {string} */ text, /** @type {string} */ cls = "head") => el("span", { class: cls, "aria-hidden": "true", text });
  grid.append(head(""), ...[...COLS].map((c) => head(c)));
  for (let i = 0; i < 36; i++) {
    if (i % 6 === 0) grid.append(head(String(i / 6 + 1), "head row-n"));
    const label = `${COLS[i % 6]}${Math.floor(i / 6) + 1}`;
    const hole = el("span", { class: "hole", "aria-hidden": "true" }), ticket = el("span", { class: "punch-sn", "aria-hidden": "true" });
    const cell = el("button", { type: "button", class: "cell", "aria-label": `move ${label}` }, hole, ticket);
    cell.addEventListener("click", () => move(i));
    cells.push(cell); holes.push(hole); tickets.push(ticket); labels.push(label);
    grid.append(cell);
  }

  /**
   * Prints a move's ticket (its leaf, the serial the stub strip shows) under the cell's hole; pressed in when new.
   * @param {number} i
   * @param {unknown} leaf none: the cell holds no ticket
   */
  function printTicket(i, leaf) {
    const t = /** @type {HTMLElement} */ (tickets[i]);
    const text = typeof leaf === "number" ? String(leaf) : "";
    if (t.textContent === text) return;
    t.textContent = text;
    if (text) moment(t, "m-print");
  }

  /**
   * A move's answer on its cell: admitted (the cell holds the lane), refused (its ticket burned), or not sent.
   * @param {number} i
   * @param {SendAnswer | null} answer
   * @param {unknown} error
   */
  function markCell(i, answer, error) {
    const cell = /** @type {HTMLButtonElement} */ (cells[i]), hole = /** @type {HTMLElement} */ (holes[i]), label = labels[i];
    const was = cell.dataset.state;
    delete cell.dataset.state;
    if (answer) {
      moves++;
      byId("moves").textContent = String(moves);
      cellTx.set(i, answer.txHash.toLowerCase());
      cell.dataset.state = "admitted";
      cell.title = `lane ${answer.nonceKeys[0]}, ticket ${answer.leaf}: admitted`;
      if (was !== "sending") moment(hole, "m-punch"); // a scene's move is punched when its answer comes
      printTicket(i, answer.leaf);
      rollNext = true; // the ticket left the session
      screen?.notice(`Move ${label}: ticket ${answer.leaf} on lane ${answer.nonceKeys[0]}, admitted.`);
    } else if (error instanceof ApiError) {
      const hash = error.body?.txHash;
      if (error.code === "refused" && hash) {
        cellTx.set(i, String(hash).toLowerCase());
        cell.dataset.state = "refused";
        printTicket(i, error.body?.leaf); // the ticket it burned
        moment(hole, "m-void"); // refused at once: punched and voided together
      }
      if (error.status !== 503) {
        screen?.notice(error.code === "tickets_exhausted"
          ? `Move ${label} not sent: the session's tickets have run out.`
          : `Move ${label}: ${errorText(error)}`, "error");
      }
    }
    lockCells();
  }

  /**
   * One click, one move: through screen.run, so a stalled chain raises the banner and turns sending off.
   * @param {number} i
   */
  async function move(i) {
    const w = screen?.wallet();
    const cell = /** @type {HTMLButtonElement} */ (cells[i]);
    if (!screen || !w) return;
    cell.dataset.state = "sending";
    printTicket(i, null); // a replayed cell drops its burned ticket; the new one prints when admitted
    moment(/** @type {HTMLElement} */ (holes[i]), "m-punch");
    lockCells();
    /** @type {unknown} */
    let error = null;
    const r = await screen.run(null, () => send(api, address, moveBody(w, screen.mempool())), (e) => { error = e; });
    markCell(i, r ?? null, error);
  }

  /** What Grant would cut: none while the ticket device cannot sign (a grant is a cut), else grantCount. */
  const grantable = (/** @type {WalletView} */ w) => (screen.deviceIssue() ? 0 : grantCount(w));

  /** The parallel-lanes plan for the grant: every granted ticket pending at once, a move of 0 wei each. */
  const plan = planView(api, address, byId("grant-plan"), (w) => {
    const n = grantable(w);
    return declined || n === 0 ? null : { n, mode: "hot", valueWei: "0", to: w.allowedTarget };
  }, { tickets: { holder: "in the session", none: "No tickets in the session yet: Grant cuts them." } });

  /**
   * The stub strip: the tickets cut this epoch, each with its state and the next one ringed (register.js); none while
   * the ticket device cannot sign, since then no stub's state is known.
   */
  function drawStubs() {
    const w = screen?.wallet();
    if (!w) return;
    strip.draw(screen?.deviceIssue() ? [] : stubsOf(w, leafStates(w, screen?.records() ?? [])), String(w.epoch));
  }

  /** @param {WalletView} w */
  function drawWallet(w) {
    const issue = screen?.deviceIssue() ?? null;
    const n = grantable(w);
    byId("request").replaceChildren(
      item("actions", String(SESSION_REQUEST), { num: true }),
      item("value each", "0 ETH", { num: true }),
      item("contract", shortHex(w.allowedTarget, 6, 4), { num: true, title: w.allowedTarget }),
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
    // the count: the number rolls like a numbering machine's wheel when a move or a grant moved it, never on a poll
    rollNumber(byId("left-n"), String(w.tickets.left), rollNext);
    rollNext = false;
    byId("left-of").textContent = ` of ${w.tickets.exported}`;
    byId("caps").replaceChildren(
      item("value per move", "0 ETH", { num: true }),
      item("account value cap", formatWei(w.hotValueCapWei), { num: true, title: formatWeiExact(w.hotValueCapWei) }),
      item("fee cap", formatWei(w.hotFeeCapWei), { num: true, title: formatWeiExact(w.hotFeeCapWei) }),
    );
    const leftNote = byId("left-note");
    leftNote.hidden = !!issue; // the device's own line says it, on this card
    leftNote.textContent = w.tickets.exported > 0 && w.tickets.left === 0
      ? "The tickets have run out: the next move is refused."
      : "tickets left; the chain burns each one on use";
    drawStubs();
    void plan.update(w);
  }

  /** A cell that holds a move stays played; one whose move was refused, expired or never sent can be played again. */
  function lockCells() {
    for (const c of cells) c.disabled = HOLDS.includes(c.dataset.state ?? "");
  }

  grant.addEventListener("click", async () => {
    const w = screen.wallet();
    if (!w) return;
    const n = grantable(w);
    if (n === 0) return; // off already; never a cut while the device cannot sign
    const r = await screen.run(grant, () => cutTickets(api, address, n));
    if (r) {
      rollNext = true; // the stubs print in by themselves (register.js), left to right
      screen.notice(`Granted ${r.count} ticket${r.count === 1 ? "" : "s"}: leaves ${r.from} to ${r.to}.`);
    }
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
    const free = cells.map((c, i) => i).filter((i) => !HOLDS.includes(cells[i]?.dataset.state ?? ""));
    return screen.run(play, () => sessionScene(api, address, {
      mempool: screen.mempool(),
      step: (text) => screen.notice(`Scene: ${text}`),
      moved: (k, o) => {
        const i = free[k];
        if (i !== undefined) markCell(i, o.answer, o.error);
        if (k === 0) void screen.refresh(); // the scene's grant reaches the card now (its stubs print in), not at the next poll
      },
    }), (e) => screen.notice(`Scene stopped: ${errorText(e)}`, "error"));
  });

  screen.onWallet(drawWallet);
  screen.onRecords((records) => {
    drawSetAside(byId("session-set-aside"), records, screen.wallet());
    const byHash = new Map(records.map((r) => [r.txHash.toLowerCase(), r]));
    let included = 0, refused = 0;
    for (const [i, hash] of cellTx) {
      const rec = byHash.get(hash), cell = cells[i], hole = holes[i];
      if (!rec || !cell || !hole) continue;
      const now = cellState(rec), was = cell.dataset.state;
      if (now === "included" || now === "refused" || now === "expired") {
        if (now === "included") included++; else refused++;
      }
      if (was === "sending") continue; // a replayed cell's new move is on its way; its old lane no longer speaks for it
      cell.dataset.state = now;
      cell.title = `lane ${rec.nonceKey}, ticket ${rec.leaf}: ${statusOf(rec).label}`;
      printTicket(i, rec.leaf);
      // the chain's mark on a move that was in flight: a violet ring when included, a slash when refused or expired
      if (was === "admitted" && now === "included") moment(hole, "m-ring");
      if (was === "admitted" && (now === "refused" || now === "expired")) moment(hole, "m-void");
    }
    lockCells();
    byId("moves-in").textContent = String(included);
    byId("moves-out").textContent = String(refused);
    drawStubs();
  });

  return { screen, stop: screen.stop };
}

if (typeof document !== "undefined" && typeof window !== "undefined") void start();
