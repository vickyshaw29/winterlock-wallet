# Handoff: Fri Nov 6, 14:10 IST (a fresh session starts here)

For a fresh Claude Code session in this repo. The rules (AGENTS.md), the spec and the plan load through
`.claude/CLAUDE.md`; follow them. This file is local only: never commit it. The earlier, longer handoff (night to
morning) is archived at `.claude/handoff-2026-11-06-morning.md`; read it only for history.

## How Vicky works

- Short answers in easy words. Teach as you go: she must explain every part to the judges. A "why/what" question gets
  one sentence.
- She wants speed AND proper testing ("speed up, we have other things to do along with proper testing").
- Commit, push, open or merge a PR only when she asks. She authors every commit. Merge with merge commits only
  (`gh pr merge --merge`), never squash or rebase (the plan forbids rewriting history). End commit messages and PR
  bodies with the attribution lines your session's system reminder gives.
- Never print, log or commit anything in `~/.winterlock` (EOA key, seeds, journals).
- Public messages (Discord, GitHub comments, Telegram): one or two sentences; type them and leave them unsent, she
  presses send (memory `public-messages-short`).
- Any download needs her OK first (say file name, source, size).
- Spec first for any interface change (edit `.claude/spec.md`, then build). Spec-versus-code gaps she parked are in
  memory `spec-gaps-deferred` (raise them for the README).
- Ultracode is on: use workflows for substantive work, review adversarially, and put each critical fix back once to see
  a test fail.

## Deadlines

Feature freeze **Sat Nov 7, 01:00 IST**. Submission **Sat 08:30 IST** (Vicky submits). Video: 3 min max (Vicky records).

## Git: where everything is

- **main = `ef9b102`** (origin/main). Merged today, all with merge commits: PR #5 (MIT licence, PR #4 attribution, two
  Rust CLI fixes), PR #6 (grinder fix for the proxy's 63/64 gas holdback + `scripts/simulate-verify-gas.ts`), PR #7
  (`fakechain/`, the local fake devnet). The main checkout `/Users/vicky/Documents/winterlock` is on `main`, clean.
