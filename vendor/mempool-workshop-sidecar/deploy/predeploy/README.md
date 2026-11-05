# Devnet predeploy

Replays original **mainnet deployment transactions** onto the EIP-8141 devnet, so testers get
the real mainnet contracts without compiling anything. It ships LINK, USDT and BAYC today;
USDC, Tornado Cash, Railgun and Uniswap v4 will be added protocol by protocol. Design: `docs/superpowers/specs/2026-09-21-devnet-predeploy-design.md`.

## Commands

Run from the repo root as `bun run predeploy <command>`.

| Command | Needs | Does |
|---|---|---|
| `list` | nothing | Protocols, their steps and dependencies, and recorded devnet addresses. |
| `creation <address>` | `ETHERSCAN_API_KEY` | Prints a mainnet contract's creation-info JSON (creation transaction hash included). Use it to write a manifest. |
| `fetch <protocols\|--all>` | `ETHERSCAN_API_KEY` | Downloads each manifest transaction into `artifacts/` (committed). |
| `fund` | devnet RPC | Sends 10 ETH from the shared devnet key to the deployer if it holds less than 2 ETH. |
| `run <protocols\|--all>` | devnet RPC | Replays the artifacts onto the devnet. `--force` deploys a fresh copy. |
| `verify <protocols\|--all>` | devnet RPC | Read-only checks. Exits 1 if any check fails. |

Environment: `PREDEPLOY_RPC_URL` (default `https://altmempool.forshtat.com`),
`PREDEPLOY_DEPLOYER_KEY` (default: the published throwaway key in `src/config.ts`),
`ETHERSCAN_API_KEY` (`fetch` and `creation` only; never commit it).

## After a devnet restart

The chain is empty again, so every recorded contract is gone. Once, install the dependencies:
`cd deploy/predeploy && bun install`. Then, from the repo root, run:

```sh
bun run predeploy fund
bun run predeploy run --all
bun run predeploy verify --all
```

The deployer starts at nonce 0 on a fresh chain and `--all` runs in registry order, so the
addresses come out the same as before. `run` detects that the recorded contracts are missing
and starts over.

After any `run`, check `git diff deploy/predeploy/addresses/1337.json`. A changed address means
the fixed deployment order was broken; the tester table in `deploy/devnet/devnet-readme.md` must
then be updated.

## Safety: the deployer nonce guard

Every contract address depends on the deployer's transaction count, so an extra transaction
shifts every address deployed after it. The journal (`addresses/<chainId>.json`) records the
deployer's transaction count (`deployerNonce`) after every step. A `run` refuses to continue if
the on-chain count differs from it while recorded contracts still exist on the chain. Either
someone else used the (published) key, or an earlier run died after a transaction was mined but
before it was journaled. Deploying would then create a second copy and shift every later
address. `--force` overrides the check. A restarted chain (no recorded contract has code) is not
affected: the guard does not apply and `run` starts over.

## Repairing a drifted journal

1. Find the deployer's transaction at the missing nonce (for example with `cast tx`, or a block
   explorer) and read the contract address it created.
2. Write that address, with its step id, into `addresses/<chainId>.json`: add it to the
   protocol's `contracts` and `mainnetToDevnet`, and its step id to `stepsDone`.
3. Set `deployerNonce` to the current `cast nonce <deployer> --rpc-url <rpc>`.

If the addresses no longer matter, redeploy on a fresh chain instead.

## Adding a protocol

1. `bun run predeploy creation <mainnet address>` prints the creation transaction hash.
2. Add `src/protocols/<name>.ts` with `defineProtocol({ name, dependsOn, steps, verify })`.
   `create` steps replay a mainnet creation by hash. `custom` steps run TypeScript for setup with
   no mainnet counterpart. `argWords` overrides a static 32-byte constructor argument by index.
3. Register it in `src/protocols/index.ts`. Order matters for `--all`.
4. `bun run predeploy fetch <name>`, commit the new `artifacts/<name>/` files.
5. Write `test/<name>.test.ts`, then `run` and `verify` against the devnet.

## Notes

- The deployer key is published on purpose and owns every deployed contract. Never use it on a
  real network.
- Address rewriting only touches whole 32-byte words in constructor arguments. Contracts that
  embed mainnet addresses in their bytecode need a dedicated step; the engine does not patch code.
- `verify` compares each contract's runtime code hash with mainnet's and reports it as
  information. A difference is expected for contracts with immutables.
