# Gas

Part of the [Winterlock README](../README.md). The four gas columns, the measured fit, why the bill is flat, the proxy's 63/64 holdback, and grinding.


## The four columns

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

## The measured fit

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

## Why the bill is flat

The 2,594-byte signature dominates. The floor (166,720) is larger than data plus execution whenever execution stays
under about 125,000 gas, and the prefix cap keeps it under 100,000. So every hash-signed transfer costs the same,
whatever its verify gas. Cheaper hashing would not lower the bill; a shorter signature would.

## The proxy finding (EIP-150)

The account is an EIP-1167 proxy. Its DELEGATECALL passes on only 63/64 of the gas left (EIP-150), so a verify frame
declared at 90,000 can use about 88,643. Point 6 above shows it: 525 steps need 89,356, which runs out of gas behind the
proxy. The grinder used to accept 525-step messages, about 14 % of all messages. Fixed in commit `5b24bd8`:
`usableVerifyGas` in `pipeline/src/grind.ts` subtracts the holdback, and `GRIND` in `pipeline/src/config.ts` comes
from the measured fit plus a 300-gas margin. Cold messages now fit up to 510 steps (66 % of messages) and hot ones up to
409 (about 1 in 231, an exact count over the digit distribution). Three transfers on the current chain then used
exactly 510 steps and fit (88,310 to 88,376 against the 88,643 usable).

## Grinding

The signer changes the transaction until its message needs few enough hash steps, then signs once. It moves
`maxFeePerGas` by one wei per try, up to 4,096 tries, and leaves the deadline exact. When the caller fixes the fee, the
backend moves the last frame's execution limit by one gas per try instead. A preflight simulation still refuses any
message the model gets wrong. Every transaction record keeps the grind (`grind` on `GET /api/tx/:hash`): the field
varied and the steps of every message tried, such as 525 then 495 under a 510 limit (block 2,907).

## The caps beside it

The declared prefix is 5,000 (expiry) + 90,000 (verify) + 100 (signature cost) = 95,100, under the 100,000 cap that both
the public mempool and the devnet sidecar enforce (Day-0: 120,000 refused, 95,000 admitted). Quip's 190,792 is the call
gas of a stateful wrapper with two storage writes, a different profile: compare verify with verify, and total with
total.
