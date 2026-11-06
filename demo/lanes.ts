// Parallel lanes from a terminal: `plan` and `burst` through the backend's HTTP API (demo scene 1).
// Written with Claude Code (AI) for Vicky.
//
// `plan` says what n lanes sent at once would hold of the wallet's balance and take to relay; `burst` checks that plan,
// sends the n lanes at once and follows each one to its end (spec: demo script 0:45, demos item 1), and prints the
// exact JSON each lane sent (spec: every script does). A send whose answer is lost may still have been sent: it is
// never reported as not sent; the wallet's records made since the burst began that no answer named are followed too.
//
//   bun lanes.ts plan  --wallet 0x… --n 8 [--mode keyed|hot] [--value-wei W] [--to 0x…]
//   bun lanes.ts burst --wallet 0x… --n 8 [--mempool alt|public] [--mode keyed|hot] [--value-wei W] [--to 0x…]
//                      [--force] [--json-out DIR]
//
// WL_BACKEND_URL names the backend (default http://127.0.0.1:8787). The backend holds the seeds and the journals and
// makes every signature; this script only asks it, so nothing here can sign a leaf twice.
import fs from "node:fs";
import path from "node:path";
import { ONE_LANE_SECONDS, explainAccountReason, explainRefusal, type RefusalExplained } from "../pipeline/src/lanes.ts";

export const USAGE = `lanes: parallel lanes through the backend (WL_BACKEND_URL, default http://127.0.0.1:8787)
  bun lanes.ts plan  --wallet 0x… --n N [--mode keyed|hot] [--value-wei W] [--to 0x…] [--expiry-seconds S]
  bun lanes.ts burst --wallet 0x… --n N [--mempool alt|public] [--mode keyed|hot] [--value-wei W] [--to 0x…] [--expiry-seconds S] [--force] [--json-out DIR]
    --n          lanes sent at once, 1 to 64
    --mode       keyed (cold leaves, the default) or hot (the wallet's tickets)
    --value-wei  each lane's value, in wei (default 0)
    --to         each lane's recipient (default: the account's allowed target)
    --mempool    alt (the sidecar, the default) or public (the node's own pool)
    --expiry-seconds  each lane's deadline, 10 to 3600 s (default 180: 8 lanes need 2 relay passes, each lane up to
                 4 pushes of 10 s, so 90 s left no margin on the devnet; spec "Fees", Nov 6)
    --force      send even when the plan says the balance does not cover the lanes
    --json-out   write each lane's sent JSON to DIR/lane-<i>-<hash>.json instead of printing it`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ arguments

export interface Args {
  command: "plan" | "burst";
  wallet: string;
  n: number;
  mode: "keyed" | "hot";
  /** decimal wei */
  valueWei: string;
  to: string | null;
  mempool: "alt" | "public";
  /** each lane's deadline, in seconds from signing */
  expirySeconds: number;
  force: boolean;
  jsonOut: string | null;
}

