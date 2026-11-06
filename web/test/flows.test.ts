// flows.js and api.js without a backend: the exact bodies the buttons send, the inline checks, the agent's tranche and
// rule, the session's grant, the ticket device's trouble (409 device_unusable, tickets.unjournaled), the parallel lanes'
// limits in words, the parallel-lanes plan, GET /api/status's shape with the status line and banner, and the client's
// errors. Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import { ApiError, createApi } from "../src/domain/api.js";
import * as flows from "../src/domain/flows.js";
import { changePct, createMockMarket, fallPct, ruleFires } from "../src/domain/market.js";

const TARGET = "0x5544596212F91984C986A919C8026DF0576816f9";
const wallet = {
  address: "0x00000000000000000000000000000000000ACC01", allowedTarget: TARGET, hotValueCapWei: "10000000000000000", hotFeeCapWei: "2000000000000000",
  balanceWei: "1000000000000000000", leafCount: 32, hotStart: 16, tickets: { exported: 0, used: 0, left: 0 },
};
/** the backend's 409 for tickets cut whose device journal is missing (backend.ts, unjournaled) */
const lostJournal = (n: number) => new ApiError(409, "device_unusable", `${n} ticket(s) of epoch 0 were cut for 0x00000000000000000000000000000000000ACC01 ` +
  `(${n} exported in the cold journal, 1 ticket file(s) in /tmp/wl/devices/0xacc01/tickets), but the device journal is missing: ` +
  "recover /tmp/wl/devices/0xacc01/journal-epoch0.json; a new journal would re-sign used tickets", {});

describe("what the buttons send", () => {
  test("the stuck payment: hot, a 4-second first deadline, one retry; no fee field, so never a low fee or a fee bump", () => {
    const body = flows.stuckBody({ wallet, valueWei: 7n, mempool: "alt" });
    expect(body).toEqual({ to: TARGET, valueWei: "7", mode: "hot", mempool: "alt", firstAttemptExpirySeconds: 4, retries: 1 });
    expect(Object.keys(body)).not.toContain("maxFeePerGasWei"); // a low fee cannot stick on this devnet (spec, Nov 6)
    expect(Object.keys(body)).not.toContain("expirySeconds"); // the retry keeps the backend's normal deadline
    expect(flows.STUCK).toEqual({ firstAttemptExpirySeconds: 4, retries: 1 });
  });

  test("pay, move, cold transfer, and the compromised server's payment", () => {
    expect(flows.payBody({ wallet, valueWei: 1000n, mempool: "public" })).toEqual({ to: TARGET, valueWei: "1000", mode: "hot", mempool: "public" });
    const move = flows.moveBody(wallet, "alt");
    expect(move).toEqual({ to: TARGET, valueWei: "0", mode: "hot", mempool: "alt" });
    expect("data" in move).toBe(false); // the account allows no calldata on a hot leaf
    expect(flows.coldTransferBody({ to: "0x00000000000000000000000000000000000b0b00", valueWei: 5n, mempool: "alt" }))
      .toEqual({ to: "0x00000000000000000000000000000000000b0b00", valueWei: "5", mode: "keyed", mempool: "alt" });
    // Server compromised: two payments, over the cap to the allowed target, and within it to a new address
    const [over, elsewhere] = flows.compromisedBodies(wallet, "alt");
    expect(over).toEqual({ to: TARGET, valueWei: "100000000000000000", mode: "hot", mempool: "alt" });
    expect(elsewhere).toMatchObject({ valueWei: "1000000000000000", mode: "hot", mempool: "alt" });
    expect(elsewhere.to).toMatch(/^0x[0-9a-f]{40}$/);
    expect(elsewhere.to.toLowerCase()).not.toBe(TARGET.toLowerCase());
    expect(flows.compromisedBodies({ ...wallet, hotValueCapWei: "0" }, "alt").map((b) => b.valueWei)).toEqual(["1", "1"]);
    expect(flows.compromisedBodies(wallet, "public", "0x00000000000000000000000000000000000b0b00")[1]).toEqual({ to: "0x00000000000000000000000000000000000b0b00", valueWei: "1000000000000000", mode: "hot", mempool: "public" });
  });

  test("set policy and create wallet refuse bad input before calling the backend", () => {
    const calls: unknown[] = [];
    const api = { hotPolicy: async (_a: string, b: unknown) => { calls.push(b); return { txHash: "0x", status: "Submitted" as const }; } } as any;
    expect(() => flows.setPolicy(api, wallet.address, { hotStart: "x", valueCap: "0.01", feeCap: "0.002", allowedTarget: TARGET })).toThrow(ApiError);
    expect(() => flows.setPolicy(api, wallet.address, { hotStart: "16", valueCap: "1e3", feeCap: "0.002", allowedTarget: TARGET })).toThrow("the caps must be amounts in ETH");
    expect(() => flows.setPolicy(api, wallet.address, { hotStart: "16", valueCap: "0", feeCap: "0.002", allowedTarget: "0x12" })).toThrow("the allowed target must be an address");
    expect(calls).toEqual([]);
    void flows.setPolicy(api, wallet.address, { hotStart: "16", valueCap: "0", feeCap: "0.002", allowedTarget: ` ${TARGET} ` });
    expect(calls).toEqual([{ hotStart: 16, valueCapWei: "0", feeCapWei: "2000000000000000", allowedTarget: TARGET }]);
    expect(flows.createWalletBody({ height: "10", valueCap: "0.01", feeCap: " ", allowedTarget: "", hotStart: "" })).toEqual({ height: 10, spendLimitWei: "10000000000000000" });
    expect(flows.createWalletBody({ height: "4", valueCap: "1", feeCap: "0.5", allowedTarget: TARGET, hotStart: "12" }))
      .toEqual({ height: 4, spendLimitWei: "1000000000000000000", hotFeeCapWei: "500000000000000000", allowedTarget: TARGET, hotStart: 12 });
    expect(() => flows.createWalletBody({ height: "10", valueCap: "" })).toThrow("the hot value cap must be an amount in ETH");
  });
});

