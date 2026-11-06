// What breaks bundled code in a browser or a MetaMask Snap, checked two ways. Shared by scripts/build-core.ts and
// test/core-bundle.test.ts. Written with Claude Code (AI) for Vicky.
//   - noNodeModules: a Bun.build plugin that fails the build when anything in the graph, our code or a dependency,
//     imports a Node or Bun module ("fs", "node:fs", "bun:ffi", "bun"). Without it, Bun's browser target quietly
//     stubs such imports (`fs` becomes an empty object) and the code only fails when it runs (review, Nov 6).
//   - nodeOnlyReferences: the bundle's text, for globals a browser or a Snap does not have.
import { builtinModules } from "node:module";
import type { BunPlugin } from "bun";

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

export const noNodeModules: BunPlugin = {
  name: "no-node-modules",
  setup(build) {
    build.onResolve({ filter: /^(node:|bun:|bun$|[a-z_]+(\/[a-z_]+)?$)/ }, (args) => {
      const p = args.path;
      if (p.startsWith("node:") || p.startsWith("bun:") || p === "bun" || BUILTINS.has(p)) {
        throw new Error(`${args.importer} imports "${p}", a Node or Bun module: not allowed in the browser- and Snap-safe core`);
      }
      return undefined;
    });
  },
};

export function nodeOnlyReferences(code: string): string[] {
  const found: string[] = [];
  for (const [what, re] of [
    ["a node: module", /["'`]node:[\w/]+["'`]/g],
    ["a bun: module", /["'`]bun(:[\w/]+)?["'`]/g],
    ["require(", /(?<![\w$.])require\s*\(/g],
    ["the Bun global", /(?<![\w$.])Bun\s*[.[]/g],
    // `process.x` or `process[...]` on the bare global; a method called process(...) (noble's hashes) is fine
    ["a bare process global", /(?<![\w$.])process\s*(\?\.|[.[])/g],
    // globalThis.process or .Buffer used without ?. (config.ts reads `globalThis.process?.env`, which is safe)
    ["globalThis.process or Buffer, unguarded", /globalThis\s*\.\s*(process|Buffer|Bun)\b(?!\s*\?\.)/g],
    ["Buffer", /(?<![\w$.])Buffer\s*[.(]/g],
    ["the global object", /(?<![\w$.])global\s*[.[]/g],
    ["setImmediate", /(?<![\w$.])setImmediate\s*\(/g],
    ["__dirname or __filename", /(?<![\w$.])__(dirname|filename)\b/g],
  ] as const) {
    for (const m of code.matchAll(re)) found.push(`${what}: ${code.slice(Math.max(0, m.index! - 40), m.index! + 40).replace(/\s+/g, " ")}`);
  }
  return found;
}