export class UsageError extends Error {}
/** The backend refused, or could not be reached. */
export class CliError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A burst's deadline (spec "Fees", Nov 6): 8 lanes take 2 relay passes and each lane up to 4 pushes of 10 s. */
export const BURST_EXPIRY_SECONDS = 180;

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "burst") throw new UsageError(command === undefined ? "say plan or burst" : `unknown command ${command}: say plan or burst`);
  const valued = new Set(["--wallet", "--n", "--mode", "--value-wei", "--to", "--mempool", "--json-out", "--expiry-seconds"]);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a !== "--force" && !valued.has(a)) throw new UsageError(`unknown argument ${a}`);
    if (flags.has(a)) throw new UsageError(`${a} is given twice`);
    if (a === "--force") { flags.set(a, true); continue; }
    const v = rest[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    flags.set(a, v);
  }
  if (command === "plan") for (const f of ["--mempool", "--force", "--json-out"]) if (flags.has(f)) throw new UsageError(`${f} is for burst only`);
  const text = (f: string) => { const v = flags.get(f); return typeof v === "string" ? v : undefined; };
  const wallet = text("--wallet");
  if (!wallet || !ADDRESS.test(wallet)) throw new UsageError("--wallet must be the wallet's address (0x and 40 hex digits)");
  const nText = text("--n");
  if (nText === undefined || !/^\d{1,2}$/.test(nText) || Number(nText) < 1 || Number(nText) > 64) throw new UsageError("--n must be a whole number of lanes from 1 to 64");
  const mode = text("--mode") ?? "keyed";
  if (mode !== "keyed" && mode !== "hot") throw new UsageError("--mode must be keyed or hot");
  const mempool = text("--mempool") ?? "alt";
  if (mempool !== "alt" && mempool !== "public") throw new UsageError("--mempool must be alt or public");
  const valueWei = text("--value-wei") ?? "0";
  if (!/^(0|[1-9]\d*)$/.test(valueWei)) throw new UsageError("--value-wei must be a whole number of wei");
  const to = text("--to") ?? null;
  if (to !== null && !ADDRESS.test(to)) throw new UsageError("--to must be an address (0x and 40 hex digits)");
  const expiryText = text("--expiry-seconds") ?? String(BURST_EXPIRY_SECONDS);
  if (!/^\d{1,4}$/.test(expiryText) || Number(expiryText) < 10 || Number(expiryText) > 3600) throw new UsageError("--expiry-seconds must be a whole number of seconds from 10 to 3600");
  return {
    command, wallet, n: Number(nText), mode, valueWei, to, mempool, expirySeconds: Number(expiryText),
    force: flags.has("--force"), jsonOut: text("--json-out") ?? null,
  };
}

// ------------------------------------------------------------------ the backend

export interface Reply { status: number; body: any }
export interface Client { base: string; get(p: string): Promise<Reply>; post(p: string, body: unknown): Promise<Reply> }