describe("inline checks and plans", () => {
  test("a hot amount: positive, within the cap; the kill switch says so", () => {
    expect(flows.checkHotAmount("0.01", wallet)).toEqual({ ok: true, wei: 10n ** 16n });
    expect(flows.checkHotAmount("0.0100000001", wallet)).toEqual({ ok: false, error: "above the hot value cap of 0.01 ETH; the account refuses it too" });
    expect(flows.checkHotAmount("0", wallet)).toEqual({ ok: false, error: "more than 0" });
    expect(flows.checkHotAmount("", wallet).ok).toBe(false);
    expect(flows.checkHotAmount("0.001", { hotValueCapWei: "0" })).toEqual({ ok: false, error: "hot tickets are off: the value cap is 0 (the kill switch)" });
  });

  test("tranches at the cap when the balance covers them, smaller when not, none when nothing is left", () => {
    expect(flows.trancheWei(wallet)).toBe(10n ** 16n);
    expect(flows.trancheWei({ ...wallet, balanceWei: "20000000000000000" })).toBe(3n * 10n ** 15n);
    expect(flows.trancheWei({ ...wallet, balanceWei: "0" })).toBeNull();
    expect(flows.maxLossWei({ ...wallet, tickets: { exported: 10, used: 3, left: 7 } })).toBe(7n * 12n * 10n ** 15n);
  });

  test("the grant: the dapp's 20, no more than the uncut hot band, no more than 64 at once", () => {
    expect(flows.uncutHotLeaves(wallet)).toBe(16);
    expect(flows.grantCount(wallet)).toBe(16);
    expect(flows.grantCount({ leafCount: 1024, hotStart: 900, tickets: { exported: 0, used: 0, left: 0 } })).toBe(20);
    expect(flows.grantCount({ leafCount: 1024, hotStart: 900, tickets: { exported: 0, used: 0, left: 0 } }, 100)).toBe(64);
    expect(flows.grantCount({ ...wallet, tickets: { exported: 16, used: 2, left: 14 } })).toBe(0);
  });

  test("the agent's rule: more than 2 % down within 30 s fires; less, or longer ago, does not", () => {
    const m = createMockMarket({ start: 1000, now: 0 });
    m.drop(1.9, 1_000);
    expect(ruleFires(m.history, 1_000, flows.RULE)).toBe(false);
    m.drop(0.5, 2_000);
    expect(ruleFires(m.history, 2_000, flows.RULE)).toBe(true);
    expect(fallPct(m.history, 40_000, flows.RULE.windowMs)).toBe(0); // the window has moved past every tick
    expect(changePct(m.history, 2_000, 30_000)).toBeCloseTo(-2.39, 1);
    const a = createMockMarket({ seed: 7, now: 0 }), b = createMockMarket({ seed: 7, now: 0 });
    for (let t = 1; t <= 50; t++) { a.tick(t * 500); b.tick(t * 500); }
    expect(a.history.map((x) => x.price)).toEqual(b.history.map((x) => x.price)); // the mock is the same on every load
    expect(Math.abs(fallPct(a.history, 25_000, 30_000))).toBeLessThan(10);
  });
});

