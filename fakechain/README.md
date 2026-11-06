# fakechain: a local FAKE devnet

One Bun process that answers the JSON-RPC of the ethrex node and of the workshop sidecar, so the pipeline's scripts
(and later the backend) run against it unchanged, by environment variables, while the real devnet is halted. Written
with Claude Code (AI) for Vicky.

**It is fake.** It runs no EVM code. It models in TypeScript what the devnet does for this project (the spec's Day-0
results, the vendored sidecar's code) and what `account/yul/Account.yul` checks. Its client version, its explorer page
and this file all say so. A run on it proves the pipeline's logic, never that the devnet will accept the same bytes.

## Run it

Prerequisites: Bun, and `bun install` in both `fakechain/` and `pipeline/`. The account signs with the pipeline's
TypeScript keyring; the Rust signer (`signer/`, `cargo build --release`) is needed only for hot-ticket files
(`export-leaves`, `sign --ticket-file`).

```sh
export PATH="$HOME/.bun/bin:$PATH"
(cd pipeline && bun install) && cd fakechain && bun install

# shell 1: the fake chain; it prints its data folder and the env.sh to source
bun run.ts                      # node at http://127.0.0.1:8545, sidecar at /rpc, explorer at /explorer

# shell 2: the env.sh line shell 1 printed, then a script
source /var/folders/…/fakechain-XXXXXX/env.sh
cd pipeline && bun scripts/hashsig-devnet.ts
```

**Every `WL_*` variable must come from that `env.sh`.** Do not override one on a command line, not even the
`WL_GATEWAY_URL=… bun scripts/hashsig-devnet.ts` prefix in that script's header. The fake chain's guard protects the
fake chain's own process only: the pipeline's scripts have no guard and use whatever `WL_*` they are given. In a mixed
environment they can reach the real devnet, or write this run's leaves into a real journal. Only the chain pin (chain
31337 and this run's genesis) stops them from signing there.

| Flag | Default | What it does |
| --- | --- | --- |
| `--port N` | 8545 | 127.0.0.1 port for the node (`/`), the sidecar (`/rpc`) and the explorer (`/explorer`) |
| `--block-time S` | 6 | seconds between blocks, at least 1, as the devnet |
| `--height H` | 10 | tree height of the first account, 5 to 12 (below 5 the 16 hot leaves leave no cold one; verify gas is measured up to 12). `lib/wallet.ts` and `hashsig-devnet.ts` assume 10 |
| `--public-per-sender N` | 1 | pending frame transactions per sender in the public pool |
| `--base-fee WEI` | 7 | fixed base fee per gas: the devnet's (estimate.ts asks for 2 x base fee; the measured estimates carry 14 wei) |
| `--bundle-interval S` | 10 | seconds between the sidecar's relay and reconcile passes (its `bundleInterval`) |
| `--proxy-holdback on\|off` | on | EIP-150: the account proxy's DELEGATECALL keeps 1/64 of the gas back |
| `--enforce-gas-price` | off | the sidecar's `enforceGasPrice`: a transaction priced below the quote is never relayed |

Each start is a new world: a fresh data directory in the OS temp dir (printed; never inside the repo, never under
`~/.winterlock`), a random genesis hash, chain id **31337**, a throwaway EOA (key written with mode 0600, 1,000 ETH in
genesis) and a throwaway faucet key. Then it creates the first account exactly as `scripts/deploy-account.ts` does: a
fresh seed `seeds/account-1.seed` with this genesis pinned beside it, the keyring for generation 0, the journal created
before the account, the EOA's `createAccount` transaction (hotStart 2^h − 16, value cap 0.01 ETH, fee cap 0.002 ETH,
allowed target the "shop" address funded in genesis), then 10 ETH. It writes `pipeline-data/deployment-31337.json` (the
`Deployment` shape of `scripts/lib/wallet.ts`) and `env.sh`, which exports `WL_CHAIN_ID`, `WL_NODE_URL`, `WL_GATEWAY_URL`,
`WL_EXPLORER_URL`, `WL_DATA_DIR`, `WL_BACKEND_DIR`, `WL_EOA_KEY_FILE` and `WL_SEED_FILE`. Ctrl-C stops it. A start that
fails, or is stopped before it is ready, removes its folder and the throwaway key in it.

### Which scripts work against it

