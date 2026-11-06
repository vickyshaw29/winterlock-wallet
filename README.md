# Noncebound

Noncebound is a post-quantum smart account for EIP-8141 frame transactions. Every payment is signed with a
one-time hash-based key (WOTS+, under a Merkle tree), and that key's number is the payment's own EIP-8250 nonce key.
The protocol consumes the nonce key in the same step that approves the payment, so it retires the key too. The account
never records which keys it has used: no bitmap, no counter, no storage write during validation.

Because every payment has its own nonce key, one account can have many hash-signed payments pending at once on the
ERC-8421 alternative mempool. The public mempool holds one per sender.

Built at ETHGlobal Mumbai 2026 for the Ethereum Foundation's *Best use of the Frame Transaction Alternative Mempool*
prize, and run on that prize's devnet (chain 1337). [What was submitted](#ethglobal-mumbai-2026).

Its working name was Winterlock, which the repository, packages and paths still use. It is not the Safe forum's
Winterlock proposal, which is different work ([note](#prior-art)).

```
$ cd pipeline && WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun scripts/hashsig-devnet.ts
account 0xf3e63d269dae09032ea950cd9722733e9b3f2d37 (real verifier), 0.2 ETH

== 1. first hash-signed transfer
   cold transfer, 1 wei: leaf 1, key 0x1, OnChain in block 386
     message 0xaf823680d168d739220883499d4ecb8256f4ce257a51f2f58498f16497a84dfd: 510 chain steps (limit 510, 2 fee value(s) tried)
     verify frame 88373 gas of 90000 declared; whole transaction 186245 gas
     included: 17 of 17 rules passed
     https://explorer.altmempool.wtf/tx/0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175
…
== 2. forgeries (simulated only; each signing leaf is burned)
   OK one signature byte flipped                               sig: hash-based check
   OK a valid signature of leaf A under leaf B's nonce key     sig: hash-based check
```

**[Measured](#measured)** · [Real and not](#what-is-real-and-what-is-not) · [Quickstart](#quickstart) ·
[How it works](#how-it-works) · [Where to look](#where-to-look-in-the-code) · [Design](#design) ·
[Parallel lanes](#parallel-lanes-on-the-alt-mempool) · [Gas](#gas) · [Devnet evidence](#devnet-evidence) ·
[Trade-offs](#trade-offs) · [Prior art](#prior-art) · [CROPS](#crops) · [ETHGlobal](#ethglobal-mumbai-2026) ·
[Limitations](#known-limitations) · [Authorship](#authorship-and-ai-use)

## Why it matters

- **The protocol keeps the record of used keys.** Leaf *i* signs only a transaction whose nonce key is *i*, at
  sequence 0 (`account/yul/Account.yul:54-61`). EIP-8250 marks that key used when the payment is approved, so a second
  payment on it is refused by the protocol itself: `Nonce mismatch: expected 1, got 0`. The verify frame contains no
  `sstore` (`Account.yul:46-116`).
- **Frame transactions leave no other safe place for that record.** The verify frame runs as a static call, so it
  cannot write "this key is used". A write in a later SENDER frame comes after approval, when two pending transactions
  in two lanes could both have passed against the same key. Consuming the nonce is the one state change the protocol
  makes in the same step as payment approval.
- **Many hash-signed payments from one account are pending at once.** Eight payments on eight nonce keys were admitted
  and pending together, and landed in two blocks of four (2,272 and 2,275). Given the same burst, the public mempool
  kept one and refused the next: `A pending frame transaction from this sender is already in the pool`.
- **A stuck payment is never fee-bumped.** A replacement would sign the same one-time key twice, and two signatures
  from one WOTS+ key let anyone forge a third. So a stuck payment waits out its deadline (an expiry frame the chain
  checks), its leaf is burned, and the retry goes out on a fresh key. Measured: the first attempt expired with its key
  unused at block 2,285, and the retry was included at 2,293.
- **Hot tickets carry caps the account enforces.** A phone or an agent holds a few one-time keys and no seed. The
  account refuses a payment above the value cap, to any other address, or after the kill switch, and names the rule it
  broke: `hot: value cap`, `hot: frame target`, `hot: disabled`. All three were refused on the devnet.
- **It fits the 100,000-gas verification cap** that the devnet enforces on every transaction. The signer nudges the
  fee until the message needs few enough hash steps, then signs once: 88,373 gas used of 90,000 declared, at 510 steps.
- **The chain's own verifier refuses forgeries**, including a valid signature of leaf A sent under leaf B's nonce key.
- **Three implementations agree, and 729 tests run offline.** The Rust signer's test vectors pass the TypeScript
  verifier; the TypeScript signer's vectors pass the Yul verifier and Quip Network's audited `WOTSPlus.sol`, used as an
  oracle for the signature format.

## Why you might not

- **Each payment costs about 186,000 gas**, nearly nine times a plain 21,000-gas transfer. The 2,594-byte signature
  sets the bill through the calldata floor of 64 gas a byte; the hashing does not. A shorter signature would lower the
  cost, and cheaper hashing would not.
- **The keys run out.** One tree holds 1,024 keys per chain at height 10, 16 of them hot tickets. After that the tree is
  rotated, and a rotation cancels every pending lane.
- **The signer must keep a journal.** The chain learns of a key only when its payment lands. Until then, only the
  signer's journal stops it from signing a second, different message with the same key. A seed alone is not enough to
  resume signing safely: after restoring one, rotate first.
- **The classical co-signature is built but off.** The account can require an owner ECDSA signature beside the
  hash-based one. The backend refuses to create such a wallet, and no measured profile uses it.
- **Hot tickets do not expire on their own yet.** Expiry through EIP-8272 recent roots, and a certified hypertree that
  grows without cancelling lanes, are designed and not built.
- **It runs on one devnet, with that devnet's quirks**: send through the miner's own sidecar, keep a 3 gwei floor on
  the priority fee, and expect at most four lanes relayed per 10-second pass ([evidence](#devnet-evidence)).
- **The nonce key shows the leaf number on chain**, so anyone can count how many keys an account has used.

## What is real, and what is not

| Part | Status |
| --- | --- |
| The account, its Yul verify frame and the factory | Real, deployed on the devnet; every transaction below was verified by it on chain |
| WOTS+ signatures and Merkle paths | Real: 2,594-byte entries, checked by the chain, by Quip's `WOTSPlus.sol` in tests, and by the Rust and TypeScript signers |
| Parallel lanes, the public mempool's refusal, expiry and retry | Real, on the devnet's alt mempool and node, with hashes |
| Hot tickets and their refusals | Real: ticket files from the Rust CLI, caps checked by the account |
| The backend and the three screens | Real: they send real transactions; the screens show only the backend's records |
| The agent screen's market price | **A mock**, labelled so on screen; it only decides when the agent fires |
| `fakechain/` | **A fake devnet** for tests and practice, chain 31337, marked FAKE CHAIN; it runs no EVM code and is never evidence |
| Hybrid ECDSA co-signature | Built in the account, **off**, refused by the backend |
| Recent-root expiry, certified hypertree | **Designed, not built** |

## Measured

| | Measured | Source |
| --- | --- | --- |
| Verify frame of the qualifying transaction | **88,373 gas** of 90,000 declared, 510 hash steps | receipt, block 386 |
| Whole transaction, cold leaf | **186,245 gas** | receipt, block 386; the same in 8 node simulations |
| Whole transaction, hot ticket | 186,373 gas (verify 87,947 at 405 steps) | receipt, block 441 |
| Verify gas per hash step | 54,928 + 65.53 × steps | 6 receipts, blocks 386 to 433 |
| Payments pending at once from one account | **8 of 8** admitted; landed in 2 blocks of 4, 57 s from the first send to the last landing | blocks 2,272 and 2,275 |
| The same burst on the public mempool | 1 pending; the next refused | block 2,165 |
| Stuck payment, then its retry on a fresh key | expired with its key unused at block 2,285; retry included at block 2,293, about 15 s after its send | |
| Hot-ticket refusals | value cap, wrong target, kill switch: each named by the account | node simulation, `revertData` |
| Lanes after a rotation (epoch 1) | 8 of 8 landed, blocks 2,660 and 2,662 | the three screens, run on the devnet |
| Signature entry | 2,594 bytes: 2,144 WOTS+, 448 Merkle path, 2 header | `Account.yul:77` |
| Calldata floor of one transfer | 166,720 gas, which is 2,605 billed bytes × 64 | computed with ethrex's billing, matches every receipt |
| Tests, offline, all passing | 729: 677 TypeScript (pipeline 271, web 189, backend 115, fake chain 90, demo 12), 25 Foundry, 27 Rust | `main` at `2542891`, Nov 6, 17:00 IST |

Every figure comes from a receipt, a node simulation or a test run on the devnet below, on Nov 5 and 6, 2026, and
every transaction is listed with its hash in [Devnet evidence](#devnet-evidence). A figure worked out from a formula
says *computed*.

## Quickstart

Needs Bun, Foundry (it installs solc 0.8.38) and Rust.

**1. The tests, offline.** Build the account first: the fake chain's tests read its compiled code. The slowest suite,
the fake chain's, takes about two minutes.

```sh
export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
(cd signer && cargo build --release && cargo test)
(cd account && scripts/build.sh && forge test)
for d in pipeline backend demo fakechain; do
  (cd $d && bun install && bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test)
done
(cd web && bun install && bun run typecheck && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test)
```

**2. The whole product on a local fake chain**, with no devnet and no keys of your own. The fake chain answers the
node's and the sidecar's JSON-RPC and models the account's checks in TypeScript; it runs no EVM code, so it proves the
logic, never that the devnet accepts the bytes. Each start is a new chain (id 31337) with a throwaway EOA and one
funded account.

Run each line from the repository root, in its own shell, after step 1:

```sh
cd fakechain && bun run.ts                        # prints the path of an env.sh; wait until it is ready
source <that env.sh> && cd backend && bun src/main.ts    # http://127.0.0.1:8787/api
cd web && bun serve.ts                            # http://127.0.0.1:5173, marked FAKE CHAIN
```

Take every `WL_*` variable from that `env.sh`: the pipeline's scripts have no guard of their own.

**3. On the devnet.** Needs a funded EOA key in `~/.winterlock/devnet-eoa.key` (one 0x-prefixed hex line, mode 0600).

```sh
export WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc       # the miner's sidecar: it relays
(cd account && scripts/build.sh && forge build)
(cd pipeline && bun install && bun scripts/deploy-account.ts)    # implementation, factory, one account
(cd pipeline && bun scripts/hashsig-devnet.ts)                   # the transcript above
(cd backend && bun src/main.ts)                                 # keep it running; the screens as in step 2
(cd demo && bun lanes.ts burst --wallet <address> --n 8)         # eight lanes at once
(cd demo && bun lanes.ts burst --wallet <address> --n 8 --mempool public)
```

Fire a burst when the last three blocks hold no public-mempool transaction, and send nothing to the public mempool
while alt lanes are pending ([why](#parallel-lanes-and-the-stuck-payment)). The three screens, `hot-cold.html`,
`agent.html` and `session.html`, each have a Play scene button that runs their story, and a Mempool switch between alt
and public. Seeds, journals and keys live in
`~/.winterlock`, never in the repository. The working name of the project was Winterlock, so packages, paths and
variables still say `winterlock` and `WL_`.

## How it works

Think of a cheque book.

- **The cheque book is a key tree.** It holds 1,024 one-time keys per chain (height 10). Each is a WOTS+ key: a
  hash-based signature, safe against quantum computers, that may sign only once.
- **Each cheque has a printed number, its leaf.** A payment signed with leaf 5 carries nonce key 5 at sequence 0. The
  full key is `(epoch << 32) | leaf`.
- **The bank stamps the number when it pays.** EIP-8250 marks the nonce key used at payment approval, in the same step.
  A second payment on the same key is refused by the protocol.
- **So the account keeps no list of used cheques.** No bitmap, no counter, no storage write in the verify frame.
- **The wallet still keeps a journal.** Until a payment lands, only the wallet can stop itself from signing a second,
  different payment with the same cheque, and the mempool would accept that second payment as a replacement with a
  10 % fee bump (`vendor/mempool-workshop-sidecar/packages/executor/src/entities/FrameTxMempoolEntry.ts:175-202`). So
  the journal (`pipeline/src/leaves.ts`) writes "reserved" to disk before anything is signed, and never moves a leaf
  backwards.
- **A stuck payment expires; it is never bumped.** Every transaction starts with an expiry frame, a deadline the chain
  checks (90 s by default, `pipeline/src/config.ts:68`). When a block past the deadline, read two blocks below the head,
  still shows the key unused, the payment can never land (`waitForInclusion` in `pipeline/src/submit.ts`). The wallet
  marks that cheque burned and pays again with the next one, on a new nonce key: a new lane.
- **Many cheques can be in flight at once.** Every payment has its own key, and the devnet's alt mempool holds one
  pending transaction per key, with no cap per account ([Parallel lanes](#parallel-lanes-on-the-alt-mempool)).

```
 web/ ──HTTP──▶ backend/ ──▶ pipeline/ ─── alt ───▶ ERC-8421 sidecar ──▶ ethrex node ──▶ account/
 three screens  seeds,       build, grind,            (miner's)             (devnet)       Yul verify frame
                journals     sign, send,  ─ public ─────────────────────────▶               behind an
                   │         follow                                                         EIP-1167 proxy
                   └──▶ signer/  Rust CLI: ticket files, signing from a ticket
```

The backend is the only process that holds seeds and journals, and it listens on 127.0.0.1 only. The pipeline is a
library with no HTTP; it also builds for a browser or a MetaMask Snap ([below](#using-the-pipeline-in-a-browser-or-a-snap)).

## Where to look in the code

| Claim | Where |
| --- | --- |
| The leaf is the nonce key, at sequence 0, in the current epoch | `account/yul/Account.yul:54-62` |
| The verify frame writes no storage | `account/yul/Account.yul:46-116` (no `sstore`) |
| The protocol consumes the key at approval | `account/yul/Account.yul:93-95`, `APPROVE` scope 0x3 |
| The chain id is hashed into every leaf | `account/yul/hashsig/HashSigVerify.yul:104-109` |
| WOTS+ in Quip's format | `account/yul/hashsig/HashSigVerify.yul:39-68`; checked in `account/test/HashSigVectors.t.sol` |
| Hot tickets' caps | `account/yul/Account.yul:98-116` |
| A leaf is reserved on disk before it signs, and never moves back | `pipeline/src/leaves.ts` |
| Expiry decided from the nonce manager, two blocks below the head | `waitForInclusion` in `pipeline/src/submit.ts` |
| Grinding to fit the 90,000 limit behind the proxy | `usableVerifyGas` in `pipeline/src/grind.ts`; `GRIND` in `pipeline/src/config.ts` |
| The 3 gwei tip floor | `withTipFloor` in `pipeline/src/rpc.ts`; `MIN_TIP_WEI` in `pipeline/src/config.ts` |
| ethrex's gas billing, the four gas columns | `frameGasModel` in `pipeline/src/estimate.ts` |
| Ticket files: cut, exported first, signed on the device | `pipeline/src/tickets.ts`; `signer export-leaves`, `signer sign --ticket-file` |
| Lanes: what one holds of the balance, the plan for N | `pipeline/src/lanes.ts`; `demo/lanes.ts` |
| The backend's API | `backend/src/app.ts`, `backend/src/backend.ts`, `backend/README.md` |

## Design

### Keyed only

Every hash-signed transaction carries exactly one nonce key at sequence 0. The verify frame refuses everything else:
another key count (`Account.yul:55`), the legacy key 0 (`:57`), a non-zero sequence (`:58`), another epoch (`:59`), a
leaf outside the tree (`:61`).

There is no sequential mode. An expired transaction leaves a sequential nonce unchanged, so the retry would re-sign the
same leaf. A fresh key at sequence 0 can be burned instead.

Accounts are created by an EOA calling the factory (`account/src/Factory.sol`, `createAccount`). A deploy frame would
need about 546,000 state gas, above the devnet's 500,000 state cap, and would use the legacy nonce `[0]`, which the
verify frame refuses. Creating an account from the EOA measured 953,678 gas, with six storage slots written.

### The verify frame, step by step

The account is a 45-byte EIP-1167 proxy to one implementation, a standalone Yul object (`account/yul/Account.yul`). The
EIP-8141 opcodes are emitted with `verbatim` (`Account.yul:37-41`). Their operand orders come from the ethrex source at
the devnet's commit, and were confirmed on chain ([Day-0 results](#day-0-results)). `account/scripts/build.sh` splices the
verifier `account/yul/hashsig/HashSigVerify.yul` in at `Account.yul:118` and compiles with solc 0.8.38
`--strict-assembly --optimize`.

| Step | What it checks | Lines |
| --- | --- | --- |
| 1. Dispatch | Caller 0xaa (the frame entry point) runs the verify path; the account itself runs admin calls; anyone else gets views, `initialize` (once, from the factory) or a plain ETH receipt | `Account.yul:27-33` |
| 2. Storage | Three cold SLOADs: root, tree seed, packed config. A hot leaf reads three more (slots 3 to 5) | `:48-52`, `:99-102` |
| 3. Nonce mode | One key, not key 0, sequence 0, the current epoch, leaf below 2^h. Hot when leaf ≥ hotStart | `:54-62` |
| 4. Signature shape | Entry count; with hybrid on, an owner ECDSA entry over the canonical hash; then the ARBITRARY entry: scheme, empty msg, length 2,146 + 32 × (h + 4), copied with SIGDATACOPY, version 1, slot at most 15 | `:64-82` |
| 5 to 8. Hash-based check | WOTS+ over the sig hash (TXPARAM 0x08), then the Merkle path to the stored root, with CHAINID hashed into the leaf | `:84-88`; `HashSigVerify.yul:15-30` |
| 9. Hot policy | Only for hot leaves ([Hot tickets](#hot-tickets)) | `:90-91`, `:98-116` |
| 10. Approve | APPROVE with scope 0x3, execution and payment. Here the protocol consumes the nonce key | `:93-95` |

Inside the hash-based check (`account/yul/hashsig/HashSigVerify.yul`):

- index = (slot << h) | leaf (`:23`); per-leaf public seed P = keccak256(treeSeed ‖ uint32(index)) (`:32-36`).
- 15 randomization elements r_k = keccak256(0x03 ‖ P ‖ uint16(k)), k = 1 to 15, as in Quip's `WOTSPlus.sol` (`:39-46`).
- 64 message digits plus 3 checksum digits; each chain runs 15 − digit steps of keccak256(x XOR r) (`:50-68`). The step
  loop is unrolled by the bits of the step count (`:74-102`). This is where the gas goes.
- leaf node = keccak256(P ‖ uint256(chainId) ‖ pkHash) (`:104-109`); h + 4 path hashes up to the root (`:111-120`).

Every refusal reverts with a 32-byte ASCII reason (`Account.yul:240`), such as `nonce: epoch` or `hot: value cap`. The
node's simulation returns it as `revertData`, so a refused transaction names the rule it broke.

What the verify frame reads, and why each read is allowed in a static frame: its own storage, TXPARAM, FRAMEPARAM,
SIGPARAM, SIGDATACOPY, CHAINID and memory. The verify path uses no TIMESTAMP, NUMBER, BALANCE, GAS or SSTORE, and
makes no CALL. The compiled implementation contains no ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT. The
proxy's GAS right before its DELEGATECALL passes the devnet's tracer.

The signature entry is 2,594 bytes at h = 10: version (1) ‖ chain slot (1) ‖ WOTS+ signature (67 × 32 = 2,144) ‖ path
(14 × 32 = 448). It travels in the transaction's own signature list as scheme ARBITRARY, which costs 100 gas toward the
prefix cap. The leaf index is not in the entry: it comes from the nonce key.

### Hot tickets

The top of each chain's tree is the hot band, leaves hotStart to 2^h − 1. With h = 10 and hotStart = 1008 there are 16
tickets. The cold device exports a range of hot leaves to a ticket file, holding the leaf secrets and paths and no seed
(`signer export-leaves`, file mode 0600). The hot device signs from it (`signer sign --ticket-file`) and keeps its own
journal (`pipeline/src/tickets.ts`). The cold journal marks the range exported before the file is written, so a ticket
is never handed out twice.

The account, not the app, enforces the caps (`Account.yul:98-116`):

- the value cap must be above zero: zero is the kill switch (`:100`);
- the transaction's maximum cost (TXPARAM 0x06) must be at most the fee cap (`:101`);
- every later frame must be a SENDER frame, with no calldata, to the one allowed target (`:107-110`);
- the sum of their values must be at most the value cap (`:111-115`).

Hot tickets carry no ECDSA entry (`:66`). A stolen hot device can spend at most its unused tickets times (value cap +
fee cap), to one address. `setHotPolicy` may keep or lower hotStart, never raise it (`:167`): raising it would turn
exported tickets into cold leaves, which have no caps.

### Hybrid co-signature: off

The account can require an owner ECDSA signature beside the hash-based one (`Account.yul:66-72`): scheme SECP256K1,
empty msg (so it signs the canonical hash, not just any digest), signer equal to the stored owner. It is off
(`hybridRequired = 0`), and the backend refuses to create a hybrid wallet. Turning it on costs 2,800 gas of signature
cost and 85 more billed bytes (a 20-byte signer and a 65-byte signature), 5,440 gas at the calldata floor (computed).

### Chain slots

One tree holds 16 chain slots of 2^h leaves. The same account address on two chains has two separate nonces, so
without slots, nonce 5 on two chains would sign two messages with one key. The chain id is hashed into every leaf from
CHAINID (`Account.yul:86`, `HashSigVerify.yul:104-109`), so a leaf built for one chain never verifies on another. The
slot byte only says where that chain's subtree sits (`HashSigVerify.yul:21-23`). Unlisted slots hold
EMPTY_SUBTREE = keccak256("nonce-bound-pq-wallet/empty-slot") (`pipeline/src/hashsig/tree.ts:11`). The demo lists one
chain, 1337, in slot 0.

### Rotation and admin calls

Admin calls are SENDER frames from the account to itself (`Account.yul:121-129`), signed by a cold leaf.

- `rotate(root, treeSeed, height)` installs a new tree and adds 1 to the epoch (`:133-147`). The new tree is built for
  generation = new epoch, so it shares no one-time key with the old one, and the installed tree is refused (`:139`).
  Rotation invalidates every pending lane, because their keys name the old epoch (`:59`), so the backend refuses to
  rotate while lanes are in flight.
- `setHotPolicy(hotStart, valueCap, feeCap, target)` (`:162-174`), with a guard that always leaves a cold leaf
  (`:236-238`).
- `setHybrid(bool)` refuses to turn on with no owner (`:153`); `setOwner(address)` refuses 0 while hybrid is on
  (`:180`).

## Parallel lanes on the alt mempool

A lane is one nonce key with a transaction pending. To have N payments from one account in the mempool at once, give
each its own key. Every Noncebound transaction already is a fresh key at sequence 0.

### The rules, side by side

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

### What the lanes share

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

### Order and timing

- Eight lanes need at least two relay passes, so they land over two or more blocks.
- Our grinder never changes the priority fee, so our lanes are relayed in the order they were admitted; only lanes
  within one pass can swap.
- A landed transfer changes nothing the other lanes read. A landed `rotate` or `setHotPolicy` can cancel them: every
  New lane is re-simulated each block (`SC/services/BundlingService/reconciliation.ts:423-477`).
- Three devnet facts decide whether lanes land, all found on Nov 6 ([evidence](#parallel-lanes-and-the-stuck-payment)):
  the public gateway admitted but had no peers to relay to, so send through the miner's sidecar; the sidecar relays the
  highest priority fee first, so the pipeline raises every fee quote to a floor of 3 gwei (`withTipFloor` in
  `pipeline/src/rpc.ts`, `MIN_TIP_WEI` in `pipeline/src/config.ts`); and ethrex drops a relayed lane when a
  public-mempool transaction rebuilds the block, so bursts take a 180 s deadline (`demo/lanes.ts --expiry-seconds`).

### The tooling

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

## Gas

### The four columns

| Profile | Declared verify limit | Measured verify execution | Intrinsic, signature bytes and floor | Receipt gas_used |
| --- | --- | --- | --- | --- |
| **Cold transfer, the qualifying transaction, block 386** | 90,000 | **88,373 at 510 hash steps** | fixed part 19,525; data about 41,500; floor 166,720 (2,605 billed bytes × 64) | **186,245** |
| **Hot ticket, leaf 1008, block 441** | 90,000 | **87,947 at 405 hash steps** (ground over 284 fee values) | floor 166,848 (2,607 billed bytes) | **186,373** |
| Cold transfer, 8 points, simulated on the earlier chain | 94,900, so every point could run | 82,390 to 92,326 at 420 to 570 steps | as the first row | 186,245 for all 8 (simulation) |
| Day-0 stub, no hashing, with owner ECDSA, block 405,523 of the earlier chain | not recorded | 20,317 | | 193,882 |

How the columns are computed (`frameGasModel` in `pipeline/src/estimate.ts`, after ethrex's `transaction.rs` at
`9aa3645d`):

- fixed part = 12,000 + 475 per frame + 100 for the ARBITRARY entry + 6,000 per value-carrying frame
  = 12,000 + 3 × 475 + 100 + 6,000 = 19,525;
- billed bytes = frame data (an 8-byte deadline) + signature bytes (2,594) + the RLP of the nonce fields (3 bytes for
  keys 1 to 127) = 2,605;
- data = 4 gas per zero byte and 16 per other byte, about 41,500 here; floor = 64 per billed byte = 166,720;
- gas used = fixed part + max(data + execution, floor) = 19,525 + 166,720 = **186,245**, matching the receipt and all
  8 simulations exactly.

The nonce key's RLP grows with the leaf, and each extra byte adds 64 gas at the floor: leaves 1 to 127 cost 186,245,
128 to 255 cost 186,309, 256 to 1,023 cost 186,373, and a leaf from epoch 1 costs 186,565 (computed; the epoch-1
transfer at block 2,907 used 186,565). A transfer with no value has no value-carrying frame and costs 6,000 less
(180,565 at epoch 1, measured at blocks 2,660 to 2,671). The backend reports all four columns for every transaction it
sends (`gas` on `GET /api/tx/:hash`).

### The measured fit

`pipeline/scripts/simulate-verify-gas.ts`, Nov 6, on account 2 of the earlier chain at its halted head, block 408,262.
Each point was signed by a fresh cold leaf, journaled before signing and burned after. Nothing was sent.

| Leaf | Hash steps | Verify frame gas | Frames (expiry / verify / transfer) | Whole transaction |
| --- | --- | --- | --- | --- |
| 1 | 420 | 82,390 | 3,051 / 82,390 / 100 | 186,245 |
| 2 | 450 | 84,525 | 3,051 / 84,525 / 100 | 186,245 |
| 3 | 480 | 86,280 | 3,051 / 86,280 / 100 | 186,245 |
| 4 | 495 | 87,094 | 3,051 / 87,094 / 100 | 186,245 |
| 5 | 510 | 88,429 | 3,051 / 88,429 / 100 | 186,245 |
| 6 | 525 | 89,356 | 3,051 / 89,356 / 100 | 186,245 |
| 7 | 555 | 91,344 | 3,051 / 91,344 / 100 | 186,245 |
| 8 | 570 | 92,326 | 3,051 / 92,326 / 100 | 186,245 |

Fit: verify frame = 54,630 + 66.09 × hash steps, largest residual 252 gas. From real receipts on the current chain
(account 3, `pipeline/scripts/hashsig-devnet.ts`): 54,928 + 65.53 × steps over six included transfers (510 → 88,373;
510 → 88,376; 495 → 87,397; 510 → 88,310; 480 → 86,246; 465 → 85,475). The two fits agree within about 20 gas at the
510-step edge. Hash steps per message: 506 on average, 420 at the 1st percentile and 600 at the 99th, 45 at best and
990 at worst; every reachable count is a multiple of 15. The standalone verifier alone measured 24,070 + 66.06 × steps
(`pipeline/scripts/measure-verifier.ts`).

### Why the bill is flat

The 2,594-byte signature dominates. The floor (166,720) is larger than data plus execution whenever execution stays
under about 125,000 gas, and the prefix cap keeps it under 100,000. So every hash-signed transfer costs the same,
whatever its verify gas. Cheaper hashing would not lower the bill; a shorter signature would.

### The proxy finding (EIP-150)

The account is an EIP-1167 proxy. Its DELEGATECALL passes on only 63/64 of the gas left (EIP-150), so a verify frame
declared at 90,000 can use about 88,643. Point 6 above shows it: 525 steps need 89,356, which runs out of gas behind the
proxy. The grinder used to accept 525-step messages, about 14 % of all messages. Fixed in commit `5b24bd8`:
`usableVerifyGas` in `pipeline/src/grind.ts` subtracts the holdback, and `GRIND` in `pipeline/src/config.ts` comes
from the measured fit plus a 300-gas margin. Cold messages now fit up to 510 steps (66 % of messages) and hot ones up to
409 (about 1 in 231, an exact count over the digit distribution). Three transfers on the current chain then used
exactly 510 steps and fit (88,310 to 88,376 against the 88,643 usable).

### Grinding

The signer changes the transaction until its message needs few enough hash steps, then signs once. It moves
`maxFeePerGas` by one wei per try, up to 4,096 tries, and leaves the deadline exact. When the caller fixes the fee, the
backend moves the last frame's execution limit by one gas per try instead. A preflight simulation still refuses any
message the model gets wrong. Every transaction record keeps the grind (`grind` on `GET /api/tx/:hash`): the field
varied and the steps of every message tried, such as 525 then 495 under a 510 limit (block 2,907).

### The caps beside it

The declared prefix is 5,000 (expiry) + 90,000 (verify) + 100 (signature cost) = 95,100, under the 100,000 cap that both
the public mempool and the devnet sidecar enforce (Day-0: 120,000 refused, 95,000 admitted). Quip's 190,792 is the call
gas of a stateful wrapper with two storage writes, a different profile: compare verify with verify, and total with
total.

## Devnet evidence

Devnet: chain 1337, 6 s blocks, node `https://altmempool.forshtat.com` (`ethrex/v23.0.0-eip8141-tracer-9aa3645d…`),
miner's sidecar `https://altmempool.forshtat.com/rpc` (`skandha/v4.1.1`), gateway
`https://altmempoolgateway.forshtat.com/rpc`. The explorer, `https://explorer.altmempool.wtf/tx/<hash>`, keeps its
history in memory and reads the gateway, so every row below also carries its full hash and block; a lane sent to the
miner's sidecar may not appear there.

### The current chain

The devnet halted at block 408,262 on Nov 6, 04:28 IST, and came back at about 11:54 IST as a new chain: the same chain
id, ethrex build and system contracts, but a new genesis
(`0x2ad3f67b059fbde111ad7af27cfb4955d997351579612237ca0318937a5bae7a`) and block numbers from 0. Every contract and
balance was gone. Each seed is pinned to the genesis it was made for (`pipeline/src/genesis.ts`), so the seeds of the
earlier chain refuse to sign here, as designed.

| What | Transaction | Block |
| --- | --- | --- |
| **The qualifying transaction: the first hash-signed transfer on this chain.** Account 3 pays 1 wei with one WOTS+ signature of leaf 1 (nonce key `0x1`, sequence 0): 510 hash steps, verify frame 88,373 of 90,000, 186,245 gas; "included: 17 of 17 rules passed" | [`0x3446d855…`](https://explorer.altmempool.wtf/tx/0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175) `0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175` | 386 |
| Five more cold transfers, leaves 5 to 9, all 17 of 17, for the gas fit | `0x9deeb8ffde62b3e6b285016b05ce621b6b0d24712a5d7693bb81de9b8cb45875`, `0xb49df1f54481bd0d6286d327d0f5c3f693abd64c3aa2852941055eae9c730dc6`, `0xac82c9ca6c75ddc2ea999412e66de2c7b0d3a515d4f379bf945ecc5511f152f6`, `0xd09fb2e8cf248b55b03cd1001bcdc477e6cede489787eea762af36c4bafa46b2`, `0x9b00f09510837d152ee9ef8138c584de3f142908911cb96532cf861be837be7a` | 399 to 433 |
| **Hot ticket**, leaf 1008 (key `0x3f0`), no classical key, 0.001 ETH to the one allowed target: 405 steps, verify 87,947, 186,373 gas, 17 of 17 | [`0x8d0aefb7…`](https://explorer.altmempool.wtf/tx/0x8d0aefb70282cad3212ce08e9df8f0d9d7228805787fdb56faaea49c162272ce) `0x8d0aefb70282cad3212ce08e9df8f0d9d7228805787fdb56faaea49c162272ce` | 441 |
| Two forgeries refused by the account in simulation, `sig: hash-based check`: one signature byte flipped, and a valid signature of leaf A under leaf B's nonce key | simulation only; leaves 2 to 4 burned | – |
| The pipeline with plain ECDSA: the test EOA calls `increment()` on a counter contract in a frame transaction, nonce key `0x200000007`, 17 of 17, count 0 → 1 | `0xd801fbfd8f2bd2963b71df19091ec1a560dd3888099c6b46e96f59a4ad4313e5` | 366 |

### Parallel lanes and the stuck payment

All on account 3, through the backend, on Nov 6.

- **8 lanes at once, the scene** (about 16:00 IST): admitted 8 of 8, 8 pending at once, landed in two blocks of four,
  57 s from the first send to the last landing (leaves 36 to 43):
  - block 2,272: `0x39b205e1fa214ca13b5c8bd956c6477993f586ed4a2fc67846b21b62575b5163`,
    `0xebfc703ea10c576eb54b81acae727046cf41c13e0f40bcdaec309410742b0f2b`,
    `0xec4cfe374c2aaa00a2ca7a0fd5d08f745e97753aee706545d718fb5a9cd058b2`,
    `0xc5a16a74492e2fa1ec92bd41d55ab40375594e533a198e23da45f4af73db0125`;
  - block 2,275: `0xb6d18d7323074c006125cb159545d9af953243eda2c994604e8df668f3e3ad92`,
    `0xcc8622f4dafc80371b2156b596a49ccb7ad22316ab5ae713c502cdd63e50e596`,
    `0x8a39af57f89ccbcc693eda8b65588879934dacbe06ca5bc132f2bf720e83f2d6`,
    `0xf71a23cceb43fd3447bca7ad2c7647ce5b489be3d5325ca03c3a459594855295`.
- **4 lanes at once**, all in block 2,255 (leaves 32 to 35):
  `0xcd7392ff8a2595f1f27b70e9f55d9006be30a7dc446544a6cc650e5e17569a8b`,
  `0x06df7eeffb9ff4dce6009b684b6cc46691598c8974f3cbfd4bb0b7ff747ab4c2`,
  `0x922b410cebeba99b271666c7367377daf49c1ea43da2a0611b9bee947b242f6a`,
  `0xd85174489240554f1748e0470bc6a3e8bfdcaffd5e5f074c4d80446fa45c3991`. One lane alone, leaf 31, landed in block 2,247
  about 19 s after the send (`0x2fdd5db408a23a6197cce7c2714d1614b1a282129dc7f625d1b44f171a246787`).
- **The public mempool holds one per sender** (`demo/lanes.ts burst --n 2 --mempool public`): leaf 29 was admitted and
  landed in block 2,165 (`0x0d9f3e811f69b34ccf35989fe0370aa8e867357f4fa057121926d3b9db988fb8`); leaf 30 was refused at
  submission because the account already had one pending (`0x2f85ba7741349ffbe67bee24fb5b1ce3d6eb9a14b01866b5a776ecc1cb6ad202`,
  never pending; the leaf is burned).
- **The stuck payment** (0.001 ETH, a 4 s first deadline, one retry): the first attempt, leaf 44
  (`0xfd8fc1be49389c57ff4e1efe67d91e80c29f51300374432575bb8d39f46da377`), expired with its key unused in block 2,285, its
  leaf burned and no fee paid. The retry went on a fresh lane, leaf 45, key `0x2d`, neither re-signed nor fee-bumped,
  and landed in block 2,293 about 15 s after its send (`0x28cdd22fb85d2da094d0a05db311a6ba2ec868246c4da3b1ebd2af9593885e00`).
- **A hot ticket signed from the ticket file** by the ticket device, with no master seed: 0.005 ETH, under the
  0.01 ETH cap, leaf 1,011, key `0x3f3`, block 2,300 (`0x76870aaeb0e218431107db7cd670b737116d1c33982859bfe5d6ff34648a04e9`).
- **Two hot refusals** by the node's preflight simulation, each named by the account: 0.1 ETH against the 0.01 ETH cap,
  `account: hot: value cap` (leaf 1,009); 0.001 ETH to `0x…dEaD`, `account: hot: frame target` (leaf 1,010). Both
  tickets were signed and so are burned; neither was sent.
- **Before the fix**, between 14:50 and 15:30 IST, two 8-lane bursts and two stuck-payment retries all expired with
  their keys unused, so no fee was paid (leaves 10 to 28 burned). The gateway admitted but had no peers to relay to;
  the miner's sidecar relayed by priority fee, and our oracle-priced tip of 1,999,999,993 wei waited behind a team that
  pays a flat 2 gwei; and ethrex drops a relayed lane when a public-mempool transaction rebuilds the block (`payload.rs`
  at `9aa3645d`). Over 197 relay pushes from all senders, a push landed in 62 of 66 blocks with no public transaction
  and 20 of 51 with one. The tip floor, the 180 s burst deadline and sending in a quiet window fixed it. One hash per
  group: `0xebd20c49c4395887c82f051f8c9171ce1ff4a764cacb2fd1a65c20250b6411fd` (gateway burst),
  `0x43872511cdb78dbd4d0303158985ea703a4c1b0f7d332dee9286a703cb553468` (sidecar burst, relayed 4 times and cancelled).

### The three screens, end to end

On Nov 6, 16:13 to 16:49 IST, the three screens on `main` drove a backend on the devnet through the miner's sidecar.
The backend created a new wallet, `0x273CA502D7A6648A043e958E8d6618d16F892C80`, by an EOA call to the factory
(`0x01cf5e56d53859e13f456454ec967628065ac200ef5ca02ea7d03bc29fad7c78`), funded it from the EOA because the sidecar's
faucet was off (`0xeac14ea219a2072274456a12d53e5bafca938c2c707bb20e1215d589051df42b`), cut tickets and made 38
transactions. Every one ended as designed.

| Scene | What happened | Transactions | Blocks |
| --- | --- | --- | --- |
| Hot and cold: the phone pays while the laptop is offline | Three hot payments on three lanes; leaves 1008 and 1010 landed | `0xf6ab1a631a2d32ddbaf95f0e74b6be572e198896a708b0b31bfa5a8a7b2a3710`, `0x1c490883563db0dcdf6f89a82aaa09fe72c15e2c72976f001def78e05457f971` | 2,557 |
| Hot and cold: the stuck payment | Leaf 1009, a 4 s first deadline, expired with its key unused; the retry on leaf 1014, not re-signed, landed | `0xfdc22d0deb352a93688c3b8c58bf04eeb1fc845f2eb53d711792cfcdbe00cc65` → `0xb9b6bf3eaccb99a4e6299bd00a4526cd2d8800c8b4d9b6e0b26d1efc83c60743` | 2,555 (expired), 2,565 |
| Hot and cold: Mempool switched to public | Three payments 3 s apart: each was admitted only while none was pending, so leaves 1011 and 1012 landed one block apart and leaf 1013 was refused, "A pending frame transaction from this sender is already in the pool" | `0x57ccec4e07fa9c5a8d2688976163cace6ac95888943ad494cf611925461568e3`, `0x117f12cc2ba6e8dd0a2d57ac8f76580c6483940b0d218efcd73385ebf52d5e58`; refused `0xd2e6847e0f154d032177cfdb018d88339bacf8f72668626e224ceb49b606bc13` | 2,556, 2,557 |
| Kill switch | `setHotPolicy` with value cap 0, signed by cold leaf 3; a hot payment (leaf 1015) refused, `hot: disabled`; cap restored to 0.01 ETH by cold leaf 5 | `0x69d346860ef645bcd1f169944bf91084c4465fa69d979e0feb4bbe8214898102`, `0xe71540ec5724bf63f9449066e8b719233ead43a8244279d790729e61ddac68d0` | 2,590, 2,600 |
| Agent: four tranches in one second | Leaves 1016 to 1019, 0.01 ETH each, all in one block | `0x599f4bfc124e226f43d0ce28065cecf33983232d8c4ed55ef687b897b5055190`, `0x667da2c230aaf1788c226c7dcbf8475543053229d97ea2cd97997801f944a8a6`, `0x68f66bd46e6d3ea6a3d71589471131074178644e35826a6aac898d40f5442179`, `0xb8f4fdb1d04ed0e4afa98a644a25cab2986fc80a77957a46c7bacf00bde0779a` | 2,612 |
| Agent: server compromised | 0.001 ETH to a new address refused, `hot: frame target` (leaf 1020); 0.1 ETH refused, `hot: value cap` (leaf 1021) | refused in preflight, never sent | – |
| Rotation | `rotate` signed by cold leaf 8; the backend switched to epoch 1 once the chain showed it | `0xc413551b3cdf799da7c926f54d710663b48a15b2ceedd1c3b8ea659c75d90eef` | 2,652 |
| Session: eight moves, at epoch 1 | Leaves 1008 to 1015 under keys `0x1000003f0` to `0x1000003f7`, landed out of order over two blocks | 4 in 2,660 (`0xdaac9a27b75a03bedc5bbe549d0fc4b251ba0d848c1f9b3f5f68fe6c14abd747`, …), 4 in 2,662 (`0xa3fdd862a6ad9d526998614d7c519ff2ec1b125f1111f789dac68c803f4aaa6c`, …) | 2,660, 2,662 |
| Session: Mempool switched to public | Eight moves: two landed, six refused while one was pending | `0xc2068b3cd44f6799699b1e6fb92f86c9be52b11b8230c3ccc46002d1fc5a2f86`, `0x3c0330edd076097ca7f2ae6d83a60c94b0619295b958429ff54ac392402e0f76` | 2,670, 2,671 |
| Cold payment at epoch 1, with the grind recorded | Leaf 0 of epoch 1 (key `0x100000000`): messages of 525 and then 495 steps tried under a 510 limit | `0x14e518e52dd1801bdaeaf97e4c33dd29927321e6608f100ed6139ed8af265856` | 2,907 |

### The earlier chain (before the halt)

These blocks no longer exist; the explorer links are dead.

| What | Transaction | Block |
| --- | --- | --- |
| The first hash-signed transaction of the event: account 1 (`0x9908548a8b28d85191dc04d27d1d3c6e1430439b`), leaf 3 (nonce key `0x3`, sequence 0), 420 hash steps, verify 89,006 of 94,900 declared (an older verifier), 186,245 gas, 17 of 17 | `0x38b51a318a039225d17feaf6257b7f71c1ca66c81fb511d5b8a90ad3dad26475` | 407,107 |
| The pipeline's first transaction (V2): the test EOA with native ECDSA, nonce key `0x200000001`, a leading expiry frame | `0x31cc7937cb5d7ba3f48e1f7e5b75ee6070ff34f8396a4685e87b866cee2464af` | 405,073 |

### Accounts and contracts

| What | Address |
| --- | --- |
| **Account 3**, current chain: h = 10, hotStart 1008, hot value cap 0.01 ETH, hot fee cap 0.002 ETH, allowed target `0x5544596212F91984C986A919C8026DF0576816f9`, hybrid off; created at block 375 (953,766 gas), funded 0.2 ETH at block 376 | `0xf3e63d269dae09032ea950cd9722733e9b3f2d37` |
| Implementation (block 373) and factory (block 374), current chain | `0x13075a0f56d6a793eba4493d866e6502052abe87`, `0xe7227c802ea370f04ae533827041c89dc5a4e659` |
| The screens' wallet, current chain, created by the backend | `0x273CA502D7A6648A043e958E8d6618d16F892C80` |
| Test EOA | `0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d` |
| Earlier chain: account 2 (current verifier), its implementation and factory; account 1 (older verifier); the standalone verifier used for gas measurement | `0x4565906974d62abf53ad28165ef0ec43a1e39f57`; `0x9b8ed97f198ce8f8adb20e16056fb1a29818213f`, `0x4b1cbca3a579bb55b1f948ad1c517a05c9aca6cb`; `0x9908548a8b28d85191dc04d27d1d3c6e1430439b`; `0xA6Ecb14e644631C0ae9178Ab3383a72Fc384ec61` |

### Day-0 results

Probed from Nov 5, 21:00 IST, on the workshop devnet, before any project code was written. The probe scripts are kept
outside this repository.

| Check | Result |
| --- | --- |
| Chain and clients | Chain id 1337; 6 s blocks (over 10 blocks); node `ethrex/v23.0.0-eip8141-tracer-9aa3645d…`; sidecar `skandha/v4.1.1` |
| Legacy nonce encoding | `[0]` accepted. `[]` refused: "nonceKeys count must be between 1 and 16" (-32602) |
| One key, used twice | Sequence 0 admitted and landed. The same key at sequence 0 again: "Nonce mismatch: expected 1, got 0" (-32500); its nonce-manager slot reads 1. The same key at sequence 1 is admitted, so the account itself must require sequence 0 (`Account.yul:58`) |
| Single-use sentinel 2^64 − 1 | Not sent: the sidecar's static check refuses it ("nonceSeq must be < 2**64 - 1") |
| Two keys pending at once | Two keyed transactions on two keys from one EOA pending at once, landed in the same block. A second transaction in a pending (sender, key) slot at the same fee: "Frame transaction cannot be replaced: fee too low" |
| TXPARAM | Selectors 0x00 to 0x11 exist; the values logged on chain matched (block 405,513) |
| SIGPARAM, SIGDATACOPY, FRAMEPARAM | Operand orders from the ethrex source at `9aa3645d`, confirmed on chain. All 18 reads `Account.yul` needs pass the tracer in a VERIFY frame: 317 gas besides the 20,000 key cost |
| Yul with `verbatim` | Compiles with solc 0.8.38 `--strict-assembly --optimize`; its TXPARAM read runs on chain (block 405,590). A hybrid probe passed 14 checks, including SIGDATACOPY of a 2,594-byte entry, for 1,379 gas besides the key cost |
| Expiry verifier | No code at the EIP's `0x81413f0c…FfFf`. Live at `0x…8141` (26 bytes). A leading expiry frame is accepted; it used 3,051 gas (block 405,073) |
| Nonce manager | 5 bytes (`revert(0,0)`) at `0x…8250`; no code at the EIP's address |
| Recent roots | 144 bytes at `0x…8272`; none at the EIP's address. Write and reference not tried |
| Verify budget | A 120,000 prefix is refused: "validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX_VERIFY_GAS 100000" (-32602). 95,000 is admitted. A flat 100,000, no per-entity budget |
| First use of a key | 20,000 execution gas inside the verify frame (20,170 at sequence 0 against 170 at sequence 1) |
| Proxy | An EIP-1167 proxy's DELEGATECALL is accepted in the verify frame; about 3,060 gas (23,227 against 20,170 direct) |
| Account checks before hashing | Cold 30,677; hybrid cold 30,798; hot 37,300, measured without the hash-based check |
| Signature entry | A 2,594-byte ARBITRARY entry beside a 65-byte ECDSA entry is admitted and included; ARBITRARY costs 100 toward the prefix cap; TXPARAM 0x08 equals the vendored codec's `computeSigHash` (checked on 2 transactions) |
| Calldata floor | 193,882 gas used with a 20,317-gas stub verify frame (block 405,523): the floor sets the bill |
| CHAINID | Passes the tracer |
| Bytecode | `account/build/Account.bin`: 1,992 instructions, none of ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT |
| Simulation fields | `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid` and `canonicalMempoolViolation`, not the documented `valid` and `violation` |
| Old state | Real state only for about the last 126 blocks. Older block numbers silently get the latest state, with no error |
| Faucet | 1 ETH per call on the gateway; a code-less address can be funded |
| Not run | A 2,914-byte entry (h = 20); `eth_estimateFrameTransactionGas` across 60,000 to 95,000; a recent-root write and reference; the stake flow |

## Trade-offs

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

This table is the design document's, unchanged. Where the build differs from it:

- **Hybrid:** off in the build, not on by default ([Hybrid co-signature](#hybrid-co-signature-off)).
- **Keyed only:** no transaction uses the legacy nonce, not even the deployment, because an EOA calls the factory.
- **Minimal proxy:** the DELEGATECALL also holds back 1/64 of the verify gas ([the proxy finding](#the-proxy-finding-eip-150)).
  "Under 100k" is the code deposit alone (45 bytes × 1,530 = 68,850 state gas); a whole creation also pays for the new
  account and its storage slots.

## Prior art

Hash-based accounts exist on Ethereum today. What is new here is narrow: the key index is the protocol's own nonce
key, consumed atomically by payment approval, so validation writes nothing.

**The claim, stated exactly:** to our knowledge this is the first hash-based-signature account on frame transactions
whose one-time-key index is the protocol's own nonce key, consumed atomically by payment approval, with no account
storage write per signature. We do **not** claim the idea of nonce-indexed one-time keys (QRL, EIP-8310 and the Safe
forum's Winterlock proposal below), the first hash-based account on Ethereum (Quip, ERC-4337, mainnet 2026-09-17), or
the first on frame transactions (NiceTry's FORS+C FrameAccount, with an enforced rotation frame).

| Project | What it is | How it tracks used keys | Transport | Measured gas | Notes |
| --- | --- | --- | --- | --- | --- |
| [Quip Network hashsigs-solidity](https://github.com/quipnetwork/hashsigs-solidity) | WOTS+ verifier library in keccak: n = 32, w = 16, 67 chains, 2,144-byte signature, 64-byte on-chain key (publicSeed, publicKeyHash) | Stateless library; wrapper example stores a cursor or bitmap per key | Direct calls, ERC-1271 | Stateful wrapper 190,792 (256-bit), 117,759 (128-bit) | AGPL-3.0; Oak Security audit dated 2026-09-24 |
| [Quip ethereum-sdk](https://github.com/QuipNetwork/ethereum-sdk) | Production ShrincsWallet: stateful tree (4,096 leaves deployed) plus stateless FORS-C fallback; hybrid owner ECDSA and hash-based signature on the userOp path | Used-leaf bitmap and an action nonce written in validation (SSTORE per tx); explicit key rotation | ERC-4337 v0.7 EntryPoint only | Wrapper overhead ~7.7k per validation | Deployed Ethereum mainnet 2026-09-17; no EIP-8141 or 7702 |
| [Skale xmss-solidity](https://github.com/skalenetwork/xmss-solidity) | RFC 8391 XMSS verifier, SHA-256, formally checked | README tells the caller to keep a leafUsed mapping | Library | ~745k | MIT |
| [OpenZeppelin community PR #301](https://github.com/OpenZeppelin/openzeppelin-community-contracts/pull/301) | Draft keccak XMSS ERC-7913 verifier, n = 16 | Not addressed | Library | None published | Author notes it is AI-generated and unreviewed |
| [poqeth (ePrint 2025/091)](https://eprint.iacr.org/2025/091.pdf) | Benchmarks of PQ verification on Ethereum | n/a | n/a | Hash-based ~295k | Academic |
| [pq-dksap](https://github.com/ivanmmurciaua/pq-dksap) | ML-KEM stealth receive, ML-DSA spend over EIP-8141 frame txs | n/a (lattice, reusable key) | EIP-8141 testnet | Not published | Proof of concept |
| [QuantumCanary](https://github.com/identity-md-launches/launch-1213-src-quantumcanary-sol) and BitMEX Research canary | Nothing-up-my-sleeve secp256k1 address as a quantum alarm | n/a | n/a | n/a | Not built here |
| Winterlock (Safe forum proposal, 2026-10-09) | Proposed EIP-1271 Safe owner verifying WOTS signatures against a Merkle tree; SPHINCS+ for recovery; optional STARK-batched verification | "Each key is valid for one Safe nonce only"; separate key slots planned for flows that sign more than once per nonce | Safe owner contract (ERC-1271), not frame transactions | none; proposal only, no code yet | Closest prior statement of the nonce-indexed idea. Safe's nonce is contract state; ours is consumed by the protocol |
| NiceTry (Solvency-Labs / RivaLabs, ethresear.ch 24273 and 24526, 2026-03 to 2026-05) | ERC-4337 account rotating the signer every operation; now FORS+C few-time signatures as primary, WOTS+C kept as comparison; a FrameAccount path for EIP-8141 that requires the next frame to be the rotation frame | Rotation write in a SENDER frame after approval; FORS+C chosen because it degrades gracefully under bounded reuse | 4337 UserOp; frame-transaction path pending its opcode bridge | WOTS+C about 73k, FORS+C about 35k verify on Sepolia (their figures) | The only other hash-based design on frame transactions we found. Their rotation write tolerates the two-lanes race by using a few-time scheme; we remove the race by consuming the nonce key |
| QRL (Quantum Resistant Ledger) | XMSS-based chain since 2018 | Wallets use the transaction nonce to pick the next one-time key; the chain also tracks used OTS indices on chain | its own protocol | n/a | Historical prior art for nonce-guided key selection |
| EIP-8310 (2026-06-19) | Post-quantum keystore for stateful leanXMSS validator keys | Synchronized mode leaf = f(slot); signer-side high-water mark; reserved disjoint leaf ranges; durable state authority | consensus layer | n/a | The consensus-layer analogue of this idea; its warning that recovering a seed is not the same as safely resuming signing applies here too |

**A note on the name.** This project's working name was Winterlock, and its repository, packages, paths and variables
still use it. It is not the Safe forum's Winterlock proposal above, which is different work by other people; the
project was renamed Noncebound on Nov 6 so the two are not confused.

**Deliberate reuse.** We adopt Quip's WOTS+ wire format bit for bit (chain function, randomization elements, checksum,
key hash), so their code can serve as a test oracle (`account/test/HashSigVectors.t.sol`,
`account/test/WotsDigitsOracle.t.sol`). We wrote our own verifier and tree. Quip's code is AGPL-3.0: it runs only in our
tests, and nothing we deploy or build links it.

## CROPS

The prize page defines CROPS as censorship resistant, open source, private and secure.

- **C, censorship resistant.** The account pays its own fees: no paymaster, and no bundler signs for it. Any node that
  runs the alt mempool can carry its transactions; today the pipeline sends to one, the miner's sidecar
  (`WL_GATEWAY_URL`). If that node refuses or goes away, only time is lost: a refused payment burns its leaf at once,
  and a stranded one dies at its deadline, after which the next send can go to another node. Each payment is its own
  lane, so one stuck payment cannot block the others.
- **O, open source.** MIT. The account, the verifier, both signers (TypeScript and Rust), the test vectors, the
  pipeline, the backend, the screens and the fake chain are all in this repository.
- **P, private.** Seeds and keys stay on the machine, in files under `~/.winterlock`, read only by local processes: the
  backend, the Rust CLI it runs, and the pipeline's scripts. The backend listens on 127.0.0.1 only (`SERVE` in
  `backend/src/app.ts`). The screens make no third-party request: the fonts are self-hosted and the content security
  policy allows only the page's own origin (`web/serve.ts`). The pipeline reads the devnet's public RPC directly. A
  nonce key shows the leaf index on chain.
- **S, secure.** Hash-based signatures with n = 32: about 128-bit security against a quantum attacker (Grover). The
  protocol, not our code, guarantees each one-time key is consumed once. The journal is written before signing, a
  payment is never fee-bumped, and hot tickets are capped by the account itself.

## ETHGlobal Mumbai 2026

Entered in the Classic track, for the Ethereum Foundation's *Best use of the Frame Transaction Alternative Mempool*
prize. What the prize asks for, where it is in this repository, and where it shows:

| The prize asks for | Where it is |
| --- | --- |
| A frame-transaction application on the alt mempool; area one names "PQ-secure smart wallets" | The account (`account/`), the pipeline (`pipeline/`), the backend and the three screens. The verify frame fits the 100,000 cap; what needs the alt mempool is many hash-signed payments from one account pending at once ([Parallel lanes](#parallel-lanes-on-the-alt-mempool)) |
| An admitted transaction on the devnet explorer | [`0x3446d855…`](https://explorer.altmempool.wtf/tx/0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175), block 386, 17 of 17 rules passed, and every transaction in [Devnet evidence](#devnet-evidence) |
| The ability to explain the design, the code and the trade-offs | [Design](#design), [Gas](#gas), [Trade-offs](#trade-offs), and the verify frame line by line in `account/yul/Account.yul` |

The demo runs the three screens on the devnet: hot and cold first (parallel lanes, the stuck payment and its retry,
the public mempool's refusal), then the agent (four tranches in one block, the two named refusals), then the session
(moves landing out of order). [The three screens, end to end](#the-three-screens-end-to-end) lists every transaction
of one such run.

### What existed before the event, and what was built during it

Hacking began on Thu Nov 5, 21:00 IST. **No project code existed before it.** Before it there were a design document
(Nov 1, revised Nov 3) and a build plan (Nov 4), disclosed to ETHGlobal in writing as pre-existing design, and three
static UI prototypes (Nov 4), which are not in this repository and were not used: the screens were written during the
event from the design's text. Times below are IST.

| Commit | When | What |
| --- | --- | --- |
| `f118189` | Nov 5, 01:21 | A 3-line README, to check GitHub write access |
| `3b5fe45` | Nov 5, 15:58 | Empty stubs written with Claude Code: hello-world Rust crates in `backend/`, `pipeline/` and `signer/`; a Foundry skeleton in `contracts/`; `bun init` in `demo/` and `web/`; submodules for forge-std, Quip's hashsigs-solidity, mempool-workshop and mempool-workshop-sidecar |
| `5395bac` | Nov 5, 18:33 | The submodules replaced by plain vendored folders: third-party code only |

During the event:

| When | What | Merged as |
| --- | --- | --- |
| Nov 5, 21:00 to 22:30 | Day-0 probes on the devnet; the scripts are kept outside the repository | – |
| Nov 5, 23:25 | The frame-transaction pipeline in Bun and TypeScript | `5fcf6c3`, PR #3 |
| Nov 6, 02:42 to 05:10 | The Rust signer and CLI, the test vectors, ticket files, benchmarks, the WebAssembly build | PR #4, `dac0256` |
| Nov 6, 06:01 to 06:04 | The Yul account, the TypeScript signer and the Yul verifier, the hardened send path, fee grinding | `445cdaa`, `2a631c3`, PR #3, `253334b` |
| Nov 6, 07:16 | MIT licence, AI attribution, two CLI fixes | PR #5, `cbba437` |
| Nov 6, 10:09 | The grinder fix for the proxy's 63/64, the measured `GRIND` | PR #6, `934d964` |
| Nov 6, 11:58 | The local fake chain, `fakechain/` | PR #7, `ef9b102` |
| Nov 6, 14:15 to 15:45 | The backend, the three screens, the parallel-lanes CLI, a browser- and Snap-safe pipeline core | PR #8, `88e9660` |
| Nov 6, 15:54 to 16:46 | The tip floor and the 180 s burst deadline; the screens' Ledger design and the key register; the grind and gas columns on every transaction | PR #9, `a724fb7`, `326471f`, `2542891` |

The plan expected an outside signature library to be published before the event; it was not, so the hash-based scheme
was written during the event (`account/yul/hashsig/HashSigVerify.yul:1-2`). The qualifying transaction of the earlier
chain landed at block 407,107, before PR #3 was merged.

## Differences from the design document

| The design says | The code does | Why |
| --- | --- | --- |
| WOTS+ randomization elements r[0..14] | r[1..15] (`HashSigVerify.yul:7,42`) | Quip's `WOTSPlus.sol` uses r[1..15], and the oracle tests pass |
| The vector file's `params.chains` | The Rust vector file writes `params.hashChains` | Not changed during the event |
| CLI `--seed` | No `--seed` flag: `--seed-file` or `PQ_SEED` only | The plan says never pass a seed as an argument, where process lists show it |
| `export-leaves` without a band | Needs `--hot-start` and refuses colder leaves | A ticket must be a hot leaf |
| `sign --ticket-file` with the tree flags | Refuses the tree flags | The ticket file carries them |
| `verify` prints `{ok: false, reason}` | Exits 1 with an error object | Not changed during the event |
| `vectors --seed --count` | Takes `--height`, `--chains` and `--out` only | Not changed during the event |
| A tree cache; sign under 50 ms warm | No cache: 0.36 s per signature from the seed at h = 10 | Not changed during the event |
| No WebAssembly | `signer-wasm/` exists, with tests but no build notes | Built early for a Snap; nothing uses it, because the pipeline and the Snap example sign in TypeScript |
| `hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, chainId)` | Takes the leaf too: `(…, height, leaf, chainId)` (`HashSigVerify.yul:15`) | The leaf comes from the nonce key, not from the entry |
| The demo's stuck payment is a low fee | A 4-second first deadline (`firstAttemptExpirySeconds: 4`, `retries: 1`) | On this devnet a fee below the 7-wei base fee is refused at admission and any fee above it is included, so a low fee cannot stick |
| 4 pending per lane, 64 per unstaked sender; eight lanes "in one or two blocks" | 1 per key, no per-sender cap for self-paying keyed lanes, at most 4 relayed per 10 s pass; "two or more blocks" | The devnet sidecar's real rules, from its code; 4 and 64 are the ERC-8421 draft's |
| Deployment by a deploy frame on the legacy nonce | An EOA calls the factory; the verify frame refuses `[0]` | A deploy frame needs about 546,000 state gas, over the 500,000 cap |
| Hybrid on by default | Off | The plan's default for the demo |
| At most four cold SLOADs | Three for a cold leaf, six for a hot leaf | The hot rules need slots 3 to 5 |
| A priority fee from the sidecar's quote | The quote raised to a 3 gwei floor (`WL_MIN_TIP_WEI`) | The sidecar relays the highest tip first, and its quote sat below other teams' fixed 2 gwei |

## Known limitations

- **Hybrid is off.** The account supports the ECDSA co-signature, but the backend refuses to create a hybrid wallet
  (400) and refuses cold sends and admin calls on a hybrid account (409 `hybrid_unsupported`).
- **Recent-root expiry and the hypertree are not built.** Hot tickets that expire with EIP-8272's 8,191-slot window,
  and a certified hypertree that grows without invalidating pending lanes, are designed only. The agent screen says so.
- **The grinder's hot margin uses the Day-0 estimate.** `GRIND.hot` adds 6,623 gas for the hot rules
  (`pipeline/src/config.ts`), a Day-0 figure measured without the hash-based check; the hot ticket at block 441
  measured about 6,550, so the grinder is about 70 gas cautious there.
- **A policy change does not wait for lanes.** `POST /hot-policy` is refused while a rotation is pending but goes ahead
  while lanes are in flight. A lower hotStart turns pending cold lanes above it into hot ones, which then fail the hot
  rules, and the sidecar's per-block re-simulation cancels them. Rotation does wait.
- **Gas estimates spend leaves.** `eth_estimateFrameTransactionGas` runs the verify frame, so each estimate signs with
  its own cold leaf, which is then burned. The backend estimates only calls with data and admin calls; a plain transfer
  uses fixed limits. Estimate messages are not ground, so about 1 in 65 runs out of gas at its 94,900 limit (messages of
  600 or more hash steps, by the measured fit).
- **Four cold leaves are kept for admin calls**, enough for the kill switch and one rotation at two leaves each
  (`ADMIN_CALL_LEAVES` and `ADMIN_LEAVES` in `backend/src/backend.ts`).
- **Small band.** 16 hot tickets and 1,007 cold leaves at epoch 0 (h = 10). Production would use h = 20, which costs
  about 1 billion hashes per listed chain to build (computed).
- **The Rust signer has no tree cache**: 0.36 s per signature from the seed.
- **Two review findings are not acted on.** On macOS, `fsync` is not `F_FULLFSYNC`, so a journal write could be lost
  on power loss after a signature left the machine. And `sendKeyed` burns a leaf and continues when that key is used on
  chain but missing from the journal (`pipeline/src/submit.ts:434`), where stopping might be safer.
- **The 2,300-gas stipend.** An account is a 45-byte EIP-1167 proxy, so every call to it, a plain ETH payment included,
  runs a DELEGATECALL to the implementation (about 2,700 gas with a cold implementation). It cannot receive ETH from a
  contract that forwards only the 2,300-gas stipend (Solidity's `transfer` and `send`); a plain `call` with value works.
- **Explorer links.** The explorer reads the gateway, so lanes sent to the miner's sidecar may not show there.

## Divergences found on Day 0

To be filed on the sidecar and ethrex repositories.

| # | Divergence | Where |
| --- | --- | --- |
| 1 | The expiry verifier and the nonce manager are at `0x…8141` and `0x…8250`; the EIP addresses have no code. The same for recent roots (`0x…8272`) | sidecar docs |
| 2 | `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid` and `canonicalMempoolViolation`; the devnet readme says `valid` and `violation` | sidecar docs |
| 3 | ethrex `docs/eip-8141.md` at `9aa3645d` describes a SIGPARAM 0x04 copy, which halts | ethrex |
| 4 | ethrex docs give an intrinsic cost of 15,000; the code (`transaction.rs`) charges 12,000 | ethrex |
| 5 | Older blocks silently answer with the latest state, with no error (only about the last 126 blocks are real) | ethrex |
| 6 | From about 23:40 IST Nov 5 the gateway admitted frame transactions but never relayed them; `skandha_explorer_peers` was empty | sidecar, event Discord |
| 7 | The chain halted at block 408,262 (04:28 IST Nov 6) | event Discord, reported |
| 8 | The miner's sidecar answers "Faucet is disabled"; only the gateway's faucet pays | event Discord |

The devnet pins older drafts, which are not bugs: `[]` is refused and the legacy nonce is `[0]`; the sentinel
2^64 − 1 is refused; a key's first use costs 20,000 execution gas, not the EIP's 97,920 state + 12,100;
`computeSigHash` replaces empty-msg signature bytes with empty bytes, where the EIP uses their length.

Found later, on Nov 6, in the vendored sidecar's source:

- `skandha_explorer_listTransactions` filters by status only, with no sender filter (`SC/modules/explorer.ts:108-139`).
- An error while re-simulating a lane, a transport error included, cancels that lane, so a node outage during
  revalidation cancels every New lane on that node (`SC/services/BundlingService/reconciliation.ts:436-461`).
- The workshop's `explainRejection` maps only OP-011 and STO (mempool-workshop `src/lib/frameTx/send.ts:55-65`).

## Using the pipeline in a browser or a Snap

The pipeline has two entries. `@winterlock/pipeline` (`pipeline/src/index.ts`) is for Bun (its file journal locks with `bun:ffi`): the backend, the scripts and the tests use it, unchanged. `@winterlock/pipeline/core` (`pipeline/src/core.ts`) runs anywhere JavaScript runs, a browser page or a MetaMask Snap included: it builds frame transactions, grinds them to fit the 90k verify limit, signs them in two passes with the WOTS+ keyring, keeps the journal of exposed leaves, and sends and follows them, with no Node or Bun API, no `process` and no file system.

```ts
import { GRIND, Keyring, MemoryJournal, createPipeline, keyringSigner } from "@winterlock/pipeline/core";

const p = createPipeline({ chainId: 1337n, nodeUrl, gatewayUrl });  // its own network: nothing global, nothing from env
const signer = keyringSigner(new Keyring({ seed, generation: 0, height: 10, chains: [1337n] }));
const journal = MemoryJournal.open(stored, { wallet, chainId: 1337n, epoch: 0, height: 10, treeSeed: signer.treeSeed }, { store });
await p.sendKeyed({ journal, band: { from: 1, to: 1008 }, sender: wallet, calls, verifyGas: 90_000n,
  signatures: (leaf) => [{ kind: "hash", signer, leaf }], grind: GRIND.cold, preflight: true });
```

- `MemoryJournal` keeps the journal's rules (a leaf is handed out once, a missing journal is never recreated empty, statuses only move forward, one writer) and saves through a store the host gives it, such as a Snap's `snap_manageState`. Such a store is asynchronous, so the send path waits for it (`Journal.durable`) before a leaf signs and before a transaction leaves; a failed save stops it handing out leaves. The rules, and what a host must add (one journal instance for its whole life, a rotation after restoring an older copy), are listed in `pipeline/src/journal.ts`.
- Every path that reserves or settles leaves (`sendKeyed`, `estimateCalls`, `settleSubmitted`) refuses a journal of another chain or wallet, and a pipeline's node must answer its own chain id: with pipelines on several chains, one leaf must never sign on a chain whose journal does not know it.
- `bun run build` in `pipeline/` writes `dist/core.js` (one ES module, about 230 KB, viem and the hashes inside) and its type declarations in `dist/types/`. It refuses to finish if the bundle references a Node or Bun API, or if the core does not typecheck against browser types alone.
- Proof, in `pipeline/test/`: `core-bundle.test.ts` scans the browser bundle, then runs a bundled end-to-end scenario (keyring, grind, two-pass signature, a journal with an async store, a full send against a stand-in chain) under SES lockdown in a compartment with only a Snap's globals, and checks it signs the same bytes as in Bun. `package.test.ts` packs the package, installs it into an empty project, typechecks that project and runs it in plain Node (`dist/core.js`) and in Bun. `journal.test.ts` covers `MemoryJournal`, a store that fails, and pipelines side by side.
- `pipeline/examples/browser/`: `bun examples/browser/serve.ts`, then http://127.0.0.1:15190. The page builds a height-10 tree from a throwaway seed (about 2 s), grinds and signs a transfer, and checks the 2,594-byte entry against the root. Its Content-Security-Policy allows no connection, so nothing can be sent.
- `pipeline/examples/snap/`: an example MetaMask Snap, not a wallet. It takes its seed from `snap_getEntropy`, salted with an account nonce created at install (a reinstall gets a new tree, never the old one's leaves), keeps one journal in `snap_manageState`, handles requests one at a time, answers only `http://127.0.0.1:15190`, signs, and sends against a stand-in chain. On a real chain a send's follow phase can outlast MetaMask's 60 s request limit, so a real Snap would answer once the transaction is submitted and settle it in a later request. `bun run build` in `pipeline/`, then `bun install && npm test` in the example typechecks it, builds it with MetaMask's Snaps CLI (which also evaluates the bundle in its sandbox) and runs it in MetaMask's Snap simulator (`@metamask/snaps-jest`).
- Found while building it: a bare SES compartment throws on `Date.now()`. A Snap's `Date` works, so the SES test gives the compartment one, as MetaMask does. MetaMask's test stack (`@metamask/utils` 12, Oct 2026) ships ES-module-only packages that Jest 29 cannot require, so the example converts them with SWC (`test/esm-to-cjs.cjs`).

## Authorship and AI use

Noncebound is a solo hackathon project, built during the event by Vicky Prasad
([github.com/vickyshaw29](https://github.com/vickyshaw29)), who authored every commit and drove every AI tool. It
follows a design document written before the event and disclosed to ETHGlobal (see
[What existed before](#what-existed-before-the-event-and-what-was-built-during-it)).

The core idea (the nonce key as the record of used keys, expiry instead of fee bumps, hot tickets) comes from that
design document. The decisions during the event were Vicky's: probe the devnet before writing code, and build on what
it measured rather than on the drafts; create accounts from an EOA, because a deploy frame does not fit the devnet's
state cap; write the hash-based scheme during the event when the expected library did not arrive, and check it against
Quip's audited verifier; make the demo's stuck payment a short deadline, because on this devnet a low fee cannot
stick; find why lanes expired on the devnet, and fix the tip and the deadline rather than the claim; keep the hybrid
co-signature off; and declare every limit rather than let a judge find it.

The code was written with Claude Code (Anthropic) under those decisions, and reviewed and run by Vicky. 24 of the 26
non-merge commits carry a `Co-Authored-By: Claude` trailer, and the boilerplate commit `3b5fe45` says in its message
that it was made with Claude, so `git log` shows where AI was used. Per file:

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
- The local fake devnet for hand tests while the devnet was halted (Nov 6): every file in `fakechain/` (`run.ts`, `src/`, `test/`, `README.md`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `.gitignore`), and the fit line in `pipeline/scripts/hashsig-devnet.ts`, which now subtracts the proxy's 1/64 holdback
- The parallel-lanes tooling (Nov 6): `pipeline/src/lanes.ts` (what one pending lane holds of the balance, the plan for n lanes at once, the sidecar's relay settings, what each refusal or drop means for a lane) and its tests `pipeline/test/lanes.test.ts`; the terminal CLI `demo/lanes.ts` (`plan` and `burst`, lost answers followed through the wallet's records) with its tests `demo/test/lanes.test.ts` and `demo/test/setup.ts`, `demo/README.md`, `demo/bunfig.toml`, `demo/package.json` and `demo/tsconfig.json` (the `bun init` stub `demo/index.ts` is removed)
- Hot tickets in the pipeline: `pipeline/src/tickets.ts` (ticket cuts with the Rust CLI's `export-leaves`, marked exported first; where a cut starts; the ticket device with its own journal; signing with `sign --ticket-file`) and its tests `pipeline/test/tickets.test.ts`, which run the real CLI
- The pipeline's changes for the backend (Nov 6): in `pipeline/src/submit.ts`, the `onSubmitted` hook, the public-mempool path, the dry run carried on every refusal, and grinding the last frame's limit when the caller fixes the fee; in `pipeline/src/estimate.ts`, a used-up band as `LeavesExhausted` and a leaf burned when its key cannot be read; in `pipeline/src/rpc.ts`, `node.call`, `node.transactionByHash` and the dry run's `revertData`; in `pipeline/src/index.ts`, the exports of `tickets.ts` and `lanes.ts`; in `pipeline/scripts/lib/wallet.ts`, the refusal of a record the backend rotated. Their tests: `pipeline/test/submit.test.ts`, `pipeline/test/estimate.test.ts`, `pipeline/test/rpc-reads.test.ts` and `pipeline/test/wallet.test.ts`
- The backend, every file in `backend/`: `src/app.ts`, `src/backend.ts`, `src/chain.ts`, `src/config.ts`, `src/files.ts`, `src/http.ts`, `src/main.ts`, `src/registry.ts`, `src/store.ts`; the tests `test/admin.test.ts`, `test/app.test.ts`, `test/lanes.test.ts`, `test/restart.test.ts`, `test/secrets.test.ts`, `test/send.test.ts`, `test/tickets.test.ts` and `test/wallets.test.ts`, with the in-process fake chain and sidecar `test/fake-chain.ts` and the harness `test/helpers.ts`; `backend/README.md`; `package.json`, `bun.lock`, `tsconfig.json` and `.gitignore` (the Rust stub of `3b5fe45`, `Cargo.toml`, `Cargo.lock` and `src/main.rs`, is removed)
- The browser- and Snap-safe core (Nov 6): the new files `pipeline/src/core.ts`, `network.ts`, `pipeline.ts`, `journal.ts`, `chain-pin.ts`, `signer-cli.ts` (the CLI signer moved out of `signer.ts`) and `pipeline/src/hashsig/keyring-core.ts` (the keyring without the file system); the changes to `pipeline/src/index.ts`, `config.ts`, `rpc.ts`, `submit.ts`, `estimate.ts`, `admission.ts`, `lanes.ts`, `leaves.ts`, `genesis.ts`, `signer.ts` and `hashsig/keyring.ts`; the build `pipeline/scripts/build-core.ts`, `pipeline/scripts/lib/browser-safe.ts`, `pipeline/tsconfig.build.json` and the `exports`, `files` and `build` entries of `pipeline/package.json`, with `pipeline/tsconfig.json`'s `exclude`, `pipeline/.gitignore`'s `dist` and `pipeline/bunfig.toml`; the tests `pipeline/test/core-bundle.test.ts`, `journal.test.ts` and `package.test.ts` with `pipeline/test/fixtures/sandbox-scenario.ts`, `ses-run.ts` and `consumer/`; the examples, every file in `pipeline/examples/browser/` and in `pipeline/examples/snap/` but `bun.lock`
- The screens, every file in `web/` but the `bun init` stub `index.ts` and the scaffolding's `.gitignore` and `bun.lock`: `serve.ts` (the static files and the `/api/*` proxy) and `lan.ts` (LAN mode for a phone on the same hotspot); every file in `web/public/` but the fonts (`index.html`, `hot-cold.html`, `agent.html`, `session.html`, `style.css`, `index.css`, `hot-cold.css`, `agent.css`, `session.css`, `api.js`, `board.js`, `dom.js`, `flows.js`, `format.js`, `index.js`, `hot-cold.js`, `agent.js`, `session.js`, `lanes.js`, `market.js`, `register.js`, `scenes.js`, `ui.js`, `tsconfig.json`); the tests `web/test/board.test.ts`, `flows.test.ts`, `format.test.ts`, `integration.test.ts`, `lan.test.ts`, `lanes.test.ts`, `ledger-agent.test.ts`, `ledger-hot-cold.test.ts`, `ledger-session.test.ts`, `pages.test.ts`, `register.test.ts`, `screens.test.ts` and `serve.test.ts`, with `web/test/fake-dom.ts`, `records.ts` and `setup.ts`; `web/README.md`; `package.json`, `tsconfig.json` and `bunfig.toml`
- The parallel-lanes fix (Nov 6, approved by Vicky, spec "Fees"): the tip floor `MIN_TIP_WEI` in `pipeline/src/config.ts` and `withTipFloor` in `pipeline/src/rpc.ts` (with `gateway.gasPrice` applying it), the `--expiry-seconds` flag and the 180 s burst deadline in `demo/lanes.ts`; their tests in `pipeline/test/rpc.test.ts` and `demo/test/lanes.test.ts`
- The Ledger restyle of the screens, started on Nov 6 and stopped part-way (Claude Code workflow): `web/public/register.js` (the key register's leaf states) and the per-screen styles `web/public/hot-cold.css`, `agent.css`, `session.css` and `index.css`; changes across `web/public/` (tokens and `@font-face` in `style.css`, the ledger board, ticket strip, tear and cancellation stamp in `board.js`, `lanes.js`, `ui.js`, `hot-cold.js`, `agent.js`, `session.js`, `index.js`, the pages' HTML) and in `web/serve.ts` (font MIME type, CSP); the tests `web/test/register.test.ts`, `ledger-hot-cold.test.ts`, `ledger-agent.test.ts` and `ledger-session.test.ts`, with changes to the other web tests; in the backend, the wallet view's `leaves` field (`leafStates` in `backend/src/backend.ts`) with tests in `backend/test/tickets.test.ts` and `backend/test/wallets.test.ts`
- The core fixes after the Nov 6 end-to-end run: the grinding handed over at submission and on refusals (`GrindInfo` in `pipeline/src/submit.ts`); `grind` and the four gas columns `gas` on `GET /tx/:hash` and the lane board, and `GET /wallets` leaving out wallets that cannot sign on this chain (`grindView`, `gasView` and `pinnedElsewhere` in `backend/src/backend.ts`, `TxGrind` in `backend/src/store.ts`, `backend/README.md`); their tests in `pipeline/test/submit.test.ts`, `backend/test/send.test.ts` and `backend/test/wallets.test.ts`
- This README (Nov 6): written with Claude Code from the measured runs, the code and Vicky's notes, and edited by Vicky. The Day-0 probe scripts, kept outside this repository, were also written with Claude Code

Not written by us: `pipeline/src/codec/codec.ts` and `pipeline/src/codec/FrameTx.ts` are copied from [mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar) at commit `2e22ff0a`, MIT, Copyright (c) 2023 Etherspot; Claude Code added only the header comments and changed one import path. `fakechain/src/sidecarRules.ts` ports the sidecar's admission rules (classifyFrame, recognizeValidationPrefix, validateStructuralRules, validateSignature, describeStructuredFailure) from the same commit, MIT, Copyright (c) 2023 Etherspot, so the fake refuses with the sidecar's own words. The fonts in `web/public/fonts/`, Archivo (`archivo-latin.woff2`) and Besley (`besley-latin.woff2`), are from Google Fonts under the SIL Open Font License 1.1, Copyright 2020 The Archivo Project Authors and The Besley Project Authors; their licences are beside them (`OFL-Archivo.txt`, `OFL-Besley.txt`).

## Licence

MIT, see [LICENSE](LICENSE). Vendored code keeps its own licence: `vendor/mempool-workshop-sidecar` (MIT, Etherspot),
`contracts/lib/forge-std` (MIT or Apache-2.0), and Quip Network's `contracts/lib/hashsigs-solidity` and Rust crate
`hashsigs-rs` (both AGPL-3.0-or-later). Quip's code runs only in our tests, as an oracle for the WOTS+ format; no
contract we deploy and no binary we build links it. `fakechain/src/sidecarRules.ts` and `pipeline/src/codec/` keep the
sidecar's MIT notice (Copyright (c) 2023 Etherspot). The fonts in `web/public/fonts/` are under the SIL Open Font
License 1.1, beside their licence files.
