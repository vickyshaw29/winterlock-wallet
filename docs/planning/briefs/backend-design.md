# V6 backend: build brief (Nov 6, approved by Vicky)

Work in the git worktree `/Users/vicky/Documents/winterlock-backend` (branch `feat/backend`, made from `main`).
Never touch `/Users/vicky/Documents/winterlock` (the main checkout holds other uncommitted work), never commit,
never push. The devnet is halted: nothing in this task may send anything to any network. Tests run offline.

## Read first

- The project rules: `/Users/vicky/Documents/winterlock/AGENTS.md`, `/Users/vicky/Documents/winterlock/.claude/spec.md`
  and `/Users/vicky/Documents/winterlock/.claude/plan.md` (`.claude/` is local-only, so the worktree has no copy:
  read these paths). In the spec: "Shared interfaces (frozen before coding)", item 5 **Backend API**, extended on
  Nov 6 with Vicky's approval (this is the contract you build); "Pipeline, backend and frontend"; "Account contract";
  "Transaction format and signing flow". In the plan: sections 7 (V5, V6) and 11.
- The pipeline you wrap (in the worktree): `pipeline/src/submit.ts` (sendKeyed, sendWithRetry, waitForInclusion,
  settleSubmitted, the error classes), `leaves.ts` (LeafJournal), `signer.ts`, `rpc.ts`, `admission.ts`, `config.ts`,
  `account.ts`, `builder.ts`, `estimate.ts`, `genesis.ts`, `hashsig/keyring.ts`; `pipeline/scripts/lib/wallet.ts`,
  `scripts/deploy-account.ts`, `scripts/hashsig-devnet.ts`; the fake-chain test pattern in `pipeline/test/submit.test.ts`.
- The account: `account/yul/Account.yul` (verifyFrame, hotPolicy, rotate, setHotPolicy, requireColdLeaf).
- The Rust CLI's ticket flow: `signer/src/bin/signer/args.rs`, `commands.rs`, `io.rs`, `signer/src/ticket.rs`, `api.rs`.

## Facts already checked (do not re-derive; do verify anything you build on that is not listed)

- `export-leaves --from F --to T` exports the **inclusive** range [F, T]. `LeafJournal.markExported(from, to)` is
  **exclusive**: [from, to). So exporting N tickets from F is `markExported(F, F + N)` and `--to F + N - 1`.
- A ticket file is JSON with top-level `version, treeSeed, root, height, generation, chainId, slot, leaves[{leaf,
  secrets[67], authPath[h + 4]}]`. The CLI writes it with mode 0600. `sign --ticket-file F --leaf L --msg M
  [--chain-id C]` signs from it and refuses `--seed-file`, `--height`, `--generation`, `--chains`; a leaf not in the
  file gives `leaf_not_in_ticket`. `export-leaves` needs `--hot-start` and refuses leaves below it.
- `LeafJournal.open` refuses to open when **any** `*.json` file in the journal's own directory has a top-level
  `treeSeed` equal to the journal's (`refuseSecondJournalForTree`). A ticket file has exactly that field. So a ticket
  file must never sit in a directory that holds a journal of the same tree, and the backend must never write any JSON
  with a top-level `treeSeed` into a journal directory.
- `scripts/lib/wallet.ts` `openKeyring`/`accountSigner` hard-code generation 0 and height 10 (`TREE`). A rotated
  wallet needs a keyring built for its own epoch and height: build `new Keyring({seed, generation, height, chains,
  cacheDir})` yourself, with the genesis pin check (`pinOrCheckChain(pinFileFor(seedFile))`) before every signature,
  as `accountSigner` does. Never call `loadOrCreateSeed` for an existing wallet (it creates a seed when the file is
  missing): a missing seed file for an existing wallet is an error.
- `estimateCalls` signs a throwaway transaction per call with a fresh leaf and burns it.
- The account's hot rules (Account.yul hotPolicy): every frame after the verify frame must be SENDER, carry no data,
  target `allowedTarget`; total value <= hotValueCap; the transaction's maximum cost (TXPARAM 0x06) <= hotFeeCap;
  hotValueCap 0 refuses every hot leaf. Admin calls (rotate, setHotPolicy, ...) are SENDER frames to the account itself
  and need a cold leaf. setHotPolicy may keep or lower hotStart, never raise it. rotate keeps hotStart, refuses the
  installed root or tree seed, increments the epoch; leaves restart at 0 under the new epoch (leaf 0 is unusable only at
  epoch 0, where its key would be the legacy nonce 0).
