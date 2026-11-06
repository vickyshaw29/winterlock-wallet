// What each screen's buttons send, as functions over the API client (the integration test calls the same ones through
// serve.ts); the forms' inline checks; the words for the lane limits, the ticket device's trouble and the parallel-lanes
// plan (in the screen's words, never the API's); how the status line and the stalled-chain banner read the backend.
// Written with Claude Code (AI) for Vicky.
import { ApiError } from "./api.js";
import { formatAgo, formatWei, formatWeiExact, isAddress, parseEth, shortHex, toBigInt } from "./format.js";

/** @import { Api, SendBody, WalletView, HotPolicyBody, CreateWalletBody, Tickets } from "./api.js" */
/** @typedef {"alt" | "public"} Mempool */

/**
 * The stuck payment (spec, Nov 6: demos item 2, script 1:20): its first attempt gets a 4-second deadline, shorter than
 * the devnet's 6-second block, so it should miss its block and expire, its ticket burned; one retry goes out on a
 * fresh lane with the normal deadline (expirySeconds, the backend's 90 s). Not certain: a few tries in a hundred land,
 * when the sidecar's 10 s relay pass and the next slot both fall inside the 4 s (a recording may need a retake). No
 * fee field: on this devnet a fee below the 7-wei base fee is refused at admission and any fee above it is included,
 * so a low fee cannot make a payment stuck.
 */
export const STUCK = Object.freeze({ firstAttemptExpirySeconds: 4, retries: 1 });

/**
 * Parallel lanes as the devnet's sidecar runs them (spec, Nov 6, from the vendored sidecar's code): 1 pending
 * transaction per lane (nonce key), no per-sender cap for keyed lanes the account pays for itself, and at most 4
 * relayed per 10 s pass by default, so 8 lanes land over two or more blocks. Any ERC-8421 draft number is labelled as
 * the draft's; the public mempool's one per sender is measured on the devnet: 1 of 8 admitted, block 5,738.
 */
export const LANE_LIMITS_TEXT = "Parallel lanes on the devnet's sidecar: 1 pending per lane (nonce key), no per-sender cap for keyed lanes the " +
  "account pays for itself, relayed at most 4 per 10 s pass by default, so 8 lanes land over two or more blocks. " +
  "(The ERC-8421 draft's numbers, 4 per key and 64 per unstaked sender, are the draft's, not the devnet's.) " +
  "The public mempool holds one pending per sender: measured on the devnet: 1 of 8 admitted, block 5,738.";

/**
 * What the notice line says when the Mempool switch moves.
 * @param {Mempool} m
 */
export function mempoolNotice(m) {
  return m === "public"
    ? "Mempool: public. It holds one pending frame transaction per sender (measured on the devnet: 1 of 8 admitted, block 5,738), so a second lane is refused and its leaf burned."
    : "Mempool: alt. Parallel lanes: 1 pending per lane (nonce key), no per-sender cap for keyed lanes the account pays for itself; the sidecar relays at most 4 per 10 s pass by default, so they land out of order, 8 lanes over two or more blocks.";
}

/** The agent's rule (spec, AI agent): a fall of more than 2 % in 30 s buys in 4 tranches. */
export const RULE = Object.freeze({ dropPct: 2, windowMs: 30_000, tranches: 4 });
/** The dapp's session request (spec, Session keys): 20 actions; the backend cuts at most 64 tickets at once. */
export const SESSION_REQUEST = 20;
export const MAX_CUT = 64;

/**
 * Hot leaves not yet cut to the ticket device. Cuts are contiguous from where the first one started, so this is exact
 * unless hotStart was lowered after the first cut, or the first cut skipped hot leaves a script had already signed
 * (then it counts those too); the backend refuses a cut past the tree's last leaf (409 leaves_exhausted) either way.
 * @param {Pick<WalletView, "leafCount" | "hotStart" | "tickets">} w
 */
export function uncutHotLeaves(w) {
  return Math.max(0, w.leafCount - w.hotStart - w.tickets.exported);
}