/** The backend's API at `base` (default WL_BACKEND_URL, else http://127.0.0.1:8787); every path is under /api. */
export function createClient(o: { base?: string; fetch?: typeof fetch } = {}): Client {
  const base = (o.base ?? process.env.WL_BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const f = o.fetch ?? globalThis.fetch;
  const call = async (method: string, p: string, body?: unknown): Promise<Reply> => {
    let res: Response;
    try {
      res = await f(`${base}/api${p}`, {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new CliError(`the backend at ${base} did not answer (${message(e)}): start it with (cd backend && bun src/main.ts), or set WL_BACKEND_URL`, { cause: e });
    }
    let text: string;
    try { text = await res.text(); } catch (e) {
      throw new CliError(`the backend at ${base} answered ${res.status}, but its answer was cut off (${message(e)})`, { cause: e });
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed ?? { error: "not_json", detail: text.slice(0, 200) } };
  };
  return { base, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

/** GET /api/wallets/:address/lanes/plan, as the backend answers it (amounts as decimal strings of wei). */
export interface Plan {
  wallet: string; n: number; mode: "keyed" | "hot"; to: string; valueWei: string; expirySeconds: number;
  affordable: boolean; setAsideWei: string; shortfallWei: string; passes: number; etaSeconds: number; warnings: string[];
  perLaneCostWei: string; perLane: { gasLimit: string; maxFeePerGasWei: string; gasCostWei: string; valueWei: string };
  pendingLanes: number; pendingCostWei: string; unpricedLanes: number; balanceWei: string; lanesLeft: number;
  relay: { bundleSize: number; bundleIntervalSeconds: number; maxSubmitAttempts: number; useropsTTLSeconds: number; bundlingMode: string | null; testingMode: boolean; assumed: boolean; notes: string[] };
}

export async function fetchPlan(c: Client, a: Pick<Args, "wallet" | "n" | "mode" | "valueWei" | "to" | "expirySeconds">): Promise<Plan> {
  const q = new URLSearchParams({ n: String(a.n), mode: a.mode, valueWei: a.valueWei, expirySeconds: String(a.expirySeconds) });
  if (a.to) q.set("to", a.to);
  const r = await c.get(`/wallets/${a.wallet}/lanes/plan?${q}`);
  if (r.status !== 200) throw new CliError(`the plan was refused (${r.status} ${r.body?.error}): ${r.body?.detail}`);
  return r.body as Plan;
}

// ------------------------------------------------------------------ words

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const lanesText = (k: number) => `${k} lane${k === 1 ? "" : "s"}`;

/** "1,000 wei (0.000000000000001 ETH)": wei exactly, ETH beside it for reading. */
export function weiText(wei: string | bigint): string {
  const w = BigInt(wei);
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${group(w.toString())} wei (${w / 10n ** 18n}${frac ? `.${frac}` : ""} ETH)`;
}

/** The plan in plain words, one line each. */
export function planLines(p: Plan): string[] {
  return [
    `parallel lanes plan for ${p.wallet}: ${lanesText(p.n)} at once, ${p.mode === "hot" ? "hot tickets" : "keyed"}, each sending ${weiText(p.valueWei)} to ${p.to}`,
    `  each lane holds at most ${weiText(p.perLaneCostWei)} while pending: ${group(p.perLane.gasLimit)} gas at ${group(p.perLane.maxFeePerGasWei)} wei per gas, plus its value (an upper bound before signing)`,
    `  pending now: ${p.pendingLanes ? `${lanesText(p.pendingLanes)} holding ${weiText(p.pendingCostWei)}${p.unpricedLanes ? `, ${p.unpricedLanes} of them with no recorded cost, left out` : ""}` : "nothing"}`,
    `  set aside with the new lanes: ${weiText(p.setAsideWei)} of a balance of ${weiText(p.balanceWei)}: ${p.affordable ? "affordable" : `NOT affordable, short by ${weiText(p.shortfallWei)}`}`,
    `  relay: ${p.relay.bundleSize} lanes per pass, a pass every ${p.relay.bundleIntervalSeconds} s ${p.relay.assumed ? "(assumed: the sidecar's defaults)" : "(read from the sidecar)"}${p.relay.bundlingMode ? `, bundling ${p.relay.bundlingMode}` : ""}`,
    `  ${lanesText(p.n)} need ${p.passes} relay pass${p.passes === 1 ? "" : "es"}: the last should land about ${p.etaSeconds} s after the send (an estimate: ${ONE_LANE_SECONDS} s for one lane, measured Nov 5, plus one interval per further pass); each lane's deadline is ${p.expirySeconds} s`,
    `  ${p.mode === "hot" ? "tickets" : "cold leaves for keyed lanes"} left: ${p.lanesLeft}`,
    ...p.warnings.map((w) => `  warning: ${w}`),
  ];
}

/**
 * Why a send was refused, from the backend's error body: the first of its detail and its simulation's violations
 * that explainRefusal knows, else the account's reason as the backend reads it ("account: <reason>"); null if none.
 */
export function explainSendError(body: { detail?: unknown; simulation?: { violations?: unknown } } | null | undefined): RefusalExplained | null {
  const violations = Array.isArray(body?.simulation?.violations) ? body!.simulation!.violations : [];
  const texts = [body?.detail, ...violations].filter((t): t is string => typeof t === "string");
  for (const t of texts) {
    const e = explainRefusal(t);
    if (e.code !== "unknown") return e;
  }
  const account = texts.find((t) => t.startsWith("account: "));
  return account ? explainAccountReason(account.slice("account: ".length)) : null;
}

// ------------------------------------------------------------------ the burst

/** GET /api/tx/:hash, the fields the burst reads. */
export interface TxView {
  txHash: string; status: string; leaf: number; nonceKey: string; mempool: "alt" | "public" | null;
  timeline: { status: string; at: string }[]; receipt: { blockNumber: string } | null; admission: { summary: string } | null;
  detail: string | null; wire: unknown | null; maxCostWei: string | null; valueWei: string | null; updatedAt: string;
  /** unix seconds; createdAt is ISO time */
  deadline: number | null; createdAt: string;
}

/**
 * What a request's answer says about its lane. admitted: 200 with its hash. refused: the backend's 422, the leaf signed
 * and burned. not_sent: any other answer of the backend's own (400, 404, 409, 502, 503): nothing reached a mempool.
 * no_answer: no answer at all (the connection failed, or the answer was cut off), the backend's 500 (a bug, which may
 * have come after the transaction left), or an answer that is not the backend's: the lane may have been sent.
 */
export type LaneKind = "admitted" | "refused" | "not_sent" | "no_answer";

export interface Lane {
  /** 1 to n, in the order the requests went out */
  index: number;
  kind: LaneKind;
  /** seconds from the first request to this lane's answer */
  answeredAt: number;
  /** POST /send's HTTP status; 0 when no answer came */
  httpStatus: number;
  answer: { txHash: string; leaf: number; nonceKeys: string[]; nonceSeq: string; status: string } | null;
  /** the backend's error body: {error, detail, txHash?, leaf?, simulation?, admission?}; for no answer, what went wrong */
  error: { error: string; detail: string; txHash?: string | null; leaf?: number | null; simulation?: { violations?: string[] } } | null;
  explained: RefusalExplained | null;
  /** the transaction's hash, whenever an answer named one (refused ones too) */
  hash: string | null;
  /** GET /tx/:hash as last read */
  record: TxView | null;
  /** where --json-out wrote its sent JSON */
  jsonFile: string | null;
}

/**
 * A record of the wallet's (GET /wallets/:address/txs) created since the burst began that no answer named: the lane
 * of a request whose answer was lost, or another client's sent meanwhile. Followed and printed like the lanes.
 */
export interface FoundLane {
  /** 1, 2, … in the order found */
  index: number;
  hash: string;
  /** GET /tx/:hash as last read */
  record: TxView | null;
  /** where --json-out wrote its sent JSON */
  jsonFile: string | null;
}

export interface BurstResult {
  plan: Plan;
  /** false when the plan stopped it (not affordable, no --force): nothing was signed or sent */
  sent: boolean;
  lanes: Lane[];
  /** lanes the mempool admitted (POST /send answered 200) */
  admitted: number;
  /** requests that got no answer of the backend's own (kind no_answer): each may have been sent */
  noAnswer: number;
  /** records created since the burst began that no answer named, followed like the lanes */
  found: FoundLane[];
  /** lanes with no answer that no found record accounts for (noAnswer minus found, at least 0): exit 3 */
  unaccounted: number;
  /** the most lanes seen pending (Submitted) at once while following, found ones included */
  maxPending: number;
  /** the blocks the landed lanes are in, lowest first */
  blocks: bigint[];
  /** seconds from the first request to the last outcome */
  seconds: number;
  /** lanes still Submitted when following stopped */
  unfinished: number;
}

export interface BurstOptions {
  out: (line: string) => void;
  /** between reads of the lanes' records; default 1,000 ms */
  pollMs?: number;
  /** stop following after this long; default 15 min (the backend follows a lane up to 10 min past its deadline) */
  timeoutMs?: number;
  /** after each read of every lane: how many are pending and how many have ended */
  onPoll?: (s: { pending: number; ended: number }) => void;
  /**
   * once every lane followed has ended, how long the wallet's records are still read for lanes whose answer was lost,
   * counted from the last answer; default 10 s (a lost answer is often a backend still at work on the send)
   */
  lostAnswerGraceMs?: number;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** The answer of one POST /send, as its lane's kind (LaneKind) and fields. */
function readAnswer(lane: Lane, r: Reply): void {
  lane.httpStatus = r.status;
  const hash = typeof r.body?.txHash === "string" && HASH.test(r.body.txHash) ? (r.body.txHash as string) : null;
  lane.hash = hash;
  const code = typeof r.body?.error === "string" ? (r.body.error as string) : null;
  if (r.status === 200 && hash) {
    lane.kind = "admitted";
    lane.answer = r.body;
  } else if (r.status === 200 || r.status === 500 || code === null || code === "not_json" || code === "backend_unreachable") {
    // not the backend's own answer about this send (a 500 is a bug that may come after the send; backend_unreachable is
    // the web proxy's, whose backend failed mid-answer): the lane may have been sent
    lane.kind = "no_answer";
    lane.error = { error: code ?? `http_${r.status}`, detail: typeof r.body?.detail === "string" ? r.body.detail : "" };
  } else {
    lane.kind = code === "refused" ? "refused" : "not_sent";
    lane.error = r.body;
    lane.explained = explainSendError(r.body);
  }
}

function answerLine(l: Lane): string {
  const at = `+${l.answeredAt.toFixed(2)} s`;
  if (l.kind === "admitted") return `lane ${l.index}: admitted, leaf ${l.answer!.leaf}, nonce key ${l.answer!.nonceKeys[0]}, tx ${l.answer!.txHash} (${at})`;
  const e = l.error!;
  if (l.kind === "no_answer") {
    const what = l.httpStatus ? `${l.httpStatus} ${e.error}${e.detail ? `: ${e.detail}` : ""}` : e.detail;
    return `lane ${l.index}: no answer: may have been sent (${what}); the wallet's records are read for it (${at})`;
  }
  const burned = l.kind === "refused" && typeof e.leaf === "number" ? `, leaf ${e.leaf} burned` : "";
  const head = l.kind === "refused" ? `refused${burned}` : `not sent (${l.httpStatus} ${e.error})`;
  return `lane ${l.index}: ${head}: ${l.explained ? `${l.explained.laneState}. ${l.explained.hint}` : e.detail} (${at})`;
}

/**
 * n lanes at once, after the plan; each answer printed as it comes, then every lane followed to its end. A request
 * whose answer was lost may still have been sent: the wallet's records created since the burst began that no answer
 * named are taken in, followed and printed like the lanes, and counted apart; a lane no record accounts for is
 * reported as unaccounted (main exits 3), never as not sent.
 */
export async function burst(c: Client, a: Args, o: BurstOptions): Promise<BurstResult> {
  const plan = await fetchPlan(c, a);
  for (const l of planLines(plan)) o.out(l);
  const none = { plan, lanes: [], admitted: 0, noAnswer: 0, found: [], unaccounted: 0, maxPending: 0, blocks: [], seconds: 0, unfinished: 0 };
  if (!plan.affordable && !a.force) {
    o.out(`not sent: the balance does not cover the ${lanesText(plan.n)} (short by ${weiText(plan.shortfallWei)}); fund the wallet, send fewer lanes, or pass --force to let the mempool decide`);
    return { ...none, sent: false };
  }
  if (!plan.affordable) o.out("--force: sending although the plan says the balance does not cover every lane");
  const body = { to: plan.to, valueWei: plan.valueWei, mode: a.mode, mempool: a.mempool, expirySeconds: a.expirySeconds };
  o.out(`sending ${lanesText(plan.n)} at once to the ${a.mempool === "alt" ? "alt mempool (the sidecar)" : "public mempool (the node's own pool)"}, each POST /send ${JSON.stringify(body)}`);

  const t0 = Date.now();
  const fire = async (index: number): Promise<Lane> => {
    const lane: Lane = { index, kind: "no_answer", answeredAt: 0, httpStatus: 0, answer: null, error: null, explained: null, hash: null, record: null, jsonFile: null };
    try {
      readAnswer(lane, await c.post(`/wallets/${a.wallet}/send`, body));
    } catch (e) {
      // the request may have reached the backend, which may have signed and sent before the answer was lost
      lane.error = { error: "no_answer", detail: message(e instanceof CliError && e.cause ? e.cause : e) };
    }
    lane.answeredAt = (Date.now() - t0) / 1000;
    o.out(answerLine(lane));
    return lane;
  };
  const lanes = await Promise.all(Array.from({ length: plan.n }, (_, i) => fire(i + 1)));
  const answersEnded = Date.now();

  // Records no answer named: read once after the sends, and again at every poll while a lost answer is unaccounted for.
  const named = new Set(lanes.flatMap((l) => (l.hash ? [l.hash.toLowerCase()] : [])));
  const noAnswer = lanes.filter((l) => l.kind === "no_answer").length;
  const found: FoundLane[] = [];
  const unaccounted = () => Math.max(0, noAnswer - found.length);
  const lookForUnnamed = async () => {
    const r = await c.get(`/wallets/${a.wallet}/txs`).catch(() => null);
    if (r?.status !== 200 || !Array.isArray(r.body)) return;
    const fresh = (r.body as { txHash?: unknown; createdAt?: unknown }[])
      .filter((t): t is { txHash: string; createdAt: string } => typeof t?.txHash === "string" && HASH.test(t.txHash) && typeof t.createdAt === "string")
      .filter((t) => Date.parse(t.createdAt) >= t0 && !named.has(t.txHash.toLowerCase()))
      .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
    for (const t of fresh) {
      named.add(t.txHash.toLowerCase());
      const f: FoundLane = { index: found.length + 1, hash: t.txHash, record: null, jsonFile: null };
      found.push(f);
      o.out(`found ${f.index}: tx ${f.hash}, created since the burst began, named by no answer (${noAnswer ? "a lost answer's lane, or another client's" : "another client's"}): followed like the lanes`);
    }
  };
  await lookForUnnamed();

  // Follow every lane that signed something, and every found one: refused ones end at once, the others when the
  // backend decides them.
  const followed = () => [...lanes.filter((l) => l.hash !== null), ...found];
  const giveUp = Date.now() + (o.timeoutMs ?? 15 * 60_000);
  const graceUntil = answersEnded + (o.lostAnswerGraceMs ?? 10_000);
  let maxPending = 0, unfinished = 0;
  for (;;) {
    const all = followed();
    await Promise.all(all.map(async (l) => {
      const r = await c.get(`/tx/${l.hash}`).catch(() => null);
      if (r?.status === 200) l.record = r.body as TxView;
    }));
    const pending = all.filter((l) => !l.record || l.record.status === "Submitted").length;
    maxPending = Math.max(maxPending, pending);
    o.onPoll?.({ pending, ended: all.length - pending });
    if (pending === 0 && (unaccounted() === 0 || Date.now() >= graceUntil)) break;
    if (Date.now() > giveUp) {
      unfinished = pending;
      o.out(`stopped following: ${lanesText(pending)} still Submitted; GET /api/tx/<hash> shows each one later`);
      break;
    }
    await sleep(o.pollMs ?? 1_000);
    if (unaccounted() > 0) await lookForUnnamed();
  }

  // The status timelines, then the numbers, then each admission report, then the JSON sent.
  const since = (iso: string) => `+${((Date.parse(iso) - t0) / 1000).toFixed(2)} s`;
  const recordLines = (name: string, r: TxView) => {
    const block = r.receipt ? ` in block ${BigInt(r.receipt.blockNumber)}` : "";
    o.out(`${name}: leaf ${r.leaf}, nonce key ${r.nonceKey}, ${r.status}${block}, tx ${r.txHash}`);
    for (const t of r.timeline) o.out(`  ${since(t.at)}  ${t.status}`);
  };
  o.out("");
  o.out("lanes:");
  for (const l of lanes) {
    if (l.record) recordLines(`lane ${l.index}`, l.record);
    else if (l.hash) o.out(`lane ${l.index}: tx ${l.hash}, no record read`);
    else if (l.kind === "no_answer") o.out(`lane ${l.index}: no answer: may have been sent (its record, if the backend made one, is among the found lanes)`);
    else o.out(`lane ${l.index}: not sent (${l.httpStatus} ${l.error!.error})`);
  }
  for (const f of found) {
    if (f.record) recordLines(`found ${f.index}`, f.record);
    else o.out(`found ${f.index}: tx ${f.hash}, no record read`);
  }
  const outcomes = [...lanes, ...found];
  const blocks = [...new Set(outcomes.flatMap((l) => (l.record?.receipt ? [BigInt(l.record.receipt.blockNumber)] : [])))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const ends = followed().flatMap((l) => (l.record && l.record.status !== "Submitted" ? [Date.parse(l.record.updatedAt)] : []));
  const seconds = ends.length ? Math.max(0, (Math.max(...ends) - t0) / 1000) : 0;
  const count = (k: LaneKind) => lanes.filter((l) => l.kind === k).length;
  const admitted = count("admitted");
  const landed = outcomes.filter((l) => l.record?.receipt).length;
  o.out("");
  o.out(`admitted ${admitted} of ${lanesText(plan.n)}; refused ${count("refused")}; not sent ${count("not_sent")}; no answer ${noAnswer}`);
  if (noAnswer || found.length) {
    o.out(`found ${lanesText(found.length)} named by no answer, created since the burst began (${noAnswer ? "a lost answer's, or another client's" : "another client's"}): followed like the others`);
  }
  if (unaccounted()) {
    const one = unaccounted() === 1;
    o.out(`UNACCOUNTED: ${lanesText(unaccounted())} got no answer and no record of the wallet's accounts for ${one ? "it" : "them"}: ` +
      `${one ? "it" : "each"} may still have been sent, its leaf spent. Read GET /api/wallets/${a.wallet}/txs and the explorer before sending again`);
  }
  o.out(`most lanes pending at once: ${maxPending}`);
  o.out(landed ? `landed in ${blocks.length} block${blocks.length === 1 ? "" : "s"}: ${blocks.join(", ")} (${lanesText(landed)})` : "landed: none");
  o.out(`first send to last outcome: ${seconds.toFixed(2)} s`);
  const shown = [
    ...lanes.filter((l) => l.hash !== null).map((l) => ({ name: `lane ${l.index}`, file: `lane-${String(l.index).padStart(2, "0")}`, l })),
    ...found.map((l) => ({ name: `found ${l.index}`, file: `found-${String(l.index).padStart(2, "0")}`, l })),
  ];
  o.out("admission reports:");
  for (const { name, l } of shown) {
    o.out(`  ${name}: ${l.record?.admission?.summary ?? (l.record?.mempool === "public" ? "none: the public pool keeps no admission record" : "none")}`);
  }

  for (const { name, file, l } of shown) {
    const wire = l.record?.wire ?? null;
    if (wire === null) { o.out(`${name}: no JSON was sent (refused by the node's dry run before any mempool saw it)`); continue; }
    const raw = l.record?.mempool === "public" ? " (the public pool got its raw encoding)" : "";
    if (a.jsonOut) {
      fs.mkdirSync(a.jsonOut, { recursive: true });
      l.jsonFile = path.join(a.jsonOut, `${file}-${l.hash}.json`);
      fs.writeFileSync(l.jsonFile, `${JSON.stringify(wire, null, 2)}\n`);
      o.out(`sent JSON written: ${l.jsonFile}${raw}`);
    } else {
      o.out(`sent JSON, ${name} (tx ${l.hash})${raw}: ${JSON.stringify(wire)}`);
    }
  }
  return { plan, sent: true, lanes, admitted, noAnswer, found, unaccounted: unaccounted(), maxPending, blocks, seconds, unfinished };
}

// ------------------------------------------------------------------ the command line

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  burst?: Omit<BurstOptions, "out">;
}

/**
 * Exit codes: 0 done, 1 refused by the plan or the backend (or not reached), 2 a usage error, 3 a burst lane got no
 * answer and no record of the wallet's accounts for it (it may have been sent: look before sending again).
 */
export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { io.out(USAGE); return 0; }
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    io.err(`${message(e)}\n\n${USAGE}`);
    return 2;
  }
  const c = createClient({ base: io.env?.WL_BACKEND_URL, fetch: io.fetch });
  try {
    if (a.command === "plan") {
      for (const l of planLines(await fetchPlan(c, a))) io.out(l);
      return 0;
    }
    const r = await burst(c, a, { ...io.burst, out: io.out });
    if (!r.sent) return 1;
    if (r.unaccounted > 0) {
      io.err(`${lanesText(r.unaccounted)} unaccounted for: no answer came and the backend lists no record for ${r.unaccounted === 1 ? "it" : "them"}; it may still have been sent`);
      return 3;
    }
    return 0;
  } catch (e) {
    io.err(message(e));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }));
}
