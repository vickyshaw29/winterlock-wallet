// The isolation refusals: the guard's endpoint and chain-id checks, the fetch guard, and the launcher's data directory.
// Written with Claude Code (AI) for Vicky.
// The guard reads the pipeline's endpoints once per process, so its refusals run in child processes with their own
// environment. A stand-in home keeps every test away from the real ~/.winterlock.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dataDirRefusal, forbiddenRoots, makeDataDir, resolveReal } from "../src/dataDir.ts";
import { isLocalUrl } from "../src/guard.ts";

const FAKECHAIN = path.resolve(import.meta.dir, "..");
const REPO = path.resolve(FAKECHAIN, "..");
const INSIDE_REPO = path.join(FAKECHAIN, "test"); // an existing folder inside the repo: nothing may ever be created in it
const ROOT = fs.mkdtempSync(path.join(process.env.FAKECHAIN_TEST_ROOT!, "isolation-"));
const HOME = path.join(ROOT, "home");
const WINTERLOCK = path.join(HOME, ".winterlock");
fs.mkdirSync(path.join(WINTERLOCK, "tmp"), { recursive: true });
const LINK_TO_REPO = path.join(ROOT, "link-to-repo");
const LINK_TO_WINTERLOCK = path.join(ROOT, "link-to-winterlock");
fs.symlinkSync(INSIDE_REPO, LINK_TO_REPO);
fs.symlinkSync(WINTERLOCK, LINK_TO_WINTERLOCK);
const ROOTS = [REPO, WINTERLOCK];
const insideRepoBefore = fs.readdirSync(INSIDE_REPO);
afterAll(() => expect(fs.readdirSync(INSIDE_REPO)).toEqual(insideRepoBefore));

const LOCAL = { WL_CHAIN_ID: "31337", WL_NODE_URL: "http://127.0.0.1:1", WL_GATEWAY_URL: "http://127.0.0.1:1/rpc", WL_EXPLORER_URL: "http://127.0.0.1:1/explorer" };
/** A child bun in fakechain/ with only PATH, the stand-in HOME, a TMPDIR of the test's own and `env`. */
async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, ...args], { cwd: FAKECHAIN, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME, TMPDIR: ROOT, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

describe("the guard loads only when every pipeline endpoint is on this machine and the chain id is 31337", () => {
  test("all local, chain 31337: it loads", async () => {
    expect((await run(["src/guard.ts"], LOCAL)).code).toBe(0);
  });
  // Expanded messages only: Bun prints the throwing source line too, so a bare "not this machine" would match the code.
  const refusals = [
    ["WL_NODE_URL", "https://example.invalid", "the pipeline's WL_NODE_URL is https://example.invalid, not this machine"],
    ["WL_GATEWAY_URL", "https://example.invalid/rpc", "the pipeline's WL_GATEWAY_URL is https://example.invalid/rpc, not this machine"],
    ["WL_NODE_URL", "http://127.0.0.1.example.invalid:8545", "the pipeline's WL_NODE_URL is http://127.0.0.1.example.invalid:8545, not this machine"],
    ["WL_CHAIN_ID", "1337", "the pipeline's chain id is 1337, not the fake's 31337"],
  ] as const;
  for (const [name, value, text] of refusals) {
    test(`${name}=${value}: refused`, async () => {
      const r = await run(["src/guard.ts"], { ...LOCAL, [name]: value });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(text);
    });
  }
  test("no WL_* at all, so the pipeline's defaults (the real devnet's endpoints): refused before anything is sent", async () => {
    const r = await run(["src/guard.ts"], {});
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/the pipeline's WL_NODE_URL is https:\/\/[^,\s]+, not this machine/);
  });
});

describe("the fetch guard: only 127.0.0.1, localhost and [::1]", () => {
  test("which URLs count as this machine", () => {
    for (const u of ["http://127.0.0.1:8545", "http://127.0.0.1:8545/rpc", "http://localhost/", "http://[::1]:1/x", "https://LOCALHOST:443"]) expect(isLocalUrl(u)).toBe(true);
    for (const u of [
      "https://example.invalid", "http://127.0.0.1.example.invalid/", "http://localhost.example.invalid:1/", "http://localhost@example.invalid/",
      "http://example.invalid/?u=http://127.0.0.1/", "http://10.0.0.1/", "ws://127.0.0.1/", "file:///etc/hosts",
    ]) expect(isLocalUrl(u)).toBe(false);
  });

  test("fetch refuses another host whatever form the argument takes, and still reaches this machine", async () => {
    for (const input of ["https://example.invalid/rpc", new URL("https://example.invalid/rpc"), new Request("https://example.invalid/rpc")]) {
      await expect(fetch(input)).rejects.toThrow("fakechain fetch guard");
    }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("here") });
    try { expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("here"); } finally { server.stop(true); }
  });
});

describe("the launcher's data directory: never in the repo or under ~/.winterlock, symlinks resolved, checked before it exists", () => {
  test("refused inside either, directly, through a symlink, or below a path that does not exist yet", () => {
    for (const dir of [REPO, INSIDE_REPO, path.join(REPO, "no", "such", "dir"), LINK_TO_REPO, path.join(LINK_TO_REPO, "deeper"), WINTERLOCK, path.join(WINTERLOCK, "tmp"), LINK_TO_WINTERLOCK]) {
      expect(dataDirRefusal(dir, ROOTS)).toContain("refusing to put a fake run's files in");
    }
    expect(dataDirRefusal(ROOT, ROOTS)).toBeNull();
    expect(dataDirRefusal(`${WINTERLOCK}-other`, ROOTS)).toBeNull(); // a sibling with a longer name is not inside it
  });

  test("a forbidden root that is itself a symlink is resolved too", () => {
    const elsewhere = path.join(ROOT, "elsewhere");
    const home2 = path.join(ROOT, "home2");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(home2);
    fs.symlinkSync(elsewhere, path.join(home2, ".winterlock"));
    expect(dataDirRefusal(path.join(elsewhere, "tmp"), [REPO, path.join(home2, ".winterlock")])).toContain("inside");
  });

  test("makeDataDir creates nothing when it refuses, and a fakechain-* folder otherwise; the defaults are the repo and ~/.winterlock", () => {
    expect(() => makeDataDir(LINK_TO_REPO, ROOTS)).toThrow("refusing");
    expect(fs.readdirSync(INSIDE_REPO)).toEqual(insideRepoBefore);
    const made = makeDataDir(ROOT, ROOTS);
    expect([path.dirname(made), path.basename(made).startsWith("fakechain-")]).toEqual([resolveReal(ROOT), true]);
    expect(forbiddenRoots(HOME)).toEqual([REPO, WINTERLOCK]);
  });

  test("run.ts refuses a TMPDIR inside the repo (through a symlink) or under ~/.winterlock, before it creates anything", async () => {
    const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); // a start past the check would fail here and clean up
    try {
      for (const tmp of [LINK_TO_REPO, path.join(WINTERLOCK, "tmp")]) {
        const r = await run(["run.ts", "--port", String(busy.port)], { TMPDIR: tmp });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(`refusing to put a fake run's files in ${tmp} (`); // the expanded message, not the source line
      }
    } finally {
      busy.stop(true);
    }
    expect(fs.readdirSync(INSIDE_REPO)).toEqual(insideRepoBefore);
    expect(fs.readdirSync(path.join(WINTERLOCK, "tmp"))).toEqual([]);
  });
});