- `scripts/hashsig-devnet.ts`, with `env.sh` sourced: the only script checked against the fake (end to end, in
  `test/launch.test.ts`).
- **Never** `deploy-account.ts`, `smoke.ts`, `account-sim.ts` or `measure-verifier.ts`: they read the real EOA key from a
  fixed path under `~/.winterlock`.
- `retry-demo.ts` and `estimate-demo.ts` need a placeholder deployment and refuse this one (`requirePlaceholder`).
- Every other script is unchecked here. The tests drive the pipeline's functions directly (`sendKeyed`,
  `sendWithRetry`, `estimateCalls`, `settleSubmitted` and the rest, `test/fakechain.test.ts`), not those scripts.

Gas the fake prints, in its receipts, in its simulations and in `hashsig-devnet.ts`'s fit, is the model's own input
played back, not a measurement. A fit on the fake returns 54,630 + 66.09 x steps because the fake was given those numbers.

## Isolation

- Chain id 31337, never 1337: nothing signed here is valid on the devnet. Seeds made in one run refuse to sign in any
  other (random genesis, `pipeline/src/genesis.ts`), and seeds pinned to the devnet refuse here.
- The server binds 127.0.0.1 only. `src/guard.ts` refuses to load unless every `WL_*` endpoint the pipeline read is on
  this machine and the chain id is 31337, and it wraps `fetch` so the process cannot reach any other host.
- `run.ts` sets the environment before it loads anything of the pipeline (which reads its endpoints once, at load).
  It checks the data folder's place before creating it, with symlinks resolved (`src/dataDir.ts`).

## What is real and what is modelled

