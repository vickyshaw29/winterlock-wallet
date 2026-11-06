# Parallel lanes on the alt mempool

Part of the [Winterlock README](../README.md). The mempool rules side by side, what lanes share, order and timing, the tooling, and what each refusal means.


A lane is one nonce key with a transaction pending. To have N payments from one account in the mempool at once, give
each its own key. Every Winterlock transaction already is a fresh key at sequence 0.

## The rules, side by side

`SC` is `vendor/mempool-workshop-sidecar/packages/executor/src`, the workshop sidecar vendored on Nov 5 at commit
`2e22ff0a`. The devnet's sidecar reports `skandha/v4.1.1` and the vendored packages say 4.0.2, so the devnet may run a
later build. `ERC` is the ERC-8421 draft, `ERCS/erc-8421.md` in ethereum/ERCs PR #2028, read on Nov 6. `ETHREX` is
`docs/eip-8250.md` at ethrex commit `9aa3645d`, the devnet node's commit.

| Rule | Devnet sidecar, the alt mempool that runs | ERC-8421 draft, not on the devnet | Public pool |
| --- | --- | --- | --- |
| Pending per (sender, key) | 1. A transaction sharing a key with a pending one in another slot is refused (`SC/services/MempoolService/service.ts:374-407`) | 4, with contiguous sequences (`ERC` L42) | EIP-8141: 1 per sender (mempool rule 7). ethrex's pool: 1 holder per key (`ETHREX` L56-62) |
| Pending per sender | No cap for keyed transactions the sender pays for itself. Linear `[0]` transactions stay capped (`SC/services/MempoolService/constants.ts:1`; `reputation.ts:33-47`). A third-party payer stays capped (`reputation.ts:87-95,130-143`) | 64 for an unstaked sender (`ERC` L43) | 1 for this account, measured. ethrex admits several keyed ones only if the prefix reads none of the sender's storage (`ETHREX` L76-96; ethrex `mempool.rs:173-186`). Ours reads its own slots |
| Stake | Not needed for these lanes (`reputation.ts:138-143`). A throttled entity is capped at 4, keyed included (`reputation.ts:114-129`) | Staked senders have no sender-wide cap (`ERC` L278) | none |
| Verify budget | A flat 100,000 over the whole prefix plus signature costs (Day-0 probe) | 100,000 per unstaked entity, 1,000,000 staked (`ERC` L38-39, BUDGET-010 at L171-173). An earlier revision, read Nov 1, said 250,000 and 2,500,000 | 100,000 (EIP-8141 `MAX_VERIFY_GAS`) |
| Money | Everything pending, max cost plus value, must fit the balance; when it no longer fits, New entries are cancelled newest first (`SC/services/MempoolService/obligations.ts:5-33`; `service.ts:409-478`) | reserved per payer | reserved per paymaster (EIP-8141, `reserved_pending_cost`) |
| Relay | At most 4 New entries per 10 s pass, by tip, then in admission order (`SC/config.ts:628,635`; `SC/entities/FrameTxMempoolEntry.ts:213-216`) | n/a | n/a |
| Replacement | Same slot with +10 % on both fees, or with no bump once 300 s have passed (`FrameTxMempoolEntry.ts:175-202`; `SC/config.ts:620`). We never replace | | one per sender, by fee bump |

## What the lanes share

- **Money.** Every pending lane's maximum cost plus value must fit the balance: the screens' "set aside for pending"
  line.
- **Relay throughput.** At most 4 lanes per 10 s pass, chosen across all senders, highest priority fee first.
- **The throttle.** About 110 admissions without inclusions throttle the account to 4 pending
  (`SC/entities/ReputationEntry.ts:35-69`, with `minInclusionDenominator` 10 and `throttlingSlack` 10 at
  `SC/config.ts:601-602`).
- **One journal writer.** One process owns a journal through a kernel file lock (`pipeline/src/leaves.ts`). Fire a
  burst through the backend, or from a script with the backend stopped.
- **A finite band.** 16 hot tickets; cold leaves 1 to 1007 at epoch 0. Leaf 0 cannot sign at epoch 0, because its key
  would be the legacy key 0 (`Account.yul:57`).

## Order and timing

- Eight lanes need at least two relay passes, so they land over two or more blocks.
- Our grinder never changes the priority fee, so our lanes are relayed in the order they were admitted; only lanes
  within one pass can swap.
- A landed transfer changes nothing the other lanes read. A landed `rotate` or `setHotPolicy` can cancel them: every
  New lane is re-simulated each block (`SC/services/BundlingService/reconciliation.ts:423-477`).
- Three devnet facts decide whether lanes land, all found on Nov 6 ([evidence](devnet-evidence.md#parallel-lanes-and-the-stuck-payment)):
  the public gateway admitted but had no peers to relay to, so send through the miner's sidecar; the sidecar relays the
  highest priority fee first, so the pipeline raises every fee quote to a floor of 3 gwei (`withTipFloor` in
  `pipeline/src/rpc.ts`, `MIN_TIP_WEI` in `pipeline/src/config.ts`); and ethrex drops a relayed lane when a
  public-mempool transaction rebuilds the block, so bursts take a 180 s deadline (`demo/lanes.ts --expiry-seconds`).

## The tooling

- `pipeline/src/lanes.ts`: `laneMaxCostWei` (what the sidecar sets aside for one lane), `planLanes` (whether the
  balance carries N lanes, how many passes, an estimated time), `relayConfig` (the sidecar's relay settings, or its
  defaults flagged as assumed) and `explainRefusal`.
- The backend's `GET /api/wallets/:address/lanes/plan` reserves no leaf and signs nothing. Every transaction record
  carries `maxCostWei` and `wire`, the exact JSON sent.
- `demo/lanes.ts plan` and `burst` drive the backend. `burst` plans first, sends N payments at once, follows every lane
  to its end, then prints the status timelines, the most lanes seen pending at once, each admission report and the
  exact JSON each lane sent (`demo/README.md`).

What a refusal means:

| Message contains | Meaning | Source |
| --- | --- | --- |
| `is already held by pending transaction` | The key is busy in another slot | `SC/services/MempoolService/service.ts:399-404` |
| `cannot be replaced: fee too low` | A second transaction in the same slot: a signer bug. Never bump | `service.ts:509-512` |
| `already known` | The same bytes again: follow the first | `service.ts:492-501` |
| `cannot cover its pending frame transactions` | Over the money set aside | `service.ts:409-437` |
| `Nonce mismatch: expected X, got Y` | X > Y: the key is already used. X < Y: the sequence is ahead | Day-0 probe |
| `exceeds MAX_VERIFY_GAS` | Prefix over 100,000 | Day-0 probe |
| `validation frame N: reverted with data 0x…` | The account refused it: decode the 32-byte reason, such as `hot: value cap` | `SC/services/UserOpValidation/validators/frameTx.ts:226-228`; `Account.yul:240` |
| `revalidation failed as of block` or `relayed N times without being included` | Dropped: read the chain before anything else | `SC/services/BundlingService/reconciliation.ts:456`, `BundlingService/service.ts:340` |
| `A pending frame transaction from this sender is already in the pool` | Public pool: one per sender | ethrex `error.rs:165` |
