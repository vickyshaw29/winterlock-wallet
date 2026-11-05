# Devnet traffic playground

Sends about 60 frame transactions of many shapes to the devnet's gateway and miner: ordinary ones,
ones that fail in every way the admission rules and the execution can fail, ones that stall, and
duplicates. It exists to give the explorer something to show and to exercise the admission rules
end to end. It is not a test suite: it prints what each node answered and does not assert.

## Run it

```sh
bun install && bun run build          # the tool imports the built executor package
bun deploy/devnet/playground/play.ts setup
bun deploy/devnet/playground/play.ts play
```

`setup` (safe to repeat) funds 31 throwaway keys with 0.1 ETH each from the shared devnet account
and deploys 18 tiny hand-assembled contracts, one per failure it wants to provoke. It writes the
contract addresses to `./.playground-state.json` (git-ignored; set `PLAYGROUND_STATE` to keep it
elsewhere). `play` then sends the scenarios and, after 50 seconds, prints each accepted
transaction's status as the miner and the gateway see it.

| Option | Meaning |
| --- | --- |
| `--only <text>` | Run only the scenarios whose name contains the text (case-insensitive) |
| `--pause <ms>` | Wait this long between sends (default 400), so you can watch the explorer |
| `--keys-from <n>` | Rotate the funded keys `s1`..`s30` by `n` (wrapping), so a rerun uses keys with nothing in flight |

| Environment variable | Default |
| --- | --- |
| `PLAYGROUND_GATEWAY` | `https://altmempoolgateway.forshtat.com/rpc` |
| `PLAYGROUND_MINER` | `https://altmempool.forshtat.com/rpc` |
| `PLAYGROUND_ETHREX` | `https://altmempool.forshtat.com` |
| `PLAYGROUND_CHAIN_ID` | `1337` |
| `PLAYGROUND_FUNDER_KEY` | the shared devnet key from `devnet-readme.md` |

The funder key is the devnet's throwaway genesis key, public on purpose. Never point this tool at a
real network, and never use that key for anything else.

## What it sends

Every sender can have only one transaction in flight (the node accepts only a sender's current
on-chain nonce), so each scenario that must coexist with others uses its own funded key.

| Group | Scenarios |
| --- | --- |
| Accepted, ordinary | EOA transfer to the gateway and to the miner; three transfers; an atomic batch plus a tail frame; 20 KB of calldata; 40 frames; a contract wallet paying for itself; paymaster-sponsored, with one and three sender frames |
| Accepted, execution fails | a sender frame that reverts; one that runs out of gas; an atomic batch with a reverting frame; a call to the approving wallet; a value above the balance. These land on chain as `Reverted` |
| Stalling | a fee below the base fee; just above it; a very large fee |
| Replacement and duplicates | one key sending the same nonce with a higher, a barely higher and a lower fee; the same transaction sent to the gateway, the miner and the gateway again |
| Burst | six senders at once, alternating between the nodes |
| Rejected: prefix and structure | no verification frame; verification targeting a stranger; the atomic flag on a verification or last frame; a verification frame after the prefix; 65 frames; no frames; another chain id; verification gas above the cap; an unknown frame mode; no signature entry |
| Rejected: signature and simulation | signed by the wrong key; no funds; nonce already used; nonce in the future; validation out of gas, looping, never approving, or reverting |
| Rejected: ERC-7562 | the banned opcodes TIMESTAMP, NUMBER, COINBASE, ORIGIN and GASPRICE; reading another contract's storage; a call with value; touching the code of an empty address |

## What to expect

On a node with the fixes from `docs/superpowers/plans/2026-09-25-devnet-findings-fixes.md`:

- the wrong-chain-id transaction is rejected: "frame transaction chain id 9 does not match this
  node's chain id 1337";
- the fee errors answer with ethrex's own text (for example "Insufficient max fee per gas") as a
  JSON-RPC error, not a bare HTTP 500;
- a resent transaction is "Frame transaction already known";
- a cancelled transaction shows why, and the gateway's pool follows the miner's inclusions;
- a payer without funds is told its balance and the transaction's maximum cost;
- a malformed frame names the field ("frames.0.mode: …").

A value call inside a validation frame is not stopped by the OP-061 rule: validation frames are
read-only, so the call reverts first and the rejection is "validation prefix frame reverted".