Real (the project's own code, imported unchanged): the codec and the sig hash, `buildFrameTx`, the two-pass signer,
the TypeScript keyring and its verifier `verifyEntry` (the off-chain mirror of `hashsig_verify`), the WOTS+ step count,
the gas model `frameGasModel`, `predictAccountAddress` and `proxyRuntimeCode`, the journal, `sendKeyed` and the rest of
`submit.ts`, `estimate.ts`. The implementation's code is `account/build/Account.bin`'s runtime and the factory's is
Foundry's artifact with the implementation filled in, but neither is executed.

Modelled:

| Piece | Model and source |
| --- | --- |
| The account's verify frame | `src/accountModel.ts`: Account.yul's `verifyFrame` and `hotPolicy` check by check, same order, same 32-byte revert strings (a test compares the list with the Yul source) |
| Admin calls and views | `rotate`, `setHybrid`, `setHotPolicy`, `setOwner`, `initialize`, the views, with Account.yul's argument checks and refusals |
| Factory | `createAccount`, `predictAddress`, `implementation()`; Solidity's ABI checks; no payable function, so a call carrying ETH reverts; an `initialize` refusal reverts the whole call |
| Verify-frame gas | account 2's measured fit at height 10, 54,630 + 66.09 x chain steps cold (pipeline `GRIND`), +121 hybrid, +6,623 hot (Day-0 estimates). Split into the proxy's 3,124 before its DELEGATECALL, the account's checks, `hashsig_verify`, the hot reads and the fresh key's 20,000 inside APPROVE, so a failing check costs what ran before it. Other heights: 196 per level more or less, since the path part scales with height + 4 (190 measured for `hashsig_verify` with `HashSigVerifier.measure` at heights 4, 10 and 12; about 6 estimated for the longer SIGDATACOPY) |
| The proxy's 63/64 | the account's code gets all but 1/64 of what is left at the DELEGATECALL; past it the proxy reverts with no data (at 90,000 declared, 510 steps fit and 525 do not, as measured on the devnet) |
| Other gas | expiry frame 3,051; frame entry 100 warm or 3,000 cold; SSTORE 2,100 cold + 2,900, and 97,920 state gas from zero, failing with 2,300 gas or less left (EIP-2200); a new account 183,600 state gas; createAccount about 953,700 from an EOA; calls into other code a fixed 2,000 |
| Transaction gas | `frameGasModel`: mandatory + max(calldata + execution, floor) + state; the limit charged up front max(intrinsic + limits, mandatory + floor + state limits); TXPARAM 0x06 = that limit x maxFeePerGas |
| Node checks | static nonce rules, chain id, `Insufficient max fee per gas` below the base fee, `Nonce mismatch: expected N, got M`, EIP-8141 signature validation (the sidecar's `validateSignature`, synchronous) |
| ethrex_simulateFrameTransaction | a refused prefix answers `canonicalMempoolViolation: "validation prefix frame reverted"`, `failedFrameIndex`, `haltReason`, `revertData`, and no frame gas; `erc7562Trace` is always null (no EVM, no opcode trace) |
| Sidecar admission | the vendored sidecar's order and texts: chain id, gas limit (25,000,000), recent roots, the node's simulation, prefix shape, structure (the exact `MAX_VERIFY_GAS` message), signatures, the simulation verdict, the entity rules, then the mempool; the explorer's rule ids and its "skipped" rules |
| Alt mempool | one pending transaction per (sender, nonce key); same slot: `already known`, or `cannot be replaced: fee too low` without a 10 % bump on both fees; balance obligations (maximum cost plus values) |
| Bundler and reconciler | every `--bundle-interval`: up to 4 New entries relayed (Submitted); after each new block, included ones become OnChain or Reverted, missed ones New again, and New ones that no longer validate Cancelled (`revalidation failed as of block N: …`) |
| Public pool | the node's own checks, then at most `--public-per-sender` pending frame transactions per sender (the spec's assumption; ethrex's docs say its pool may admit more) |
| Receipts | the node's shape (`payer`, `frameReceipts` with `gasUsed` and `stateGasUsed`); status 0x1 only when every frame succeeded; an extra `fakechainRevertReasons` names why a frame reverted (a real receipt carries no reason) |
| State reads | the state of the last 130 blocks; an older block is an error, not the devnet node's silent latest-state answer |
| EOA transactions | legacy and EIP-1559, chain 31337 only, the next nonce (no queue), enough balance; contract creation refused. A pooled nonce is replaced only when the fee cap and the tip both rise by 10 % (ethrex's `check_replacement_bid`, its default bump assumed), else ethrex's "Attempted to replace a pooled transaction with an underpriced transaction" |
| Faucet | 1 ETH from a funded throwaway key, once per address per hour, 100 an hour. The gas is estimated on the latest state, as viem asks the node in the real faucet, so an address with code (the account) is funded; a transfer that would fail gets the sidecar's `-32603 Internal error`, and nothing is sent |

Not modelled (refused with a message that says so): frame transactions from an address without account code (EOA
default code), EIP-8272 recent-root references, blobs, deploy and paymaster prefixes, flags on frames after the prefix,
DEFAULT frames into an account.

## Where it differs from the brief, and why

- Base fee 7 wei by default, not 1 gwei: the devnet's base fee. At 1 gwei `estimateCalls` would push a hot estimate's
  maximum cost (about 20 million gas) over the 0.002 ETH fee cap.
- A fee below the base fee is refused at admission (`Vm execution error: Invalid Transaction: Insufficient max fee per
  gas`), as the sidecar answers when ethrex's simulation refuses it, instead of waiting in the pool. A stuck payment is
  shown by a short expiry (as `retry-demo.ts` does) or, with `--enforce-gas-price`, by a fee below the quote.
- Sidecar statuses follow its code: New on admission, Submitted when relayed, OnChain or Reverted after inclusion,
  Cancelled after a failed revalidation (Day-0 saw "New, Submitted, OnChain").
- The verify-gas numbers are account 2's measured fit (pipeline/src/config.ts), not the earlier 24,070 + 30,396 split.

## Tests

```sh
cd fakechain && bun install && bunx tsc --noEmit -p . && bun test
```

`test/preload.ts` points every `WL_*` at a free local port before any test loads the pipeline. `test/model.test.ts`
runs the model alone (account-sim's cases, the admin refusals, the gas model, drift checks against Account.yul, the
interface and the factory artifact). `test/fakechain.test.ts` runs the pipeline's own functions against an in-process
fake over HTTP. `test/isolation.test.ts` checks the refusals: the guard in child processes with other `WL_*`, the
fetch guard, and the data folder inside the repo or under a stand-in `~/.winterlock`, symlinks included.
`test/launch.test.ts` checks the launcher's flag refusals and its cleanup after a failed start. It then launches
`run.ts`, runs `scripts/hashsig-devnet.ts` with `env.sh`'s variables only, and stops it with SIGINT.

Ported code: `src/sidecarRules.ts` follows the vendored mempool-workshop-sidecar (MIT, Copyright (c) 2023 Etherspot).
