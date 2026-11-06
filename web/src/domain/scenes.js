// The spec's three scenes (Use cases), one Play scene button each, through the real API, with hooks for the page. A
// scene throws the first answer it does not expect (409, 422, 503); the refusals it shows are outcomes; it stops before
// any cut while the ticket device cannot sign (tickets cut but missing from its journal). No DOM.
// Written with Claude Code (AI) for Vicky.
import { ApiError } from "./api.js";
import {
  MAX_CUT, RULE, STUCK, compromisedPayments, cutTickets, deviceIssue, errorText, fireTranches, grantCount, moveBody, payBody, stuckBody, trancheWei,
  uncutHotLeaves,
} from "./flows.js";
import { formatWei } from "./format.js";

/** @import { Api, SendAnswer, SendBody, WalletView } from "./api.js" */
/** @import { Mempool } from "./flows.js" */

/**
 * @typedef {Object} SceneIo what a scene needs from its page; every hook but step is optional
 * @property {(text: string) => void} step progress, for the notice line
 * @property {(m: Mempool) => void} [mempool] sets the page's Mempool switch
 * @property {(on: boolean) => void} [offline] sets the cold device's Offline toggle
 * @property {(ms: number) => Promise<void>} [sleep] the pauses between steps (the tests pass a shorter one)
 * @property {() => void} [trigger] the agent: drops the mock price, so the rule's trigger shows
 * @property {(results: PromiseSettledResult<SendAnswer>[], tranche: bigint) => void} [fired] the agent's tranches
 * @property {(sent: { body: SendBody, result: PromiseSettledResult<SendAnswer> }[]) => void} [compromised]
 * @property {(k: number, outcome: Outcome) => void} [moved] the session: move k's outcome, for its grid cell
 */

/** @typedef {{ body: SendBody, answer: SendAnswer | null, error: unknown }} Outcome */

/** The story's numbers: the laptop cuts ten tickets a week; the agent holds twenty; eight moves within two seconds. */
export const SCENE = Object.freeze({ coldCut: 10, agentTickets: 20, moves: 8, moveGapMs: 250, pauseMs: 2_000 });

/** @param {SceneIo} io @param {number} ms */
const pause = (io, ms) => (io.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);

/** @param {SendBody} body @param {Promise<SendAnswer>} p @returns {Promise<Outcome>} */
const settle = (body, p) => p.then((answer) => ({ body, answer, error: null }), (error) => ({ body, answer: null, error }));

/** @param {unknown} e a refusal the scene is there to show: the backend's 422 (the leaf is burned) */
const isRefusal = (e) => e instanceof ApiError && e.status === 422;

/** @param {Outcome} o */
const said = (o) => (o.answer ? `admitted on lane ${o.answer.nonceKeys[0]} (ticket ${o.answer.leaf})` : errorText(o.error));

/**
 * Stops a scene before anything is sent or cut while the ticket device cannot sign: tickets were cut but are missing
 * from its journal (the backend answers 409 device_unusable to both), so cutting more is never offered.
 * @param {WalletView} w
 */
function requireDevice(w) {
  const issue = deviceIssue(w);
  if (issue) throw new Error(issue.text);
}

/**
 * Cuts tickets when fewer than `need` are left: up to the story's count, never more than the hot band has uncut.
 * @param {Api} api
 * @param {string} address
 * @param {WalletView} w
 * @param {number} need
 * @param {number} story
 * @param {SceneIo} io
 * @returns {Promise<WalletView>}
 */
async function ensureTickets(api, address, w, need, story, io) {
  requireDevice(w);
  if (w.tickets.left >= need) return w;
  const uncut = uncutHotLeaves(w);
  const count = Math.min(uncut, MAX_CUT, Math.max(story, need) - w.tickets.left);
  if (w.tickets.left + count < need) {
    throw new Error(`the scene needs ${need} tickets: ${w.tickets.left} left and ${uncut} hot leaves not cut yet. Rotate on the cold device for a new hot band.`);
  }
  io.step(`the cold device cuts ${count} ticket${count === 1 ? "" : "s"}`);
  await cutTickets(api, address, count);
  return api.wallet(address);
}

/**
 * A payment a ticket may send in a scene: a tenth of the value cap (1 wei at least). Hot tickets off is a stop.
 * @param {WalletView} w
 */
function sceneAmount(w) {
  const cap = BigInt(w.hotValueCapWei);
  if (cap === 0n) throw new Error("hot tickets are off: the value cap is 0 (the kill switch). Set a policy on the cold device first.");
  return cap / 10n > 0n ? cap / 10n : 1n;
}

/**
 * Hot and cold (spec): the phone pays three times while the cold device is offline, as parallel lanes, the third one
 * the stuck payment (its 4-second first deadline should miss its block, so it expires and is retried on a fresh
 * lane); then the mempool switches to public and the phone pays three more times, one after another, each shown
 * admitted or refused as the backend reports it.
 * @param {Api} api
 * @param {string} address
 * @param {SceneIo} io
 */