- GRIND in config.ts (cold and hot cost models); the declared verify limit is 90,000 (spec). Plain transfers use
  `DEFAULTS.transferGas`; a transfer to an empty account (no code, zero balance, zero nonce) needs 183,600 state gas
  (spec, frame list).

## Invariants (reviewers will check each one)

- I1. A leaf signs at most once. Every signature goes through `sendKeyed` (or `estimateCalls`) with a LeafJournal:
  cold leaves through the wallet's cold journal, hot leaves through the ticket device's journal. No other path signs.
- I2. Bands never overlap. Keyed (cold) sends and admin calls use the band [0, hotStart) of the cold journal
  (peekNext already skips leaf 0 at epoch 0). Hot sends use only the ticket device's band.
- I3. Tickets: `markExported` in the cold journal **before** the CLI writes the ticket file. If the CLI then fails, the
  leaves stay exported: wasted, never reused. Cuts are contiguous: each cut starts where the device's band ends (or at
  the chain's hotStart for the first cut), and every leaf of the cut must be free in the cold journal and below 2^h.
- I4. Ticket files live in `<deviceDir>/tickets/`; the device journal is `<deviceDir>/journal-epoch<e>.json`;
  `<deviceDir>` holds no cold journal, and no journal directory holds a ticket file.
- I5. One writer per journal (flock). The backend opens each journal once per process and keeps it open. If a script
  holds it, answer 409 `journal_busy` with the journal's own message.
- I6. Seeds, ticket secrets and the EOA key are never logged, printed, returned or put in an error detail. Only public
  values (root, treeSeed, addresses, hashes) leave the process. Request logs carry no bodies.
- I7. Never pay twice. Only `sendWithRetry` retries, and only after Expired; nothing else resends.
- I8. Rotation: refuse while any lane of the wallet (cold or hot journal, reserved or submitted) is in flight, while a
  send request for the wallet is between its start and its reservation, or while another rotation is pending. Create
  the new epoch's cold journal (create: true, identity with the new tree seed and height) **before** sending rotate.
  Switch the wallet to the new epoch only after reading the chain: `epoch() == old + 1` and `root() == newRoot`.
  While pending, refuse sends, ticket cuts and policy changes with 409 `rotation_pending`.
- I9. Before the first signature for a (wallet, epoch), check that the record's tree, the signer's tree and the
  chain's `root()`, `treeSeed()`, `height()`, `epoch()` all agree; otherwise 409 `tree_mismatch` and no leaf is spent.
- I10. At startup, `settleSubmitted` runs in the background for every journal the backend opens (cold and device),
  and its outcomes update the transaction store.

## Pipeline changes (keep them small; each one gets tests in `pipeline/test/`, and all 162 existing tests must pass)

- P1. `sendKeyed`: optional `onSubmitted(s: { leaf, nonceKey, txHash, deadline, altHashes, accepted })`, called once,
  right after the submission step and before following; `accepted` is false when the send's outcome was unknown and
  the transaction is followed by its key. A throwing callback must not change the send's behaviour (catch it, note it).
- P2. `sendKeyed`: optional `mempool: "alt" | "public"` (default "alt", which must behave exactly as today).
  "public" submits with `node.sendRawPublic`. Refusal rule, mirroring the alt path: a deliberate JSON-RPC refusal
  (`RpcError.refused`) burns the leaf and throws `SubmissionRefused` only when the node does not hold the transaction,
  checked with a new `node.transactionByHash` (`eth_getTransactionByHash`; null means not held). "already known", a
  non-null answer, or any error while checking means: follow it by its key. No admission report for "public" (the
  sidecar never saw it). Comment that the public path is unverified on the devnet (ethrex's docs say its pool may admit
  several keyed transactions with disjoint keys from one sender).