/**
 * An amount a hot ticket may send: positive, and within the account's hot value cap (the account refuses more).
 * @param {string} text ETH as typed
 * @param {Pick<WalletView, "hotValueCapWei">} w
 * @returns {{ ok: true, wei: bigint } | { ok: false, error: string }}
 */
export function checkHotAmount(text, w) {
  const wei = parseEth(text);
  if (wei === null) return { ok: false, error: "an amount in ETH, at most 18 decimals" };
  if (wei === 0n) return { ok: false, error: "more than 0" };
  const cap = BigInt(w.hotValueCapWei);
  if (cap === 0n) return { ok: false, error: "hot tickets are off: the value cap is 0 (the kill switch)" };
  if (wei > cap) return { ok: false, error: `above the hot value cap of ${formatWeiExact(cap)}; the account refuses it too` };
  return { ok: true, wei };
}

// ------------------------------------------------------------------ the ticket device

/**
 * @typedef {Object} DeviceIssue the ticket device cannot sign: the backend's 409 device_unusable
 * @property {number | null} count tickets cut whose device journal is missing, when the backend says how many
 * @property {string} text the cards' line
 */

/**
 * The cards' line for tickets cut whose device journal is missing.
 * @param {number} n
 */
export function unjournaledText(n) {
  return n === 1
    ? "1 ticket was cut but is missing from the device journal: recover it"
    : `${n} tickets were cut but are missing from the device journal: recover it`;
}

/**
 * From GET /wallets/:address: tickets cut whose device journal is missing (tickets.unjournaled). The backend then signs
 * none of them and cuts no more (409 device_unusable), because a new journal would re-sign used tickets; so the screens
 * never offer a cut. Null when the journal is there.
 * @param {{ tickets: Tickets } | null | undefined} w
 * @returns {DeviceIssue | null}
 */
export function deviceIssue(w) {
  const n = w?.tickets?.unjournaled;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? { count: n, text: unjournaledText(n) } : null;
}

/**
 * From a failed call: the backend's 409 device_unusable. Its detail names the count when the journal is missing ("3
 * ticket(s) of epoch 0 were cut for 0x…, but the device journal is missing: recover …"); any other cause (ticket files
 * of another tree, a gap) keeps the backend's words. Null for every other error.
 * @param {unknown} e
 * @returns {DeviceIssue | null}
 */
export function deviceIssueOf(e) {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== "device_unusable") return null;
  const n = Number(/^(\d+) ticket\(s\) of epoch \d+ were cut\b[^]*\bthe device journal is missing\b/.exec(e.detail)?.[1] ?? 0);
  if (Number.isSafeInteger(n) && n > 0) return { count: n, text: unjournaledText(n) };
  return { count: null, text: `The ticket device cannot be used: ${e.detail}` };
}

// ------------------------------------------------------------------ hot and cold

/**
 * Cold pane, Set policy.
 * @param {Api} api
 * @param {string} address
 * @param {{ hotStart: string, valueCap: string, feeCap: string, allowedTarget: string }} form ETH and text as typed
 */
export function setPolicy(api, address, form) {
  const hotStart = Number(form.hotStart);
  const valueCap = parseEth(form.valueCap), feeCap = parseEth(form.feeCap);
  if (!Number.isInteger(hotStart) || hotStart < 0) throw new ApiError(400, "bad_request", "hot start must be a leaf number", {});
  if (valueCap === null || feeCap === null) throw new ApiError(400, "bad_request", "the caps must be amounts in ETH", {});
  if (!isAddress(form.allowedTarget.trim())) throw new ApiError(400, "bad_request", "the allowed target must be an address", {});
  /** @type {HotPolicyBody} */
  const body = { hotStart, valueCapWei: valueCap.toString(), feeCapWei: feeCap.toString(), allowedTarget: form.allowedTarget.trim() };
  return api.hotPolicy(address, body);
}

/**
 * Cold pane, Cut tickets.
 * @param {Api} api
 * @param {string} address
 * @param {number} count
 */
export function cutTickets(api, address, count) {
  return api.tickets(address, { count });
}

/**
 * Cold pane, Rotate root.
 * @param {Api} api
 * @param {string} address
 * @param {number} height
 */
