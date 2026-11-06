# Devnet evidence

Part of the [Winterlock README](../README.md). Every transaction behind the README's numbers, with its full hash and block, and what Day 0 found on the devnet.


Devnet: chain 1337, 6 s blocks, node `https://altmempool.forshtat.com` (`ethrex/v23.0.0-eip8141-tracer-9aa3645d…`),
miner's sidecar `https://altmempool.forshtat.com/rpc` (`skandha/v4.1.1`), gateway
`https://altmempoolgateway.forshtat.com/rpc`. The explorer, `https://explorer.altmempool.wtf/tx/<hash>`, keeps its
history in memory and reads the gateway, so every row below also carries its full hash and block; a lane sent to the
miner's sidecar may not appear there.

## The current chain

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

## Parallel lanes and the stuck payment

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

## The three screens, end to end

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

## The earlier chain (before the halt)

These blocks no longer exist; the explorer links are dead.

| What | Transaction | Block |
| --- | --- | --- |
| The first hash-signed transaction of the event: account 1 (`0x9908548a8b28d85191dc04d27d1d3c6e1430439b`), leaf 3 (nonce key `0x3`, sequence 0), 420 hash steps, verify 89,006 of 94,900 declared (an older verifier), 186,245 gas, 17 of 17 | `0x38b51a318a039225d17feaf6257b7f71c1ca66c81fb511d5b8a90ad3dad26475` | 407,107 |
| The pipeline's first transaction (V2): the test EOA with native ECDSA, nonce key `0x200000001`, a leading expiry frame | `0x31cc7937cb5d7ba3f48e1f7e5b75ee6070ff34f8396a4685e87b866cee2464af` | 405,073 |

## Accounts and contracts

| What | Address |
| --- | --- |
| **Account 3**, current chain: h = 10, hotStart 1008, hot value cap 0.01 ETH, hot fee cap 0.002 ETH, allowed target `0x5544596212F91984C986A919C8026DF0576816f9`, hybrid off; created at block 375 (953,766 gas), funded 0.2 ETH at block 376 | `0xf3e63d269dae09032ea950cd9722733e9b3f2d37` |
| Implementation (block 373) and factory (block 374), current chain | `0x13075a0f56d6a793eba4493d866e6502052abe87`, `0xe7227c802ea370f04ae533827041c89dc5a4e659` |
| The screens' wallet, current chain, created by the backend | `0x273CA502D7A6648A043e958E8d6618d16F892C80` |
| Test EOA | `0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d` |
| Earlier chain: account 2 (current verifier), its implementation and factory; account 1 (older verifier); the standalone verifier used for gas measurement | `0x4565906974d62abf53ad28165ef0ec43a1e39f57`; `0x9b8ed97f198ce8f8adb20e16056fb1a29818213f`, `0x4b1cbca3a579bb55b1f948ad1c517a05c9aca6cb`; `0x9908548a8b28d85191dc04d27d1d3c6e1430439b`; `0xA6Ecb14e644631C0ae9178Ab3383a72Fc384ec61` |

## Day-0 results

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

## Sending from MetaMask, and the scenes run again (Nov 6, evening)

On the current chain, after the MetaMask path was merged (`98014fe`). The Winterlock account `0xf2fde1b5c10069c0300ff21773ef102565b7b790` was created by the Snap's prepared `createAccount` call (block 5,587) and added to MetaMask Flask as an ERC-4337 account. The scenes' wallet `0x9019Db416BbbB93BB75407476e004DE69F842f10` was created by a devnet backend.

| What | Transaction | Block |
| --- | --- | --- |
| Sent from MetaMask Flask: MetaMask's confirmation, the Snap signs leaf 2, the local bundler sends | `0xfce762a999fec43241b92f086a643265d0977f6d42511da6fe814f303a46d56a` | 5,703 |
| Sent from MetaMask Flask again, leaf 3 | `0xd16844958b6ae069c02d5b0caa7a17c090ef62d78b17313c31027c18013aecd3` | 5,808 |
| Sent through the Snap's own dialog, leaf 4 | `0x052b14cb…3d0cd1` (in the Snap's journal) | 5,898 |
| Eight lanes at once on the alt mempool: 8 of 8 admitted, all 8 pending together, 41 s from the first send to the last outcome | leaves 1 to 8: `0x7bea0ab5eee5ddfc91e7ca4ab5d678349314792ec65b7883f47f26f5e8098225`, `0x4c372e40408fb95cac3e9fb67964516fd3d4b3b9faa9d15ae04878cc7490180c`, `0xd3a5a20a59f2baa746923c74e357ad6c1096dbbf128332dc64f118fbd6ffe667`, `0xc06dab04d0d0db358cefeeb62bc2e37068b09d3d014fd0e045fa523671795c72`, `0x351c049f40412c46345b993c02acab6fcfd673fe2ca7f45cbf2b63961fd88807`, `0x0f017f73845bd9b9e5113923f09a6d3ca63c55852c857ea65174deff8edf28b8`, `0x368ea8adc0b81cb3597ee9cb31deb921ced1200fcf75e10d7839acafabed167b`, `0x49c8388fc892a2f300f04445be09cc00412092117eccd282c2667d6827eee38a` | 5,729 and 5,730 |
| The same eight on the public mempool: 1 admitted, 7 refused, "one pending frame transaction per sender" | leaf 9: `0x81c37e1459a98235d36d13f47e508e8d6e5709cbbd23ed604dd963883917609f` | 5,738 |
| A stuck payment (4 s deadline) expired with its key unused, then the retry on a fresh key landed | leaf 17: `0x5142cd34ea41ac551ce92411a9347d0f6ecc8b8a4aeebcabcffad18cb6efef02`; leaf 18: `0x0b02b13382fa89b533a7ec72fcd50b32aa1ab2a762b047a6547f7f6ebd5b1778` | expired at 5,876 |
| Hot policy set by a cold leaf; one hot ticket paid within the caps; over the value cap, to another target, and with the tickets used up: refused | policy `0xd91758eeb5711045807759656419fdacf11b149caa06b4b118423cfb0936f73d`; ticket `0x9d8b39110946072298b686c6d78d2ac9c749c677d6d684a76b595d3f1b4a84e0` | |

Found while sending from MetaMask live: MetaMask's sign request carries the user operation alone, not the entry point the keyring API's docs list; Flask cannot estimate fees on chain 1337, so the page passes the fee fields; Flask kept an EOA's balance at 0 after a faucet payment and disabled its confirmation; and work a Snap leaves running after it answers did not progress in real MetaMask, so the Snap finds each lane's end at the page's next request.

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