- P3. New `pipeline/src/tickets.ts`:
  - `cliTicketSigner({ bin, ticketFile }): HashSigner`: height, generation and treeSeed from the ticket file's public
    fields; `sign` spawns `bin sign --ticket-file F --chain-id C --leaf L --msg M`, checks the returned leaf, maps the
    CLI's error object to `HashSignerError(code, detail)`. Never keep or log the secrets.
  - `exportTickets({ bin, seedFile, coldJournal, tree: { height, generation, chains }, chainId, hotStart, from, count,
    ticketsDir })`: checks I3, `markExported(from, from + count)` first, then `bin export-leaves --seed-file S ...
    --from F --to F+count-1 --hot-start H --out <ticketsDir>/epoch<g>-<F>-<T>.json`; then parses the file and checks
    its public fields (treeSeed, root, height, generation, chainId) and that its leaves are exactly F..T. The seed only
    ever goes in by `--seed-file`.
  - `TicketDevice.open({ dir, wallet, chainId, epoch, height, treeSeed, create })`: the device journal (LeafJournal
    with that identity) and the epoch's ticket files; `band()` (contiguous [first, last + 1) or null), `counts()`
    ({ exported, used, left }), `signer()`: a HashSigner whose `sign` picks the ticket file holding the leaf (all of
    an epoch's files share one tree; check that on load).
  - Export the new pieces from `pipeline/src/index.ts`.
- P4. `node.call(to, data)` (`eth_call` at "latest") in `rpc.ts`, for the account's views.

## Backend (replace the Rust stub in `backend/`: delete Cargo.toml, Cargo.lock and src/main.rs)

Bun and TypeScript, no framework. `backend/package.json` (private, `type: module`, same viem and typescript versions as
the pipeline), `tsconfig.json` (copy the pipeline's), `src/`, `test/`, `README.md` (how to run, every environment
variable). Import the pipeline by relative path (`../../pipeline/src/index.ts`, and `pipeline/scripts/lib/wallet.ts`
only where it fits). Start every new file with a one-line purpose comment and "Written with Claude Code (AI) for Vicky."

Configuration (environment, all optional): `WL_BACKEND_DIR` (default `~/.winterlock/backend`: wallets, backend seeds,
ticket devices, the transaction store), `WL_BACKEND_PORT` (default 8787), `WL_DATA_DIR` (the pipeline's deployment
records, as wallet.ts), `WL_SIGNER_BIN` (default `<repo>/signer/target/release/signer`), `WL_EOA_KEY_FILE` (default
`~/.winterlock/devnet-eoa.key`), `WL_FUND_WEI` (default 0.02 ETH). Listen on 127.0.0.1 only.

Wallet registry:
- Serves the pipeline's hashsig deployment records in `WL_DATA_DIR` (`deployment-<chain>.json` and archived
  `deployment-<chain>.0x….json`) whose seed file exists, and the backend's own records in `<backendDir>/wallets/`.
  Placeholder records are skipped. A record is written back, atomically (temp file, fsync, rename), to the file it came
  from when the backend changes it (rotation).
- Cold signer per (wallet, epoch): the TypeScript Keyring (see the facts above), cache dir `<backendDir>/hashsig-cache`.
- Cold journal: `<seedFile>.journal-epoch<e>.json` (wallet.ts `journalFile`), never created except by POST /wallets
  (new wallet) and rotation (new epoch). Device dir: `<backendDir>/devices/<address lowercase>/`.

Endpoints: exactly the spec's Shared interfaces 5 as extended Nov 6. Notes per endpoint:
- POST /wallets: hybrid true → 400 (plan section 8). chainIds must include the devnet's chain id, at most 16, distinct.
  height from 2 to 12 (default 10). hotStart default max(2, 2^h - 16), must leave a cold leaf (Account.yul
  requireColdLeaf) and be at most 2^h. The implementation and factory come from the current pipeline deployment record;
  check both have code and `factory.implementation()` matches. New seed `<backendDir>/seeds/account-<n>.seed` (n the
  next free number) via `loadOrCreateSeed`, genesis pin beside it, Keyring for generation 0, salt derived from the tree
  seed, address from `predictAccountAddress` and cross-checked with `predictAddress` by eth_call. Order, as in
  deploy-account.ts: refuse a tree seed another wallet already uses; create the journal; write the record; the EOA's
  createAccount transaction (legacy, its own nonce, nothing sent while an earlier EOA transaction is pending, all EOA
  transactions serialized by one mutex); check the code at the address is `proxyRuntimeCode(implementation)`; fund:
  faucet first (errors tolerated), then the EOA (`WL_FUND_WEI`) if the balance is still under it and the EOA can pay;
  `funded` = balance > 0 at the end.
- GET /wallets/:address: values from the chain (views by eth_call: root, treeSeed, height, epoch, hotStart, hotValueCap,
  hotFeeCap, allowedTarget, hybridRequired; balance), leavesUsed = entries in the cold journal, leafCount = 2^height,
  lanesInFlight = reserved or submitted leaves in the cold and device journals, tickets from the device, locked false.