export function rotateRoot(api, address, height) {
  return api.rotate(address, { height });
}

/**
 * Phone pane, Pay: one hot ticket to the allowed target.
 * @param {{ wallet: Pick<WalletView, "allowedTarget">, valueWei: bigint, mempool: Mempool }} p
 * @returns {SendBody}
 */
export function payBody(p) {
  return { to: p.wallet.allowedTarget, valueWei: p.valueWei.toString(), mode: "hot", mempool: p.mempool };
}

/**
 * Phone pane, Simulate stuck payment: a hot ticket whose first attempt has a 4-second deadline, so it should miss its
 * block and expire (a few tries in a hundred still land), its ticket burned; the one retry goes out on a fresh lane
 * with the normal deadline. Both attempts offer the market's fee: never a fee bump, and no low fee (it cannot stick on
 * this devnet).
 * @param {{ wallet: Pick<WalletView, "allowedTarget">, valueWei: bigint, mempool: Mempool }} p
 * @returns {SendBody}
 */
export function stuckBody(p) {
  return {
    to: p.wallet.allowedTarget, valueWei: p.valueWei.toString(), mode: "hot", mempool: p.mempool,
    firstAttemptExpirySeconds: STUCK.firstAttemptExpirySeconds, retries: STUCK.retries,
  };
}

/**
 * Cold pane, Transfer: a keyed send signed by the next cold leaf, to any address (large transfers go through the cold
 * device; spec, Hot and cold, Limits).
 * @param {{ to: string, valueWei: bigint, mempool: Mempool }} p
 * @returns {SendBody}
 */
export function coldTransferBody(p) {
  return { to: p.to, valueWei: p.valueWei.toString(), mode: "keyed", mempool: p.mempool };
}

/**
 * @param {Api} api
 * @param {string} address
 * @param {SendBody} body
 */
export function send(api, address, body) {
  return api.send(address, body);
}

// ------------------------------------------------------------------ agent

/**
 * The tranche the agent buys with: the value cap, or less when the balance cannot cover the tranches and the most their
 * fees may reach (the hot fee cap each). Null when the wallet cannot afford any.
 * @param {Pick<WalletView, "hotValueCapWei" | "hotFeeCapWei" | "balanceWei">} w
 * @param {number} [count]
 * @returns {bigint | null}
 */
export function trancheWei(w, count = RULE.tranches) {
  const cap = BigInt(w.hotValueCapWei), fee = BigInt(w.hotFeeCapWei), balance = BigInt(w.balanceWei);
  const affordable = balance / BigInt(count) - fee;
  const t = cap < affordable ? cap : affordable;
  return t > 0n ? t : null;
}

/**
 * Fire: the tranches at once, each on its own lane, to the allowed target. Every answer is kept, refusals included.
 * @param {Api} api
 * @param {Pick<WalletView, "address" | "allowedTarget">} w
 * @param {{ tranche: bigint, mempool: Mempool, count?: number }} p
 */
export function fireTranches(api, w, p) {
  const bodies = Array.from({ length: p.count ?? RULE.tranches }, () => payBody({ wallet: w, valueWei: p.tranche, mempool: p.mempool }));
  return Promise.allSettled(bodies.map((b) => api.send(w.address, b)));
}

/** A fresh random address, never the allowed target. */
export function randomAddress() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Server compromised (spec, AI agent): two hot payments outside the policy, each its own ticket: ten times the value
 * cap to the allowed target (the account refuses it: exceeds value cap), and a tenth of the cap to a new address (the
 * account refuses it: target not allowed). Each refusal comes from the dry run (422) and burns its ticket.
 * @param {Pick<WalletView, "allowedTarget" | "hotValueCapWei">} w
 * @param {Mempool} mempool
 * @param {string} [to] the new address
 * @returns {[SendBody, SendBody]}
 */
export function compromisedBodies(w, mempool, to = randomAddress()) {
  const cap = BigInt(w.hotValueCapWei);
  const small = cap / 10n > 0n ? cap / 10n : 1n;
  return [
    { to: w.allowedTarget, valueWei: (cap === 0n ? 1n : cap * 10n).toString(), mode: "hot", mempool },
    { to, valueWei: small.toString(), mode: "hot", mempool },
  ];
}

