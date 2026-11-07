# Winterlock

**A post-quantum smart account whose one-time keys are retired by the protocol itself.**

Every payment is signed with a one-time hash-based key (WOTS+, under a Merkle tree), and that key's number is the
payment's own EIP-8250 nonce key. The protocol consumes the nonce key in the same step that approves the payment, so it
retires the key too. The account never records which keys it has used: no bitmap, no counter, no storage write during
validation.

Every payment has its own nonce key, so one account can have many payments pending at the same time on the ERC-8421
alternative mempool. The public mempool can't do this for us. Our verify step reads the account's own storage, and for
an account like that, ethrex's public pool allows only one pending transaction per sender. The alt mempool gives each
nonce key its own slot. We measured both: 8 of 8 payments pending together on the alt mempool, and 1 of 8 on the
public one.

It also sends from MetaMask Flask. A Snap makes the account a MetaMask account, and a small local bundler carries its
frame transactions to the alt mempool.

While building it, we also found and fixed two problems in the alt mempool itself, and opened a PR for each:
[What we fixed in the alt mempool](#what-we-fixed-in-the-alt-mempool).

Built at ETHGlobal Mumbai 2026 for the Ethereum Foundation's
[*Best use of the Frame Transaction Alternative Mempool*](https://ethglobal.com/events/mumbai/prizes/ethereum-foundation)
prize, and run on that prize's devnet (chain 1337). [What was submitted](#ethglobal-mumbai-2026). Not to be confused
with the Safe forum's Winterlock proposal, which is different work ([note](#prior-art)).

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

**[Measured](#measured)** · [Sidecar PRs](#what-we-fixed-in-the-alt-mempool) · [Quickstart](#quickstart) · [How it works](#how-it-works) ·
[From MetaMask](#send-from-metamask) · [Deployed](#deployed-on-the-devnet) · [Design](#design) · [Gas](#gas) ·
[Parallel lanes](#parallel-lanes) · [Evidence](#devnet-evidence) · [Trade-offs](#trade-offs) ·
[Prior art](#prior-art) · [CROPS](#crops) · [ETHGlobal](#ethglobal-mumbai-2026) · [Limitations](#known-limitations) ·
[Authorship](#authorship-and-ai-use)

## What we fixed in the alt mempool

To understand how many payments one account can keep pending, we read the code of the sidecar, the ERC-8421 mempool
this devnet runs. We found two problems, fixed both, and opened a PR for each. Both fixes were tested live on this
devnet.

- **[#5: only recheck pending transactions that a new block actually touched](https://github.com/forshtat/mempool-workshop-sidecar/pull/5).**
  After every block, the sidecar re-simulated every pending transaction, with no limit. Now it reads the block's
  access list (EIP-7928) and rechecks a transaction only if something it depends on changed: a storage slot it read,
  its sender or payer account, or its nonce key. It rechecks at most 50 per block, and when it can't be sure (a reorg,
  or an access list it can't read), it rechecks everything like before. On the devnet, 4 pending lanes went from 4
  simulations every block to 0.
- **[#6: cap pending transactions per unstaked sender at 64](https://github.com/forshtat/mempool-workshop-sidecar/pull/6).**
  A keyed transaction that pays for itself skipped every per-sender cap, so one address could park any number of
  transactions. ERC-8421 (LIFECYCLE-030) allows 64 for an unstaked sender. The PR enforces that limit, closes a way to
  bring cancelled transactions back in past the cap, and fixes a config whitelist lookup that only ever worked for
  factories.

Together they close a cheap attack: park thousands of low-tip lanes from one address, and make the node re-check all of
them every block.

## What is real, and what is not

| Part | Status |
| --- | --- |
| The account, its Yul verify frame and the factory | Real, deployed on the devnet; every transaction below was verified by it on chain |
| WOTS+ signatures and Merkle paths | Real: 2,594-byte entries, checked by the chain, by Quip's `WOTSPlus.sol` in tests, and by the Rust and TypeScript signers |
| Parallel lanes, the public mempool's refusal, expiry and retry | Real, on the devnet's alt mempool and node, with hashes |
| Hot tickets and their refusals | Real: ticket files from the Rust CLI, caps checked by the account |
| The backend and the three screens | Real: they send real transactions; the screens show only the backend's records |
| Sending from MetaMask Flask | Real: the Snap signs, the local bundler sends; two MetaMask sends landed on the devnet. Flask only (MetaMask's ERC-4337 path is not in regular MetaMask) |
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
| Sent from MetaMask Flask | **2 of 2** landed, about 25 s after confirming; a Snap-dialog send landed too | blocks 5,703, 5,808 and 5,898 |
| Tests, offline, all passing | **761**: 698 TypeScript (pipeline 288, web 189, backend 115, fake chain 90, demo 12, bundler 4), 11 in MetaMask's Snap simulator, 25 Foundry, 27 Rust | `main` at `98014fe`, Nov 6, 22:45 IST |

Every figure comes from a receipt, a node simulation or a test run on the devnet below, on Nov 5 and 6, 2026, and
every transaction is listed with its hash in [docs/devnet-evidence.md](docs/devnet-evidence.md). A figure worked out from a formula
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
cd web && bun run start                          # builds React; http://127.0.0.1:5173, marked local simulation
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
while alt lanes are pending ([why](docs/devnet-evidence.md#parallel-lanes-and-the-stuck-payment)). The three screens, `hot-cold.html`,
`agent.html` and `session.html`, each have a Play scene button that runs their story, and a Mempool switch between alt
and public. Seeds, journals and keys live in `~/.winterlock`, never in the repository.

**4. From MetaMask Flask.** The React workspace on `http://127.0.0.1:5173/` signs through the backend. The Snap has
its own page, `snap/site/`, on `http://localhost:15190`; the Snap answers both origins. Needs MetaMask Flask in Chrome
(a separate profile, or regular MetaMask disabled) with a throwaway recovery phrase, and no other network on chain 1337.

```sh
(cd pipeline && bun install) && (cd bundler && bun install)
cd snap && bun install && bun run dev    # pipeline core, bundler on 15192, the Snap on 15191, its page on 15190
```

On `http://localhost:15190`, in order: Connect Flask (installs `local:http://localhost:15191`), Add devnet to Flask,
Get 1 test ETH, Create account using Flask (confirm the factory call in Flask), Fund from Flask, then Send with
Winterlock Snap, or Add to MetaMask and Send from MetaMask. The first connect builds the key tree in the Snap (up to
30 s); the Snap keeps its leaf nodes, so later starts reuse them. Removing the Snap loses the account's keys: send its
balance away first.

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
  pending transaction per key, with no cap per account yet ([Parallel lanes](#parallel-lanes); our PR
  [#6](https://github.com/forshtat/mempool-workshop-sidecar/pull/6) adds ERC-8421's cap of 64).

```
 web/ ──HTTP──▶ backend/ ──▶ pipeline/ ─── alt ───▶ ERC-8421 sidecar ──▶ ethrex node ──▶ account/
 three screens  seeds,       build, grind,            (miner's)             (devnet)       Yul verify frame
                journals     sign, send,  ─ public ─────────────────────────▶               behind an
                   │         follow                    ▲                                    EIP-1167 proxy
                   └──▶ signer/  Rust CLI              │
                                                       │
 MetaMask Flask ──user op──▶ bundler/ ─────────────────┘
      ▲   │                  unwraps the signed frame tx, checks it, follows it
      │   └─prepare, sign──▶ snap/  the account's seed and journal, inside MetaMask
```

The backend is the only process that holds seeds and journals, and it listens on 127.0.0.1 only. The pipeline is a
library with no HTTP; it also builds for a browser or a MetaMask Snap ([docs/design.md](docs/design.md#using-the-pipeline-in-a-browser-or-a-snap)).

## Send from MetaMask

MetaMask cannot build a frame transaction, but MetaMask Flask can send an ERC-4337 user operation for an account an
Account Snap holds, to the bundler URL the Snap names. So the Winterlock Snap (`snap/`) is also an Account Snap whose one
account, type `eip155:erc4337`, is the Winterlock account, and a local bundler (`bundler/`) unwraps what MetaMask sends.
Nothing on chain is ERC-4337: there is no EntryPoint and no bundle. The user operation is only the envelope.

1. A page calls `eth_sendTransaction` from the Winterlock account, with the fee fields (MetaMask's 4337 path refuses a
   send without them, and Flask cannot estimate fees on chain 1337).
2. MetaMask asks the Snap to prepare: the Snap reserves a fresh leaf whose key is unused on chain and answers with
   `nonce = nonceKey << 64` (an ERC-4337 nonce is a 192-bit key and a 64-bit sequence; ours is key and 0), the call
   list as `callData`, gas limits that sum to an upper bound of the transaction's gas limit, and
   `bundlerUrl = http://127.0.0.1:15192/rpc`.
3. The user confirms in MetaMask's own screen. MetaMask asks the Snap to sign. The Snap signs only the user operation
   it prepared, at the user's fees, once per leaf (a second request for the same leaf is refused), after the tip floor,
   base fee and balance checks; it records the leaf "submitted" before the signature leaves the Snap. The signature
   field carries the whole signed frame transaction.
4. MetaMask posts the user operation to the bundler, which holds no key. `checkUserOpTx` (`pipeline/src/userop.ts`), run
   by the Snap before signing and by the bundler before sending, ties every frame, fee and limit of the transaction to
   the user operation: nothing that pays anyone else, more, or at another fee is ever sent. The bundler refuses a second
   transaction on a nonce key it already carries, sends to the alt mempool, follows the key on chain, and reports
   `success: false` only for Expired or Reverted, never for an included transaction.

Two sends from MetaMask landed on the devnet, each about 25 s after confirming ([evidence](docs/devnet-evidence.md#sending-from-metamask-and-the-scenes-run-again-nov-6-evening)). How to run it: [Quickstart, step 4](#quickstart).

## Deployed on the devnet

Chain 1337, the prize's devnet: node `https://altmempool.forshtat.com`, the miner's sidecar
`https://altmempool.forshtat.com/rpc`, explorer `https://explorer.altmempool.wtf`.

| What | Address |
| --- | --- |
| Account implementation (the Yul verify frame) | [`0x13075a0f56d6a793eba4493d866e6502052abe87`](https://explorer.altmempool.wtf/address/0x13075a0f56d6a793eba4493d866e6502052abe87) |
| Factory (`createAccount`, CREATE2 of a 45-byte EIP-1167 proxy) | [`0xe7227c802ea370f04ae533827041c89dc5a4e659`](https://explorer.altmempool.wtf/address/0xe7227c802ea370f04ae533827041c89dc5a4e659) |
| Account 3, which sent the qualifying transaction | [`0xf3e63d269dae09032ea950cd9722733e9b3f2d37`](https://explorer.altmempool.wtf/address/0xf3e63d269dae09032ea950cd9722733e9b3f2d37) |
| The MetaMask account, made by the Snap | [`0xf2fde1b5c10069c0300ff21773ef102565b7b790`](https://explorer.altmempool.wtf/address/0xf2fde1b5c10069c0300ff21773ef102565b7b790) |
| The devnet's EIP-8250 nonce manager | [`0x0000000000000000000000000000000000008250`](https://explorer.altmempool.wtf/address/0x0000000000000000000000000000000000008250) |
| The devnet's expiry verifier | [`0x0000000000000000000000000000000000008141`](https://explorer.altmempool.wtf/address/0x0000000000000000000000000000000000008141) |

Every other account and contract, with the blocks they were made in: [docs/devnet-evidence.md](docs/devnet-evidence.md#accounts-and-contracts).

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
| A frame transaction carried as a user operation, and the check both ends run | `checkUserOpTx` in `pipeline/src/userop.ts` |
| A leaf reserved at prepare signs once, recorded before anyone sees it | `signPrepared` in `pipeline/src/submit.ts` |
| The MetaMask account: prepare, sign, who may call | the keyring section of `snap/src/index.tsx` |
| The bundler that holds no key | `bundler/src/bundler.ts` |

## Design

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
the devnet's commit, and were confirmed on chain ([Day-0 results](docs/devnet-evidence.md#day-0-results)). `account/scripts/build.sh` splices the
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

The hash-based check line by line, what the frame may read, the ECDSA co-signature (off), chain slots, rotation and admin calls, and where the build differs from the design document: [docs/design.md](docs/design.md).

## Gas

### The four columns

| Profile | Declared verify limit | Measured verify execution | Intrinsic, signature bytes and floor | Receipt gas_used |
| --- | --- | --- | --- | --- |
| **Cold transfer, the qualifying transaction, block 386** | 90,000 | **88,373 at 510 hash steps** | fixed part 19,525; data about 41,500; floor 166,720 (2,605 billed bytes × 64) | **186,245** |
| **Hot ticket, leaf 1008, block 441** | 90,000 | **87,947 at 405 hash steps** (ground over 284 fee values) | floor 166,848 (2,607 billed bytes) | **186,373** |
| Cold transfer, 8 points, simulated on the earlier chain | 94,900, so every point could run | 82,390 to 92,326 at 420 to 570 steps | as the first row | 186,245 for all 8 (simulation) |
| Day-0 stub, no hashing, with owner ECDSA, block 405,523 of the earlier chain | not recorded | 20,317 | | 193,882 |

### Why the bill is flat

The 2,594-byte signature dominates. The floor (166,720) is larger than data plus execution whenever execution stays
under about 125,000 gas, and the prefix cap keeps it under 100,000. So every hash-signed transfer costs the same,
whatever its verify gas. Cheaper hashing would not lower the bill; a shorter signature would.

How each column is computed, the measured fit of verify gas to hash steps, the proxy's 63/64 holdback (EIP-150), grinding, and the caps: [docs/gas.md](docs/gas.md).

## Parallel lanes

A lane is one nonce key with a transaction pending. To have N payments from one account in the mempool at once, give
each its own key. Every Winterlock transaction already is a fresh key at sequence 0.

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

The devnet sidecar's rules beside the ERC-8421 draft and the public pool, order and timing, the tooling, and what each refusal means: [docs/parallel-lanes.md](docs/parallel-lanes.md).

## Devnet evidence

Devnet: chain 1337, 6 s blocks, node `https://altmempool.forshtat.com` (`ethrex/v23.0.0-eip8141-tracer-9aa3645d…`),
miner's sidecar `https://altmempool.forshtat.com/rpc` (`skandha/v4.1.1`), gateway
`https://altmempoolgateway.forshtat.com/rpc`. The explorer, `https://explorer.altmempool.wtf/tx/<hash>`, keeps its
history in memory and reads the gateway, so every row below also carries its full hash and block; a lane sent to the
miner's sidecar may not appear there.

| What | Transaction | Block |
| --- | --- | --- |
| **The qualifying transaction: the first hash-signed transfer on this chain.** Account 3 pays 1 wei with one WOTS+ signature of leaf 1 (nonce key `0x1`, sequence 0): 510 hash steps, verify frame 88,373 of 90,000, 186,245 gas; "included: 17 of 17 rules passed" | [`0x3446d855…`](https://explorer.altmempool.wtf/tx/0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175) `0x3446d855f87b963451f0570105814ddf64d4a9237c5642d172430eebca883175` | 386 |
| Eight lanes at once, then the same eight on the public mempool | [docs/devnet-evidence.md](docs/devnet-evidence.md#parallel-lanes-and-the-stuck-payment) | 2,272 to 2,275; 5,729 and 5,730 |
| Sent from MetaMask Flask | `0xfce762a999fec43241b92f086a643265d0977f6d42511da6fe814f303a46d56a` | 5,703 |

Every transaction behind the numbers, the three screens end to end, the earlier chain, the Day-0 probe results, and the divergences from the drafts we found: [docs/devnet-evidence.md](docs/devnet-evidence.md). Two of our findings became sidecar PRs: [#5](https://github.com/forshtat/mempool-workshop-sidecar/pull/5) and [#6](https://github.com/forshtat/mempool-workshop-sidecar/pull/6).

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

- **Hybrid:** off in the build, not on by default ([Hybrid co-signature](docs/design.md#hybrid-co-signature-off)).
- **Keyed only:** no transaction uses the legacy nonce, not even the deployment, because an EOA calls the factory.
- **Minimal proxy:** the DELEGATECALL also holds back 1/64 of the verify gas ([the proxy finding](docs/gas.md#the-proxy-finding-eip-150)).
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

**A note on the name.** This project is not the Safe forum's Winterlock proposal above, which is different work by
other people: an EIP-1271 Safe owner, not an account on frame transactions.

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
