# Alt-mempool workshop: EIP-8141 frame transactions and the standard alt-mempool

A hands-on quick start. In eleven one-line commands (plus two bonus steps) you send frame transactions to a public devnet,
watch the **canonical mempool** reject a transaction that the **standard alt-mempool** accepts once
the sender is staked, and debug a rejection.

> [!WARNING]
> **Work in progress.** Everything here is under active development, and the devnet can be reset at any time.
>
> The ERC-8421 Mempool Sidecar ([source: mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar)) is the standard alt-mempool node this repo talks to. Its rules come from
> [forshtat/ERCs PR #6](https://github.com/forshtat/ERCs/pull/6), "Update ERC-7562: Add EIP-8141 specific rules",
> pinned to commit `74a868c`. That work later evolved into [ERC-8421](https://ethereum-magicians.org/t/erc-8421-frame-transaction-alternative-mempools/29800)
> ([ethereum/ERCs PR #2028](https://github.com/ethereum/ERCs/pull/2028)), and **the two are not equivalent**. The migration is ongoing. Differences known at the time of writing:
> rule IDs were renamed (for example `GREP-*` became `REPUTATION-*`); `MAX_VERIFY_GAS` became a per-entity `MAX_VERIFY_GAS_PER_ENTITY`;
> the per-entity state-gas cap was dropped; `SAME_SENDER_MEMPOOL_COUNT` is 64 and no longer applies to staked senders;
> and a pending tx is identified by (sender, `nonce_keys`, `nonce_seq`). When this repo shows a rule, it shows the PR #6 behaviour.

> [!CAUTION]
> **Step 9 cheats.** Reputation should fall because an entity keeps producing txs that are admitted but never
> included. That cannot be reproduced reliably on this devnet, so `step_9_reputation_burn` writes the reputation counters
> directly, using the devnet's open `debug_bundler_setReputation` method, for your own wallet only. Real nodes restrict that method.
> Everything else in the repo exercises the real mechanism.

## Terms used in this repo

| Term | Meaning |
|---|---|
| **Canonical mempool** | The public mempool defined by EIP-8141 itself. Strictest rules. No staking, no reputation. On the devnet this is ethrex's own validation. |
| **Standard alt-mempool** | The ERC-8421-style rule set that the sidecar implements. It admits some txs the canonical mempool rejects, when staking and reputation conditions hold. |
| **Staked entity** | A sender, paymaster or factory that has staked in the staking registry. Staking relaxes storage rules. |
| **Reputation** | Per-entity `OK` / `THROTTLED` / `BANNED` state, from how many of an entity's txs were seen versus included. A banned entity is excluded from the mempool. |

Not sure which mempool your contract needs? Read the [decision guide](docs/decision-guide.md).


## Devnet versions

What the devnet runs, pinned to commits. The EIP revisions are the ones the execution client's own notes name as its spec targets (`docs/eip-*.md` in the ethrex commit below); the code has not been checked against them here.

| Component | Pinned to |
|---|---|
| ethrex (execution client) | [`9aa3645d`](https://github.com/forshtat/ethrex/commit/9aa3645d795945c64400f41a70aace0edfa7f383), branch `eip8141-tracer` (2026-10-01). Check the live build: `curl -s -X POST <ethrex root URL> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}'` |
| [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transactions | [`4a9ad32c`](https://github.com/ethereum/EIPs/blob/4a9ad32cf2c851d16ab889d643342074ea3fab95/EIPS/eip-8141.md) (2026-07-30) |
| [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) keyed nonces | [`81b976ac`](https://github.com/ethereum/EIPs/blob/81b976ac01591fed2eecb73fa574f27cd18db2e8/EIPS/eip-8250.md) (2026-08-03), `NONCE_MANAGER` at `0x…8250` |
| [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) recent roots | [`d8636a33`](https://github.com/ethereum/EIPs/blob/d8636a330deb59a8a8f88d39dcbccb2c7d77db28/EIPS/eip-8272.md) (2026-08-03), `RECENT_ROOT_ADDRESS` at `0x…8272`, predeploy code from [EIPs PR #12131](https://github.com/ethereum/EIPs/pull/12131) |
| Standard alt-mempool rules | [`74a868cd`](https://github.com/forshtat/ERCs/commit/74a868cd4fb173c00015235fec69d6d748d781cd) of forshtat/ERCs PR #6 (see the notice above) |

The `eip8141-tracer-latest` image tag follows the branch, so the ethrex row is only true until the next deploy. Later drafts of these EIPs may differ from the pinned revisions.

## Quick start

Needs Node 20.12 or newer and yarn (v1). Foundry is optional (only to change the contracts).

```sh
git clone https://github.com/forshtat/mempool-workshop.git && cd mempool-workshop
yarn install
yarn step_1_check
```

`step_1_check` creates a throwaway key in `.workshop-state.json` (devnet only; never reuse it on a real network) and funds it from the devnet's faucet (1 ETH; also available as the **Faucet** button in the explorer). Devnet: chain `1337`,
every request goes to the gateway, `https://altmempoolgateway.forshtat.com/rpc` (a sidecar node that gossips to the miner and forwards chain reads to ethrex),
explorer at <https://explorer.altmempool.wtf/>. All configuration is in `workshop.config.json5` (read-only for the code; every key is required). There are no environment variables.

The mempool node is the sidecar, a fork that speaks EIP-8141. Its source, the full RPC reference (`deploy/devnet/devnet-readme.md`), the P2P guide and the devnet explorer API docs live in the sidecar repo: <https://github.com/forshtat/mempool-workshop-sidecar>.

## The steps

Every step is one command. Each prints a short summary, accepts `--json` for one machine-readable object, and exits 0 when the **expected**
outcome happened (for the "fail" steps, that means the rejection). Details and expected output are in [`docs/steps/`](docs/steps/). Each step also prints a short plain-language explanation before it runs: what is going on, which components are involved, what to watch for and why it matters (not in `--json` mode).

| Command | You achieve |
|---|---|
| `yarn step_1_check` | Confirm the devnet and explorer work, and fund your key |
| `yarn step_2_tx_first` | Broadcast your first frame tx |
| `yarn step_3_tx_paymaster` | Broadcast a frame tx paid for by a paymaster |
| `yarn step_4_wallet_deploy` | Deploy your own validation-frame wallet contract |
| `yarn step_5_tx_wallet` | Send a tx validated by your wallet |
| `yarn step_6_tx_violating_canonical` | **Fail** to broadcast a rule-violating tx to the canonical mempool |
| `yarn step_7_stake` | Stake the wallet |
| `yarn step_8_tx_violating_alt` | Send **the same tx** to the standard alt-mempool: accepted |
| `yarn step_9_reputation_burn` | Get the entity banned (**a declared shortcut**, see above) |
| `yarn step_10_tx_violating_alt_banned` | **Fail** to send the tx because of low reputation |
| `yarn step_11_debug <txHash>` | Debug any tx: admission report, lifecycle, status |
| `yarn step_12_tx_keyed_nonces` | **Bonus** (needs step 4): two txs from one wallet on different nonce keys (EIP-8250), pending side by side |
| `yarn step_13_tx_recent_roots` | **Bonus** (needs step 4): commit a recent root, declare it in a tx, and see an uncommitted one refused (EIP-8272) |

Run them in order the first time. State (deployed addresses, last tx hash) lives in `.workshop-state.json`. If the devnet was reset, the recorded
addresses are gone: re-run the deploy steps with `--fresh`.

## Working with an AI agent

Point your agent at [`AGENTS.md`](AGENTS.md). Every step can be run alone, `--json` output is a single object, and error codes are listed with fixes.

## Layout

```
contracts/src        Solidity: SponsorPaymaster, ExampleWallet, ViolatingWallet (+ tests in contracts/test)
contracts/fork       the same wallet for the EIP-8141 solc fork (optional, see below)
contracts/artifacts  compiled output, committed (steps run without foundry); rebuild with `yarn build:contracts`
src/steps            one file per step
src/lib              frame tx codec and builders, RPC, explorer, state
docs/steps           runbook per step
docs/findings.md     what was verified on the devnet, and why the contracts look the way they do
```

### Optional: the EIP-8141 solc fork (very experimental and untested)

The contracts in `contracts/src` are written for vanilla `solc` plus the `HegotaSupport` base contract from `@forshtat/hegota-support`, which deploys one small Yul helper per opcode. That stays the workshop's way. A community fork of the compiler, [chiranjeev13/solidity](https://github.com/chiranjeev13/solidity) (release `v0.8.38-eip8141.0`), instead teaches inline assembly the EIP-8141 opcodes as Yul builtins (`approve`, `txparam`, `frameparam`, `sigparam`, ...), enabled by the EVM version `cancun+eip8141`. [`contracts/fork/ForkSolcWallet.sol`](contracts/fork/ForkSolcWallet.sol) is `ExampleWallet` written that way: no base contract, no helpers, so the opcode runs in the wallet's own code. `yarn compile:fork /path/to/solc` compiles it with the fork and checks that `SIGPARAM`, `APPROVE` and `TXPARAM` are in the bytecode. It needs the fork's `solc` binary (from the release page, or built from source) and does not run in `yarn test`; `forge build` ignores the file. **This path is very experimental and untested:** it has been compiled, but never run on the devnet.

Contract tests: `forge install foundry-rs/forge-std --no-git --root contracts` once, then `yarn test:contracts`. TypeScript tests: `yarn test`.
