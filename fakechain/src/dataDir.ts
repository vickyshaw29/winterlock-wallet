// The launcher's data directory: refused before anything is created when it would sit inside the repo or under
// ~/.winterlock, with every symlink resolved first. Written with Claude Code (AI) for Vicky.
// Imports nothing of the pipeline, so fakechain/run.ts can call it before it sets the WL_* variables.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The repository (fakechain's parent) and ~/.winterlock: no fake run writes below either. */
export const forbiddenRoots = (home = os.homedir()) => [path.resolve(import.meta.dir, "../.."), path.join(home, ".winterlock")];

/** `p` with every symlink resolved; for a path that does not exist yet, its nearest existing parent's. */
export function resolveReal(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(resolveReal(parent), path.basename(abs));
  }
}

/** Why `dir` may not hold a fake run's files, or null. */
export function dataDirRefusal(dir: string, forbidden = forbiddenRoots()): string | null {
  const real = resolveReal(dir);
  for (const root of forbidden.map(resolveReal)) {
    if (real === root || real.startsWith(`${root}${path.sep}`)) return `refusing to put a fake run's files in ${dir} (${real}): it is inside ${root}`;
  }
  return null;
}

/** A fresh fakechain-XXXXXX folder in `parent` (the OS temp dir), checked before it exists. */
export function makeDataDir(parent = os.tmpdir(), forbidden = forbiddenRoots()): string {
  const refusal = dataDirRefusal(parent, forbidden);
  if (refusal) throw new Error(refusal);
  return fs.mkdtempSync(path.join(resolveReal(parent), "fakechain-"));
}
