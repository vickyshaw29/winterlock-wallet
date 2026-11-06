<!--
NOTES FOR VICKY (delete this block before the text goes into README.md)

Drafted Fri Nov 6, about 12:00 IST, with Claude Code; fact-checked about 12:20 IST against git, the code, the vendored
sidecar, the measurement output and the fetched EIP/ERC/prize-page copies. Local file only; nothing in the repo was
changed.

1. Search for "Vicky to confirm": each one is a fact the draft could not settle from git, the code or the notes.
2. The spec and plan live in .claude/ and are never committed, so a judge cannot open them. The README therefore
   cites code lines, transaction hashes, the vendored sidecar and its own Day-0 table (section 6.3) instead.
3. Name clash: the spec's prior art lists "Winterlock (Safe forum proposal, 2026-10-09)", a different project with
   the same name. A judge may think we are that proposal. Keep the name with a clear note (section 8 has one), or
   rename. Vicky to confirm.
4. ERC-8421 budget numbers: the spec (read Nov 1) says 250,000 per unstaked entity and 2,500,000 staked. The draft
   text read on Nov 6 (ethereum/ERCs PR #2028, erc-8421.md L38-39 and BUDGET-010 at L171-173) says 100,000 and
   1,000,000. AGENTS.md says ask: the draft prints both and marks it. Vicky to confirm which to keep.
5. CROPS P: the screens load Inter and JetBrains Mono from Google Fonts (web/serve.ts CSP allows
   fonts.googleapis.com and fonts.gstatic.com). No analytics, but it is a third-party request. Self-host the
   fonts, or say so in the README (section 9 says so for now).
6. At 12:15 IST, pipeline/src/lanes.ts and pipeline/test/lanes.test.ts exist in the backend worktree (uncommitted,
   still changing); demo/lanes.ts does not exist yet. Section 4.5 describes them from .claude/briefs/lanes-design.md
   and the current lanes.ts. Check the flags against the final code.
7. fakechain/ is on main now: commit 2205489 (11:58 IST), merged as PR #7 (ef9b102, 12:08 IST). backend/, web/,
   pipeline/src/tickets.ts, the lanes tooling and the send-path changes are still uncommitted in the worktree
   /Users/vicky/Documents/winterlock-backend, branch feat/backend, which starts at dac0256 (before PRs #5 to #7). The
   paths below assume they land on main as they are now.
8. The explorer keeps its history in memory and reads the gateway. Open every link in section 6 before submitting.
9. Re-run every test suite before submitting and update the counts in section 10.
10. Two numbers here differ from comments in the code: hot messages fit 1 in 231 (exact count over the digit
   distribution), where pipeline/src/config.ts:71, pipeline/src/grind.ts:59 and commit 5b24bd8 say 1 in 227; and an
   unground estimate fails about 1 in 65, where the handoff said 1 in 60. The README uses the exact figures.
-->

# Winterlock

A post-quantum smart account for EIP-8141 frame transactions. Each one-time WOTS+ key is named by an EIP-8250 nonce
key, so the protocol, not the account, records which keys are used.

Built at ETHGlobal Mumbai 2026 (event start Thu Nov 5, 21:00 IST) for the Ethereum Foundation prize "Best use of the
Frame Transaction Alternative Mempool".

## 1. The claim

To our knowledge this is the first hash-based-signature account implemented on frame transactions whose
one-time-key index is the protocol's own nonce key, consumed atomically by payment approval, with no account storage
write per signature.

What we do **not** claim:

- **The idea of nonce-indexed one-time keys.** QRL's wallets used the transaction nonce to pick the next XMSS key
  (with on-chain usage tracking). EIP-8310 defines leaf = f(slot) for validator keys. The Winterlock proposal on the
  Safe forum (2026-10-09) proposes an EIP-1271 WOTS owner with one key per Safe nonce.
- **The first hash-based account on Ethereum.** That is Quip (ERC-4337, mainnet 2026-09-17).
- **The first hash-based account on frame transactions.** That is NiceTry's FORS+C FrameAccount, with an enforced
  rotation frame.

Why frame transactions force this design. The verify frame runs as a static call, so it cannot write "this key is
used". A write in a later SENDER frame comes after approval, when two pending transactions in two lanes could both
have passed against the same key. The one state change the protocol makes atomically with payment approval is the
nonce consumption. So we make that the key-consumption event.

Why the alt mempool. Our verify frame fits the 100,000-gas cap (section 5). What needs the alt mempool is many
hash-signed payments from one account pending at once, each on its own nonce key: parallel lanes (section 4). The
public mempool holds one pending frame transaction per sender (EIP-8141, mempool rule 7).

## 2. How it works, in easy words

Think of a cheque book.

- **The cheque book is a key tree.** It holds 1,024 one-time keys per chain (height h = 10). Each key is a WOTS+ key,
  a hash-based signature that is safe against quantum computers but may sign only once.
- **Each cheque has a printed number: the leaf.** A payment signed with leaf 5 carries nonce key 5 at sequence 0
  (`account/yul/Account.yul:54-61`). The key is `(epoch << 32) | leaf`.
- **The bank stamps the number when it pays.** EIP-8250 records the nonce key as used at payment approval, in the
  same step. A second payment on the same key is refused by the protocol: "Nonce mismatch: expected 1, got 0" (Day-0
  probe, section 6.3).
- **So the account keeps no list of used cheques.** No bitmap, no counter, no storage write in the verify frame:
  `verifyFrame` and `hotPolicy` (`Account.yul:46-116`) contain no `sstore`.
- **The wallet still keeps a journal.** The chain only learns of a cheque when the payment lands. Until then, only
  the wallet can stop itself from signing a second, different payment with the same cheque. The mempool would even
  accept that second payment as a replacement, with a 10 % fee bump
  (`vendor/mempool-workshop-sidecar/packages/executor/src/entities/FrameTxMempoolEntry.ts:175-202`). Two signatures
  from one WOTS+ key let an attacker forge a third. So the journal (`pipeline/src/leaves.ts`) writes "reserved" to
  disk before anything is signed, and never moves a leaf backwards.
- **A stuck payment expires; it is never bumped.** Every transaction starts with an expiry frame: a deadline the
  chain checks (90 s by default, `pipeline/src/config.ts:37`, `DEFAULTS.expirySeconds`). If a block past the deadline,
  read two blocks below the head, still shows the key unused, the payment can never land
  (`pipeline/src/submit.ts`, `waitForInclusion`). The wallet marks that cheque burned and pays
  again with the next cheque, on a new nonce key: a new lane. It never re-signs with a higher fee, because that would
  sign the same cheque twice.
- **Many cheques can be in flight at once.** Every payment has its own key, and the devnet's alt mempool holds one
  pending transaction per key with no per-account cap (section 4).

## 3. Design

### 3.1 Keyed only

Every hash-signed transaction carries exactly one nonce key at sequence 0. The verify frame refuses anything else:
the key count (`Account.yul:55`), the legacy key 0 (`:57`), a non-zero sequence (`:58`), another epoch (`:59`), a
leaf outside the tree (`:61`).

There is no sequential mode. An expired transaction leaves a sequential nonce unchanged, so the retry would re-sign
the same leaf. A fresh key at sequence 0 can be burned instead.

Accounts are created by an EOA calling the factory (`account/src/Factory.sol`, `createAccount`). A deploy frame would
need about 546,000 state gas, above the devnet's 500,000 state cap, and would use the legacy nonce `[0]`, which the
verify frame refuses. Creating an account from the EOA measured 953,678 gas, with six storage slots written.

### 3.2 The verify frame, step by step

The account is a 45-byte EIP-1167 proxy to one implementation, a standalone Yul object
(`account/yul/Account.yul`). The EIP-8141 opcodes are emitted with `verbatim` (`Account.yul:37-41`); their operand
orders come from the ethrex source at the devnet's commit and were confirmed on chain (section 6.3).
`account/scripts/build.sh` splices the verifier `account/yul/hashsig/HashSigVerify.yul` in at `Account.yul:118` and
compiles with solc 0.8.38 `--strict-assembly --optimize`.

| Step | What it checks | Lines |
| --- | --- | --- |
| 1. Dispatch | Caller 0xaa (the frame entry point) runs the verify path; the account itself runs admin calls; anyone else gets views, `initialize` (once, called by the factory) or a plain ETH receipt | `Account.yul:27-33` |
| 2. Storage | Three cold SLOADs: root, tree seed, packed config. A hot leaf reads three more (slots 3 to 5) | `:47-52`, `:99-102` |
| 3. Nonce mode | One key, not key 0, sequence 0, epoch matches, leaf below 2^h. Hot when leaf ≥ hotStart | `:54-62` |
| 4. Signature shape | Entry count; with hybrid on, an owner ECDSA entry over the canonical hash; then the ARBITRARY entry: scheme, empty msg, length 2,146 + 32 × (h + 4), copied with SIGDATACOPY, version 1, slot ≤ 15 | `:64-82` |
| 5 to 8. Hash-based check | WOTS+ over the sig hash (TXPARAM 0x08), then the Merkle path to the stored root, with CHAINID hashed into the leaf | `:84-88`; `HashSigVerify.yul:15-30` |
| 9. Hot policy | Only for hot leaves (section 3.3) | `:90-91`, `:98-116` |
| 10. Approve | APPROVE with scope 0x3 (execution and payment); this is where the protocol consumes the nonce key | `:93-95` |

Inside the hash-based check (`account/yul/hashsig/HashSigVerify.yul`):

- index = (slot << h) | leaf (`:23`); per-leaf public seed P = keccak256(treeSeed ‖ uint32(index)) (`:32-36`).
- 15 randomization elements r_1 to r_15 = keccak256(0x03 ‖ P ‖ uint16(k)), as Quip's `WOTSPlus.sol` (`:39-46`).
- 64 message digits plus 3 checksum digits; each chain runs 15 − digit steps of keccak256(x XOR r) (`:50-68`). The
  step loop is unrolled by bits of the step count (`:74-102`): this is where the gas goes.
- leaf node = keccak256(P ‖ uint256(chainId) ‖ pkHash) (`:104-109`); h + 4 path hashes up to the root (`:111-120`).

Every refusal reverts with a 32-byte ASCII reason (`Account.yul:240`), for example `nonce: epoch` or `hot: value
cap`. The node's simulation returns it as `revertData`, so a refused transaction names the rule it broke.

What the verify frame reads, and why each read is allowed in a static frame: its own storage, TXPARAM, FRAMEPARAM,
SIGPARAM, SIGDATACOPY, CHAINID and memory. The verify path uses no TIMESTAMP, NUMBER, BALANCE, GAS or SSTORE, and
makes no CALL. The compiled implementation contains no ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT (Day-0
disassembly, section 6.3). The proxy's GAS right before its DELEGATECALL passed the devnet's tracer (Day-0).

The signature entry is 2,594 bytes at h = 10: version (1) ‖ chain slot (1) ‖ WOTS+ signature (67 × 32 = 2,144) ‖
path (14 × 32 = 448). It travels in the transaction's own signature list as scheme ARBITRARY, which costs 100 gas
toward the prefix cap (Day-0). The leaf index is not in the entry: it comes from the nonce key.

### 3.3 Hot tickets

The top of each chain's tree is the hot band, leaves hotStart to 2^h − 1. In the demo h = 10 and hotStart = 1008, so
there are 16 tickets (account 2, section 6.2). The cold device exports a range of hot leaves to a ticket file:
leaf secrets and paths, no seed (`signer export-leaves`, file mode 0600). The hot device signs from it
(`signer sign --ticket-file`) and keeps its own journal (`pipeline/src/tickets.ts`). The cold journal marks the range
exported before the file is written, so a ticket is never handed out twice.

The account, not the app, enforces the caps (`Account.yul:98-116`):

- the value cap must be above zero: zero is the kill switch (`:100`);
- the transaction's maximum cost (TXPARAM 0x06) must be at most the fee cap (`:101`);
- every later frame must be a SENDER frame, with no calldata, to the one allowed target (`:107-110`);
- the sum of their values must be at most the value cap (`:111-115`).

Hot tickets carry no ECDSA entry (`:66`). A stolen hot device can spend at most its unused tickets times (value cap +
fee cap), to one address. `setHotPolicy` may keep or lower hotStart, never raise it (`:167`): raising it would turn
exported tickets into cold leaves, which have no caps.

### 3.4 Hybrid co-signature: off

The account can require an owner ECDSA signature beside the hash-based one (`Account.yul:66-72`): scheme SECP256K1,
empty msg (so it signs the canonical hash, not any digest), signer equal to the stored owner. It is off for the demo
(`hybridRequired = 0`), and the backend refuses to create a hybrid wallet. Turning it on costs 2,800 gas of signature
cost (EIP-8141) and 85 more billed bytes (20-byte signer and 65-byte signature), which is 5,440 gas at the calldata
floor (computed, section 5).

### 3.5 Chain slots

One tree holds 16 chain slots of 2^h leaves. The same account address on two chains has two separate nonces, so
without slots nonce 5 on two chains would sign two messages with one key. The chain id is hashed into every leaf
from CHAINID (`Account.yul:86`, `HashSigVerify.yul:104-109`), so a leaf built for one chain never verifies on another.
The slot byte only says where that chain's subtree sits (`HashSigVerify.yul:21-23`). Unlisted slots hold
EMPTY_SUBTREE = keccak256("nonce-bound-pq-wallet/empty-slot") (`pipeline/src/hashsig/tree.ts:11`). The demo lists one
chain, 1337, in slot 0.

### 3.6 Rotation and admin calls

Admin calls are SENDER frames from the account to itself (`Account.yul:121-129`), signed by a cold leaf.

- `rotate(root, treeSeed, height)` installs a new tree and adds 1 to the epoch (`:133-147`). The new tree is built
  for generation = new epoch, so it shares no one-time key with the old one. It refuses the installed tree (`:139`).
  Rotation invalidates every pending lane: their keys name the old epoch (`:59`). The backend refuses to rotate while
  lanes are in flight.
- `setHotPolicy(hotStart, valueCap, feeCap, target)` (`:162-174`) and the guard that always leaves a cold leaf
  (`:236-238`).
- `setHybrid(bool)` refuses to turn on with no owner (`:153`); `setOwner(address)` refuses 0 while hybrid is on
  (`:180`).

## 4. Parallel lanes on the alt mempool

### 4.1 What a lane is

A lane is one nonce key with a transaction pending. To have N payments from one account in the mempool at once, give
each one its own key. Our account already does: every transaction is a fresh key at sequence 0.

### 4.2 The rules, side by side

`SC` below is `vendor/mempool-workshop-sidecar/packages/executor/src`, the workshop sidecar as vendored on Nov 5
(commit `2e22ff0a`). The devnet's sidecar reports `skandha/v4.1.1` and the vendored packages say 4.0.2, so the devnet
may run a later build of it (Vicky to confirm). `ERC` is the ERC-8421 draft, `ERCS/erc-8421.md` in ethereum/ERCs
PR #2028, read Nov 6. `ETHREX` is `docs/eip-8250.md` at ethrex commit `9aa3645d`, the devnet node's commit.

| Rule | Devnet sidecar (the alt mempool that runs) | ERC-8421 draft (not on the devnet) | Public pool |
| --- | --- | --- | --- |
| Pending per (sender, key) | 1. A transaction sharing a key with a pending one in another slot is refused (`SC/services/MempoolService/service.ts:374-407`) | 4, with contiguous sequences (`ERC` L42) | EIP text: 1 per sender (EIP-8141 mempool rule 7). ethrex's pool: 1 holder per key (`ETHREX` L56-62) |
| Pending per sender | No cap for keyed transactions the sender pays for itself. Linear `[0]` transactions stay capped: 4 in the sender bucket (`SC/services/MempoolService/constants.ts:1`), 10 or more for a self-paying one, which is counted as its own payer (`SC/services/MempoolService/reputation.ts:33-47`; `SC/services/ReputationService.ts:203-218`). We send none. A third-party payer stays capped (`reputation.ts:87-95,130-143`) | 64 for an unstaked sender (`ERC` L43) | EIP text: 1. ethrex admits several keyed ones only if four conditions hold, one being that the prefix read none of the sender's storage (`ETHREX` L76-96). Our verify frame reads its own storage, so our account should get 1. From source only, not yet probed |
| Stake | Not needed for these lanes (`reputation.ts:138-143`). A throttled entity is capped at 4, keyed included (`reputation.ts:114-129`; `constants.ts:2`) | Staked senders have no sender-wide cap (`ERC` L278) | none |
| Verify budget | Flat 100,000 over the whole prefix plus signature costs (Day-0 probe) | 100,000 per unstaked entity, 1,000,000 staked (`ERC` L38-39, BUDGET-010 at L171-173). The spec read 250,000 and 2,500,000 on Nov 1. Vicky to confirm | 100,000 (EIP-8141 `MAX_VERIFY_GAS`) |
| Money | Everything pending, max cost plus value, must fit the balance; when it no longer fits, New entries are cancelled newest first (`SC/services/MempoolService/obligations.ts:5-33`; `service.ts:409-478`) | reserved per payer | reserved per paymaster (EIP-8141, `reserved_pending_cost`) |
| Relay | At most 4 New entries per 10 s pass, by tip, then admission order (`SC/config.ts:628,635`; `SC/entities/FrameTxMempoolEntry.ts:213-216`) | n/a | n/a |
| Replacement | Same slot with +10 % on both fees, or with no bump once 300 s have passed (`SC/entities/FrameTxMempoolEntry.ts:175-202`; `SC/config.ts:620`). We never replace | | one per sender, by fee bump |

### 4.3 What the lanes share

- **Money.** The sum of every pending lane's maximum cost plus value must fit the balance. This is the screens' "set
  aside for pending" line.
- **Relay throughput.** At most 4 lanes per 10 s pass, chosen across all senders.
- **The throttle.** About 110 admissions without inclusions throttle the account to 4 pending
  (`SC/entities/ReputationEntry.ts:35-69`, with `minInclusionDenominator` 10 and `throttlingSlack` 10 at
  `SC/config.ts:601-602`).
- **One journal writer.** One process owns a journal (a kernel file lock, `pipeline/src/leaves.ts`). Fire a burst
  through the backend, or from a script with the backend stopped.
- **A finite band.** 16 hot tickets in the demo; cold leaves 1 to 1007 at epoch 0 (leaf 0 cannot sign at epoch 0: its
  key would be the legacy key 0, which the verify frame refuses, `Account.yul:57`).

### 4.4 Order and timing

- Eight lanes need at least two relay passes, so they land over two or more blocks.
- The sidecar relays by `maxPriorityFeePerGas`, highest first, and equal ones in admission order
  (`SC/entities/FrameTxMempoolEntry.ts:213-216`). Our grinder never changes the priority fee, so our lanes are relayed
  in the order they were admitted; only lanes within one pass can swap.
- One transaction took about 28 s from New to OnChain on Nov 5 (Day-0). By estimate, 8 lanes take about 38 s
  (28 s + one more 10 s pass) and 16 lanes about 58 s. These are estimates, not measurements.
- A landed transfer changes nothing the other lanes read. A landed `rotate` or `setHotPolicy` can cancel them: every
  New lane is re-simulated each block (`SC/services/BundlingService/reconciliation.ts:423-477`).

### 4.5 The tooling (being built, Vicky to confirm)

- `pipeline/src/lanes.ts`: `laneMaxCostWei` (what the sidecar sets aside for one lane), `planLanes` (can the balance
  carry N lanes, how many passes, an ETA), `relayConfig` (the relay settings from `skandha_config` and
  `skandha_explorer_info`, else the defaults 4 and 10 s, flagged as assumed) and `explainRefusal` (below).
- Backend: `GET /api/wallets/:address/lanes/plan?n=8&mode=keyed&valueWei=…&to=…` returns
  `{affordable, setAsideWei, shortfallWei, passes, etaSeconds, warnings}`. It reserves no leaf and signs nothing.
  Every transaction record also carries `maxCostWei` and `wire`, the exact JSON sent.
- CLI, talking to the backend (`WL_BACKEND_URL`, default `http://127.0.0.1:8787`):

  ```sh
  bun demo/lanes.ts plan  --wallet <address> --n 8 [--mode keyed|hot] [--value-wei W] [--to A]
  bun demo/lanes.ts burst --wallet <address> --n 8 [--mempool alt|public] [--force] [--json-out DIR]
  ```

  `burst` plans first, sends N payments at once, prints each lane as it is answered, follows every lane to its end,
  and prints the most lanes seen pending at once and the exact JSON each lane sent.

What a refusal means:

| Message contains | Meaning | Source |
| --- | --- | --- |
| `is already held by pending transaction` | The key is busy in another slot | `SC/services/MempoolService/service.ts:399-404` |
| `cannot be replaced: fee too low` | A second transaction in the same slot: a signer bug. Never bump | `service.ts:509-512` |
| `already known` | The same bytes again: follow the first | `service.ts:492-501` |
| `cannot cover its pending frame transactions` | Over the money set aside | `service.ts:409-437` |
| `Nonce mismatch: expected X, got Y` | X > Y: the key is already used. X < Y: the sequence is ahead | Day-0 probe |
| `exceeds MAX_VERIFY_GAS` | Prefix over 100,000 | Day-0 probe |
| `validation frame N: reverted with data 0x…` | The account refused it: decode the 32-byte reason, for example `hot: value cap` | `SC/services/UserOpValidation/validators/frameTx.ts:226-228`; `Account.yul:240` |
| `revalidation failed as of block` or `relayed N times without being included` | Dropped: check the chain before anything else | `SC/services/BundlingService/reconciliation.ts:456`, `BundlingService/service.ts:340` |
| `A pending frame transaction from this sender is already in the pool` | Public pool: one per sender | ethrex `error.rs:165` |

## 5. Gas

### 5.1 The four columns

| Profile | Declared verify limit | Measured verify execution | Intrinsic, signature bytes and floor | Receipt gas_used |
| --- | --- | --- | --- | --- |
| Cold transfer, account 2, h = 10, leaves 1 to 8 (simulated) | 94,900 in the measurement, so every point could run; 90,000 in normal sends | 82,390 to 92,326 at 420 to 570 chain steps; fit 54,630 + 66.09 × steps | fixed part 19,525; data about 41,500; intrinsic about 61,000; floor 166,720 (2,605 billed bytes × 64) | 186,245 for all 8, from simulation (nothing was sent, so no receipt) |
| Cold transfer, account 1, older verifier: the qualification transaction, block 407,107 | 94,900 | 89,006 at 420 chain steps | the same as above (leaf 3) | 186,245 |
| **Cold transfer, account 3, the qualification transaction on the reset chain, block 386** | 90,000 | **88,373 at 510 chain steps** (the new grind limit, behind the proxy) | as above (leaf 1) | **186,245** (receipt) |
| **Hot ticket, account 3, leaf 1008, block 441** | 90,000 | **87,947 at 405 chain steps** (ground over 284 fee values) | floor 166,848 (2,607 billed bytes) | **186,373** (receipt) |
| Day-0 stub, no hashing, with owner ECDSA, block 405,523 | not recorded | 20,317 | | 193,882 |

How the columns are computed (`pipeline/src/estimate.ts`, `frameGasModel`, from ethrex's `transaction.rs` at
`9aa3645d`):

- fixed part = 12,000 + 475 per frame + 100 for the ARBITRARY entry + 6,000 per value-carrying frame
  = 12,000 + 3 × 475 + 100 + 6,000 = 19,525;
- billed bytes = frame data (8-byte deadline) + signature bytes (2,594) + the RLP of the nonce fields (3 bytes for
  keys 1 to 127) = 2,605;
- data = 4 gas per zero byte and 16 per other byte, about 41,500 here; floor = 64 per billed byte = 166,720;
- gas used = fixed part + max(data + execution, floor) = 19,525 + 166,720 = **186,245**. This matches the receipt and
  all 8 simulations exactly.

The nonce key's RLP grows with the leaf, and each extra byte adds 64 gas at the floor: leaves 1 to 127 cost 186,245,
leaves 128 to 255 cost 186,309, leaves 256 to 1023 cost 186,373, and any leaf from epoch 1 costs 186,565 (computed).
The gas limit charged up front for one lane is about 206,000 (intrinsic + 5,000 + 90,000 + 50,000 declared,
computed).

Per height (computed for leaves 1 to 127, not measured on the devnet): h = 12 has a 2,658-byte entry and costs
190,341; h = 20 has a 2,914-byte entry and costs 206,725. The verifier costs about 196 gas more per extra level: 190
per level for `hashsig_verify` at heights 4, 10 and 12, measured for two messages on a local anvil EVM (a scratch
script outside the repo, Nov 6; `account/test/HashSigVectors.t.sol` measures h = 10 only), plus about 6 for the longer
SIGDATACOPY (computed). Vicky to confirm, or commit the measurement script.

### 5.2 The 8 measured points

`pipeline/scripts/simulate-verify-gas.ts`, Nov 6, on account 2 (`0x4565906974d62abf53ad28165ef0ec43a1e39f57`), at the
halted head 408,262. Each point is signed by one fresh cold leaf, journaled before it signs and burned after. Nothing
was sent.

| Leaf | Chain steps | Verify frame gas | Frames (expiry / verify / transfer) | Whole transaction |
| --- | --- | --- | --- | --- |
| 1 | 420 | 82,390 | 3,051 / 82,390 / 100 | 186,245 |
| 2 | 450 | 84,525 | 3,051 / 84,525 / 100 | 186,245 |
| 3 | 480 | 86,280 | 3,051 / 86,280 / 100 | 186,245 |
| 4 | 495 | 87,094 | 3,051 / 87,094 / 100 | 186,245 |
| 5 | 510 | 88,429 | 3,051 / 88,429 / 100 | 186,245 |
| 6 | 525 | 89,356 | 3,051 / 89,356 / 100 | 186,245 |
| 7 | 555 | 91,344 | 3,051 / 91,344 / 100 | 186,245 |
| 8 | 570 | 92,326 | 3,051 / 92,326 / 100 | 186,245 |

Fit: verify frame = 54,630 + 66.09 × chain steps, largest residual 252 gas.

Measured again from real receipts on the reset chain (Nov 6, account 3, `scripts/hashsig-devnet.ts`): 54,928 + 65.53 ×
chain steps over six included transfers (510 → 88,373; 510 → 88,376; 495 → 87,397; 510 → 88,310; 480 → 86,246;
465 → 85,475). The two fits agree within about 20 gas at the 510-step edge. Chain steps per message: 506 on average,
420 at the 1st percentile and 600 at the 99th; 45 at best and 990 at worst. Every reachable step count is a multiple
of 15. The standalone verifier measured on the devnet alone: 24,070 + 66.06 × steps
(`pipeline/scripts/measure-verifier.ts`, verifier `0xA6Ecb14e644631C0ae9178Ab3383a72Fc384ec61`).

### 5.3 Why the bill is flat

The 2,594-byte signature dominates. The floor (166,720) is larger than data plus execution whenever execution stays
under about 125,000 gas, and the prefix cap keeps it under 100,000. So every hash-signed transfer costs the same,
whatever its verify gas. Cheaper hashing would not lower the bill; a shorter signature would.

### 5.4 The proxy finding (EIP-150)

The account is an EIP-1167 proxy. Its DELEGATECALL passes on only 63/64 of the gas left (EIP-150), so a verify frame
declared at 90,000 can use about 88,643. Point 6 shows it: 525 steps need 89,356, which runs out of gas behind the
proxy. The grinder used to accept 525-step messages, about 14 % of all messages, and aimed hot tickets at 420 steps,
which also run out by the model (61,253 + 66.09 × 420 = 89,011). The hot extra is now measured on chain: leaf 1008 at
405 steps used 87,947, about 6,550 over the cold fit (the Day-0 estimate was 6,623). After the fix, three transfers on
the reset chain used exactly 510 steps and fit (88,310 to 88,376 against the 88,643 usable). Fixed on Nov 6 (commit `5b24bd8`, PR #6): `usableVerifyGas` in `pipeline/src/grind.ts` subtracts
the holdback, and `GRIND` in `pipeline/src/config.ts:63-76` comes from the measured fit plus a 300-gas margin. Cold
messages now fit up to 510 steps (66 % of messages); hot ones up to 409 steps (about 1 in 231, exact count over the
digit distribution).

### 5.5 Grinding

The signer changes the transaction until its message needs few enough chain steps, then signs once. It moves
`maxFeePerGas` by one wei per try, up to 4,096 tries, and leaves the deadline exact (commit `2a631c3`). When the
caller fixes the fee, the backend moves the last frame's execution limit by one gas per try instead. A preflight
simulation still refuses any message the model gets wrong.

### 5.6 The caps beside it

The declared prefix is 5,000 (expiry) + 90,000 (verify) + 100 (signature cost) = 95,100, under the 100,000 cap that
both the public mempool and the devnet sidecar enforce (Day-0: 120,000 refused, 95,000 admitted). Quip's 190,792 is
the call gas of a stateful wrapper with two storage writes, a different profile: compare verify with verify and total
with total.

## 6. Devnet evidence

The explorer keeps its history in memory and loses it on restart, so every link below also has its hash and block.

| What | Transaction | Block |
| --- | --- | --- |
| **Reset chain (genesis `0x2ad3f67b…`): first hash-signed transaction, the qualification milestone again.** Account 3 `0xf3e63d269dae09032ea950cd9722733e9b3f2d37` pays 1 wei with one WOTS+ signature of leaf 1 (nonce key `0x1`, sequence 0): 510 chain steps, verify frame 88,373 of 90,000 declared, 186,245 gas in all; admission "included: 17 of 17 rules passed" | [`0x3446d855…`](https://explorer.altmempool.wtf/tx/0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175) (`0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175`) | 386 |
| Reset chain: five more cold transfers, leaves 5 to 9, all 17/17 | `0x9deeb8ffde62b3e6b285016b05ce621b6b0d24712a5d7693bb81de9b8cb45875`, `0xb49df1f54481bd0d6286d327d0f5c3f693abd64c3aa2852941055eae9c730dc6`, `0xac82c9ca6c75ddc2ea999412e66de2c7b0d3a515d4f379bf945ecc5511f152f6`, `0xd09fb2e8cf248b55b03cd1001bcdc477e6cede489787eea762af36c4bafa46b2`, `0x9b00f09510837d152ee9ef8138c584de3f142908911cb96532cf861be837be7a` | 399 to 433 |
| Reset chain: **hot ticket**, leaf 1008 (key `0x3f0`), no classical key, 0.001 ETH to the one allowed target: 405 chain steps, verify 87,947, 186,373 gas in all, 17/17 | [`0x8d0aefb7…`](https://explorer.altmempool.wtf/tx/0x8d0aefb70282cad3212ce08e9df8f0d9d7228805787fdb56faaea49c162272ce) (`0x8d0aefb70282cad3212ce08e9df8f0d9d7228805787fdb56faaea49c162272ce`) | 441 |
| Reset chain: two forgeries refused in simulation by the account, `sig: hash-based check`: one signature byte flipped, and a valid signature of leaf A under leaf B's nonce key (the nonce-to-leaf binding) | (simulation only; leaves 2 to 4 burned) | – |
| Reset chain: pipeline check with plain ECDSA (local tooling, not in the repo): the test EOA calls `increment()` on a Counter in a frame transaction, nonce key `0x200000007`; 17/17, count 0 → 1, the event's caller is the EOA | [`0xd801fbfd…`](https://explorer.altmempool.wtf/tx/0xd801fbfd8f2bd2963b71df19091ec1a560dd3888099c6b46e96f59a4ad4313e5) (`0xd801fbfd8f2bd2963b71df19091ec1a560dd3888099c6b46e96f59a4ad4313e5`) | 366 |
| Chain before the reset (explorer link dead since): **First hash-signed transaction** (qualification milestone): account `0x9908548a8b28d85191dc04d27d1d3c6e1430439b` sends its ETH to `0x4565906974d62abf53ad28165ef0ec43a1e39f57`. One WOTS+ signature of leaf 3 (nonce key `0x3` at sequence 0) over sig hash `0x2d3d5bb269f9673bdf8de264dfebd8191ce3fc1ebcc9634ff8b39575ff64ee28`, verified on chain by the account's Yul verifier: 420 chain steps, verify frame 89,006 gas of 94,900 declared (this transaction, older verifier), 186,245 gas for the whole transaction; status success; admission report "included: 17 of 17 rules passed" | [`0x38b51a31…26475`](https://explorer.altmempool.wtf/tx/0x38b51a318a039225d17feaf6257b7f71c1ca66c81fb511d5b8a90ad3dad26475) (`0x38b51a318a039225d17feaf6257b7f71c1ca66c81fb511d5b8a90ad3dad26475`) | 407,107 |
| Pipeline smoke test (V2): built, signed and sent by `pipeline/`, keyed nonce `0x200000001` at sequence 0, leading expiry frame, test EOA with native ECDSA | [`0x31cc7937…2464af`](https://explorer.altmempool.wtf/tx/0x31cc7937cb5d7ba3f48e1f7e5b75ee6070ff34f8396a4685e87b866cee2464af) | 405,073 |

Devnet: chain 1337, node `altmempool.forshtat.com`, gateway `altmempoolgateway.forshtat.com/rpc`.

### 6.1 The chain halt

The devnet's last block is 408,262, at 2026-11-05 22:58:46 UTC (04:28 IST Nov 6). It was still the head at the last
check, about 08:35 IST (the head was 14,791 s old in the simulation run). The node, the miner's sidecar and the gateway
all answer that head, and `devnet1/2/3.altmempool.wtf` refuse TLS. Since 23:40 IST Nov 5 the gateway admits frame
transactions but never relays them; the miner's own sidecar, `altmempool.forshtat.com/rpc`, relayed (New, Submitted,
OnChain in about 28 s). The faucet was empty. The pipeline refuses to send while the head's timestamp is more than
60 s from the host clock, so no leaf was spent on a dead chain.

**The reset.** The devnet came back at about 11:54 IST Nov 6 as a new chain: chain id 1337, 6 s blocks and the same
ethrex build and system contracts, but a new genesis (`0x2ad3f67b059fbde111ad7af27cfb4955d997351579612237ca0318937a5bae7a`)
and block numbers from 0. Every contract and balance of ours was gone. The seeds of accounts 1 and 2 stay pinned to the
old genesis and refuse to sign, as designed. The gateway relays again (both sidecars have peers) and its faucet works.
Account 3 was deployed with a new seed (section 6.2), and the qualification transaction was sent again (section 6).

What was measured while it was halted: simulation still works on the halted head, so account 2's real verify gas was
measured with 8 real signatures and nothing sent (section 5.2).

### 6.2 Accounts and contracts

| What | Address |
| --- | --- |
| **Account 3, reset chain** (current): h = 10, hotStart 1008, hot value cap 0.01 ETH, hot fee cap 0.002 ETH, allowed target `0x5544596212F91984C986A919C8026DF0576816f9`, hybrid off; created block 375 (953,766 gas), funded 0.2 ETH block 376 | `0xf3e63d269dae09032ea950cd9722733e9b3f2d37` |
| Account 3's implementation (block 373) and factory (block 374) | `0x13075a0f56d6a793eba4493d866e6502052abe87`, `0xe7227c802ea370f04ae533827041c89dc5a4e659` |
| Genesis of the reset chain (pinned beside account 3's seed) | `0x2ad3f67b059fbde111ad7af27cfb4955d997351579612237ca0318937a5bae7a` |
| Chain before the reset: Account 2 (current verifier), h = 10, hotStart 1008, hot value cap 0.01 ETH, hot fee cap 0.002 ETH, allowed target `0x5544596212F91984C986A919C8026DF0576816f9`, hybrid off | `0x4565906974d62abf53ad28165ef0ec43a1e39f57` |
| Account 2's implementation and factory | `0x9b8ed97f198ce8f8adb20e16056fb1a29818213f`, `0x4b1cbca3a579bb55b1f948ad1c517a05c9aca6cb` |
| Account 1 (older verifier) | `0x9908548a8b28d85191dc04d27d1d3c6e1430439b` |
| Standalone verifier, for gas measurement | `0xA6Ecb14e644631C0ae9178Ab3383a72Fc384ec61` |
| Test EOA | `0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d` |
| Genesis of chain 1337 (pinned by `pipeline/src/genesis.ts`; nothing signs on another genesis) | `0x196a1589ac71e2f305b1fbc7bfd23e55367f9fd6eb9da97e2f572c2791e17bbc` |

### 6.3 Day-0 results (from Thu Nov 5, 21:00 IST, into Nov 6)

Probed on the workshop devnet: node `altmempool.forshtat.com`, sidecar `/rpc`, gateway
`altmempoolgateway.forshtat.com/rpc`.

| Check | Result |
| --- | --- |
| Chain and clients | Chain id 1337; 6 s blocks (measured over 10 blocks); node `ethrex/v23.0.0-eip8141-tracer-9aa3645d…`; sidecar `skandha/v4.1.1` |
| Legacy nonce encoding | `[0]` accepted. `[]` refused: "nonceKeys count must be between 1 and 16" (-32602) |
| One key, used twice | Sequence 0 admitted and landed. The same key at sequence 0 again: "Nonce mismatch: expected 1, got 0" (-32500); its nonce-manager slot reads 1. The same key at sequence 1 is admitted, so the account itself must require sequence 0 (`Account.yul:58`) |
| Single-use sentinel 2^64 − 1 | Not sent: the sidecar's static check refuses it ("nonceSeq must be < 2**64 - 1") |
| Two keys pending at once | Two keyed transactions on two keys from one EOA pending at once, landed in the same block. A second transaction in a pending (sender, key) slot at the same fee: "Frame transaction cannot be replaced: fee too low" |
| TXPARAM | Selectors 0x00 to 0x11 exist; values logged on chain matched (block 405,513) |
| SIGPARAM, SIGDATACOPY, FRAMEPARAM | Operand orders from the ethrex source at `9aa3645d`, confirmed on chain. All 18 reads `Account.yul` needs pass the tracer in a VERIFY frame: 317 gas besides the 20,000 key cost |
| Yul with `verbatim` | Compiles with solc 0.8.38 `--strict-assembly --optimize`; its TXPARAM read runs on chain (block 405,590). A hybrid probe passed 14 checks including SIGDATACOPY of a 2,594-byte entry, for 1,379 gas besides the key cost |
| Expiry verifier | No code at the EIP's `0x81413f0c…FfFf`. Live at `0x…8141` (26 bytes). A leading expiry frame is accepted; it used 3,051 gas (block 405,073) |
| Nonce manager | 5 bytes (`revert(0,0)`) at `0x…8250`; no code at the EIP's address |
| Recent roots | 144 bytes at `0x…8272`; none at the EIP's address. Write and reference not tried |
| Verify budget | A 120,000 prefix is refused: "validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000" (-32602). 95,000 is admitted. A flat 100,000, no per-entity budget |
| First use of a key | 20,000 execution gas inside the verify frame (20,170 at sequence 0 against 170 at sequence 1) |
| Proxy | An EIP-1167 proxy's DELEGATECALL is accepted in the verify frame; about 3,060 gas (23,227 against 20,170 direct) |
| Account checks before hashing | Cold 30,677; hybrid cold 30,798; hot 37,300, measured without the hash-based check. Hence hot +6,623 and hybrid +121, both still estimates for account 2 |
| Signature entry | A 2,594-byte ARBITRARY entry beside a 65-byte ECDSA entry is admitted and included; ARBITRARY costs 100 toward the prefix cap; TXPARAM 0x08 equals the vendored codec's `computeSigHash` (checked on 2 transactions). 2,914 bytes (h = 20) not tried |
| Calldata floor | 193,882 gas used with a 20,317-gas stub verify frame (block 405,523): the floor sets the bill |
| CHAINID | Passes the tracer |
| Bytecode | `account/build/Account.bin`: 1,992 instructions, none of ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT |
| Simulation fields | `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid` and `canonicalMempoolViolation`, not the documented `valid` and `violation` |
| Old state | Real state only for about the last 126 blocks. Older block numbers silently get the latest state, with no error |
| Faucet | 1 ETH per call on the gateway; a code-less address can be funded |
| Explorer | `https://explorer.altmempool.wtf/tx/<hash>` (also `altmempoolexplorer.forshtat.com`) |
| Not yet run | The public pool for our account (section 4.2); a hot leaf's verify gas on account 2; a 2,914-byte entry; `eth_estimateFrameTransactionGas` across 60k to 95k; recent-root write and reference; the stake flow |

### 6.4 Parallel-lanes bursts on account 3 (Nov 6, about 14:50 to 15:15 IST, blocks 1,571 to 1,656)

Run with `demo/lanes.ts` through the backend (cold leaves, 0 wei to the allowed target, 90 s deadline). Sent JSON and
logs are local, not in the repo.

- **Burst 1, 8 lanes, through the gateway:** all 8 were admitted (17 of 17 rules) and pending at once, but the gateway
  relayed none: its `skandha_explorer_peers` is empty and its `bundlingMode` is `manual`. Every lane stayed New, the
  gateway cancelled it, and each expired at its deadline with its key unused (block 1,605). Leaves 10 to 17 were burned
  and no fee was paid. Hashes: `0xebd20c49c4395887c82f051f8c9171ce1ff4a764cacb2fd1a65c20250b6411fd`,
  `0x09ed1b75904e5ccee3a8c94a1ed92718af436203ba3f303623e2fdd43222357e`,
  `0x0cda3c462e84f30f61ea3519f0b3402d09d44739b92ebc9caadda8b7f03434dc`,
  `0xee8e7e6725bef999b3460f2809e192f8a320819e0243762790e37f47be6bdbcb`,
  `0xa84d81de3bce003d4751895da53393b6c702e5b69516f1f21bb38bc8d86e44cd`,
  `0x95d5b054ccc6283af3137cf4151aea339594db4ad43ff257f8a6aeae297c6656`,
  `0xae6e9b4d74ffbe22b8ecb9c2c51f7aa55cf8063f1af6cb426d31e39d76dc2c32`,
  `0xdc25209101b9429a6089baca6a2ce4bdfb92cb02d8941f2bd3099d4ec0698b9b`.
- **One lane through the miner's sidecar** (`WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc`): leaf 18, OnChain in
  block 1,618 about 40 s after the send, relayed twice before it landed:
  `0xa9b150a3542d127ddb5d0baf7ea97384c747aeb96ee0dff9a7beb40e322122b1` (verify 88,348, gas used 180,245).
- **Burst 2, 8 lanes, through the miner's sidecar:** all 8 were admitted and pending at once, and none landed. The
  sidecar relayed the first lane (leaf 19, `0x43872511cdb78dbd4d0303158985ea703a4c1b0f7d332dee9286a703cb553468`)
  4 times from +47 s to +76 s; each time ethrex's block build did not include it, and the sidecar cancelled it,
  "relayed 4 times without being included in a block". The other 7 stayed New until about +94 s and were relayed too
  late for their deadline. All 8 expired with their keys unused (block 1,638): leaves 19 to 26 burned, no fee paid.
- **Why, as far as the sources show:** the miner's sidecar hands each transaction to ethrex with
  `ethrex_submitPrivilegedFrameTransaction`, which ethrex tries in one payload build only and drops silently if that
  build does not take it (`BundlingService/relayers/privileged.ts`; ethrex `blockchain.rs` `privileged_frame_txs`,
  `payload.rs` `drain_privileged_transactions`). The sidecar relays highest `maxPriorityFeePerGas` first, at most
  `bundleSize` 4 per 10 s pass. We follow `skandha_getGasPrice`, which quotes a priority fee of 1,999,999,993 wei; a
  busy contract account (`0xf8299765149d1e0c47fff0441167cdc16c1543ed`, gossiped in from another sidecar) pays an even
  2,000,000,000 and lands 4 keyed lanes per block (blocks 1,600, 1,603, 1,613, 1,625, 1,630), so its lanes go first.
  Block gas is not the limit (60M per block, under 17M used).

### 6.5 Stuck payment and hot-ticket refusals on account 3 (Nov 6, about 15:23 to 15:30 IST)

Through the backend on the miner's sidecar.

- **Stuck payment** (0.001 ETH to the allowed target, `firstAttemptExpirySeconds: 4`, `retries: 1`): the first attempt,
  leaf 27 (`0x7b333565668f285f3380de44de72e27e564be97f74bbc83a53a679d4b3b8b2c1`), was cancelled by the sidecar and
  expired with its key unused (block 1,752): leaf burned, no fee. The retry went on a fresh lane, leaf 28, key `0x1c`,
  not re-signed (`0x64dd0a664cf2f44556997edb9785a54c5334f8bdda558ecc683a0230ddbb8a9f`). It was relayed 4 times without
  being included and expired too (block 1,770), the same relay problem as 6.4.
- **Tickets cut:** 4 hot leaves, 1,009 to 1,012, exported to the ticket device (no transaction).
- **Over the value cap** (hot, 0.1 ETH to the allowed target, cap 0.01 ETH): refused by the node's preflight simulation,
  HTTP 422. The account's verify frame reverted with "account: hot: value cap". Ticket 1,009 is burned because it was
  signed (`0x14b82af802e48407d6ce28d06a56b8e676edebb939b1e6cce0f6fb66fd0c6197`, never sent).
- **Wrong target** (hot, 0.001 ETH to `0x000000000000000000000000000000000000dEaD`): refused the same way, with
  "account: hot: frame target". Ticket 1,010 is burned (`0x5c77b220761777672e454fb0921fa70f89829e2bd156cc34fd579fc920f0048b`,
  never sent). 2 tickets are left.

### 6.6 The public mempool holds one per sender (Nov 6, about 15:36 IST)

`demo/lanes.ts burst --n 2 --mempool public` (the node's own pool, `eth_sendRawTransaction`): lane 2, leaf 29, was
admitted and OnChain in block 2,165 about 19 s later (`0x0d9f3e811f69b34ccf35989fe0370aa8e867357f4fa057121926d3b9db988fb8`).
Lane 1, leaf 30, was refused at submission because this account already had one pending
(`0x2f85ba7741349ffbe67bee24fb5b1ce3d6eb9a14b01866b5a776ecc1cb6ad202`, never pending; the leaf is burned). The source
agrees: ethrex's pool allows several keyed transactions from one sender only when the validation prefix reads no
sender storage. Ours reads its own slots, so it is `Denied`, and a second lane gets `FrameTxSenderAlreadyPending`
(ethrex 9aa3645d `mempool.rs:173-186`, `1005-1013`; `blockchain.rs:4431-4445`).

**Why relayed lanes miss** (research, read-only, blocks 1,590 to 1,800, 197 relay pushes from all senders):
- The miner's sidecar hands lanes to ethrex's privileged queue, which one payload build empties. `build_payload_loop`
  rebuilds on every public-mempool insert, and a rebuild does not re-apply what an earlier build took
  (`payload.rs:498-526`, `638-642`).
- So a relayed push lands about 94% of the time in a block with no public transaction (62 of 66), and 39% when one
  lands in the same block (20 of 51). No push in the last ~2 s before a block landed (64 of 64), for any sender.
- The sidecar relays the highest `maxPriorityFeePerGas` first, 4 per 10 s pass (`MempoolService/service.ts:125-131`).
  A team pays a fixed 2 gwei; our oracle tip, 1,999,999,993, waited behind its backlog.

### 6.7 The fix, and 8 parallel lanes landing (Nov 6, about 16:00 IST)

The fix, approved by Vicky (spec "Fees", Nov 6), is on branch `fix/lanes-tip`:
- **A tip floor.** Every fee quote's priority fee is raised to `WL_MIN_TIP_WEI` (3 gwei by default on chain 1337), and
  the max fee by the same amount (`pipeline/src/rpc.ts` `withTipFloor`).
- **A 180 s deadline for bursts** (`demo/lanes.ts --expiry-seconds`, default 180). Single sends keep 90 s.
- **Fire in a quiet window,** with no public transaction in the last 3 blocks.

Results, through the miner's sidecar at 3,000,004,104 wei per gas:
- **1 lane:** leaf 31, OnChain in block 2,247, about 19 s after the send
  (`0x2fdd5db408a23a6197cce7c2714d1614b1a282129dc7f625d1b44f171a246787`).
- **4 lanes at once:** all OnChain in one block, 2,255 (leaves 32 to 35):
  `0xcd7392ff8a2595f1f27b70e9f55d9006be30a7dc446544a6cc650e5e17569a8b`,
  `0x06df7eeffb9ff4dce6009b684b6cc46691598c8974f3cbfd4bb0b7ff747ab4c2`,
  `0x922b410cebeba99b271666c7367377daf49c1ea43da2a0611b9bee947b242f6a`,
  `0xd85174489240554f1748e0470bc6a3e8bfdcaffd5e5f074c4d80446fa45c3991`.
- **8 lanes at once (the scene):** admitted 8 of 8, 8 pending at once, landed in 2 blocks of 4, 2,272 and 2,275,
  57 s from the first send to the last landing (leaves 36 to 43):
  - block 2,272: `0x39b205e1fa214ca13b5c8bd956c6477993f586ed4a2fc67846b21b62575b5163`,
    `0xebfc703ea10c576eb54b81acae727046cf41c13e0f40bcdaec309410742b0f2b`,
    `0xec4cfe374c2aaa00a2ca7a0fd5d08f745e97753aee706545d718fb5a9cd058b2`,
    `0xc5a16a74492e2fa1ec92bd41d55ab40375594e533a198e23da45f4af73db0125`;
  - block 2,275: `0xb6d18d7323074c006125cb159545d9af953243eda2c994604e8df668f3e3ad92`,
    `0xcc8622f4dafc80371b2156b596a49ccb7ad22316ab5ae713c502cdd63e50e596`,
    `0x8a39af57f89ccbcc693eda8b65588879934dacbe06ca5bc132f2bf720e83f2d6`,
    `0xf71a23cceb43fd3447bca7ad2c7647ce5b489be3d5325ca03c3a459594855295`.

### 6.8 Stuck payment and a hot ticket, with the fix (Nov 6, about 15:47 to 15:49 IST)

- **Stuck payment** (0.001 ETH to the allowed target, a 4 s first deadline, 1 retry):
  - The first attempt, leaf 44 (`0xfd8fc1be49389c57ff4e1efe67d91e80c29f51300374432575bb8d39f46da377`), expired with its
    key unused in block 2,285. The leaf is burned and no fee was paid.
  - The retry went on a fresh lane, leaf 45, key `0x2d`, and was not re-signed or fee-bumped. It was OnChain in block
    2,293, about 15 s after its send (`0x28cdd22fb85d2da094d0a05db311a6ba2ec868246c4da3b1ebd2af9593885e00`).
- **Hot ticket from the ticket file** (signed by the ticket device with `sign --ticket-file`, no master seed): 0.005 ETH
  to the allowed target, under the 0.01 ETH cap. Leaf 1,011, key `0x3f3`, OnChain in block 2,300
  (`0x76870aaeb0e218431107db7cd670b737116d1c33982859bfe5d6ff34648a04e9`). 1 ticket is left.

## 7. Trade-offs

| Trade-off | What we chose | What it costs | Why it is right for this design |
| --- | --- | --- | --- |
| Stateful hash-based keys vs stateless (SPHINCS-style) | Stateful tree, index bound to nonce | Finite keys per tree, rotation needed; signer must never sign a leaf twice | The protocol already guarantees nonce-key uniqueness, so the usual state risk disappears; Quip's stateless path measures 1,629,049 gas, and NiceTry's few-time FORS+C verifies in about 35k but is chosen to survive reuse, which is the race we remove instead |
| Nonce-bound leaves vs a used-leaf bitmap | Nonce-bound | One protocol nonce-manager slot per key (97,920 state gas in the current EIP, 20,000 execution on the devnet revision); a durable local journal of exposed leaves is still required | Zero account writes in validation, and the consumption is atomic with payment approval, so two pending lanes can never both pass against one leaf; a SENDER-frame bitmap cannot give that |
| Expiry frames vs fee bumping | Expiry, never replace | A stuck tx waits out its deadline (90 s default) before the next attempt | Replacement reuses the leaf and leaks key material; expiry keeps one signature per leaf |
| Keyed-only hash signing vs a sequential legacy mode | Keyed only; the legacy nonce is used by the deployment alone | One nonce-manager slot per transaction | The sequential route cannot burn a leaf after an expiry without moving the nonce; a fresh key at sequence 0 can, and the devnet rejects the single-use sentinel anyway |
| Hybrid ECDSA plus hash-based vs hash-based only | Hybrid on by default | 2,800 gas and a second key to manage | Defense in depth during migration; hot tickets carry no classical key, and the hot cap is the kill switch |
| Per-leaf public seed vs one seed per tree | Per-leaf | One extra keccak per verification | Avoids a multi-target weakness across 2^h leaves |
| Quip-compatible WOTS+ format vs our own | Quip's | Our format choices are constrained | Their audited verifier becomes a test oracle for free |
| n = 32 vs n = 16 | 32 | Twice the chains and gas of n = 16 | About 128-bit quantum security; n = 16 gives about 64 |
| Minimal proxy vs full contract per account | Proxy | A DELEGATECALL in the verify frame | Deploy state gas drops from millions to under 100k |
| Per-chain tree slots vs one flat tree | 16 slots, chain id hashed into every leaf | One byte and four siblings per signature; keygen runs per listed chain | The same address on two chains has two nonces; a flat tree would sign the same one-time key twice at the same nonce |

Where the build differs from this table (Vicky to confirm the wording):

- Hybrid row: hybrid is **off** for the demo, not on by default.
- Keyed-only row: no transaction uses the legacy nonce, not even the deployment: an EOA calls the factory.
- Minimal proxy row: the DELEGATECALL also holds back 1/64 of the verify gas (section 5.4). "Under 100k" is the code
  deposit alone (45 bytes × 1,530 = 68,850 state gas); a whole creation also pays for the new account and its storage
  slots (section 3.1).

## 8. Prior art

| Project | What it is | How it tracks used keys | Transport | Measured gas | Notes |
| --- | --- | --- | --- | --- | --- |
| [Quip Network hashsigs-solidity](https://github.com/quipnetwork/hashsigs-solidity) | WOTS+ verifier library in keccak: n = 32, w = 16, 67 chains, 2,144-byte signature, 64-byte on-chain key (publicSeed, publicKeyHash) | Stateless library; wrapper example stores a cursor or bitmap per key | Direct calls, ERC-1271 | Stateful wrapper 190,792 (256-bit), 117,759 (128-bit) | AGPL-3.0; Oak Security audit dated 2026-09-24 |
| [Quip ethereum-sdk](https://github.com/QuipNetwork/ethereum-sdk) | Production ShrincsWallet: stateful tree (4,096 leaves deployed) plus stateless FORS-C fallback; hybrid owner ECDSA and hash-based signature on the userOp path | Used-leaf bitmap and an action nonce written in validation (SSTORE per tx); explicit key rotation | ERC-4337 v0.7 EntryPoint only | Wrapper overhead \~7.7k per validation | Deployed Ethereum mainnet 2026-09-17; no EIP-8141 or 7702 |
| [Skale xmss-solidity](https://github.com/skalenetwork/xmss-solidity) | RFC 8391 XMSS verifier, SHA-256, formally checked | README tells the caller to keep a leafUsed mapping | Library | \~745k | MIT |
| [OpenZeppelin community PR #301](https://github.com/OpenZeppelin/openzeppelin-community-contracts/pull/301) | Draft keccak XMSS ERC-7913 verifier, n = 16 | Not addressed | Library | None published | Author notes it is AI-generated and unreviewed |
| [poqeth (ePrint 2025/091)](https://eprint.iacr.org/2025/091.pdf) | Benchmarks of PQ verification on Ethereum | n/a | n/a | Hash-based \~295k | Academic |
| [pq-dksap](https://github.com/ivanmmurciaua/pq-dksap) | ML-KEM stealth receive, ML-DSA spend over EIP-8141 frame txs | n/a (lattice, reusable key) | EIP-8141 testnet | Not published | Proof of concept |
| [QuantumCanary](https://github.com/identity-md-launches/launch-1213-src-quantumcanary-sol) and BitMEX Research canary | Nothing-up-my-sleeve secp256k1 address as a quantum alarm | n/a | n/a | n/a | Concept exists; our wiring to account lockdown is new |
| Winterlock (Safe forum proposal, 2026-10-09) | Proposed EIP-1271 Safe owner verifying WOTS signatures against a Merkle tree; SPHINCS+ for recovery; optional STARK-batched verification | "Each key is valid for one Safe nonce only"; separate key slots planned for flows that sign more than once per nonce | Safe owner contract (ERC-1271), not frame transactions | none; proposal only, no code yet | Closest prior statement of the nonce-indexed idea; cite it. Safe's nonce is contract state, ours is consumed by the protocol |
| NiceTry (Solvency-Labs / RivaLabs, ethresear.ch 24273 and 24526, 2026-03 to 2026-05) | ERC-4337 account rotating the signer every operation; now FORS+C few-time signatures as primary, WOTS+C kept as comparison; a FrameAccount path for EIP-8141 that requires the next frame to be the rotation frame | Rotation write in a SENDER frame after approval; FORS+C chosen because it degrades gracefully under bounded reuse | 4337 UserOp; frame-transaction path pending its opcode bridge | WOTS+C about 73k, FORS+C about 35k verify on Sepolia (their figures) | The only other hash-based design on frame transactions we found. Their rotation write tolerates the two-lanes race by using a few-time scheme; we remove the race by consuming the nonce key |
| QRL (Quantum Resistant Ledger) | XMSS-based chain since 2018 | Wallets use the transaction nonce to pick the next one-time key; the chain also tracks used OTS indices on chain | its own protocol | n/a | Historical prior art for nonce-guided key selection; cite it |
| EIP-8310 (2026-06-19) | Post-quantum keystore for stateful leanXMSS validator keys | Synchronized mode leaf = f(slot); signer-side high-water mark; reserved disjoint leaf ranges; durable state authority | consensus layer | n/a | The consensus-layer analogue of our idea; its warning that recovering a seed is not the same as safely resuming signing applies to us |

The Safe forum proposal and this project share the name Winterlock but are different work. Vicky to confirm the
wording, or a rename.

Deliberate reuse: we adopt Quip's WOTS+ wire format bit for bit (chain function, randomization elements, checksum,
key hash), so their code can serve as a test oracle (`account/test/HashSigVectors.t.sol`,
`account/test/WotsDigitsOracle.t.sol`). We wrote our own verifier and tree. Quip's code is AGPL-3.0: it runs only in
our tests, and nothing we deploy or build links it.

## 9. CROPS

The prize page defines CROPS as censorship resistant, open source, private and secure.

- **C, censorship resistant.** The account pays its own fees: no paymaster, and no bundler signs for it. Any node that
  runs the alt mempool can carry its transactions; today the pipeline sends to one, the miner's sidecar
  (`WL_GATEWAY_URL`). If that node refuses or goes away, only time is lost: a refused payment burns its leaf at once,
  and a stranded one dies at its deadline (the expiry frame), after which the next send can go to another node. Each
  payment is its own lane, so one stuck payment cannot block the others.
- **O, open source.** MIT. The account, the verifier, both signers (TypeScript and Rust), the test vectors and the
  fake chain are in this repo; the backend and the screens once branch `feat/backend` is merged (Vicky to confirm).
- **P, private.** Seeds and keys stay on this machine, in files under `~/.winterlock` (the devnet accounts' seeds, the
  EOA key, and the backend's wallets and ticket devices in `~/.winterlock/backend`, `loadConfig` in `backend/src/config.ts`).
  Only local processes read them: the backend, the Rust CLI it runs, and the pipeline's scripts. The backend listens
  on 127.0.0.1 only (`SERVE` in `backend/src/app.ts`). The screens send no analytics, but they load two fonts, Inter and
  JetBrains Mono, from Google Fonts (the content security policy `CSP` in `web/serve.ts`), so Google sees each page load.
  The pipeline reads the devnet's public RPC directly. A nonce key shows the leaf index on chain.
- **S, secure.** Hash-based signatures with n = 32: about 128-bit security against a quantum attacker (Grover). The
  protocol, not our code, guarantees each one-time key is consumed once. The journal is written before signing, a
  payment is never fee-bumped, and hot tickets are capped by the account itself.

## 10. How to run

Needs Bun (`~/.bun/bin`), Foundry (solc 0.8.38 through its svm) and Rust (`~/.cargo/bin`). Every test suite below runs
offline.

**Tests.**

```sh
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
(cd signer && cargo build --release && cargo test)
(cd account && scripts/build.sh && forge test)
(cd pipeline && bun install && bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test)
(cd backend && bun install && bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test)
(cd web && bun install && bun run typecheck && bun test)
(cd fakechain && bun install && bunx tsc --noEmit -p . && bun test)
```

Counts on main at `ef9b102`, re-run offline Nov 6, 12:05 to 12:10 IST: 27 Rust, 25 Foundry, 164 pipeline and 90 fake
chain tests, all passing. The uncommitted backend branch, as last reported about 11:50 IST: 198 pipeline, 95 backend,
89 web (Vicky to re-run once it is merged; the lanes work adds tests).

**The Rust signer CLI.** One JSON object on stdout, or exit 1 with `{error, detail}` on stderr. The seed comes only
from `--seed-file` or `PQ_SEED`.

```sh
S=signer/target/release/signer
$S keygen --seed-file seed.bin --height 10 --chains 1337
$S sign --seed-file seed.bin --height 10 --chains 1337 --chain-id 1337 --leaf 5 --msg 0x<32 bytes>
$S verify --tree-seed 0x… --root 0x… --height 10 --chain-id 1337 --leaf 5 --msg 0x… --entry 0x…
$S export-leaves --seed-file seed.bin --height 10 --chains 1337 --chain-id 1337 --hot-start 1008 --from 1008 --to 1017 --out tickets.json
$S sign --ticket-file tickets.json --leaf 1008 --msg 0x…
$S vectors --height 10 --chains 1337 --out vectors/h10.json
```

**The fake chain** (a local, fake devnet for hand tests while the real one is down; it runs no EVM code and proves
logic only):

```sh
cd fakechain && bun install && bun run.ts      # prints its data folder and an env.sh
# in a second shell: source the env.sh it printed, then
cd pipeline && bun scripts/hashsig-devnet.ts
```

Take every `WL_*` variable from that `env.sh`, never from the command line: the pipeline's scripts have no guard of
their own.

**Backend and screens.**

```sh
cd backend && bun install && bun src/main.ts   # http://127.0.0.1:8787/api
cd web && bun install && bun serve.ts          # http://127.0.0.1:5173: hot-cold.html, agent.html, session.html
```

On the fake chain, source its `env.sh` before starting the backend. Vicky to confirm the end-to-end run (fake chain,
backend, screens) once it is done.

**On the devnet** (when it produces blocks again), from `pipeline/`:

```sh
WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/hashsig-devnet.ts
```

It needs the deployment record (`pipeline/.data/deployment-1337.json`), the seed and the EOA key, which
`scripts/deploy-account.ts` creates; keys and seeds live in `~/.winterlock` and never in the repo. Use the miner's
sidecar: the public gateway stopped relaying on Nov 5. The faucet runs only on the gateway.

## 11. What existed before the event, and what was built during it

The event began Thu Nov 5, 21:00 IST. Times are IST; the Rust signer's commits carry UTC author dates, converted here.

**Before 21:00 IST Nov 5** (on main):

| Commit | Time | What |
| --- | --- | --- |
| `f118189` | Nov 5 01:21 | README, 3 lines (a check of GitHub write access) |
| `3b5fe45` | Nov 5 15:58 | Empty stubs, written with Claude Code: Rust hello-world crates in `backend/`, `pipeline/` and `signer/`; a Foundry skeleton in `contracts/`; `bun init` in `demo/` and `web/`; submodules for forge-std, Quip's hashsigs-solidity, mempool-workshop and mempool-workshop-sidecar; a README line and the root `.gitignore` |
| `bd5278f` | Nov 5 16:03 | Merge of PR #1 |
| `5395bac` | Nov 5 18:33 | The submodules replaced by plain vendored folders: third-party code only |
| `3d17beb` | Nov 5 19:13 | Merge of PR #2 |

Two earlier versions of that boilerplate, `e42824d` (Nov 5 14:48) and `0936dd4` (15:46), are on branch
`chore/boilerplate` only, not on main.

No project code existed before the event. Also before the event, outside the repo: the design spec (Nov 1, revised
Nov 3) and the technical plan (Nov 4), disclosed to ETHGlobal as pre-existing design, and three static UI prototypes
(Nov 4), which are not in the repo; the screens were written during the event from the spec's text. The plan expected
an outside signature library (by the spec's author, not a participant) to be published before the event. It was not,
so the hash-based scheme was written during the event (`HashSigVerify.yul:1-2`). Vicky to confirm all four points,
and that the ETHGlobal disclosure now says so.

**During the event:**

| When | What | Commits |
| --- | --- | --- |
| Nov 5, 21:00 to 22:30 | Day-0 probes on the devnet; scripts outside the repo | none |
| Nov 5, 23:25 | V2: the frame-transaction pipeline in Bun and TypeScript | `5fcf6c3` (PR #3) |
| Nov 6, 02:42 to 05:10 | The Rust signer and CLI, vectors, ticket files, benchmarks, the WebAssembly build | `4ed3dc7` to `49ea34b` (PR #4, merged 06:26 as `dac0256`) |
| Nov 6, 06:01 to 06:04 | V3: the Yul account, the TypeScript signer and Yul verifier, the hardened send path; grinding the fee | `445cdaa`, `2a631c3` (PR #3, merged 06:26 as `253334b`) |
| Nov 6, 07:16 | MIT licence, AI attribution, two CLI fixes | `a4982e0`, `25022c4` (PR #5, merged 07:19 as `cbba437`) |
| Nov 6, 10:09 | The grinder fix for the proxy's 63/64, the measured `GRIND`, `simulate-verify-gas.ts` | `5b24bd8` (PR #6, merged 10:10 as `934d964`) |
| Nov 6, 11:58 | The fake chain, `fakechain/`, and the fit line in `pipeline/scripts/hashsig-devnet.ts` | `2205489` (PR #7, merged 12:08 as `ef9b102`) |
| Nov 6, not yet committed | `backend/`, the screens in `web/`, `pipeline/src/tickets.ts` and the send-path changes (worktree branch `feat/backend`); `pipeline/src/lanes.ts` and `demo/lanes.ts` (being built) | Vicky to fill in |

The qualification transaction landed at block 407,107, before PR #3 was merged (section 6).

## 12. Differences from the spec

| The spec says | The code does | Why |
| --- | --- | --- |
| WOTS+ randomization elements r[0..14] | r[1..15] (`HashSigVerify.yul:7,42`) | Quip's `WOTSPlus.sol` uses r[1..15], and the oracle tests pass. The code is right; the spec line is parked |
| The vector file's `params.chains` | The Rust vector file writes `params.hashChains` | Parked |
| CLI `--seed` | No `--seed` flag: `--seed-file` or `PQ_SEED` only (`signer/src/bin/signer/io.rs:13`) | The plan says never pass the seed as an argument |
| `export-leaves` without a band | Needs `--hot-start` and refuses colder leaves | A ticket must be a hot leaf |
| `sign --ticket-file` with the tree flags | Refuses the tree flags | The ticket file carries them |
| `verify` prints `{ok: false, reason}` | Exits 1 with an error object | Parked |
| `vectors --seed --count` | Takes `--height`, `--chains` and `--out` only | Parked |
| A tree cache; sign under 50 ms warm | No cache: 0.36 s per signature from the seed at h = 10 | Parked |
| No WebAssembly (plan) | `signer-wasm/` exists, unbuilt, with no build notes | Parked |
| `hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, chainId)` (plan) | Takes the leaf too: `(…, height, leaf, chainId)` (`HashSigVerify.yul:15`) | The leaf comes from the nonce key, not from the entry |
| The stuck payment of the demo is a low fee | A 4-second first deadline (`firstAttemptExpirySeconds: 4`, `retries: 1`) | Nov 6, Vicky: a fee below the 7-wei base fee is refused at admission and any fee above it is included, so a low fee cannot stick |
| 4 pending per lane, 64 per unstaked sender; eight lanes "in one or two blocks" | Devnet: 1 per key, no per-sender cap for self-paying keyed lanes, at most 4 relayed per 10 s pass; "two or more blocks" | Nov 6, Vicky: the devnet's real rules, from its code. 4 and 64 are the draft's |
| Deployment by a deploy frame on the legacy nonce | An EOA calls the factory; the verify frame refuses `[0]` | Nov 6: a deploy frame needs about 546,000 state gas, over the 500,000 cap |
| Hybrid on by default | Off | Plan, section 8 |
| An outside library before the event | Written during the event | It was not published |
| At most four cold SLOADs | Three for a cold leaf, six for a hot leaf | The hot rules need slots 3 to 5 |
| Declared verify limit at most 90,000 | The qualification transaction declared 94,900 | It was sent by `sweep-hashsig.ts`, which declared 94,900 until commit `2a631c3` moved it to the 90,000 ceiling; normal sends declare 90,000 |

## 13. Known limitations

- **Hybrid is off.** The account supports the ECDSA co-signature, but the backend refuses to create a hybrid wallet
  (400) and refuses cold sends and admin calls on a hybrid account (409 `hybrid_unsupported`,
  `hybridUnsupported` in `backend/src/backend.ts`). No measured profile uses it.
- **Level B and C are not built.** The recent-root hot authority (hot tickets that expire with an 8,191-slot window)
  and the certified hypertree (growth without invalidating pending lanes) are designed, not built. The agent screen
  says so: "Recent-root expiry: proposed (Level B), not built" (`web/public/agent.html`).
- **The hot +6,623 gas is an estimate.** It comes from a Day-0 measurement without the hash-based check (37,300
  against 30,677), not from a real hot signature on account 2. One hot leaf, simulated, would measure it.
- **A policy change does not wait for lanes.** `POST /hot-policy` is refused while a rotation is pending (409
  `rotation_pending`) but goes ahead while lanes are in flight (`backend/src/backend.ts`, `hotPolicy`). A lower hotStart turns pending cold lanes above it into hot ones,
  which then fail the hot rules, and the sidecar's per-block re-simulation cancels them. Rotation does wait.
- **The public-pool rule is not yet probed.** From ethrex's source our account should get one pending transaction
  there, because its verify frame reads its own storage. Until a probe confirms it, the "public mempool holds one"
  scene is a prediction.
- **The devnet was reset on Nov 6** (section 6.1). On the new chain a hot ticket and the gas fit are now on chain; lanes
  at scale, the public-mempool contrast and the 4-second expiry scene are still to be run there. The fake chain shows the
  logic only.
- **Estimates burn leaves.** `eth_estimateFrameTransactionGas` runs the verify frame, so each estimate signs with its
  own cold leaf, which is then burned. The estimate messages are not ground, so about 1 in 65 runs out of gas at its
  94,900 limit (messages of 600 or more chain steps, by the measured fit). Still so at 12:15 IST: the worktree's
  `pipeline/src/estimate.ts` does not grind. Vicky to confirm before submitting.
- **Four cold leaves are kept for admin calls**, enough for the kill switch and one rotation, at 2 leaves each (one
  for the estimate, one for the call; `ADMIN_CALL_LEAVES` and `ADMIN_LEAVES` in `backend/src/backend.ts`).
- **Small band.** 16 hot tickets and 1,007 cold leaves at epoch 0 (h = 10). Production would use h = 20.
- **The Rust signer has no tree cache:** 0.36 s per signature from the seed. Yul and Rust are compared only through
  TypeScript, with no direct test.
- **Two review findings are not acted on yet** (each needs Vicky's go): on macOS, `fsync` is not `F_FULLFSYNC`, so a
  journal write could be lost on power loss after a signature left the machine; and `sendKeyed` burns and continues
  when a key is used on chain but missing from the journal.
- **The 2,300-gas stipend.** An account is a 45-byte EIP-1167 proxy, so every call to it, a plain ETH payment
  included, runs a DELEGATECALL to the implementation (about 2,700 gas with a cold implementation). It cannot receive
  ETH from a contract that forwards only the 2,300-gas stipend (Solidity's `transfer` and `send`); a plain `call` with
  value works.
- **Explorer links.** The explorer reads the gateway, which stopped relaying, so lanes sent to the miner's sidecar may
  not show there.

## 14. Divergences found on Day 0 (to file upstream)

None is filed yet. Vicky to file them on the sidecar or ethrex repositories and link each issue here.

Bugs and stale documents:

| # | Divergence | Where |
| --- | --- | --- |
| 1 | The expiry verifier and the nonce manager are at `0x…8141` and `0x…8250`; the EIP addresses have no code. Same for recent roots (`0x…8272`) | sidecar docs |
| 2 | `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid` and `canonicalMempoolViolation`; the devnet readme says `valid` and `violation` | sidecar docs |
| 3 | ethrex `docs/eip-8141.md` at `9aa3645d` describes a SIGPARAM 0x04 copy, which halts | ethrex |
| 4 | ethrex docs give an intrinsic cost of 15,000; the code (`transaction.rs`) charges 12,000 | ethrex |
| 5 | Older blocks silently answer with the latest state, with no error (only about the last 126 blocks are real) | ethrex |
| 6 | From about 23:40 IST Nov 5 the gateway admitted frame transactions but never relayed them; `skandha_explorer_peers` was empty | sidecar, event Discord |
| 7 | The chain halted at block 408,262 (04:28 IST Nov 6) | event Discord |
| 8 | The faucet runs only on the gateway, and is empty | event Discord |

The devnet pins older drafts (not bugs; note them): `[]` is refused and the legacy nonce is `[0]`; the sentinel
2^64 − 1 is refused; a key's first use costs 20,000 execution gas, not the EIP's 97,920 state + 12,100;
`computeSigHash` replaces empty-msg signature bytes with empty bytes, where the EIP uses their length.

Found later, on Nov 6, in the vendored sidecar's source:

- `skandha_explorer_listTransactions` filters by status only, with no sender filter (`SC/modules/explorer.ts:108-139`).
- An error while re-simulating a lane, a transport error included, cancels that lane, so a node outage during
  revalidation cancels every New lane on that node (`SC/services/BundlingService/reconciliation.ts:436-461`).
- The workshop's `explainRejection` maps only OP-011 and STO (mempool-workshop `src/lib/frameTx/send.ts:55-65`).

## 15. AI attribution

Vicky drives every AI tool and authors every commit. Files written with Claude Code (Anthropic), reviewed and run by Vicky:

- Scaffolding in commit `3b5fe45` ("boilerplate using claude"): the initial `backend/`, `contracts/`, `demo/`, `pipeline/` (a Rust stub, replaced by the TypeScript pipeline in V2), `signer/` and `web/` stubs, the root `.gitignore` and the submodule setup.
- `pipeline/src/config.ts`, `rpc.ts`, `builder.ts`, `signer.ts`, `leaves.ts`, `submit.ts`, `index.ts`
- `pipeline/test/codec.test.ts`, `builder.test.ts`, `leaves.test.ts`, `signer.test.ts`, and `pipeline/test/fixtures/devnet-sighash.json` (two devnet transactions and their on-chain sig hashes, fetched by a Claude-written script)
- `pipeline/scripts/smoke.ts`, `pipeline/package.json`, `pipeline/.gitignore` (`pipeline/tsconfig.json` is a copy of `demo/tsconfig.json`)
- `pipeline/scripts/deploy-account.ts` and `pipeline/scripts/account-sim.ts` (devnet deployment and the verify-path test suite)
- `pipeline/src/wots.ts`, `grind.ts`, `admission.ts`; `pipeline/test/wots.test.ts`, `grind.test.ts`, `admission.test.ts`; `pipeline/scripts/gen-wots-fixture.ts` and `retry-demo.ts`; the fixtures `pipeline/test/fixtures/wots-digits.json` (generated) and `admission-records.json` (one record fetched from the devnet, one shaped from the sidecar docs); `account/test/WotsDigitsOracle.t.sol` (checks our digits against Quip's WOTSPlus.sol, which is AGPL and used in tests only)
- `pipeline/src/account.ts`, `genesis.ts`, `estimate.ts`; `pipeline/test/account.test.ts`, `genesis.test.ts`, `estimate.test.ts`; `pipeline/scripts/estimate-demo.ts`; the fixture `pipeline/test/fixtures/account-deployment.json` (public addresses of the devnet deployment)
- `account/yul/Account.yul`, `account/yul/hashsig/HashSigVerify.placeholder.yul` (a stand-in that checks no signature, used only by the early devnet test accounts), `account/src/Factory.sol`, `account/src/IWinterlockAccount.sol`, `account/scripts/build.sh`, `account/test/Account.t.sol`, `account/foundry.toml`, `account/.gitignore`
- The hash-based signature scheme, written during the event instead of waiting for an outside library: the TypeScript signer `pipeline/src/hashsig/scheme.ts`, `tree.ts`, `keyring.ts`; the Yul verifier `account/yul/hashsig/HashSigVerify.yul` and its test wrapper `account/yul/HashSigVerifier.yul`; the tests `pipeline/test/hashsig.test.ts` and `account/test/HashSigVectors.t.sol` (which also checks our WOTS+ layer against Quip's `WOTSPlus.sol`, AGPL, tests only); `vectors/h10.ts.json`, generated by `pipeline/scripts/gen-vectors.ts` from a throwaway seed (`vectors/h10.json` is the Rust signer's file, PR #4)
- Devnet scripts: `pipeline/scripts/lib/wallet.ts`, `hashsig-devnet.ts`, `sweep-hashsig.ts`, `sweep-placeholder.ts`, `measure-verifier.ts`, `calibrate-verify-gas.ts`, `init-journal.ts`, `move-journal.ts`
- The fixes after two reviews of the pipeline on Nov 6 (a kernel file lock per journal, kept beside the account's seed; inclusion and expiry decided from the nonce manager two blocks deep; lost send answers followed instead of called refusals; OnChain only when every frame succeeded, Included when the key is used but no receipt can be read; checks before a leaf is reserved, including the system contracts' code), with `pipeline/test/submit.test.ts`, `pipeline/test/rpc.test.ts` and `pipeline/test/wallet.test.ts`
- The Rust signer and CLI (PR #4; every commit co-authored by Claude Code): `signer/Cargo.toml`, `signer/Cargo.lock`, every file in `signer/src/` and `signer/src/bin/signer/`, `signer/tests/` and `signer/benches/ops.rs`; the WebAssembly build `signer-wasm/` (`.gitignore`, `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `test/*.mjs`); and `vectors/h10.json`, the vector file the Rust CLI writes. Two CLI fixes after the PR #4 audit: the ticket file is created with mode 0600 instead of being narrowed after creation, and a missing flag is named in the `bad_args` error
- `LICENSE` (the standard MIT text)
- The verify-gas measurement and the grinder fix (Nov 6): `pipeline/scripts/simulate-verify-gas.ts`, the stop in `pipeline/scripts/calibrate-verify-gas.ts`, `usableVerifyGas` and the measured `GRIND` in `pipeline/src/grind.ts` and `pipeline/src/config.ts`, and their tests in `pipeline/test/grind.test.ts` and `pipeline/test/submit.test.ts`
- The backend (replaces the Rust stub of `3b5fe45`): every file in `backend/src/` (`app.ts`, `backend.ts`, `chain.ts`, `config.ts`, `files.ts`, `http.ts`, `main.ts`, `registry.ts`, `store.ts`) and `backend/test/` (`admin.test.ts`, `app.test.ts`, `fake-chain.ts`, `helpers.ts`, `restart.test.ts`, `secrets.test.ts`, `send.test.ts`, `tickets.test.ts`, `wallets.test.ts`), `backend/README.md`, `backend/package.json`, `backend/tsconfig.json` and the change to `backend/.gitignore`
- The pipeline changes for the backend: `pipeline/src/tickets.ts` (hot tickets: the cut and the device journal), `pipeline/test/tickets.test.ts`, `pipeline/test/rpc-reads.test.ts`, and the changes to `pipeline/src/submit.ts` (the alt or public mempool switch, `onSubmitted`, the fixed-fee grind), `rpc.ts`, `estimate.ts`, `index.ts`, `scripts/lib/wallet.ts` and their tests
- The parallel-lanes tooling: `pipeline/src/lanes.ts`, `demo/lanes.ts`, the backend's lanes plan endpoint and the `maxCostWei` and `wire` fields, with their tests (Vicky to confirm the final file list)
- The screens: `web/serve.ts`, `web/bunfig.toml`, every file in `web/public/` (`index.html`, `hot-cold.html`, `agent.html`, `session.html`, `style.css`, `agent.js`, `api.js`, `board.js`, `dom.js`, `flows.js`, `format.js`, `hot-cold.js`, `index.js`, `lanes.js`, `market.js`, `scenes.js`, `session.js`, `ui.js`, `tsconfig.json`) and `web/test/` (`board.test.ts`, `fake-dom.ts`, `flows.test.ts`, `format.test.ts`, `integration.test.ts`, `lanes.test.ts`, `pages.test.ts`, `records.ts`, `screens.test.ts`, `serve.test.ts`, `setup.ts`), and the changes to `web/package.json` and `web/tsconfig.json`. `web/index.ts` and `web/README.md` are still the `bun init` stubs of `3b5fe45`
- The local fake devnet for hand tests while the devnet was halted (Nov 6, PR #7): every file in `fakechain/` (`run.ts`, `src/`, `test/`, `README.md`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `.gitignore`), and the fit line in `pipeline/scripts/hashsig-devnet.ts`, which now subtracts the proxy's 1/64 holdback. `fakechain/src/sidecarRules.ts` is a port of the vendored sidecar's admission rules (below)
- The Day-0 probe scripts, kept outside this repo, and this README, drafted with Claude Code and edited by Vicky (Vicky to confirm)

Not written by us: `pipeline/src/codec/codec.ts` and `pipeline/src/codec/FrameTx.ts` are copied from [mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar) at commit `2e22ff0a`, MIT, Copyright (c) 2023 Etherspot; Claude Code added only the header comments and changed one import path. `fakechain/src/sidecarRules.ts` ports the sidecar's admission rules (classifyFrame, recognizeValidationPrefix, validateStructuralRules, validateSignature, describeStructuredFailure) from the same commit, MIT, Copyright (c) 2023 Etherspot, so the fake refuses with the sidecar's own words.

## 16. Licence

MIT, see [LICENSE](LICENSE). Vendored code keeps its own licence: `vendor/mempool-workshop-sidecar` (MIT, Etherspot),
`contracts/lib/forge-std` (MIT or Apache-2.0), and Quip Network's `contracts/lib/hashsigs-solidity` and Rust crate
`hashsigs-rs` (both AGPL-3.0-or-later). Quip's code runs only in our tests, as an oracle for the WOTS+ format; no
contract we deploy and no binary we build links it. `fakechain/src/sidecarRules.ts` and `pipeline/src/codec/` keep the
sidecar's MIT notice (Copyright (c) 2023 Etherspot).
