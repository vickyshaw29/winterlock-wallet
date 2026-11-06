# Handoff: make the pipeline composable (browser- and MetaMask Snap-safe core)

For a fresh Claude Code session. Written Fri Nov 6, ~14:15 IST. Local only (under `.claude/`): never commit it.
The rules (AGENTS.md), the spec and the plan load through `.claude/CLAUDE.md`; follow them. The general state of the
project is in `.claude/handoff.md` (rewritten at 14:20 for a fresh session: read it first).

## The task (Vicky's words)

> "make sure the pipeline is composable which means that this tx builder package can also be used in UI or MM Snap."

Status when this was written: **not done, not live.** Vicky asked for this to be done in a fresh session.

## What is true today (checked at 14:10 IST)

The pipeline is the TypeScript library that builds, signs (two-pass) and sends EIP-8141 frame transactions. The newest
copy is in the git worktree **`/Users/vicky/Documents/winterlock-backend`** (branch `feat/backend`, NOT yet committed at
14:10: ask Vicky whether it has been committed since). It has modules main does not: `pipeline/src/tickets.ts`,
`pipeline/src/lanes.ts`, and in `submit.ts` the `onSubmitted` hook and the `mempool: "alt" | "public"` option; `rpc.ts`
gained `node.call` and `node.transactionByHash`. Main (`ef9b102`) has the older pipeline plus the grind fix.

Per module (worktree), what stops it running in a browser or a Snap (SES sandbox, no Node built-ins, no `process`):

| Module | Status |
| --- | --- |
| `account.ts`, `admission.ts`, `builder.ts`, `estimate.ts`, `grind.ts`, `lanes.ts`, `rpc.ts`, `submit.ts`, `wots.ts`, `hashsig/scheme.ts`, `hashsig/tree.ts`, `codec/codec.ts`, `codec/FrameTx.ts` | no Node/Bun API of their own (portable code), BUT they import `config.ts` (directly or indirectly) |
| `config.ts` | reads `process.env` at module load: **crashes on import** where there is no `process`. Nearly every module imports it (DEVNET, DEFAULTS, GRIND, MAX_VERIFY_GAS, the system-contract addresses and code) |
| `leaves.ts` | the journal: `bun:ffi` (flock), `node:fs`, `node:os`, `node:path` |
| `genesis.ts` | `node:fs` (the genesis pin file beside a seed) |
| `tickets.ts` | `Bun.spawn` (the Rust CLI), `node:fs`, `node:path`, `process.env` |
| `hashsig/keyring.ts` | `node:fs`, `node:path` (leaf cache directory, `loadOrCreateSeed`); its crypto is pure |
| `signer.ts` | `cliHashSigner` uses `Bun.file`, `Bun.spawn`, `process.env` (inside the function); the two-pass `signFrameTx` and `placeholders` are portable |
| `index.ts` | re-exports everything, including `leaves`, `genesis`, `tickets`: importing the package pulls in `bun:ffi` and `fs` |

Also: `rpc.ts` exports singleton clients (`gateway`, `node`) bound to `DEVNET` URLs read from env at import; tests
replace their methods with `Object.assign`. Nothing browser-side imports the pipeline today: the screens (`web/`) call the
backend's HTTP API only (spec: the frontend only calls the backend; seeds stay in the backend). Vicky's Rust signer has
a WebAssembly build in `signer-wasm/` ("for JS and the Snap", PR #4) that has never been built here (no wasm32 target,
no wasm-bindgen-cli, no build notes). The plan (section 8) says "no WebAssembly; the Snap is cut": this task makes the
core Snap-READY; it does not build a Snap. Confirm that scope with Vicky before going further.

Who imports the pipeline (all must keep working): `backend/src/*` (imports `../../pipeline/src/index.ts` and
`pipeline/scripts/lib/wallet.ts`), `pipeline/scripts/*`, `pipeline/test/*`, `fakechain/` (on main: imports main's
pipeline), `demo/lanes.ts` (talks to the backend API; check), `.claude/pipeline-test/counter-test.ts` (local).

## The plan (proposed to Vicky; refine it, then build)