- **Worktree `/Users/vicky/Documents/winterlock-backend`, branch `feat/backend`, NOT COMMITTED**, based on `dac0256`
  (old main). It holds:
  - `backend/` (Bun API: wallets, keyed and hot sends, ticket device, rotation, hot policy, status, the lanes plan; the
    Rust stub deleted);
  - `web/` (three screens + start page, Play scene buttons, LAN mode `web/lan.ts` + `serve.ts --lan`, the self-hosted
    fonts in `web/public/fonts/`: Archivo and Besley latin woff2 with their OFL licences, downloaded with Vicky's OK);
  - `demo/lanes.ts` (the parallel-lanes CLI: `plan`, `burst`);
  - pipeline changes: `onSubmitted`, the `mempool: "alt" | "public"` option, `tickets.ts`, `lanes.ts`, `node.call` and
    `node.transactionByHash`, `scripts/lib/wallet.ts` refusing rotated records, estimate/submit fixes, and copies of
    PR #6's grind files (identical to main's).
  - Test counts, re-run at 14:20 (all green, every type-check clean): **pipeline 236, backend 112, demo 12, web 125**.
  - Its root README's AI-attribution section was updated for all of the above (five new bullets).
- **To land it** (only when Vicky says), in this order: (1) in the worktree, add the fonts to the README's "Not
  written by us" line (Archivo and Besley in `web/public/fonts/`, SIL OFL 1.1, from Google Fonts); (2) commit the work on
  `feat/backend` with `git add -A` (it deletes the old Rust stub `backend/Cargo.*`, `backend/src/main.rs` and
  `demo/index.ts`); (3) `git merge origin/main`, a merge commit. A dry run at 14:20 (`git merge-tree` on a temporary
  index, nothing touched) showed exactly **one conflict, `README.md`**: keep both sides (the worktree's five new
  attribution bullets, and main's bullets for PRs #5 to #7 plus its "Not written by us" line, which names the fake
  chain's `sidecarRules.ts`). `pipeline/test/submit.test.ts` auto-merges; the grind files are identical on both sides;
  main's scripts and `fakechain/` come in clean. (4) Run every suite, `fakechain/` included, since it now runs on the
  merged pipeline; (5) push, open the PR, merge with `--merge` when she says.

## Next, in order

1. **Ask Vicky to commit `feat/backend`** (above). The composable-pipeline session needs it as its base.
2. **Ledger UI.** Vicky picked direction 1, "Ledger" (design note and working mock:
   `.claude/briefs/ui-directions/1-ledger.md` and `1-ledger.html`; the other two directions are beside them). Build brief:
   `.claude/briefs/ledger-build.md` (every control and test kept, real data on the 1,024-cell key register, self-hosted
   fonts, CSP to 'self', moments: ticket tear, ledger line, the chain's dated cancellation stamp). The spec's screen
   design rules were relaxed today for this (recorded in the spec). Run it as a workflow (builder + reviewer), then check
   it yourself in Chrome (light and dark; 375, 1024, 1440 px), and send Vicky screenshots (SendUserFile).
3. **Real-devnet scenes on account 3** (the backend pointed at the real devnet; see "Run things"), writing every hash
   into `.claude/briefs/README-draft.md` at once (the explorer forgets on restart):
   - `bun demo/lanes.ts plan --wallet 0xf3e63d269dae09032ea950cd9722733e9b3f2d37 --n 8`, then `burst --n 8 --mempool alt`
     (expect all admitted, landing over 2 or more blocks: the sidecar relays at most 4 per 10 s pass);
   - `burst --n 2 --mempool public`: the public-pool probe (by ethrex's source, our account should get 1 pending and the
     second refused, because its verify frame reads its own storage; unconfirmed);
   - the stuck payment: a send with `firstAttemptExpirySeconds: 4, retries: 1` (should miss its block and retry on a
     fresh lane; a few percent land anyway);
   - hot tickets: cut tickets (the first cut now starts at leaf 1009, because 1008 was used directly), a hot payment,
     then the two refusals (0.1 ETH to the allowed target = value cap; 0.001 ETH to a new address = target).
4. **README final**: from `.claude/briefs/README-draft.md` (fact-checked; reset-chain evidence in sections 5 and 6). Add
   the scene results. Settle with Vicky: (a) the name clash with the Safe forum's "Winterlock" proposal (keep with the
   note, or rename); (b) which ERC-8421 budget numbers to print (the current draft's 100k / 1M vs the spec's 250k /
   2.5M); (c) whether to grind the estimate messages (about 1 in 65 estimates fail; a small pipeline change).
5. **File the Day-0 divergences upstream** (README draft section 14): public, so short texts and her OK.
6. **Composable pipeline** (browser- and Snap-safe core): DONE and MERGED into `feat/backend` (Vicky said yes,
   ~15:35 IST): commit `9ae1ec2` on `feat/composable-pipeline`, merge commit `223c478`; `feat/backend` pushed to origin at ~15:45 IST (`2456801..223c478`, fast-forward). **PR #8 (`feat/backend` -> `main`)
   MERGED at 15:45 IST, merge commit `88e9660`; local `main` fast-forwarded to it.** `feat/ledger-ui` already holds
   `223c478`; `fix/lanes-tip` (from `2456801`) does not: merge `main` into them before their PRs. NOTE: the merge
   ran in `winterlock-backend`, which had been switched to `feat/ledger-ui` at 14:32, so it landed on `feat/ledger-ui`;
   `feat/backend` was then fast-forwarded to the same `223c478` (no rewrite). Both branches now hold it; `fix/lanes-tip`
   (from `2456801`) does not. The merge touched only `README.md` and `pipeline/`; the uncommitted Ledger work in
   `winterlock-backend` was left as it was. `bun install` added `ses` to `winterlock-backend/pipeline/node_modules`. A backend server started before
   15:35 still runs the old pipeline until restarted. Suites on the merged tree (with the uncommitted Ledger work):
   pipeline 265, backend 113, demo 12, web 149, fakechain 90. The worktree `winterlock-composable` was removed (Vicky's
   OK); the branch `feat/composable-pipeline` is kept. `pipeline/src/core.ts` (browser/Snap) + `index.ts` (Bun entry, unchanged for backend/scripts/tests),
   `createPipeline` (no globals), `MemoryJournal` + `Journal.durable()`, installable `dist/` (`bun run build`), examples
   `pipeline/examples/browser/` (port 15190) and `pipeline/examples/snap/` (`npm test`, MetaMask's simulator). Two
   reviews, every finding fixed. Tests there: pipeline 265, backend 112, demo 12, web 125, fakechain 90, snap 4. It
   changes `pipeline/src/submit.ts`, `estimate.ts`, `rpc.ts`, `leaves.ts`, `index.ts` and `README.md`: merge into
   `feat/backend` with a merge commit when Vicky says.
7. Vicky's own: correct the ETHGlobal disclosure (we wrote our own signer and verifier; she built the Rust signer during
   the event), record the video, submit.

## Small decisions the last fixer left for Vicky

- Failure lines on the screens still show the backend's code and status ("no_tickets (409): ..."); API paths are gone.
- The stuck-payment hint on screen says "a few tries in a hundred still land in time" (keep or move to the README).
- `uncutHotLeaves` on the web can count one leaf too many after a first cut skipped a used leaf (Grant may then get a
  409 at the very end of the band).

## The devnet (reset at about 11:54 IST Nov 6)

- A new chain: chain id 1337, 6 s blocks, same ethrex `9aa3645d` and system contracts, **new genesis
  `0x2ad3f67b059fbde111ad7af27cfb4955d997351579612237ca0318937a5bae7a`**, block numbers restarted. The gateway
  `https://altmempoolgateway.forshtat.com/rpc` relays again (both sidecars have peers) and its faucet works (1 ETH per
  address per hour). Node `https://altmempool.forshtat.com`, miner's sidecar `https://altmempool.forshtat.com/rpc`.
  `devnet1/2/3.altmempool.wtf` still refuse TLS. The halt (04:28 to ~11:54 IST) was reported by Vicky in the ETHGlobal
  Discord, #partner-ethereum-foundation.
- **Account 3 (current):** `0xf3e63d269dae09032ea950cd9722733e9b3f2d37`, ~0.199 ETH. Seed
  `~/.winterlock/hashsig-account-1337-3.seed` (genesis pinned beside it), journal
  `~/.winterlock/hashsig-account-1337-3.seed.journal-epoch0.json` (leaves 1, 5-9, 1008 on chain; 2-4 burned by the
  forgery tests). Record: `pipeline/.data/deployment-1337.json` in the MAIN checkout. Implementation
  `0x13075a0f56d6a793eba4493d866e6502052abe87`, factory `0xe7227c802ea370f04ae533827041c89dc5a4e659`. h = 10, hotStart
  1008, hot value cap 0.01 ETH, fee cap 0.002 ETH, allowed target `0x5544596212F91984C986A919C8026DF0576816f9`, hybrid off.
- **Test EOA** `0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d`: ~0.78 ETH; key `~/.winterlock/devnet-eoa.key`.
- Accounts 1 and 2 belonged to the old chain: gone; their seeds stay pinned to the old genesis and refuse to sign.
- Evidence on the new chain (all hashes in the README draft): the qualifying transaction
  `0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175` (block 386, leaf 1, 510 steps, verify 88,373 of
  90,000, 17/17 rules), five more cold transfers (blocks 399 to 433), the hot ticket
  `0x8d0aefb70282cad3212ce08e9df8f0d9d7228805787fdb56faaea49c162272ce` (block 441), both forgeries refused in simulation
  ("sig: hash-based check", including leaf A's signature under leaf B's key), the counter check
  `0xd801fbfd8f2bd2963b71df19091ec1a560dd3888099c6b46e96f59a4ad4313e5` (block 366).
- Gas: on-chain fit 54,928 + 65.53 x steps; simulation fit 54,630 + 66.09; through the proxy 90,000 declared can use
  88,643, so cold messages fit up to 510 steps and hot up to 409; the hot extra is measured at about +6,550; every
  transaction's gas used is the calldata floor (186,245 cold, 186,373 hot).

## Run things

- `export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"`.
- Suites: in each of `pipeline/`, `backend/`, `demo/`, `web/` (worktree) and `pipeline/`, `fakechain/` (main):
  `bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test`
  (web also has `bunx tsc --noEmit -p public`). Foundry: `cd account && scripts/build.sh && forge test` (25). Rust:
  `cd signer && cargo test` (27).
- **Backend on the real devnet** (it then holds account 3's journal lock: no pipeline script on account 3 meanwhile):
  `cd /Users/vicky/Documents/winterlock-backend/backend && WL_DATA_DIR=/Users/vicky/Documents/winterlock/pipeline/.data WL_SIGNER_BIN=/Users/vicky/Documents/winterlock-backend/signer/target/release/signer bun src/main.ts`
  (port 8787). Screens: `cd ../web && bun serve.ts` (http://127.0.0.1:5173/). On a phone: only on Vicky's own hotspot,
  `bun serve.ts --lan` prints a link with a one-time code (never on the venue Wi-Fi).
- **Fake chain** (for practice only, never evidence): `cd /Users/vicky/Documents/winterlock/fakechain && bun run.ts`,
  then `source` the env.sh it prints and start the backend and screens in that shell on other ports
  (`WL_BACKEND_PORT=18787`, `WL_WEB_PORT=15173 WL_BACKEND_URL=http://127.0.0.1:18787`).
- Counter check with plain ECDSA (local tooling): `cd .claude/pipeline-test && bun counter-test.ts [--simulate]`.
- This session left servers running that may be gone: fake chain 18545, backend 18787, screens 15173 (all on the fake
  chain), and a static server for the UI mocks on 15180. They end with that session; if one still answers, stop it with
  `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`. No backend runs on the real devnet, so account 3's journal is free.

## Decisions made on Nov 6 (do not reopen)

- MIT licence. Spec-vs-code gaps parked (memory). The stuck payment is a 4-second first deadline
  (`firstAttemptExpirySeconds`), not a low fee (a fee under the 7-wei base fee is refused; above it is included).
- Shared interfaces 5 extended (GET /wallets, /status, /wallets/:a/txs, /lanes/plan, POST hot-policy, tickets; send
  fields mempool, maxFeePerGasWei, firstAttemptExpirySeconds, retries; maxCostWei = the gas part, set-aside = maxCostWei +
  value; wire on GET /tx only; errors 404/409/422/503).
- Lane numbers in the spec are the devnet sidecar's real ones: 1 pending per nonce key, no per-sender cap for keyed lanes
  the account pays for itself, relayed at most 4 per 10 s, "two or more blocks" (the draft's 4/64 labelled as the draft).
  The name is "parallel lanes" ("hot" means the hot band). Tooling: the narrow cut (built).
- Backend: 4 cold leaves kept for admin calls (kill switch and rotation), admin calls one at a time, hotStart guards,
  new wallets' owner is the EOA, funding tops up to WL_FUND_WEI, an Unknown rotation re-checked every 30 s, scripts
  refuse rotated records, a lost device journal is never recreated (409 device_unusable), the first ticket cut starts at
  the lowest free hot leaf.
- UI: built by Claude here (not the OpenAI assistant), Ledger direction, the spec's screen design rules relaxed, fonts self-hosted.
- LAN mode: built, hotspot only.
- Composable pipeline: a separate fresh session.

## Files

- Spec and plan: `.claude/spec.md` (Nov 6 edits are marked "(Nov 6)"), `.claude/plan.md`.
- Briefs: `.claude/briefs/backend-design.md`, `backend-fixes.md`, `web-design.md`, `fakechain-design.md`,
  `lanes-design.md`, `ledger-build.md`; `README-draft.md`; `ui-directions/` (three notes and mocks);
  `research/` (the parallel-lanes design and its critique, the gas measurement outputs, fetched sources).
- Composable-pipeline handoff: `.claude/handoff-composable.md`.
- Memory (auto-loaded): teach-while-building, judge-ready-walkthrough, research-before-building, spec-and-pitch-links,
  spec-gaps-deferred, public-messages-short.

## Booth cheat sheet (Vicky asked for easy words)

- The nonce key IS the leaf number. The protocol burns the key when it approves the payment, so it burns the leaf too:
  no bitmap, no storage write. Proven live on the new chain: leaf A's valid signature under leaf B's key is refused.
- The signer still keeps a journal on the laptop so it never SIGNS two messages with one leaf (an unsent second
  signature would leak the key too).
- A stuck payment waits out its deadline, its leaf is burned, and the retry goes on a fresh lane: never a fee bump.
- Parallel lanes: one pending transaction per key, no per-sender cap for the account's own lanes, relayed 4 per 10 s.
- You pay for the signature's bytes (the 186,245 calldata floor), not for the hashing.
- The proxy finding: a DELEGATECALL passes on only 63/64 of the gas (EIP-150), so 90,000 declared means 88,643 usable;
  fixed in the grinder and proven on chain (three 510-step transfers fit).