/**
 * Server compromised: both payments at once; every answer is kept, refusals included.
 * @param {Api} api
 * @param {Pick<WalletView, "address" | "allowedTarget" | "hotValueCapWei">} w
 * @param {Mempool} mempool
 */
export async function compromisedPayments(api, w, mempool) {
  const bodies = compromisedBodies(w, mempool);
  const results = await Promise.allSettled(bodies.map((b) => api.send(w.address, b)));
  return bodies.map((body, i) => ({ body, result: /** @type {PromiseSettledResult<import("./api.js").SendAnswer>} */ (results[i]) }));
}

/**
 * The most a thief holding the hot device can move: every ticket left at the value cap plus the fee cap, to the
 * allowed target only (spec: tickets times value cap plus fee cap).
 * @param {Pick<WalletView, "tickets" | "hotValueCapWei" | "hotFeeCapWei">} w
 */
export function maxLossWei(w) {
  return BigInt(w.tickets.left) * (BigInt(w.hotValueCapWei) + BigInt(w.hotFeeCapWei));
}

// ------------------------------------------------------------------ session

/**
 * How many tickets "Grant N tickets" cuts: the dapp's request, no more than the hot band has uncut, no more than one cut.
 * @param {Pick<WalletView, "leafCount" | "hotStart" | "tickets">} w
 * @param {number} [requested]
 */
export function grantCount(w, requested = SESSION_REQUEST) {
  return Math.min(requested, uncutHotLeaves(w), MAX_CUT);
}

/**
 * One move: a hot ticket of 0 wei to the allowed target, no calldata (the account allows none on a hot leaf).
 * @param {Pick<WalletView, "allowedTarget">} w
 * @param {Mempool} mempool
 * @returns {SendBody}
 */
export function moveBody(w, mempool) {
  return { to: w.allowedTarget, valueWei: "0", mode: "hot", mempool };
}

// ------------------------------------------------------------------ wallets

/**
 * Index page, Create wallet: the form's ETH amounts as wei; empty optional fields are left to the backend's defaults.
 * @param {{ height: string, valueCap: string, feeCap?: string, allowedTarget?: string, hotStart?: string }} form
 * @returns {CreateWalletBody}
 */
export function createWalletBody(form) {
  const cap = parseEth(form.valueCap);
  if (cap === null) throw new ApiError(400, "bad_request", "the hot value cap must be an amount in ETH", {});
  /** @type {CreateWalletBody} */
  const body = { height: Number(form.height), spendLimitWei: cap.toString() };
  if (form.feeCap?.trim()) {
    const fee = parseEth(form.feeCap);
    if (fee === null) throw new ApiError(400, "bad_request", "the hot fee cap must be an amount in ETH", {});
    body.hotFeeCapWei = fee.toString();
  }
  if (form.allowedTarget?.trim()) body.allowedTarget = form.allowedTarget.trim();
  if (form.hotStart?.trim()) body.hotStart = Number(form.hotStart);
  return body;
}

// ------------------------------------------------------------------ the parallel-lanes plan

/**
 * @typedef {Object} LanesPlan GET /api/wallets/:address/lanes/plan as the screens read it (spec, Shared interfaces 5,
 *   Nov 6): a field of another type reads as unknown (null), never as a guess
 * @property {boolean | null} affordable whether every pending lane's max cost plus value, these included, fits the balance
 * @property {bigint | null} setAsideWei what the pending lanes and these would set aside
 * @property {bigint | null} shortfallWei what is missing when it does not fit
 * @property {number | null} passes relay passes the sidecar needs for them (at most 4 per pass by default)
 * @property {number | null} etaSeconds an estimate, until the last one lands
 * @property {string[]} warnings
 * @property {bigint | null} balanceWei the balance the plan used, when the backend sends it
 */

/** @param {unknown} v */
const wei = (v) => (typeof v === "string" && /^\d+$/.test(v) ? toBigInt(v) : null);

