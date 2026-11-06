// The keyring for Node and Bun: keyring-core.ts plus a leaf cache on disk and the master seed file.
// Split on Nov 6 so the browser- and Snap-safe core holds no file system code; every name this file exported before
// is still exported from here, and Keyring still takes cacheDir.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { HashSigError, Keyring as CoreKeyring, type KeyringParams as CoreKeyringParams, type LeafCache } from "./keyring-core.ts";

export * from "./keyring-core.ts";

export interface KeyringParams extends CoreKeyringParams {
  /** a directory where leaf nodes are cached; no cache when omitted (and no leafCache given) */
  cacheDir?: string;
}

/** Leaf nodes in files under `dir`, one per subtree (the cache the keyring kept before Nov 6, same file names). */
export function fileLeafCache(dir: string): LeafCache {
  return {
    load: (name) => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    },
    save: (name, nodes) => {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, nodes);
    },
  };
}

/** The core keyring, with cacheDir turned into a fileLeafCache. */
export class Keyring extends CoreKeyring {
  constructor(p: KeyringParams) {
    const { cacheDir, ...rest } = p;
    super(cacheDir && !rest.leafCache ? { ...rest, leafCache: fileLeafCache(cacheDir) } : rest);
  }
}

/**
 * A master seed in a file readable only by its owner: created once (32 random bytes), never overwritten.
 * One seed serves one account; a new deployment, including after a devnet reset, gets a new seed (spec).
 */
export function loadOrCreateSeed(file: string): Uint8Array {
  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, "utf8").trim();
    const seed = hexToBytes(hex as Hex);
    if (seed.length !== 32) throw new HashSigError("bad_seed", `${file} does not hold 32 bytes`);
    return seed;
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytesToHex(seed) + "\n", { mode: 0o600, flag: "wx" });
  return seed;
}
