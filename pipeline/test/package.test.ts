// The installable core: bun run build, pack the package, install the tarball into a fresh project (offline: extracted,
// with the pipeline's own dependencies linked), then typecheck that project against the shipped types with browser
// types only, and run it in plain Node (dist/core.js) and in Bun (src/core.ts). Written with Claude Code (AI) for Vicky.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const ok = (r: ReturnType<typeof run>, what: string) => { expect({ what, code: r.code, err: r.code ? r.out + r.err : "" }).toEqual({ what, code: 0, err: "" }); return r.out; };

let app = "";
let tmp = "";
beforeAll(() => {
  ok(run(["bun", "scripts/build-core.ts"], ROOT), "build");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-pack-"));
  ok(run(["bun", "pm", "pack", "--destination", tmp, "--quiet"], ROOT), "pack");
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"))!;
  app = path.join(tmp, "app");
  fs.cpSync(path.join(ROOT, "test/fixtures/consumer"), app, { recursive: true });
  const scope = path.join(app, "node_modules/@winterlock");
  fs.mkdirSync(scope, { recursive: true });
  ok(run(["tar", "xzf", path.join(tmp, tgz), "-C", scope], tmp), "extract");
  fs.renameSync(path.join(scope, "package"), path.join(scope, "pipeline"));
  for (const dep of ["viem", "@noble/hashes", "@ethereumjs/rlp"]) { // the declarations import viem's types
    fs.mkdirSync(path.dirname(path.join(app, "node_modules", dep)), { recursive: true });
    fs.symlinkSync(path.join(ROOT, "node_modules", dep), path.join(app, "node_modules", dep));
  }
}, 120_000);
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const consumerOutput = (runtime: string) => JSON.parse(ok(run([runtime, "consumer.ts"], app), runtime).trim());

test("the packed package holds the bundle and its types, and nothing private", () => {
  const files = fs.readdirSync(path.join(app, "node_modules/@winterlock/pipeline"), { recursive: true }).map(String);
  expect(files).toContain(path.join("dist", "core.js"));
  expect(files).toContain(path.join("dist", "types", "core.d.ts"));
  expect(files.filter((f) => /^(test|scripts|examples|\.data|node_modules)(\/|$)/.test(f))).toEqual([]);
});

test("a project that installed it typechecks against its types alone (browser types, no Bun or Node)", () => {
  ok(run([path.join(ROOT, "node_modules/.bin/tsc"), "-p", "."], app), "tsc in the consumer");
});

test("runs in Bun (src/core.ts)", () => {
  expect(consumerOutput("bun")).toMatchObject({ entryBytes: 2338, expected: 2338, ok: true, chainId: "1337" });
});

// Plain Node takes the package's "default" export, dist/core.js: the bundle a browser or a Snap loads.
test.skipIf(!Bun.which("node"))("runs in plain Node (dist/core.js) and signs the same bytes as Bun", () => {
  expect(consumerOutput("node")).toEqual(consumerOutput("bun"));
});