export async function hotColdScene(api, address, io) {
  let w = await api.wallet(address);
  requireDevice(w); // before the Offline toggle moves: nothing of this scene can run
  const need = 7; // two payments, the stuck one and its retry, three public payments
  if (w.tickets.left < need) io.offline?.(false); // cutting is the cold device's job
  w = await ensureTickets(api, address, w, need, SCENE.coldCut, io);
  const valueWei = sceneAmount(w);
  io.offline?.(true);
  io.mempool?.("alt");
  io.step(`cold device offline; the phone pays ${formatWei(valueWei)} three times on the alt mempool as parallel lanes, the third one the stuck payment`);
  const pay = payBody({ wallet: w, valueWei, mempool: "alt" });
  const stuck = stuckBody({ wallet: w, valueWei, mempool: "alt" });
  const alt = await Promise.all([pay, pay, stuck].map((b) => settle(b, api.send(address, b))));
  const bad = alt.find((o) => o.error !== null);
  if (bad) throw bad.error;
  io.step(`3 parallel lanes pending at once: ${alt.map((o) => o.answer?.nonceKeys[0]).join(", ")}; the stuck one's first deadline is ${STUCK.firstAttemptExpirySeconds} s, shorter than one 6 s block, so it should miss its block and expire, its ticket burned, and its one retry go out on a fresh lane`);
  await pause(io, SCENE.pauseMs);
  io.mempool?.("public");
  io.step("the mempool switches to public (one pending per sender: measured on the devnet: 1 of 8 admitted, block 5,738); the phone pays three more times");
  /** @type {Outcome[]} */
  const pub = [];
  for (let i = 1; i <= 3; i++) {
    const body = payBody({ wallet: w, valueWei, mempool: "public" });
    const o = await settle(body, api.send(address, body));
    if (o.error !== null && !isRefusal(o.error)) throw o.error;
    pub.push(o);
    io.step(`public mempool, payment ${i} of 3: ${said(o)}`);
  }
  io.step(`done. Public mempool: ${pub.map((o, i) => `payment ${i + 1} ${o.answer ? "admitted" : "refused"}`).join(", ")}. The stuck lane's expiry and its retry show on the board.`);
  return { alt, public: pub };
}

/**
 * Agent (spec): the mock price falls, the rule fires four tranches at once as parallel lanes, each on its own lane;
 * then the server is compromised and sends two payments outside the hot policy, which the account refuses.
 * @param {Api} api
 * @param {string} address
 * @param {SceneIo} io
 */
export async function agentScene(api, address, io) {
  let w = await api.wallet(address);
  w = await ensureTickets(api, address, w, RULE.tranches + 2, SCENE.agentTickets, io);
  const tranche = trancheWei(w);
  if (tranche === null) throw new Error("the balance cannot cover the tranches and their fee caps");
  io.mempool?.("alt");
  io.trigger?.();
  io.step(`the mock price fell more than ${RULE.dropPct} % in 30 s: the rule fires ${RULE.tranches} tranches of ${formatWei(tranche)} at once, as parallel lanes`);
  const fired = await fireTranches(api, w, { tranche, mempool: "alt" });
  io.fired?.(fired, tranche);
  const bad = fired.find((r) => r.status === "rejected");
  if (bad) throw /** @type {PromiseRejectedResult} */ (bad).reason;
  io.step(`${RULE.tranches} parallel lanes pending at once: ${fired.map((r) => (r.status === "fulfilled" ? r.value.nonceKeys[0] : "?")).join(", ")}`);
  await pause(io, SCENE.pauseMs);
  io.step("server compromised: it sends two payments outside the hot policy");
  const stolen = await compromisedPayments(api, w, "alt");
  io.compromised?.(stolen);
  const stop = stolen.find((s) => s.result.status === "rejected" && !isRefusal(s.result.reason));
  if (stop) throw /** @type {PromiseRejectedResult} */ (stop.result).reason;
  const refused = stolen.filter((s) => s.result.status === "rejected").length;
  io.step(`done: the account refused ${refused} of the 2 compromised payments; a thief can spend only the tickets left, within the caps, to the allowed target`);
  return { fired, stolen };
}

/**
 * Session (spec): grants tickets when none are left, then eight moves within two seconds, each its own lane (parallel
 * lanes on the alt mempool), on the mempool the switch shows. On the public mempool its refusals are what the scene
 * shows; anything else stops it.
 * @param {Api} api
 * @param {string} address
 * @param {Omit<SceneIo, "mempool"> & { mempool: Mempool }} io here mempool is the switch's value, not a setter
 */
export async function sessionScene(api, address, { mempool, ...io }) {
  let w = await api.wallet(address);
  requireDevice(w); // never a grant (a cut) while the device journal is missing
  if (w.tickets.left === 0) {
    const n = grantCount(w);
    if (n === 0) throw new Error("no ticket left, and the hot band has no uncut leaf: rotate on the cold device for a new band");
    io.step(`the wallet grants ${n} ticket${n === 1 ? "" : "s"}`);
    await cutTickets(api, address, n);
    w = await api.wallet(address);
  }
  io.step(mempool === "alt"
    ? `${SCENE.moves} moves within two seconds as ${SCENE.moves} parallel lanes on the alt mempool`
    : `${SCENE.moves} moves within two seconds on the public mempool, each its own lane (one pending per sender there: measured on the devnet: 1 of 8 admitted, block 5,738)`);
  /** @type {Promise<Outcome>[]} */
  const moves = [];
  /** @type {unknown} */
  let stop = null;
  for (let k = 0; k < SCENE.moves && stop === null; k++) {
    if (k > 0) await pause(io, SCENE.moveGapMs);
    if (stop !== null) break;
    const body = moveBody(w, mempool);
    moves.push(settle(body, api.send(address, body)).then((o) => {
      if (o.error !== null && !(mempool === "public" && isRefusal(o.error))) stop ??= o.error;
      io.moved?.(k, o);
      return o;
    }));
  }
  const outcomes = await Promise.all(moves);
  if (stop !== null) throw stop;
  const admitted = outcomes.filter((o) => o.answer).length;
  const landing = mempool === "alt"
    ? "the devnet's sidecar relays at most 4 per 10 s pass by default, so 8 parallel lanes land over two or more blocks"
    : "they land as the chain includes them";
  io.step(`done: ${admitted} of ${outcomes.length} moves admitted${admitted < outcomes.length ? `, ${outcomes.length - admitted} refused` : ""}; ${landing}`);
  return { moves: outcomes };
}
