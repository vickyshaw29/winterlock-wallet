// Tests of the parallel-lanes CLI (demo/lanes.ts) against the real backend app in process, on its fake chain.
// Written with Claude Code (AI) for Vicky.
// The backend (backend/test/helpers.ts, fake-chain.ts) listens on a random loopback port and is driven over real HTTP,
// as the web's integration test does.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "bun";
import { frameTxHash, fromWire, toWire } from "../../pipeline/src/index.ts";
import { ETHREX_ONE_PER_SENDER, SIDECAR_RELAY } from "../../backend/test/fake-chain.ts";
import { Harness, TARGET, until } from "../../backend/test/helpers.ts";
import { USAGE, burst, createClient, explainSendError, fetchPlan, main, parseArgs, planLines, weiText, type Args, type Client } from "../lanes.ts";

const loopbackFetch = globalThis.fetch; // the fake chain replaces globalThis.fetch while it is installed
setDefaultTimeout(30_000);

let h: Harness;
let server: Server<undefined>;
let client: Client;
let base: string;
let a: string;
beforeEach(async () => {
  h = await Harness.create({ config: { port: 0 } });
  server = h.app.listen();
  base = `http://127.0.0.1:${server.port}`;
  client = createClient({ base, fetch: loopbackFetch });
  // over real HTTP, as everything here: the harness's own req() names port 8787, which this backend is not on.
  // Height 5, hotStart 16: cold leaves 1 to 15, so 11 keyed lanes (the last 4 stay for admin calls).
  const r = await client.post("/wallets", { height: 5, spendLimitWei: "10000000000000000", hotStart: 16, allowedTarget: TARGET });
  if (r.status !== 200) throw new Error(`POST /wallets: ${r.status} ${JSON.stringify(r.body)}`);
  a = r.body.address;
});
afterEach(async () => { await h.destroy(); });

const args = (over: Partial<Args> = {}): Args => ({
  command: "burst", wallet: a, n: 8, mode: "keyed", valueWei: "1000", to: null, mempool: "alt", expirySeconds: 180, force: false, jsonOut: null, ...over,
});
/** Lines the CLI prints, and the burst's options with a fast poll. */
function capture() {
  const lines: string[] = [];
  let mostPending = 0;
  return { lines, opts: { out: (l: string) => { lines.push(l); }, pollMs: 5, onPoll: (s: { pending: number }) => { mostPending = Math.max(mostPending, s.pending); } }, mostPending: () => mostPending };
}

