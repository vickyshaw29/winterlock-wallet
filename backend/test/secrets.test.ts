// I6: no seed, ticket secret or EOA key in any response, log line or file the backend writes besides the seed and
// ticket files themselves. Drives every endpoint (successes, refusals, a failed cut, a rotation) and then searches all
// captured output for the seed hex, every ticket secret and the EOA key. Request logs carry no bodies.
// Written with Claude Code (AI) for Vicky.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { EOA_KEY, Harness, OTHER, TARGET, requireCli, until } from "./helpers.ts";

beforeAll(requireCli);

let h: Harness;
beforeEach(async () => { h = await Harness.create(); });
afterEach(async () => { await h.destroy(); });

/** Every file under a directory, recursively. */
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

test("no seed, ticket secret or EOA key in any response, log line, record, journal or store", async () => {
  const a: Address = await h.wallet();
  const post = (p: string, body: unknown) => h.req("POST", `/wallets/${a}${p}`, body);

  await h.settle((await post("/send", { to: TARGET, valueWei: "1" })).body.txHash);
  await h.settle((await post("/send", { to: OTHER, data: "0x12345678" })).body.txHash); // estimateCalls signs too
  expect((await post("/send", { to: TARGET, valueWei: (10n ** 30n).toString() })).status).toBe(422);
  expect((await post("/tickets", { count: 2 })).status).toBe(200);
  await h.settle((await post("/send", { to: TARGET, valueWei: "1", mode: "hot" })).body.txHash);
  expect((await post("/send", { to: OTHER, valueWei: "1", mode: "hot" })).status).toBe(422); // a ticket refused
  await h.settle((await post("/hot-policy", { hotStart: 12, valueCapWei: "5", feeCapWei: "2000000000000000", allowedTarget: TARGET })).body.txHash);
  // a cut whose CLI fails after the mark: its error comes from the CLI's stderr
  const seedFile = h.record(a).tree.seedFile;
  const seedText = fs.readFileSync(seedFile, "utf8");
  fs.writeFileSync(seedFile, `${seedText.trim().slice(0, 40)}\n`);
  expect((await post("/tickets", { count: 1 })).status).toBe(500);
  fs.writeFileSync(seedFile, seedText);
  const rot = await post("/rotate", { height: 4 });
  expect(rot.status).toBe(200);
  await until(() => h.record(a).tree.generation === 1, 5_000, "the switch");
  await h.settle((await post("/send", { to: TARGET, valueWei: "1" })).body.txHash);
  for (const p of [`/wallets`, `/wallets/${a}`, `/wallets/${a}/txs`, `/tx/${rot.body.txHash}`]) expect((await h.req("GET", p)).status).toBe(200);
  await h.app.backend.idle();

  // what must never leave: the master seed, every ticket secret, the EOA key
  const secrets = new Set<string>([seedText.trim().slice(2).toLowerCase(), EOA_KEY.slice(2).toLowerCase()]);
  const ticketFiles = walk(path.join(h.deviceDir(a), "tickets"));
  expect(ticketFiles.length).toBe(1);
  const secretsOf = new Map<number, string[]>(); // ticket leaf -> its 67 chain secrets
  for (const f of ticketFiles) {
    for (const l of JSON.parse(fs.readFileSync(f, "utf8")).leaves) {
      secretsOf.set(l.leaf, l.secrets.map((s: string) => s.slice(2).toLowerCase()));
      for (const s of l.secrets) secrets.add(s.slice(2).toLowerCase());
    }
  }
  expect(secrets.size).toBe(2 + 2 * 67);
  // Parallel lanes (Nov 6): GET /tx/:hash and the store keep the exact JSON sent, signature included. A WOTS+ element
  // at digit 0 is that chain's secret itself (scheme.ts: chain j runs d_j steps from its secret), so a sent signature
  // shows a few secrets of the leaf that signed it. Keeping them is safe (backend/README.md, Parallel lanes): the JSON
  // holds only the signature the mempool already received; one WOTS+ signature cannot be turned into a signature on
  // another message, because the checksum chains would have to run backward; and the journal burns the leaf whether or
  // not its key was consumed, so it never signs again (expired and refused lanes keep their JSON too). Those values
  // are left out of the check, and only those. Every value left out must be a secret of a ticket whose transaction
  // reached a mempool.
  const published = new Set<string>();
  const sentLeaves = new Set<number>();
  for (const tx of h.chain.sent) {
    sentLeaves.add(Number(tx.nonceKeys[0]! & 0xffff_ffffn));
    for (const s of tx.signatures) {
      const elements = s.signature.slice(6, 6 + 2 * 2_144); // after 0x, the version byte and the slot byte
      for (let i = 0; i < 67; i++) published.add(elements.slice(64 * i, 64 * (i + 1)).toLowerCase());
    }
  }
  const leftOut = [...secrets].filter((s) => published.has(s));
  for (const s of leftOut) {
    const owner = [...secretsOf].find(([, list]) => list.includes(s))?.[0];
    expect(owner !== undefined && sentLeaves.has(owner)).toBe(true);
    secrets.delete(s);
  }
  expect(secrets.size).toBeGreaterThanOrEqual(2 + 67); // the seed, the EOA key and every secret of the ticket never sent

  const written = walk(h.dirs.backendDir).filter((f) => !f.endsWith(".seed") && !ticketFiles.includes(f) && !f.includes(`${path.sep}hashsig-cache${path.sep}`));
  const outputs: [string, string][] = [
    ...h.responses.map((r, i) => [`response ${i}`, r] as [string, string]),
    ...h.logs.map((l, i) => [`log line ${i}`, l] as [string, string]),
    ...written.map((f) => [f, fs.readFileSync(f, "utf8")] as [string, string]),
  ];
  expect(h.responses.length).toBeGreaterThan(20);
  expect(written.some((f) => f.endsWith("txs.json"))).toBe(true);
  for (const [where, text] of outputs) {
    const lower = text.toLowerCase();
    for (const s of secrets) if (lower.includes(s)) throw new Error(`a secret appears in ${where}`);
  }
  // request logs: method, path, status and time, never a body
  const requestLines = h.logs.filter((l) => /^(GET|POST) \/api\//.test(l));
  expect(requestLines.length).toBe(h.responses.length);
  for (const l of requestLines) expect(l).toMatch(/^(GET|POST) \/api\/[\w/-]+ \d{3} \d+ ms$/);
});