1. **Two entries.**
   - `pipeline/src/core.ts` (new): browser- and Snap-safe. Codec, builder, the two-pass signer (`placeholders`,
     `signFrameTx`, ECDSA via viem, a `HashSigner` interface), grind, wots, `hashsig/scheme` + `hashsig/tree` + an
     in-memory keyring (no fs cache, seed passed in as bytes), the RPC client as a factory taking URLs and a `fetch`,
     admission parsing, lanes planning (`laneCost`, `planLanes`, `explainRefusal`), account address and calldata.
   - `pipeline/src/node.ts` (or keep `index.ts` as the Node entry for back-compat): everything in core plus the journal
     (`leaves.ts`), genesis pin, keyring disk cache and seed files, the CLI and ticket signers, env-based config, and
     `sendKeyed`/`sendWithRetry`/`settleSubmitted` wired to the file journal.
   - `package.json` `exports`: `"."` → the Node entry (so the backend and scripts change nothing), `"./core"` → core.
2. **Config passed in, not read at import.** A `createConfig({ chainId, nodeUrl, gatewayUrl, explorerUrl, ... })`; the
   constants (DEFAULTS, GRIND, MAX_VERIFY_GAS, system addresses and code) stay plain exports; only the Node entry reads
   `process.env`. Keep every current default and value exactly (GRIND is measured; see config.ts comments).
3. **A journal interface** (`reserveNext`, `peekNext`, `mark`, `note`, `markExported`, `all`, `get`, identity getters)
   that `sendKeyed`, `estimateCalls` and `settleSubmitted` take, implemented by `LeafJournal` (file + flock) in Node. Note
   in the code what a Snap implementation (on `snap_manageState`) would have to guarantee: written BEFORE signing, never
   recreated empty, one writer. Do not weaken any guarantee of the hardened send path (`submit.ts` header lists them).
4. **Proof it is live:**
   - a test that bundles `core.ts` with `bun build --target=browser` and fails if the output references `node:`, `bun:`,
     `process`, `Bun.` or `require(`;
   - a test that imports the bundled core where `process` is undefined;
   - a live page (e.g. `web/public/sdk.html`, or in `demo/`) that imports the browser bundle and, entirely in the page,
     builds a frame transaction, signs it two-pass with the in-memory WOTS+ keyring from a throwaway seed, and shows the
     sig hash, the entry size (2,594 bytes at h = 10), the prefix budget and the wire JSON; nothing sent;
   - optional: a SES lockdown test (what Snaps run). Needs the `ses` npm package: ask Vicky before downloading.

Effort estimate: 2 to 3 h with a workflow (understand → design → implement → adversarial review).

## Constraints

- AGENTS.md: no commits, pushes or PRs unless Vicky asks; never commit `.claude/`; spec-first for any frozen interface
  change; keep the README's AI-attribution section current (list every new or changed file).
- Ultracode is on: use workflows, verify adversarially, put each critical fix back once and see a test fail.
- Tests that must stay green (counts at ~13:50 IST in the worktree; re-check, they move): pipeline 231, backend 110,
  demo 10, web ~113-120; on main: fakechain 90, pipeline 164. Commands:
  `export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"`, then in each package
  `bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test`.
- Never print, log or commit anything in `~/.winterlock` (EOA key, seeds, journals).
- Vicky: short answers in easy words; teach as you go (she explains every part to the judges).

## Coordination with the other session (read before touching files)

The first session ended at about 14:20, after its polish fixer finished (all 8 items; nothing of it is still running).
The next main session (from `.claude/handoff.md`) works in the SAME worktree: a Ledger UI rebuild in `web/`, then
real-devnet runs of the backend on account 3 (`0xf3e63d269dae09032ea950cd9722733e9b3f2d37`; that backend runs on 8787
and holds account 3's journal lock while it runs). The first session's fake-chain servers (18545, 18787, 15173, 15180)
end with it.

Safest order: ask Vicky to commit `feat/backend` first, then make your own worktree and branch from it
(`git worktree add -b feat/composable-pipeline ../winterlock-composable feat/backend`), so your refactor of `pipeline/`
cannot break the other session's running tests. Merge with merge commits only (no rebase, no squash: the plan forbids
rewriting history).

## Done means

- `import ... from "@winterlock/pipeline/core"` (or the relative `pipeline/src/core.ts`) works in a browser bundle and
  without `process`; the live page builds and signs a frame transaction in the browser.
- The backend, scripts, demo and fake chain work unchanged; every suite is green; the hardened send path's guarantees
  are unchanged (a reviewer checks `submit.ts` line by line against the old version).
- README: a short "Using the pipeline in a browser or a Snap" section, and the AI attribution updated.