describe("plan", () => {
  test("eight lanes in plain words: the per-lane bound, the set-aside against the balance, two relay passes, about 38 s", async () => {
    h.chain.relay = { ...SIDECAR_RELAY };
    const p = await fetchPlan(client, args({ command: "plan" }));
    expect(p).toMatchObject({ wallet: a, n: 8, mode: "keyed", passes: 2, etaSeconds: 38, affordable: true, lanesLeft: 11, warnings: [] });
    const lines = planLines(p);
    expect(lines[0]).toBe(`parallel lanes plan for ${a}: 8 lanes at once, keyed, each sending 1,000 wei (0.000000000000001 ETH) to ${p.to}`);
    expect(lines).toContain(`  set aside with the new lanes: ${weiText(p.setAsideWei)} of a balance of 20,000,000,000,000,000 wei (0.02 ETH): affordable`);
    expect(lines).toContain("  relay: 4 lanes per pass, a pass every 10 s (read from the sidecar), bundling auto");
    expect(lines).toContain("  8 lanes need 2 relay passes: the last should land about 38 s after the send (an estimate: 28 s for one lane, measured Nov 5, plus one interval per further pass); each lane's deadline is 180 s");
    expect(lines).toContain("  cold leaves for keyed lanes left: 11");
    expect(h.coldJournal(a).leaves).toEqual({}); // a plan reserves nothing
  });

  test("through main(), as a terminal runs it: WL_BACKEND_URL, exit 0; a sidecar that cannot be asked is said so", async () => {
    const out: string[] = [], err: string[] = [];
    const code = await main(["plan", "--wallet", a, "--n", "8"], { out: (l) => out.push(l), err: (l) => err.push(l), env: { WL_BACKEND_URL: base }, fetch: loopbackFetch });
    expect([code, err]).toEqual([0, []]);
    expect(out[0]).toMatch(/^parallel lanes plan for 0x[0-9a-fA-F]{40}: 8 lanes at once, keyed/);
    expect(out).toContainEqual(expect.stringMatching(/^ {2}warning: the sidecar's relay settings were not read \(skandha_config: no response: .+\): assumed its defaults, 4 lanes per pass every 10 s$/));
  });
});

describe("burst", () => {
  test("eight lanes on the alt mempool: all admitted, all pending at once, landing over two blocks of four", async () => {
    h.chain.relay = { ...SIDECAR_RELAY };
    h.chain.batching = true; // lanes wait as New for the relay's passes, as on the devnet
    const c = capture();
    const run = burst(client, args(), c.opts);
    await until(() => c.mostPending() === 8, 15_000, "eight lanes pending at once");
    const first = h.chain.relayPass(); // the first pass: four lanes, in admission order, into one block
    const second = h.chain.relayPass();
    expect([first.length, second.length]).toEqual([4, 4]);
    const r = await run;

    expect([r.sent, r.admitted, r.maxPending, r.unfinished, r.noAnswer, r.found, r.unaccounted]).toEqual([true, 8, 8, 0, 0, [], 0]);
    expect(r.lanes.every((l) => l.httpStatus === 200 && l.record?.status === "OnChain")).toBe(true);
    // a burst's deadline is 180 s, not the 90 s of a single send (spec "Fees", Nov 6)
    for (const l of r.lanes) expect(Math.abs(l.record!.deadline! - Date.parse(l.record!.createdAt) / 1000 - 180)).toBeLessThan(5);
    expect(new Set(r.lanes.map((l) => l.answer!.leaf)).size).toBe(8);
    expect(new Set(r.lanes.map((l) => l.answer!.nonceKeys[0])).size).toBe(8);
    expect(r.blocks).toHaveLength(2);
    const blockOf = (hash: string) => BigInt(r.lanes.find((l) => l.hash === hash)!.record!.receipt!.blockNumber);
    expect([...new Set(first.map(blockOf))]).toEqual([r.blocks[0]!]);
    expect([...new Set(second.map(blockOf))]).toEqual([r.blocks[1]!]);
    expect(first).toEqual(h.chain.sent.slice(0, 4).map((t) => frameTxHash(t))); // relayed in the order admitted

    // what it printed: each answer as it came, the timelines, the numbers, the admission reports, the JSON sent
    for (const l of r.lanes) expect(c.lines).toContain(`lane ${l.index}: admitted, leaf ${l.answer!.leaf}, nonce key ${l.answer!.nonceKeys[0]}, tx ${l.hash} (+${l.answeredAt.toFixed(2)} s)`);
    expect(c.lines).toContain("admitted 8 of 8 lanes; refused 0; not sent 0; no answer 0");
    expect(c.lines.some((l) => /^found |^UNACCOUNTED/.test(l))).toBe(false); // every answer came: nothing to look for
    expect(c.lines).toContain("most lanes pending at once: 8");
    expect(c.lines).toContain(`landed in 2 blocks: ${r.blocks.join(", ")} (8 lanes)`);
    expect(c.lines).toContainEqual(expect.stringMatching(/^first send to last outcome: \d+\.\d\d s$/));
    expect(c.lines.filter((l) => l === "  lane 1: included: 2 of 2 rules passed")).toHaveLength(1);
    expect(c.lines).toContainEqual(expect.stringMatching(/^ {2}\+\d+\.\d\d s {2}OnChain in block \d+$/));
    const printed = c.lines.filter((l) => l.startsWith("sent JSON, lane "));
    expect(printed).toHaveLength(8);
    const sent = printed.map((l) => JSON.parse(l.slice(l.indexOf(": ") + 2)));
    expect(sent).toEqual(expect.arrayContaining(h.chain.sent.map((t) => toWire(t) as unknown)));
  });

  test("eight lanes on the public mempool: one admitted, seven refused, each with the explained reason", async () => {
    h.chain.autoInclude = false; // the first payment stays pending, so the pool's one-per-sender rule shows
    h.chain.publicRefusal = ETHREX_ONE_PER_SENDER;
    const c = capture();
    const run = burst(client, args({ mempool: "public" }), c.opts);
    await until(() => h.app.backend.store.forWallet(a).length === 8, 15_000, "eight answers");
    h.chain.mine();
    const r = await run;
    expect([r.admitted, r.lanes.filter((l) => l.error?.error === "refused").length]).toEqual([1, 7]);
    const refused = r.lanes.filter((l) => l.error);
    expect(refused.every((l) => l.kind === "refused" && l.httpStatus === 422 && l.explained?.code === "public_one_per_sender")).toBe(true);
    expect(refused.every((l) => l.record?.status === "Refused")).toBe(true);
    expect(r.lanes.find((l) => l.answer)!.record!.status).toBe("OnChain");
    for (const l of refused) {
      expect(c.lines).toContain(`lane ${l.index}: refused, leaf ${l.error!.leaf} burned: public mempool: one pending frame transaction per sender, and this account already has one. ` +
        `send parallel lanes to the alt mempool, which holds one pending transaction per nonce key, or wait for the pending one to land (+${l.answeredAt.toFixed(2)} s)`);
    }
    expect(c.lines).toContain("admitted 1 of 8 lanes; refused 7; not sent 0; no answer 0");
    expect(c.lines.filter((l) => l.endsWith("none: the public pool keeps no admission record"))).toHaveLength(8);
    // all eight reached the pool, the refused ones too: each one's JSON is printed, noted as sent raw
    expect(c.lines.filter((l) => l.startsWith("sent JSON, lane ") && l.includes("(the public pool got its raw encoding): {"))).toHaveLength(8);
  });

  test("not affordable: refused before anything is signed; --force sends anyway and lets the mempool decide", async () => {
    const c = capture();
    const r = await burst(client, args({ valueWei: (3n * 10n ** 15n).toString() }), c.opts); // 8 x 0.003 ETH and gas, against 0.02 ETH
    expect([r.sent, r.lanes.length]).toEqual([false, 0]);
    expect(c.lines.at(-1)).toMatch(/^not sent: the balance does not cover the 8 lanes \(short by [\d,]+ wei \(0\.\d+ ETH\)\); fund the wallet, send fewer lanes, or pass --force/);
    expect(c.lines).toContainEqual(expect.stringMatching(/^ {2}set aside with the new lanes: .*: NOT affordable, short by /));
    expect([h.chain.sent.length, h.chain.calls.simulate]).toEqual([0, 0]);
    expect(h.coldJournal(a).leaves).toEqual({});
    // two lanes whose values fit but whose gas set-aside does not: the fake mempool has no balance rule, so both land
    const forced = capture();
    const f = await burst(client, args({ n: 2, valueWei: (99n * 10n ** 14n).toString(), force: true }), forced.opts);
    expect([f.plan.affordable, f.sent, f.admitted]).toEqual([false, true, 2]);
    expect(forced.lines).toContain("--force: sending although the plan says the balance does not cover every lane");
  });

  test("--json-out writes each lane's exact sent JSON to a file and prints only where", async () => {
    const dir = path.join(h.dirs.root, "lanes-json");
    const c = capture();
    const r = await burst(client, args({ n: 3, jsonOut: dir }), c.opts);
    expect(fs.readdirSync(dir).sort()).toEqual(r.lanes.map((l) => `lane-0${l.index}-${l.hash}.json`).sort());
    for (const l of r.lanes) {
      const json = JSON.parse(fs.readFileSync(l.jsonFile!, "utf8"));
      expect(json).toEqual(l.record!.wire);
      expect(frameTxHash(fromWire(json)) as string).toBe(l.hash!);
      expect(c.lines).toContain(`sent JSON written: ${l.jsonFile}`);
    }
    const files = r.lanes.map((l) => JSON.parse(fs.readFileSync(l.jsonFile!, "utf8")));
    expect(files).toEqual(expect.arrayContaining(h.chain.sent.map((t) => toWire(t) as unknown))); // exactly what the mempool got
    expect(c.lines.some((l) => l.startsWith("sent JSON, lane"))).toBe(false);
  });

  test("a lane the backend refuses before signing is reported, not followed: the band's last leaves stay for admin calls", async () => {
    const c = capture();
    const r = await burst(client, args({ n: 12, force: true }), c.opts); // 11 keyed lanes are left, not 12
    expect(r.plan.warnings).toContain("only 11 cold leaf(s) are left for keyed lanes (the last 4 stay for the kill switch and a rotation): the burst would stop after 11");
    expect([r.admitted, r.lanes.filter((l) => l.error?.error === "leaves_exhausted").length]).toEqual([11, 1]);
    const stopped = r.lanes.find((l) => l.error)!;
    expect([stopped.kind, stopped.httpStatus, stopped.hash, stopped.record]).toEqual(["not_sent", 409, null, null]);
    expect(c.lines).toContainEqual(expect.stringMatching(/^lane \d+: not sent \(409 leaves_exhausted\): 4 unused cold leaf\(s\) and this send needs 1/));
    expect(c.lines).toContain(`lane ${stopped.index}: not sent (409 leaves_exhausted)`);
    expect(c.lines).toContain("admitted 11 of 12 lanes; refused 0; not sent 1; no answer 0");
  });
});

describe("lost answers: a send whose answer is lost may have been sent", () => {
  /**
   * A fetch for the burst whose k-th POST /send (k = the lane, in the order the requests go out) is lost: "after" the
   * backend took it and answered (the answer is dropped), "before" it reached the backend, or "500": the backend's
   * answer replaced by its generic 500. Everything else goes through as sent.
   */
  function lossy(lose: (k: number) => "after" | "before" | "500" | undefined): typeof fetch {
    let k = 0;
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (!(init?.method === "POST" && String(url).endsWith("/send"))) return loopbackFetch(url, init);
      const how = lose(++k);
      if (how === "before") throw new Error("connect ECONNREFUSED");
      const res = await loopbackFetch(url, init);
      if (how === undefined) return res;
      await res.text(); // the backend answered; the answer never arrives
      if (how === "after") throw new Error("socket hang up");
      return new Response(JSON.stringify({ error: "internal", detail: "internal error; the backend's log has the cause" }), { status: 500 });
    }) as typeof fetch;
  }
  const saidUnsent = (lines: string[], i: number) => lines.filter((l) => l.startsWith(`lane ${i}: `) && /not sent|nothing signed/.test(l));

  test("an answer lost after the backend sent, and a 500: no answer, may have been sent; both records found, followed, printed, counted apart", async () => {
    const c = capture();
    const r = await burst(createClient({ base, fetch: lossy((k) => (k === 2 ? "after" : k === 3 ? "500" : undefined)) }), args({ n: 4 }), c.opts);
    expect([r.admitted, r.noAnswer, r.found.length, r.unaccounted]).toEqual([2, 2, 2, 0]);
    const [two, three] = [r.lanes[1]!, r.lanes[2]!];
    expect([two.kind, two.httpStatus, two.hash, three.kind, three.httpStatus, three.hash]).toEqual(["no_answer", 0, null, "no_answer", 500, null]);
    expect(c.lines).toContain(`lane 2: no answer: may have been sent (socket hang up); the wallet's records are read for it (+${two.answeredAt.toFixed(2)} s)`);
    expect(c.lines).toContain(`lane 3: no answer: may have been sent (500 internal: internal error; the backend's log has the cause); the wallet's records are read for it (+${three.answeredAt.toFixed(2)} s)`);
    for (const i of [2, 3]) {
      expect(saidUnsent(c.lines, i)).toEqual([]);
      expect(c.lines).toContain(`lane ${i}: no answer: may have been sent (its record, if the backend made one, is among the found lanes)`);
    }
    // the records no answer named are exactly the two sends whose answers were lost, followed to their end like the others
    const named = new Set(r.lanes.flatMap((l) => (l.hash ? [l.hash] : [])));
    const unnamed = h.chain.sent.map((t) => frameTxHash(t) as string).filter((x) => !named.has(x));
    expect(r.found.map((f) => f.hash).sort()).toEqual(unnamed.sort());
    for (const f of r.found) {
      expect(f.record?.status).toBe("OnChain");
      expect(c.lines).toContain(`found ${f.index}: tx ${f.hash}, created since the burst began, named by no answer (a lost answer's lane, or another client's): followed like the lanes`);
      expect(c.lines).toContain(`found ${f.index}: leaf ${f.record!.leaf}, nonce key ${f.record!.nonceKey}, OnChain in block ${BigInt(f.record!.receipt!.blockNumber)}, tx ${f.hash}`);
      expect(c.lines).toContain(`  found ${f.index}: included: 2 of 2 rules passed`);
      const printed = c.lines.find((l) => l.startsWith(`sent JSON, found ${f.index} (tx ${f.hash}): `))!;
      expect(JSON.parse(printed.slice(printed.indexOf("): ") + 3))).toEqual(f.record!.wire);
    }
    expect(c.lines).toContain("admitted 2 of 4 lanes; refused 0; not sent 0; no answer 2");
    expect(c.lines).toContain("found 2 lanes named by no answer, created since the burst began (a lost answer's, or another client's): followed like the others");
    expect(c.lines).toContainEqual(expect.stringMatching(/^landed in \d+ blocks?: [\d, ]+ \(4 lanes\)$/));
    expect(c.lines.some((l) => l.startsWith("UNACCOUNTED"))).toBe(false);

    // through main(), as a terminal runs it: every lane accounted for, exit 0
    const out: string[] = [], err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: { WL_BACKEND_URL: base }, burst: { pollMs: 5 } };
    expect(await main(["burst", "--wallet", a, "--n", "2"], { ...io, fetch: lossy((k) => (k === 1 ? "after" : undefined)) })).toBe(0);
    expect([err, out.filter((l) => l.startsWith("admitted "))]).toEqual([[], ["admitted 1 of 2 lanes; refused 0; not sent 0; no answer 1"]]);
  });

  test("a request that never reached the backend: no answer, no record found, unaccounted: exit 3, and never called not sent", async () => {
    const out: string[] = [], err: string[] = [];
    const code = await main(["burst", "--wallet", a, "--n", "3"], {
      out: (l) => out.push(l), err: (l) => err.push(l), env: { WL_BACKEND_URL: base },
      fetch: lossy((k) => (k === 2 ? "before" : undefined)), burst: { pollMs: 5, lostAnswerGraceMs: 100 },
    });
    expect(code).toBe(3);
    expect(h.chain.sent).toHaveLength(2); // the backend never saw lane 2
    expect(out).toContainEqual(expect.stringMatching(/^lane 2: no answer: may have been sent \(connect ECONNREFUSED\); the wallet's records are read for it \(\+\d+\.\d\d s\)$/));
    expect(out).toContain("lane 2: no answer: may have been sent (its record, if the backend made one, is among the found lanes)");
    expect(saidUnsent(out, 2)).toEqual([]);
    expect(out).toContain("admitted 2 of 3 lanes; refused 0; not sent 0; no answer 1");
    expect(out).toContain("found 0 lanes named by no answer, created since the burst began (a lost answer's, or another client's): followed like the others");
    expect(out).toContain(`UNACCOUNTED: 1 lane got no answer and no record of the wallet's accounts for it: it may still have been sent, its leaf spent. Read GET /api/wallets/${a}/txs and the explorer before sending again`);
    expect(err).toEqual(["1 lane unaccounted for: no answer came and the backend lists no record for it; it may still have been sent"]);
  });
});

describe("arguments and errors", () => {
  test("parseArgs: defaults, and every mistake named", () => {
    expect(parseArgs(["burst", "--wallet", `0x${"ab".repeat(20)}`, "--n", "8"])).toEqual({
      command: "burst", wallet: `0x${"ab".repeat(20)}`, n: 8, mode: "keyed", valueWei: "0", to: null, mempool: "alt", expirySeconds: 180, force: false, jsonOut: null,
    });
    expect(parseArgs(["plan", "--wallet", `0x${"ab".repeat(20)}`, "--n", "4", "--expiry-seconds", "300"]).expirySeconds).toBe(300);
    const w = ["--wallet", `0x${"ab".repeat(20)}`];
    const bad: [string[], RegExp][] = [
      [[], /say plan or burst/], [["send"], /unknown command send/], [["plan", "--n", "8"], /--wallet must be/],
      [["plan", ...w], /--n must be a whole number of lanes from 1 to 64/], [["plan", ...w, "--n", "0"], /--n must be/], [["plan", ...w, "--n", "65"], /--n must be/],
      [["plan", ...w, "--n", "8", "--mode", "warm"], /--mode must be keyed or hot/], [["burst", ...w, "--n", "8", "--mempool", "private"], /--mempool must be alt or public/],
      [["plan", ...w, "--n", "8", "--value-wei", "1.5"], /--value-wei must be a whole number of wei/], [["plan", ...w, "--n", "8", "--to", "0x12"], /--to must be an address/],
      [["plan", ...w, "--n", "8", "--force"], /--force is for burst only/], [["plan", ...w, "--n", "8", "--n", "9"], /--n is given twice/],
      [["plan", ...w, "--n"], /--n needs a value/], [["plan", ...w, "--n", "8", "--speed", "1"], /unknown argument --speed/],
      [["burst", ...w, "--n", "8", "--expiry-seconds", "9"], /--expiry-seconds must be a whole number of seconds from 10 to 3600/],
      [["burst", ...w, "--n", "8", "--expiry-seconds", "3601"], /--expiry-seconds must be/], [["burst", ...w, "--n", "8", "--expiry-seconds", "1.5"], /--expiry-seconds must be/],
    ];
    for (const [argv, why] of bad) expect(() => parseArgs(argv)).toThrow(why);
  });

  test("main: a usage error is exit 2 with the usage; --help is exit 0; a backend that does not answer is exit 1", async () => {
    const out: string[] = [], err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch: loopbackFetch };
    expect(await main(["burst", "--n", "8"], io)).toBe(2);
    expect(err.pop()).toContain(USAGE);
    expect(await main(["--help"], io)).toBe(0);
    expect(out.pop()).toBe(USAGE);
    expect(await main(["plan", "--wallet", a, "--n", "2"], { ...io, env: { WL_BACKEND_URL: "http://127.0.0.1:1" } })).toBe(1);
    expect(err.pop()).toMatch(/^the backend at http:\/\/127\.0\.0\.1:1 did not answer/);
    expect(await main(["plan", "--wallet", `0x${"00".repeat(19)}01`, "--n", "2"], { ...io, env: { WL_BACKEND_URL: base } })).toBe(1);
    expect(err.pop()).toMatch(/^the plan was refused \(404 unknown_wallet\)/);
  });

  test("explainSendError: the detail first, then the violations, then the account's reason as the backend reads it", () => {
    expect(explainSendError({ detail: "leaf 3: refused at submission: eth_sendFrameTransaction: Frame transaction already known (-32602)" })?.code).toBe("duplicate");
    expect(explainSendError({ detail: "leaf 3: preflight refused: VERIFY frame 1 reverted", simulation: { violations: ["VERIFY frame 1 reverted", "account: hot: value cap"] } }))
      .toMatchObject({ code: "account_refused", laneState: `refused by the account: "hot: value cap"` });
    expect(explainSendError({ detail: "something new" })).toBeNull();
    expect(explainSendError(null)).toBeNull();
  });
});