- POST /wallets/:address/send: validate every field (400). keyed: cold journal, band [0, hotStart), GRIND.cold. hot:
  device journal and band (409 `no_tickets` when none), the ticket signer, GRIND.hot; no policy pre-check (the account
  enforces the caps; a violation is refused by the preflight: 422, its leaf burned, which the refusal scene shows).
  verifyGas 90,000; preflight true; `expirySeconds` default 90. Calls: a plain transfer uses transferGas and 183,600
  state gas when the target is empty; a call with data in keyed mode gets its limits from `estimateCalls` (one cold leaf
  burned per call); in hot mode a call with data is sent as is (the account refuses it). `maxFeePerGasWei` (first
  attempt only) with priority = min(it, the market's). `retries` 0 to 3: with retries, `sendWithRetry` with
  `attempts: 1 + retries`. Answer when `onSubmitted` fires (200, status Submitted) or when the send throws first.
  The send keeps running in the background and updates the transaction store (onStatus timeline, outcome, receipt,
  admission, simulation summary). Retry attempts are linked both ways (retryOf, retriedAs).
- Error mapping: LeavesExhausted → 409 `leaves_exhausted` (keyed) or `tickets_exhausted` (hot); PreflightRefused and
  SubmissionRefused → 422 `refused` with txHash, leaf, the simulation summary (verify gas, violation, the account's
  revert reason decoded from `revertData` when the node returns one) and the admission report when there is one, and a
  transaction-store record with status Refused; a check failure whose cause is an RpcError → 502 `rpc_failed`; the
  clock-skew check → 503 `chain_stalled`; other check failures → 409 `cannot_send`; a RetryStopped is mapped by its
  cause; anything else → 500 `internal` with a generic detail (log the error locally, without secrets).
- GET /tx/:hash: from the store; otherwise from the journals (a leaf whose txHash matches: submitted → Submitted,
  onchain → OnChain, Reverted or Included by its note, burned → Expired or Refused by its note), with the receipt and
  admission report read live where they exist. `simulation: { verifyGas, violations }`: verifyGas is the self_verify
  frame's gas (frame index 1 after the expiry frame) as a decimal string or null; violations lists the canonical
  violation, the execution error, the decoded revert reason and the admission report's failed rules.
- POST /wallets/:address/rotate: invariants I8 and I9; height 2 to 12; the rotate call's limits from `estimateCalls`.
- POST /wallets/:address/hot-policy: refuse a hotStart above the chain's (400) or one that leaves no cold leaf (400)
  before any leaf is spent; limits from `estimateCalls` (zero-to-nonzero writes need state gas).
- POST /wallets/:address/tickets: count 1 to 64, invariants I3 and I4; the device journal is created on the first cut.
- Transaction store: `<backendDir>/txs.json`, written atomically after every change, reloaded at startup. Bigints as
  decimal strings, nonce keys as 0x hex, `nonceSeq` "0x0".

## Tests (offline, in `backend/test/`; and the pipeline changes in `pipeline/test/`)

- Fake chain and sidecar by replacing `node` and `gateway` methods (`Object.assign`), as `pipeline/test/submit.test.ts`
  does, including `eth_call` for the account views and the EOA's legacy transactions. Temporary directories only
  (`WL_BACKEND_DIR`, `WL_DATA_DIR`, seeds, journals): never `~/.winterlock`, never `pipeline/.data`. Low tree heights
  where speed matters. The ticket tests need the Rust CLI: build it (`cd signer && ~/.cargo/bin/cargo build --release`)
  and fail with a clear message if it is missing; never skip silently.
- Cover at least: every endpoint's happy path and its 400/404/409/422/502/503 cases; the export off-by-one (cut N →
  exactly N leaves exported in the cold journal, exactly N in the file, the next cut contiguous); ticket files in their
  own directory with mode 0600; a hot send end to end, then `tickets_exhausted`; rotation refused with a lane in flight,
  sends refused while it is pending, the switch only after the chain shows the new epoch and root; the public mempool's
  refusal (not held → 422 and burned; held → followed); the alt path unchanged; the transaction store surviving a
  restart and `settleSubmitted` finishing a lane; no seed, secret or key in any response or log line (search the
  captured output for the seed hex and a ticket secret).
- Put each critical fix back once (the export off-by-one, the ticket directory, a throwing onSubmitted, switching epoch
  before the chain shows it) and confirm a test fails; report which test caught it.
- Commands (with `export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"`):
  `cd pipeline && bun install && bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test`
  and the same in `backend/`. Both must pass.

## Out of scope

The web screens (next step), hybrid co-signing, deploy frames, anything on the live devnet, the README (Vicky's
attribution section is updated when the work is committed), and any change to the spec or plan. If the spec, the plan,
the code or the vendored code contradict each other or this brief, stop that part and report it as a question.
