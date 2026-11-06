// The browser- and Snap-safe core (src/core.ts), proved: its browser bundle uses no Node or Bun API, and a bundle of
// the end-to-end scenario runs inside a SES-locked compartment with only a Snap's globals, giving the same bytes as
// in Node. Written with Claude Code (AI) for Vicky.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCoreScenario } from "./fixtures/sandbox-scenario.ts";
import { noNodeModules, nodeOnlyReferences } from "../scripts/lib/browser-safe.ts";

const ROOT = path.resolve(import.meta.dir, "..");

async function bundle(entry: string, format: "esm" | "iife"): Promise<string> {
  const out = await Bun.build({ entrypoints: [path.join(ROOT, entry)], target: "browser", format, plugins: [noNodeModules] });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0]!.text();
}

describe("core.ts in a browser bundle", () => {
  test("references no Node or Bun API", async () => {
    const code = await bundle("src/core.ts", "esm");
    expect(nodeOnlyReferences(code)).toEqual([]);
    expect(code.length).toBeLessThan(600_000); // viem is tree-shaken: about 240 KB on Nov 6
  });

  test("the check catches what it is meant to", () => {
    expect(nodeOnlyReferences(`import fs from "node:fs"; const x = process.env.A; Bun.spawn(); require("x"); Buffer.from("")`)).toHaveLength(5);
    expect(nodeOnlyReferences(`globalThis.process.env.X; globalThis.Buffer.from(""); global.foo; setImmediate(f); __dirname`)).toHaveLength(5);
    expect(nodeOnlyReferences(`const e = globalThis.process?.env; class H { process(v, o) {} }`)).toEqual([]);
  });

  test("the build fails on any Node or Bun module, which Bun's browser target would otherwise stub out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-plugin-"));
    try {
      for (const [name, src] of [["fs", `import * as fs from "fs"; export const x = fs.readFileSync;`], ["nodefs", `import fs from "node:fs"; export const x = fs;`], ["ffi", `import { dlopen } from "bun:ffi"; export const x = dlopen;`]]) {
        fs.writeFileSync(path.join(dir, `${name}.ts`), src!);
        const why = await Bun.build({ entrypoints: [path.join(dir, `${name}.ts`)], target: "browser", plugins: [noNodeModules] }).then(
          (o) => (o.success ? "built" : o.logs.map(String).join("; ")),
          (e: AggregateError) => (e.errors ?? [e]).map(String).join("; "),
        );
        expect([name, why]).toEqual([name, expect.stringContaining("a Node or Bun module")]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("index.ts, the Node entry, is not browser-safe (so the check means something)", async () => {
    // Bun refuses outright: the file journal imports bun:ffi (flock).
    const why = await Bun.build({ entrypoints: [path.join(ROOT, "src/index.ts")], target: "browser" }).then(
      async (o) => (o.success ? nodeOnlyReferences(await o.outputs[0]!.text()).join("; ") : o.logs.map(String).join("; ")),
      (e: AggregateError) => (e.errors ?? [e]).map(String).join("; "),
    );
    expect(why).toContain("bun:ffi");
  });
});

describe("the end-to-end scenario inside SES, with a Snap's globals only", () => {
  test("builds, grinds, signs two-pass, journals and sends exactly as in Node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-ses-"));
    const file = path.join(dir, "scenario.js");
    fs.writeFileSync(file, await bundle("test/fixtures/sandbox-scenario.ts", "iife"));
    const proc = Bun.spawn(["bun", path.join(ROOT, "test/fixtures/ses-run.ts"), file], { stdout: "pipe", stderr: "pipe", cwd: ROOT });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
    const sandbox = JSON.parse(out.trim().split("\n").at(-1)!);
    const local = await runCoreScenario();

    expect(sandbox.globals).toEqual({ process: "undefined", Bun: "undefined", require: "undefined" });
    // The deterministic part: the same tree, the same signed bytes, in both.
    for (const k of ["root", "treeSeed", "sigHash", "entryHash", "txHash", "wire", "prefixBudget", "grind"]) expect([k, sandbox[k]]).toEqual([k, local[k]]);
    expect(sandbox.verified).toEqual({ ok: true, reason: null });
    expect(sandbox.entryLength).toBe(sandbox.expectedEntryLength);
    expect(sandbox.prefixBudget).toBe("95100"); // expiry 5,000 + verify 90,000 + ARBITRARY entry 100
    // The send path ran to its end against the fake chain, on the pipeline's own network.
    expect(sandbox.send).toMatchObject({ outcome: "OnChain", leaf: 1, nonceKey: "1", admission: "included: 1 of 1 rules passed" });
    expect(sandbox.journal).toEqual(["1:onchain"]);
    expect(sandbox.lastSaved).toEqual(["1:onchain"]);
    // The async store held the reservation before the leaf signed, and the hash before the transaction left.
    const ev: string[] = sandbox.events;
    const at = (e: string) => { const i = ev.indexOf(e); expect([e, i >= 0]).toEqual([e, true]); return i; };
    expect(at("stored 1:reserved")).toBeLessThan(at("sign leaf 1"));
    expect(at("stored 1:submitted")).toBeLessThan(at("send key 0x1"));
    expect(at("sign leaf 1")).toBeLessThan(at("send key 0x1"));
  }, 60_000);
});