/**
 * The plan's answer, exactly its documented shape; null for a backend without the route (api.js answers null on 404).
 * @param {Record<string, any> | null} p
 * @returns {LanesPlan | null}
 */
export function readPlan(p) {
  if (!p || typeof p !== "object") return null;
  const warnings = Array.isArray(p.warnings) ? p.warnings.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
  return {
    affordable: typeof p.affordable === "boolean" ? p.affordable : null, setAsideWei: wei(p.setAsideWei), shortfallWei: wei(p.shortfallWei),
    passes: num(p.passes), etaSeconds: num(p.etaSeconds), warnings, balanceWei: wei(p.balanceWei),
  };
}

/**
 * The plan's line, "4 lanes: 1 relay pass, about 28 s; set aside 0.048 ETH of balance 1 ETH" (with the shortfall when
 * it does not fit), and its warnings in the screen's words (planWarningText). The balance is the plan's own when it
 * sends one, else the wallet's.
 * @param {LanesPlan} p
 * @param {number} n the lanes asked about
 * @param {unknown} balanceWei the wallet's balance
 * @param {TicketWords} [tickets] where this screen's tickets are
 */
export function planWords(p, n, balanceWei, tickets) {
  const passes = p.passes === null ? "? relay passes" : `${p.passes} relay pass${p.passes === 1 ? "" : "es"}`;
  const eta = p.etaSeconds === null ? "about ? s" : `about ${Math.round(p.etaSeconds)} s`;
  const short = p.affordable === false ? `; does not fit: short by ${formatWei(p.shortfallWei)}` : "";
  return {
    line: `${n} lane${n === 1 ? "" : "s"}: ${passes}, ${eta}; set aside ${formatWei(p.setAsideWei)} of balance ${formatWei(p.balanceWei ?? balanceWei)}${short}`,
    warnings: p.warnings.map((w) => planWarningText(w, tickets)),
  };
}

/**
 * Where a screen's tickets are, in its words, for the plan's warnings about them.
 * @typedef {Object} TicketWords
 * @property {string} [none] the sentence for no ticket left; default "No tickets left on the phone: cut some on the cold device."
 * @property {string} [holder] where the tickets are, after "tickets left"; default "on the phone"
 */

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);
/** "only the first 3 lanes would be sent" @param {number} n */
const firstOf = (n) => `only the first ${n === 1 ? "lane" : `${n} lanes`} would be sent`;

/**
 * Text from the backend without the API's own wording: "cut some with POST /api/wallets/0x…/tickets" (the 409
 * no_tickets detail, and the plan's warning) becomes "cut some on the cold device"; any other method and /api/ path,
 * status code with a code name ("(409 rotation_pending)"), bare status ("(503)"), code name ("(hybrid_unsupported)")
 * or account reason ('("hot: value cap")') in parentheses is left out.
 * @param {string} text
 */