describe("the ticket device", () => {
  test("tickets.unjournaled: the cards' words, singular and plural; none when the journal is there", () => {
    expect(flows.deviceIssue({ tickets: { exported: 3, used: 0, left: 0, unjournaled: 3 } }))
      .toEqual({ count: 3, text: "3 tickets were cut but are missing from the device journal: recover it" });
    expect(flows.deviceIssue({ tickets: { exported: 1, used: 0, left: 0, unjournaled: 1 } })?.text)
      .toBe("1 ticket was cut but is missing from the device journal: recover it");
    expect(flows.deviceIssue({ tickets: { exported: 3, used: 1, left: 2 } })).toBeNull();
    expect(flows.deviceIssue({ tickets: { exported: 0, used: 0, left: 0, unjournaled: 0 } })).toBeNull();
    expect(flows.deviceIssue(null)).toBeNull();
  });

  test("409 device_unusable: the count from the backend's detail; another cause keeps its words; other errors are not it", () => {
    expect(flows.deviceIssueOf(lostJournal(3))).toEqual({ count: 3, text: "3 tickets were cut but are missing from the device journal: recover it" });
    expect(flows.deviceIssueOf(lostJournal(1))?.text).toBe("1 ticket was cut but is missing from the device journal: recover it");
    const other = new ApiError(409, "device_unusable", "the ticket device of 0xacc01: ticket file epoch0-16-18.json names another tree", {});
    expect(flows.deviceIssueOf(other)).toEqual({ count: null, text: "The ticket device cannot be used: the ticket device of 0xacc01: ticket file epoch0-16-18.json names another tree" });
    for (const e of [new ApiError(409, "tickets_exhausted", "no ticket left", {}), new ApiError(422, "device_unusable", "x", {}), new Error("device_unusable"), null]) {
      expect(flows.deviceIssueOf(e)).toBeNull();
    }
  });
});

describe("parallel lanes in words", () => {
  test("the devnet sidecar's limits as the spec states them; the draft's numbers labelled; public one per sender as measured", () => {
    const t = flows.LANE_LIMITS_TEXT;
    for (const words of [
      "Parallel lanes", "1 pending per lane (nonce key)", "no per-sender cap for keyed lanes the account pays for itself",
      "relayed at most 4 per 10 s pass by default, so 8 lanes land over two or more blocks",
      "The ERC-8421 draft's numbers, 4 per key and 64 per unstaked sender, are the draft's, not the devnet's",
      "one pending per sender: measured on the devnet: 1 of 8 admitted, block 5,738",
    ]) expect([words, t.includes(words)]).toEqual([words, true]);
    expect(flows.mempoolNotice("alt")).toBe("Mempool: alt. Parallel lanes: 1 pending per lane (nonce key), no per-sender cap for keyed lanes the account pays for itself; the sidecar relays at most 4 per 10 s pass by default, so they land out of order, 8 lanes over two or more blocks.");
    expect(flows.mempoolNotice("public")).toContain("one pending frame transaction per sender (measured on the devnet: 1 of 8 admitted, block 5,738)");
  });
});

