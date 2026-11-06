// Builds the installable core into dist/ (bun run build): one self-contained ES module for browsers and Snaps
// (dist/core.js, viem and the hashes bundled in) and its type declarations (dist/types). Refuses to finish if the
// bundle references any Node or Bun API, or if the core does not typecheck against browser types alone.
// Written with Claude Code (AI) for Vicky.
//   bun scripts/build-core.ts [--minify]
import fs from "node:fs";
import path from "node:path";
import { noNodeModules, nodeOnlyReferences } from "./lib/browser-safe.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DIST = path.join(ROOT, "dist");
fs.rmSync(DIST, { recursive: true, force: true });

const out = await Bun.build({
  entrypoints: [path.join(ROOT, "src/core.ts")],
  target: "browser",
  format: "esm",
  outdir: DIST,
  naming: "core.js",
  minify: process.argv.includes("--minify"),
  sourcemap: "linked",
  plugins: [noNodeModules], // fails the build on any Node or Bun module, ours or a dependency's
});
if (!out.success) throw new Error(out.logs.map(String).join("\n"));
const js = fs.readFileSync(path.join(DIST, "core.js"), "utf8");
const bad = nodeOnlyReferences(js);
if (bad.length) throw new Error(`dist/core.js is not browser-safe:\n  ${bad.join("\n  ")}`);

// Declarations, typechecked with the DOM library and no Bun or Node types: a Node API in the core fails here too.
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", path.join(ROOT, "tsconfig.build.json")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
if (tsc.exitCode !== 0) throw new Error(`tsc -p tsconfig.build.json failed:\n${tsc.stdout.toString()}${tsc.stderr.toString()}`);
// TypeScript keeps the source's ".ts" import paths in .d.ts files (in `from "./x.ts"` and in `import("./x.ts")` type
// references); a consumer resolves "./x.js" to "./x.d.ts".
const rewrite = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rewrite(p);
    else if (p.endsWith(".d.ts")) fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/((?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+))\.ts(["'])/g, "$1.js$3"));
  }
};
rewrite(path.join(DIST, "types"));

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`dist/core.js ${kb(js.length)}, ${fs.readdirSync(path.join(DIST, "types"), { recursive: true }).filter((f) => String(f).endsWith(".d.ts")).length} declaration files in dist/types`);