export function withoutApiWords(text) {
  return text
    .replace(/\bcut some with POST \/api\/wallets\/[^/\s]+\/tickets\b/g, "cut some on the cold device")
    .replace(/\s*\((?:GET|POST) \/api\/[^)]*\)/g, "")
    .replace(/[;,]?\s*(?:with |through |via |see )?\b(?:GET|POST) \/api\/\S*/g, "")
    .replace(/\s*\((?:\d{3}(?: [a-z]+(?:_[a-z]+)+)?|[a-z]+(?:_[a-z]+)+|"[a-z]+: [^"]*")\)/g, "")
    .trim();
}

/**
 * One of the plan's warnings in the screen's words: what it means for the lanes, never the API's wording (no paths,
 * status codes or reason codes). Every warning the backend writes (backend.ts lanesPlan; planLanes in the pipeline's
 * lanes.ts) has its own sentence; any other is shown without its API words (withoutApiWords).
 * @param {string} text the backend's warning
 * @param {TicketWords} [tickets]
 */
export function planWarningText(text, tickets = {}) {
  const holder = tickets.holder ?? "on the phone";
  /** @type {RegExpExecArray | null} */
  let m;
  if ((m = /^the sidecar's relay settings were not read\b[^]*: assumed its defaults, (\d+) lanes per pass every ([\d.]+) s$/.exec(text))) {
    return `The mempool's relay settings could not be read, so the plan assumes its defaults: ${m[1]} lanes per relay pass, one pass every ${m[2]} s.`;
  }
  if ((m = /^the last of (\d+) relay passes is due about ([\d.]+) s after the send \(an estimate\), past the (\d+) s deadline\b/.exec(text))) {
    return `The last of the ${m[1]} relay passes is due about ${m[2]} s after sending, past each lane's ${m[3]} s expiry: its lanes may expire before they are relayed. Send fewer at once.`;
  }
  if (/^the sidecar's bundling mode is manual\b/.test(text)) return "The mempool relays only by hand right now: the lanes stay pending until someone relays them.";
  if (/^the chain looks stalled\b/.test(text)) return "The chain looks stalled: nothing can be sent until it moves.";
  if (/^a rotation of this wallet is pending\b/.test(text)) return "A rotation is pending: nothing can be sent until the chain shows it or it fails.";
  if ((m = /^no ticket can sign: (\d+) ticket\(s\) of epoch \d+ were cut\b/.exec(text))) {
    return `${unjournaledText(Number(m[1]))}. Until then no ticket can sign and none can be cut.`;
  }
  if (/^no ticket can sign\b/.test(text)) return "No ticket can sign: the ticket device's journal is missing. Recover it first.";
  if ((m = /^only (\d+) cold leaf\(s\) are left for keyed lanes \(the last (\d+) stay\b/.exec(text))) {
    const n = Number(m[1]);
    return n === 0
      ? `No cold leaves are left for lanes (the last ${m[2]} are kept for the kill switch and a rotation): rotate on the cold device.`
      : `Only ${n} cold ${plural(n, "leaf is", "leaves are")} left for lanes (${m[2]} more are kept for the kill switch and a rotation): ${firstOf(n)}.`;
  }
  if ((m = /^only (\d+) ticket\(s\) are left on the ticket device\b/.exec(text))) {
    const n = Number(m[1]);
    return n === 0
      ? (tickets.none ?? "No tickets left on the phone: cut some on the cold device.")
      : `Only ${n} ${plural(n, "ticket", "tickets")} left ${holder}: ${firstOf(n)}.`;
  }
  if (/^this account requires the ECDSA co-signature\b/.test(text)) {
    return "This account requires the classical co-signature on cold leaves, which this backend does not make: keyed lanes would be refused.";
  }
  if (/^the hot value cap is 0\b/.test(text)) return "The hot value cap is 0, the kill switch: the account refuses every ticket.";
  if ((m = /^each lane's value, (\d+) wei, is above the hot value cap of (\d+) wei\b/.exec(text))) {
    return `Each lane sends ${formatWei(m[1])}, above the hot value cap of ${formatWei(m[2])}: the account would refuse it.`;
  }
  if ((m = /^hot lanes may pay only the allowed target (0x[0-9a-fA-F]{40}): the account refuses (0x[0-9a-fA-F]{40})/.exec(text))) {
    return `Tickets may pay only the allowed target ${shortHex(m[1])}: the account would refuse ${shortHex(m[2])}.`;
  }
  if ((m = /^each lane's maximum cost, (\d+) wei, is above the hot fee cap of (\d+) wei\b/.exec(text))) {
    return `Each lane may cost up to ${formatWei(m[1])} in fees, above the hot fee cap of ${formatWei(m[2])}: the account would refuse it.`;
  }
  if ((m = /^(\d+) lane\(s\) in flight have no recorded maximum cost\b/.exec(text))) {
    const n = Number(m[1]);
    return `${n} pending ${plural(n, "lane has", "lanes have")} no recorded cost, so the set-aside leaves ${plural(n, "it", "them")} out.`;
  }
  if ((m = /^(\d+) lane\(s\) expired in the last ([\d.]+) s\b/.exec(text))) {
    const n = Number(m[1]);
    return `${n} ${plural(n, "lane", "lanes")} expired in the last ${m[2]} s: the mempool may still hold ${plural(n, "its", "their")} cost against the balance for a while.`;
  }
  const plain = withoutApiWords(text);
  return plain ? `${plain[0]?.toUpperCase()}${plain.slice(1)}${/[.!?]$/.test(plain) ? "" : "."}` : "The backend has a note on this plan.";
}

/**
 * Why the plan could not be read, in the screen's words; the plan view puts the backend's own (errorText) in the
 * line's tooltip. Status 0 is serve.ts not answering; its 502 backend_unreachable the backend not answering it; the
 * backend's own 502 a chain or mempool it could not read.
 * @param {unknown} e
 */
export function planFailureText(e) {
  if (!(e instanceof ApiError)) return "not read";
  if (e.status === 0) return "not read: the screens' server did not answer";
  if (e.status === 502 && e.code === "backend_unreachable") return "not read: the backend did not answer";
  if (e.status === 502) return "not read: the backend could not reach the chain or the mempool";
  return "not read: the backend refused it";
}

// ------------------------------------------------------------------ status line and banner

/**
 * @typedef {Object} ChainStatus GET /api/status as the screens use it
 * @property {number | null} chainId
 * @property {number | null} head the latest block's number
 * @property {number | null} ageSeconds how old the latest block is by the backend's clock
 * @property {boolean | null} stalled the backend's 503 rule: more than 60 s off
 * @property {boolean} fake the local fake chain (chain 31337)
 */

/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * GET /api/status, exactly the backend's shape {chainId, head, headAgeSeconds, stalled, fake} (spec, Shared interfaces
 * 5, Nov 6): a field of another type reads as unknown, never as a guess. Null while the backend answers 404 (api.js).
 * @param {Record<string, any> | null} s
 * @returns {ChainStatus | null}
 */
export function readStatus(s) {
  if (!s || typeof s !== "object") return null;
  return {
    chainId: num(s.chainId), head: num(s.head), ageSeconds: num(s.headAgeSeconds),
    stalled: typeof s.stalled === "boolean" ? s.stalled : null, fake: s.fake === true,
  };
}

/**
 * The status line's words: ["chain 1337", "latest block 1002, 4 s ago"].
 * @param {ChainStatus} c
 */
export function statusWords(c) {
  return [`chain ${c.chainId ?? "?"}`, `latest block ${c.head ?? "?"}${c.ageSeconds === null ? "" : `, ${formatAgo(c.ageSeconds)}`}`];
}

/**
 * The stalled-chain banner from GET /api/status: its text while the backend calls the chain stalled, else null.
 * @param {ChainStatus | null} c
 */
export function statusBanner(c) {
  if (!c || c.stalled !== true) return null;
  return `The chain looks stalled: latest block ${c.head ?? "?"}${c.ageSeconds === null ? "" : `, ${formatAgo(c.ageSeconds)}`}. The backend refuses to sign until it moves, so sending is off.`;
}

/**
 * The stalled-chain banner: the backend answers 503 chain_stalled when the latest block is more than 60 s from its
 * clock (checked before any leaf is spent), so the banner shows and sending stops until the chain moves again.
 * @param {unknown} e
 * @returns {string | null} the banner's text, or null when the error is not a stalled chain
 */
export function stalledBanner(e) {
  if (!isStalled(e)) return null;
  return `The chain looks stalled: the backend refuses to sign (${e.detail}). Nothing was spent. Sending is off until the chain moves.`;
}

/**
 * Whether an error is the backend's 503: the chain is stalled and nothing was signed.
 * @param {unknown} e
 * @returns {e is ApiError}
 */
export function isStalled(e) {
  return e instanceof ApiError && e.status === 503;
}

/**
 * One line for a failed action, in the backend's words, without the API's own paths (withoutApiWords): the 409
 * no_tickets detail says "cut some on the cold device", not the endpoint that cuts.
 * @param {unknown} e
 */
export function errorText(e) {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  if (e.status === 0) return e.detail;
  const reasons = /** @type {string[]} */ (e.body?.simulation?.violations ?? []);
  const why = reasons.length ? `: ${reasons.join("; ")}` : "";
  return `${e.code} (${e.status}): ${withoutApiWords(e.detail)}${e.code === "refused" ? why : ""}`;
}
