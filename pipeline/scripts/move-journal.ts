// Moves a real-verifier account's leaf journal from this checkout's .data (its place before Nov 6) to beside the
// account's seed file, where every checkout shares it. Holds the journal's lock while moving; refuses if the target
// exists or the two places are on different volumes. Nothing is copied and nothing is deleted.
// Written with Claude Code (AI) for Vicky.
//   bun scripts/move-journal.ts [deployment record]
import fs from "node:fs";
import { DEVNET, LeafJournal } from "../src/index.ts";
import { journalFile, legacyJournalFile, loadDeployment, openJournal } from "./lib/wallet.ts";

const d = loadDeployment(process.argv[2]);
if (d.verifier !== "hashsig") throw new Error(`${d.account} runs the ${d.verifier} verifier: its journal stays in .data`);
const from = legacyJournalFile(d.account), to = journalFile(d);
if (!fs.existsSync(from)) throw new Error(`no journal at ${from}`);
if (fs.existsSync(to)) throw new Error(`${to} exists already: look at both files before doing anything`);
const old = LeafJournal.open(from, { wallet: d.account, chainId: DEVNET.chainId, epoch: 0, height: Number(d.params.height), treeSeed: d.params.treeSeed });
const leaves = old.all().length;
try {
  fs.renameSync(from, to); // same volume: atomic. Across volumes this throws EXDEV and nothing moves.
} finally {
  old.close();
}
fs.rmSync(`${from}.lock`, { force: true }); // the old place's lock anchor; no journal is there any more
const moved = openJournal(d);
if (moved.all().length !== leaves) throw new Error(`moved journal has ${moved.all().length} leaves, the old one had ${leaves}`);
console.log(`${d.account}: journal moved to ${to} (${leaves} leaves: ${moved.all().map((r) => `${r.leaf} ${r.status}`).join(", ") || "none"})`);
moved.close();
