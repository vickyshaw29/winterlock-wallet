# AGENTS.md: running this workshop repo with an AI agent

You are helping a developer work through an EIP-8141 / standard alt-mempool workshop on a **public throwaway devnet** (chain 1337).
Read the work-in-progress notice in [README.md](README.md) first: the sidecar's rules come from `forshtat/ERCs` PR #6, not exactly ERC-8421.

The mempool node itself (sidecar fork) is in <https://github.com/forshtat/mempool-workshop-sidecar>; its `deploy/devnet/devnet-readme.md` is the RPC reference and `docs/sidecar_explorer.md` documents the explorer API.

## Terminology (use exactly this)

- **canonical mempool**: EIP-8141's own public mempool (ethrex's validation on the devnet).
- **sidecar**: the ERC-8421 Mempool Sidecar, the mempool node (a heavily modified fork, not Skandha). Say "sidecar", never "Skandha".
- **gateway**: the one sidecar node every request goes to (`gatewayUrl`). It validates, gossips to the miner, and forwards `eth_*` reads and `eth_sendRawTransaction` to ethrex. Nothing talks to the miner or ethrex directly.
- **standard alt-mempool**: the ERC-8421-style rule set the sidecar implements.
- **staked entity**, **reputation** (`OK` / `THROTTLED` / `BANNED`).
Do not call the standard alt-mempool "canonical", and do not say "standard mempool" for the base rule set.

## Commands

All are `yarn <name>`. Pass `--json` for exactly one JSON object on stdout (logs go to stderr). Steps refuse to run out of order: a step runs only after the steps in the table's "Needs state from" column have reached their expected outcome, and only with the key step 1 recorded. Exit 0 means the **expected** outcome happened;
for the "fail" steps (6, 10) that is the rejection.

| Command | Needs state from | Expected result |
|---|---|---|
| `step_1_check` | nothing | **resets the workshop** (forgets every address and finished step; the participant key stays), chain 1337, participant key in `.workshop-state.json`, balance > 0.1 ETH (funded by the faucet) |
| `step_2_tx_first` | step 1 | tx mined, `frames: 2` |
| `step_3_tx_paymaster` | step 1 | tx mined, paymaster balance dropped, sender balance 0 |
| `step_4_wallet_deploy` | step 1 | `wallet` address in state |
| `step_5_tx_wallet` | step 4 | tx mined, wallet paid |
| `step_6_tx_violating_canonical` | step 1 | the canonical mempool (ethrex, via the gateway) rejected with `StorageReadNonSender` (exit 0) |
| `step_7_stake` | step 6 | registry shows stake 0.012 ETH |
| `step_8_tx_violating_alt` | step 7 | tx accepted and mined |
| `step_9_reputation_burn` | step 6 | explorer shows `BANNED` (**declared shortcut**; `yarn reset_reputation` undoes it) |
| `step_10_tx_violating_alt_banned` | step 9 | rejected, explorer shows `BANNED` (exit 0) |
| `step_11_debug -- <txHash>` | none (defaults to the last tx) | admission report, lifecycle, status |
| `step_12_tx_keyed_nonces` | step 4 | two keyed-nonce txs (keys 1 and 2) mined, the wallet's account nonce unchanged |
| `step_13_tx_recent_roots` | step 4 | a committed root declared in a mined tx; a never-committed root refused (exit 0) |

Flags: `--json`, `--fresh` (redeploy contracts the step owns). Config is `workshop.config.json5` and nothing else: every key is required, unknown keys are an error, the code never writes it, and there are no environment variables. What the steps generate (participant key, deployed addresses, last tx hash) is state, in `.workshop-state.json`. Per-step runbooks: `docs/steps/`.

## Error codes (`--json` failure: `{ok:false, code, rule, hint, message}`)

| code | cause | fix |
|---|---|---|
| `RPC_UNREACHABLE` | network, or the devnet is down | retry; check `gatewayUrl` in `workshop.config.json5` |
| `RPC_-32601` | the gateway does not implement that method (the explorer is off, or it has no faucet) | check `gatewayUrl`; ask the host |
| `RPC_-32502` | the mempool rules rejected the tx | read `rule` and `message`; run `step_11_debug -- <txHash>` |
| `RPC_-32500` | nonce mismatch or an invalid tx | a contract wallet's nonce is 1 plus one per contract it created (a `HegotaSupport` wallet created 7 helpers: it starts at 8); read it from the chain |
| `WRONG_CHAIN` | devnet was replaced | check `chainId` and `gatewayUrl` in `workshop.config.json5` |
| `CONFIG_INVALID` / `CONFIG_MISSING` | `workshop.config.json5` has a missing, unknown or malformed key, or is gone | the message lists each problem; restore the file from git |
| `STEP_ORDER` | a step it depends on has not finished (or step 1 has not run) | run the steps named in `hint`, in order |
| `STATE_KEY_CHANGED` | the participant key is not the one step 1 recorded; what was deployed belongs to that key | run `step_1_check` again: it resets the workshop |
| `STATE_MISSING` | a step's prerequisite did not run | run the step named in `hint` |
| `STATE_STALE` | recorded contract has no code (devnet reset) | re-run that step with `--fresh` |
| `DEPLOY_FAILED` | deploy reverted | needs ~6M gas and enough balance for `value`; run `step_1_check` to top up |
| `TX_NOT_MINED` | not mined within 120 s | devnet may be stalled; check the explorer |
| `TX_REVERTED` | mined, but a frame failed | `step_11_debug -- <txHash>` |
| `TX_UNKNOWN` | no node knows the hash | the explorer history is in memory only; check the hash |
| `FUNDING_FAILED` | the faucet refused (once per address per hour, empty, rate limited, or absent) | read `message`; use the explorer's **Faucet** button for another address or ask the host |

## Rules for agents

- Never call `debug_bundler_clear*` or any other `debug_*` method that changes the node, except through `step_9_reputation_burn` and `reset_reputation` on the participant's own wallet. They affect everyone on the devnet.
- There is no shared funded key in this repo: funding goes through the node's faucet (`skandha_explorer_faucet`). Never ask for, search for or use the devnet's genesis key.
- Do not vendor or import from `skandha/packages/*/lib`: the built output can be stale. The codec comes from the `@forshtat/hegota-support` package (`src/lib/frameTx` only binds it to this devnet's profile and keeps the workshop's gas numbers); the sidecar JSON shape (`toWire`) comes from `@forshtat/hegota-support/rpc`.
- When a tx is rejected, do not guess: run `yarn step_11_debug <txHash>` for the rule-by-rule admission report.

## Facts that explain failures

- Fund contracts only through their creation `value`; a plain transfer runs validation code outside a frame and fails.
- A contract's nonce starts at 1 and grows by one for every contract it creates: wallets and paymasters inherit `HegotaSupport`, whose constructor creates one helper per opcode (7 on this devnet), so they start at 8. An unstaked payer cannot use `BALANCE`; environment opcodes are banned for everyone.
- A throttled entity is still admitted (it is capped at 4 mempool entries); a **banned** entity is rejected, with a generic "unstaked payer accessed …" error. Check the explorer to tell the difference.
- A transfer to a brand-new account needs a non-zero `state` gas limit.
- `docs/findings.md` records what was verified on the devnet and why.

- `contracts/fork/` is a very experimental, untested optional variant for the EIP-8141 solc fork (`yarn compile:fork <solc>`). The workshop's contracts and artifacts keep using vanilla solc and `@forshtat/hegota-support`; do not move them to the fork.
