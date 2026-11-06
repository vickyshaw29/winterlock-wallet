// Runs scripts/hashsig-devnet.ts end to end against a launched fake, given only env.sh's variables.
// Written with Claude Code (AI) for Vicky.
// run.ts runs in its own process and is stopped with SIGINT at the end.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAKECHAIN = path.resolve(import.meta.dir, "..");
const PIPELINE = path.resolve(FAKECHAIN, "../pipeline");

function freePort() {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  return p;
}
/** env.sh's exports, nothing else. */
function readEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^export (\w+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}
/** A stand-in home for the children: the launcher's ~/.winterlock check never touches the real one. */
const HOME = fs.mkdtempSync(path.join(process.env.FAKECHAIN_TEST_ROOT!, "home-"));
/** A child's environment without this test process's own WL_* settings. */
const base = () => ({ PATH: process.env.PATH ?? "", HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() });
/** run.ts with `args` and a TMPDIR of its own, which must stay empty. */
async function failingStart(args: string[]) {
  const tmp = fs.mkdtempSync(path.join(process.env.FAKECHAIN_TEST_ROOT!, "tmp-"));
  const p = Bun.spawn([process.execPath, "run.ts", ...args], { cwd: FAKECHAIN, stdout: "pipe", stderr: "pipe", env: { ...base(), TMPDIR: tmp } });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { stderr, code, left: fs.readdirSync(tmp) };
}

test("run.ts refuses a --height outside 5 to 12 and a --block-time below 1, before it creates anything", async () => {
  for (const [args, text] of [
    [["--height", "4"], "--height must be a whole number from 5 to 12"],
    [["--height", "13"], "--height must be a whole number from 5 to 12"],
    [["--block-time", "0.5"], "--block-time must be a number from 1 to 3600"],
  ] as const) {
    const r = await failingStart([...args]);
    expect([r.code === 0, r.left]).toEqual([false, []]);
    expect(r.stderr).toContain(text);
  }
});

test("a failed start removes its temp folder and its throwaway key", async () => {
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  try {
    const r = await failingStart(["--port", String(busy.port)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`cannot listen on 127.0.0.1:${busy.port}`);
    expect(r.stderr).toContain("start failed, removed");
    expect(r.left).toEqual([]); // the key was written before the port was tried
  } finally {
    busy.stop(true);
  }
}, 60_000);

test("scripts/hashsig-devnet.ts runs end to end against a launched fake, with env.sh's variables, and passes", async () => {
  const port = freePort();
  const launcher = Bun.spawn([process.execPath, "run.ts", "--port", String(port), "--block-time", "1", "--bundle-interval", "1"], { cwd: FAKECHAIN, stdout: "pipe", stderr: "pipe", env: base() });
  let out = "";
  const reading = (async () => { for await (const chunk of launcher.stdout) out += new TextDecoder().decode(chunk); })();
  let script = { stdout: "", stderr: "", code: -1 };
  try {
    for (let i = 0; i < 900 && !out.includes("FAKE DEVNET READY") && launcher.exitCode === null; i++) await Bun.sleep(100);
    expect(out).toContain("FAKE DEVNET READY");
    const envFile = /source (\S+env\.sh)/.exec(out)![1]!;
    const env = readEnv(envFile);
    expect(env.WL_CHAIN_ID).toBe("31337");
    expect([env.WL_NODE_URL, env.WL_GATEWAY_URL, env.WL_EXPLORER_URL]).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/rpc`, `http://127.0.0.1:${port}/explorer`]);
    for (const k of ["WL_DATA_DIR", "WL_BACKEND_DIR", "WL_EOA_KEY_FILE", "WL_SEED_FILE"]) {
      expect(fs.realpathSync(path.dirname(env[k]!)).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    }
    expect(fs.statSync(env.WL_EOA_KEY_FILE!).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(env.WL_DATA_DIR!, "deployment-31337.json"))).toBe(true);
    const child = Bun.spawn([process.execPath, "scripts/hashsig-devnet.ts"], { cwd: PIPELINE, stdout: "pipe", stderr: "pipe", env: { ...base(), ...env } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    script = { stdout, stderr, code };
  } finally {
    launcher.kill("SIGINT");
    await launcher.exited;
    await reading;
    const data = /\n data +(\S+)/.exec(out)?.[1]; // the run's own folder in the OS temp dir: throwaway keys only
    if (data && fs.realpathSync(data).startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(data, { recursive: true, force: true });
  }
  if (script.code !== 0) console.error(script.stdout, script.stderr);
  expect(script.code).toBe(0);
  expect(script.stdout).toContain("OK one signature byte flipped");
  expect(script.stdout).toContain("OK a valid signature of leaf A under leaf B's nonce key");
  expect(script.stdout).not.toContain("XX");
  expect((script.stdout.match(/OnChain in block/g) ?? []).length).toBe(7);
  expect(script.stdout).toContain("hot ticket, 0.001 ETH: leaf 1008");
  expect(out).toContain("stopped.");
}, 300_000);
