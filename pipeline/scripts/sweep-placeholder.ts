// Moves the ETH left in the old placeholder-verifier test accounts into the current account, with ordinary
// frame transactions from those accounts (their verifier still accepts placeholder entries). Needed because the
// devnet faucet ran dry. Each old account keeps 0.003 ETH for the fee.
// Written with Claude Code (AI) for Vicky.
//   WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/sweep-placeholder.ts
import type { Address } from "viem";
import { DEVNET, LeafJournal, node, placeholderSigner, sendKeyed, type HashSigner } from "../src/index.ts";
import { legacyJournalFile, loadDeployment } from "./lib/wallet.ts";

const OLD: Address[] = ["0x107445c26594fdb3eb62803a8e79b9d7732148c3", "0x383452828ddcf9a7afa704c693cb3025eb90a6ad"];
const RESERVE = 3_000_000_000_000_000n;
const to = loadDeployment().account;
// The placeholder verifier checks no tree; these old journals name none, so the binding check has nothing to compare.
const placeholder: HashSigner = placeholderSigner({ treeSeed: "0x" });

console.log(`into ${to}, balance ${Number(await node.balance(to)) / 1e18} ETH`);
for (const from of OLD) {
  const balance = await node.balance(from);
  if (balance <= RESERVE) { console.log(`${from}: ${Number(balance) / 1e18} ETH, nothing to move`); continue; }
  const journal = LeafJournal.open(legacyJournalFile(from), { wallet: from, chainId: DEVNET.chainId, epoch: 0, height: 10 });
  const r = await sendKeyed({
    journal, band: { from: 1, to: 500 }, sender: from, calls: [{ to, value: balance - RESERVE }], verifyGas: 60_000n, preflight: true,
    signatures: (leaf) => [{ kind: "hash", signer: placeholder, leaf }],
  });
  console.log(`${from}: moved ${Number(balance - RESERVE) / 1e18} ETH, leaf ${r.leaf}, ${r.outcome}${r.receipt ? ` in block ${BigInt(r.receipt.blockNumber)}` : ""}`);
}
console.log(`${to} now holds ${Number(await node.balance(to)) / 1e18} ETH`);
