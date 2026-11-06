// What every devnet script needs: the deployment record, the account's signer, its journal.
// Written with Claude Code (AI) for Vicky.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import { DEVNET, LeafJournal, pinFileFor, pinOrCheckChain, placeholderSigner, type HashSigner } from "../../src/index.ts";
import { Keyring, keyringSigner, loadOrCreateSeed } from "../../src/hashsig/keyring.ts";

/** This checkout's data: deployment records, placeholder journals, caches. WL_DATA_DIR moves it (tests use a temp dir). */
export const DATA_DIR = process.env.WL_DATA_DIR ?? path.resolve(import.meta.dir, "../../.data");
export const DEPLOYMENT_FILE = `${DATA_DIR}/deployment-${DEVNET.chainId}.json`;
/**
 * The master seed for a NEW deployment: 32 random bytes in a file only its owner can read, outside the repo.
 * One seed serves one account only (spec): a new account gets a new label, so a new file. An existing account is
 * always signed with the seed file its own deployment record names (accountSigner).
 */
export const ACCOUNT_LABEL = process.env.WL_ACCOUNT_LABEL ?? "2";
export const SEED_FILE = process.env.WL_SEED_FILE ?? `${os.homedir()}/.winterlock/hashsig-account-${DEVNET.chainId}-${ACCOUNT_LABEL}.seed`;
/** The tree: generation = the account's epoch (0 at creation); plan section 8: height 10, the devnet's chain only. */
export const TREE = { generation: 0, height: 10, chains: [DEVNET.chainId] } as const;

export interface Deployment {
  chainId: string;
  verifier: "hashsig" | "placeholder";
  implementation: Address;
  factory: Address;
  account: Address;
  params: Record<string, any>;
  tree?: { seedFile: string; generation: number; height: number; chains: string[] };
}

/** The current deployment, or an archived one (deploy-account.ts archives the previous record under its address). */
export const loadDeployment = (file = DEPLOYMENT_FILE): Deployment => JSON.parse(fs.readFileSync(file, "utf8"));

/** The keyring of a tree. Pins the chain's genesis beside the seed, and refuses a reset chain. */
export async function openKeyring(seedFile = SEED_FILE): Promise<Keyring> {
  await pinOrCheckChain(pinFileFor(seedFile));
  const seed = loadOrCreateSeed(seedFile);
  return new Keyring({ seed, generation: TREE.generation, height: TREE.height, chains: [...TREE.chains], cacheDir: `${DATA_DIR}/hashsig-cache` });
}

/**
 * The scripts build every tree at generation 0 (TREE) and read params.treeSeed and params.height, which stay the
 * creation tree's after a rotation. A record the backend rotated names its current tree in `tree`, and only the backend
 * may sign for it (review, Nov 6; Vicky's default 3).
 */
function requireEpochZero(d: Deployment): void {
  const generation = d.tree?.generation ?? 0;
  if (generation !== 0) {
    throw new Error(`deployment ${d.account} is at tree generation ${generation}: rotated by the backend; the scripts sign at epoch 0 only. Use the backend for this account.`);
  }
}

/** The account's hash-based signer. With the real verifier it checks the genesis pin before every signature. */
export async function accountSigner(d: Deployment): Promise<HashSigner> {
  requireEpochZero(d);
  if (d.verifier === "placeholder") {
    // the placeholder verifier only checks that the entry carries the message hash
    return placeholderSigner({ treeSeed: d.params.treeSeed, height: Number(d.params.height) });
  }
  const seedFile = d.tree?.seedFile;
  if (!seedFile || !fs.existsSync(seedFile)) throw new Error(`deployment ${d.account} names no seed file that exists (${seedFile})`);
  const k = await openKeyring(seedFile);
  if (k.treeSeed.length !== 32 || `0x${Buffer.from(k.treeSeed).toString("hex")}` !== String(d.params.treeSeed).toLowerCase()) {
    throw new Error(`the seed file ${seedFile} does not build the tree account ${d.account} stores`);
  }
  const inner = keyringSigner(k);
  return {
    ...inner,
    async sign(req) {
      await pinOrCheckChain(pinFileFor(seedFile)); // a devnet reset must stop signing before a leaf is reused
      return inner.sign(req);
    },
  };
}

/**
 * Where an account's leaf journal for one epoch lives. A real tree's journal sits beside its seed file, outside any
 * checkout: every copy of the repo that can sign with the seed then shares one journal and one lock (review, Nov 6:
 * a fresh clone or worktree had its own empty .data and re-handed used leaves). A placeholder account holds no key,
 * so its journal stays in this checkout's .data.
 */
export function journalFile(d: Pick<Deployment, "verifier" | "account" | "tree">, epoch = 0): string {
  if (d.verifier === "hashsig") {
    if (!d.tree?.seedFile) throw new Error(`deployment ${d.account} names no seed file`);
    return `${d.tree.seedFile}.journal-epoch${epoch}.json`;
  }
  return legacyJournalFile(d.account, epoch);
}
/** The journal's place before Nov 6, in this checkout's .data; still the place for placeholder accounts. */
export const legacyJournalFile = (account: Address, epoch = 0) => `${DATA_DIR}/journal-${account.toLowerCase()}-epoch${epoch}.json`;

/**
 * The account's leaf journal for one epoch, locked to this process. A journal is born with its account
 * (deploy-account.ts passes create) and is never recreated: anywhere else a missing journal is an error.
 */
export function openJournal(d: Deployment, epoch = 0, opts: { create?: boolean } = {}): LeafJournal {
  if (BigInt(d.chainId) !== DEVNET.chainId) throw new Error(`deployment ${d.account} is for chain ${d.chainId}, not ${DEVNET.chainId}`);
  requireEpochZero(d);
  if (d.verifier === "hashsig" && fs.existsSync(legacyJournalFile(d.account, epoch))) {
    throw new Error(`a journal for ${d.account} is still in this checkout's .data (${legacyJournalFile(d.account, epoch)}). The account's ` +
      `journal lives beside its seed (${journalFile(d, epoch)}): if this file is the real one, move it with scripts/move-journal.ts; ` +
      "if it is a stale copy, look at both before removing anything.");
  }
  const height = Number(d.params.height);
  if (!Number.isInteger(height)) throw new Error(`deployment ${d.account} records no tree height`);
  // A real tree is named in its journal, which then refuses a second journal for the same tree (one seed, one account).
  // Placeholder accounts share one dummy tree seed and expose no key, so their journals name none.
  const treeSeed = d.verifier === "hashsig" ? (d.params.treeSeed as Hex) : undefined;
  return LeafJournal.open(journalFile(d, epoch), { wallet: d.account, chainId: DEVNET.chainId, epoch, height, treeSeed }, opts);
}

/** For scripts whose simulations sign without the journal: harmless only when a "signature" is the message hash. */
export function requirePlaceholder(d: Deployment, script: string) {
  if (d.verifier !== "placeholder") {
    throw new Error(`${script} signs with placeholder entries and simulates without the journal; ${d.account} runs the ${d.verifier} verifier. ` +
      "Pass a placeholder deployment record (.data/deployment-1337.placeholder.json).");
  }
}