describe("the parallel-lanes plan", () => {
  const UNREAD = "the sidecar's relay settings were not read (skandha_config: no response: connection refused): assumed its defaults, 4 lanes per pass every 10 s";
  const plan = { affordable: true, setAsideWei: "48000000000000000", shortfallWei: "0", passes: 1, etaSeconds: 28, warnings: [UNREAD] };

  test("the plan's line and warnings, in the task's words; plural and singular; the balance is the wallet's unless the plan sends one", () => {
    const p = flows.readPlan(plan)!;
    expect(p).toEqual({ affordable: true, setAsideWei: 48n * 10n ** 15n, shortfallWei: 0n, passes: 1, etaSeconds: 28, warnings: plan.warnings, balanceWei: null });
    expect(flows.planWords(p, 4, "1000000000000000000")).toEqual({
      line: "4 lanes: 1 relay pass, about 28 s; set aside 0.048 ETH of balance 1 ETH",
      warnings: ["The mempool's relay settings could not be read, so the plan assumes its defaults: 4 lanes per relay pass, one pass every 10 s."],
    });
    const two = flows.readPlan({ ...plan, passes: 2, etaSeconds: 38.4, balanceWei: "20000000000000000" })!;
    expect(flows.planWords(two, 8, "1000000000000000000").line).toBe("8 lanes: 2 relay passes, about 38 s; set aside 0.048 ETH of balance 0.02 ETH");
  });

  test("a plan that does not fit says by how much; a field of another type is unknown, never guessed; a 404 is null", () => {
    const short = flows.readPlan({ ...plan, affordable: false, setAsideWei: "40000000000000000", shortfallWei: "20000000000000000", passes: 4, etaSeconds: 58 })!;
    expect(flows.planWords(short, 16, "20000000000000000").line)
      .toBe("16 lanes: 4 relay passes, about 58 s; set aside 0.04 ETH of balance 0.02 ETH; does not fit: short by 0.02 ETH");
    const odd = flows.readPlan({ affordable: "yes", setAsideWei: 5, shortfallWei: "0x10", passes: "1", etaSeconds: null, warnings: [{ code: "x" }, "y"] })!;
    expect(odd).toEqual({ affordable: null, setAsideWei: null, shortfallWei: null, passes: null, etaSeconds: null, warnings: ['{"code":"x"}', "y"], balanceWei: null });
    expect(flows.planWords(odd, 1, "7").line).toBe("1 lane: ? relay passes, about ? s; set aside — of balance 7 wei");
    expect(flows.readPlan(null)).toBeNull();
  });

  /** No API wording: no method and path, no status code, no code name, no account reason in quotes, no "wei" amount. */
  const RAW = /\/api\/|\b(?:GET|POST)\b|\(\d{3}\b|\b\d{3} [a-z]+_|\b[a-z]+_[a-z_]+\b|\("hot:|\d{6,} wei/;

  test("every warning the backend writes, in the screen's words: never a path, a status or a code ('No tickets left on the phone: cut some on the cold device.')", () => {
    const A = "0x00000000000000000000000000000000000ACC01", OTHER = "0x00000000000000000000000000000000000B0B00";
    // each as backend.ts lanesPlan and the pipeline's planLanes write it (backend/test/lanes.test.ts checks those)
    const cases: [string, string][] = [
      [UNREAD, "The mempool's relay settings could not be read, so the plan assumes its defaults: 4 lanes per relay pass, one pass every 10 s."],
      ["the sidecar's relay settings were not read: assumed its defaults, 4 lanes per pass every 0.5 s", "The mempool's relay settings could not be read, so the plan assumes its defaults: 4 lanes per relay pass, one pass every 0.5 s."],
      ["the last of 2 relay passes is due about 38 s after the send (an estimate), past the 30 s deadline: its lanes may expire before they are relayed; send fewer lanes at once, or give them a longer expiry",
        "The last of the 2 relay passes is due about 38 s after sending, past each lane's 30 s expiry: its lanes may expire before they are relayed. Send fewer at once."],
      ["the sidecar's bundling mode is manual: it relays nothing by itself, so the lanes stay New until someone sends a bundle",
        "The mempool relays only by hand right now: the lanes stay pending until someone relays them."],
      ["the chain looks stalled (the latest block's timestamp 1762400000 is 120 s from the host clock): every send is refused (503) until it moves", "The chain looks stalled: nothing can be sent until it moves."],
      ["a rotation of this wallet is pending: sends wait until the chain decides it (409 rotation_pending)", "A rotation is pending: nothing can be sent until the chain shows it or it fails."],
      [`no ticket can sign: ${lostJournal(3).detail} (hot sends and cuts are 409 device_unusable until then)`,
        "3 tickets were cut but are missing from the device journal: recover it. Until then no ticket can sign and none can be cut."],
      ["only 11 cold leaf(s) are left for keyed lanes (the last 4 stay for the kill switch and a rotation): the burst would stop after 11",
        "Only 11 cold leaves are left for lanes (4 more are kept for the kill switch and a rotation): only the first 11 lanes would be sent."],
      ["only 1 cold leaf(s) are left for keyed lanes (the last 4 stay for the kill switch and a rotation): the burst would stop after 1",
        "Only 1 cold leaf is left for lanes (4 more are kept for the kill switch and a rotation): only the first lane would be sent."],
      ["only 0 cold leaf(s) are left for keyed lanes (the last 4 stay for the kill switch and a rotation): the burst would stop after 0",
        "No cold leaves are left for lanes (the last 4 are kept for the kill switch and a rotation): rotate on the cold device."],
      [`only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${A}/tickets`, "No tickets left on the phone: cut some on the cold device."],
      ["only 3 ticket(s) are left on the ticket device: the burst would stop after 3", "Only 3 tickets left on the phone: only the first 3 lanes would be sent."],
      ["this account requires the ECDSA co-signature on cold leaves, which the backend does not make: keyed lanes are refused (409 hybrid_unsupported)",
        "This account requires the classical co-signature on cold leaves, which this backend does not make: keyed lanes would be refused."],
      [`the hot value cap is 0, the kill switch: the account refuses every hot lane ("hot: disabled")`, "The hot value cap is 0, the kill switch: the account refuses every ticket."],
      [`each lane's value, 20000000000000000 wei, is above the hot value cap of 10000000000000000 wei: the account refuses it ("hot: value cap")`,
        "Each lane sends 0.02 ETH, above the hot value cap of 0.01 ETH: the account would refuse it."],
      [`hot lanes may pay only the allowed target ${TARGET}: the account refuses ${OTHER} ("hot: frame target")`, "Tickets may pay only the allowed target 0x5544…16f9: the account would refuse 0x0000…0B00."],
      [`each lane's maximum cost, 774395585959912 wei, is above the hot fee cap of 1000 wei: the account refuses it ("hot: fee cap")`,
        "Each lane may cost up to 0.000774396 ETH in fees, above the hot fee cap of 1,000 wei: the account would refuse it."],
      ["1 lane(s) in flight have no recorded maximum cost (still being sent, sent by a script, or recorded before Nov 6): the set-aside leaves them out",
        "1 pending lane has no recorded cost, so the set-aside leaves it out."],
      ["2 lane(s) in flight have no recorded maximum cost (still being sent, sent by a script, or recorded before Nov 6): the set-aside leaves them out",
        "2 pending lanes have no recorded cost, so the set-aside leaves them out."],
      ["1 lane(s) expired in the last 40 s: the sidecar may still count them against the balance until it drops them",
        "1 lane expired in the last 40 s: the mempool may still hold its cost against the balance for a while."],
    ];
    for (const [backend, screen] of cases) {
      expect([backend, flows.planWarningText(backend)]).toEqual([backend, screen]);
      expect([screen, RAW.test(screen)]).toEqual([screen, false]);
    }
    // the agent's and the session's screens name their own ticket holder
    const none = `only 0 ticket(s) are left on the ticket device: the burst would stop after 0; cut some with POST /api/wallets/${A}/tickets`;
    expect(flows.planWarningText(none, { holder: "in the session", none: "No tickets in the session yet: Grant cuts them." })).toBe("No tickets in the session yet: Grant cuts them.");
    expect(flows.planWarningText("only 2 ticket(s) are left on the ticket device: the burst would stop after 2", { holder: "with the agent" }))
      .toBe("Only 2 tickets left with the agent: only the first 2 lanes would be sent.");
    // planWords maps every warning
    const p = flows.readPlan({ ...plan, warnings: cases.map(([b]) => b) })!;
    expect(flows.planWords(p, 4, "1").warnings).toEqual(cases.map(([, s]) => s));
  });

  test("a warning the screens do not know is shown without its API words; errors too lose the API's paths", () => {
    expect(flows.planWarningText("something new happened (409 lanes_busy); see GET /api/wallets/0xabc/txs")).toBe("Something new happened.");
    expect(flows.planWarningText(`the account refuses this ("hot: something") (503)`)).toBe("The account refuses this.");
    expect(flows.planWarningText("(409 x_y)")).toBe("The backend has a note on this plan.");
    expect(flows.planWarningText("a note that is plain already (3 lanes, 250 wei)")).toBe("A note that is plain already (3 lanes, 250 wei).");
    // the backend's 409 no_tickets names the endpoint that cuts; the screens say where tickets come from instead
    const noTickets = new ApiError(409, "no_tickets", "0x00000000000000000000000000000000000ACC01 holds no tickets for epoch 0: cut some with POST /api/wallets/0x00000000000000000000000000000000000ACC01/tickets", {});
    expect(flows.errorText(noTickets)).toBe("no_tickets (409): 0x00000000000000000000000000000000000ACC01 holds no tickets for epoch 0: cut some on the cold device");
    expect(flows.errorText(lostJournal(3))).toBe(`device_unusable (409): ${lostJournal(3).detail}`); // its parentheses are words, kept
  });

  test("a plan that cannot be read says why in plain words", () => {
    expect(flows.planFailureText(new ApiError(502, "rpc_failed", "the sidecar cannot be read", {}))).toBe("not read: the backend could not reach the chain or the mempool");
    expect(flows.planFailureText(new ApiError(0, "unreachable", "the web server could not be reached: fetch failed", {}))).toBe("not read: the screens' server did not answer");
    expect(flows.planFailureText(new ApiError(502, "backend_unreachable", "the backend at http://127.0.0.1:8787 did not answer: x", {}))).toBe("not read: the backend did not answer");
    expect(flows.planFailureText(new ApiError(404, "unknown_wallet", "no wallet 0xabc", {}))).toBe("not read: the backend refused it");
    expect(flows.planFailureText(new Error("x"))).toBe("not read");
  });
});

describe("status line and banner", () => {
  test("GET /api/status in the backend's shape: the devnet and the fake chain, the status line's words, the banner", () => {
    // the devnet (chain 1337) and the local fake chain (31337), as backend.status() answers
    const devnet = flows.readStatus({ chainId: 1337, head: 408_262, headAgeSeconds: 4, stalled: false, fake: false })!;
    expect(devnet).toEqual({ chainId: 1337, head: 408_262, ageSeconds: 4, stalled: false, fake: false });
    expect(flows.statusWords(devnet)).toEqual(["chain 1337", "latest block 408262, 4 s ago"]);
    expect(flows.statusBanner(devnet)).toBeNull();
    const fake = flows.readStatus({ chainId: 31337, head: 1002, headAgeSeconds: 0, stalled: false, fake: true })!;
    expect([fake.fake, flows.statusWords(fake)]).toEqual([true, ["chain 31337", "latest block 1002, 0 s ago"]]);
    // stalled: the banner, from the backend's own verdict
    const halted = flows.readStatus({ chainId: 1337, head: 408_262, headAgeSeconds: 5_400, stalled: true, fake: false })!;
    expect(flows.statusBanner(halted)).toBe("The chain looks stalled: latest block 408262, 1 h ago. The backend refuses to sign until it moves, so sending is off.");
    // exactly the shape: a field of another type is unknown, never guessed; fake only when the backend says so
    expect(flows.readStatus({ chainId: "0x539", head: { number: 16 }, blockAgeSeconds: 2, stalled: "yes", fake: 1 }))
      .toEqual({ chainId: null, head: null, ageSeconds: null, stalled: null, fake: false });
    expect(flows.statusWords(flows.readStatus({})!)).toEqual(["chain ?", "latest block ?"]);
    expect(flows.readStatus(null)).toBeNull(); // the 404 of a backend without the route (api.js answers null)
    expect(flows.statusBanner(null)).toBeNull();
  });

  test("only a 503 raises the banner; errors read in the backend's words, with the account's reasons on a refusal", () => {
    expect(flows.stalledBanner(new ApiError(503, "chain_stalled", "the latest block's timestamp 1 is 120 s from the host clock", {}))).toContain("Nothing was spent");
    expect(flows.stalledBanner(new ApiError(502, "rpc_failed", "x", {}))).toBeNull();
    expect(flows.stalledBanner(new Error("x"))).toBeNull();
    const refused = new ApiError(422, "refused", "preflight refused", { simulation: { violations: ["account: hot: frame target"] } });
    expect(flows.errorText(refused)).toBe("refused (422): preflight refused: account: hot: frame target");
    expect(flows.errorText(new ApiError(409, "tickets_exhausted", "no ticket left", {}))).toBe("tickets_exhausted (409): no ticket left");
  });
});

describe("api.js", () => {
  const stub = (status: number, body: string, type = "application/json") => async () => new Response(body, { status, headers: { "content-type": type } });

  test("the error shape becomes an ApiError with every extra field; non-JSON and network failures too", async () => {
    const api = createApi({ base: "http://127.0.0.1:9", fetch: stub(422, JSON.stringify({ error: "refused", detail: "no", txHash: "0xab", leaf: 16 })) });
    const e = await api.send("0x1", { to: TARGET }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.detail, e.body.leaf]).toEqual([422, "refused", "no", 16]);
    const html = await createApi({ fetch: stub(500, "<h1>oops</h1>", "text/html") }).listWallets().catch((x) => x);
    expect([html.status, html.code, html.detail]).toEqual([500, "http_500", "<h1>oops</h1>"]);
    const down = await createApi({ fetch: async () => { throw new TypeError("fetch failed"); } }).listWallets().catch((x) => x);
    expect([down.status, down.code]).toEqual([0, "unreachable"]);
    expect(await createApi({ fetch: stub(404, JSON.stringify({ error: "not_found", detail: "no route" })) }).status()).toBeNull();
  });

  test("the plan: its query in the URL; null for a backend without the route (404 not_found), an unknown wallet still throws", async () => {
    const seen: string[] = [];
    let answer = new Response(JSON.stringify({ error: "not_found", detail: "no route GET /api/wallets/0xabc/lanes/plan" }), { status: 404 });
    const api = createApi({ base: "http://h", fetch: async (u) => { seen.push(u); return answer; } });
    const q = { n: 4, mode: "hot" as const, valueWei: "10000000000000000", to: TARGET };
    expect(await api.lanesPlan("0xabc", q)).toBeNull();
    expect(seen).toEqual([`http://h/api/wallets/0xabc/lanes/plan?n=4&mode=hot&valueWei=10000000000000000&to=${TARGET}`]);
    answer = new Response(JSON.stringify({ error: "unknown_wallet", detail: "no wallet 0xabc" }), { status: 404 });
    const e = await api.lanesPlan("0xabc", q).catch((x) => x);
    expect([e instanceof ApiError, e.status, e.code]).toEqual([true, 404, "unknown_wallet"]);
    answer = new Response(JSON.stringify({ affordable: true, setAsideWei: "1", shortfallWei: "0", passes: 1, etaSeconds: 28, warnings: [] }), { status: 200 });
    expect(await api.lanesPlan("0xabc", q)).toEqual({ affordable: true, setAsideWei: "1", shortfallWei: "0", passes: 1, etaSeconds: 28, warnings: [] });
  });

  test("paths and bodies: addresses encoded, JSON with its content type", async () => {
    const seen: [string, RequestInit][] = [];
    const api = createApi({ base: "http://h/", fetch: async (u, i) => { seen.push([u, i]); return new Response("{}", { status: 200 }); } });
    await api.tickets("0xabc/../x", { count: 3 });
    await api.tx("0x12");
    expect(seen[0]![0]).toBe("http://h/api/wallets/0xabc%2F..%2Fx/tickets");
    expect(seen[0]![1]).toMatchObject({ method: "POST", body: '{"count":3}', headers: { "content-type": "application/json", accept: "application/json" } });
    expect(seen[1]).toEqual(["http://h/api/tx/0x12", { method: "GET", headers: { accept: "application/json" } }]);
  });
});
