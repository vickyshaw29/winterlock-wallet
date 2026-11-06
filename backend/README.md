# backend

The HTTP backend over the pipeline (spec, Shared interfaces 5, extended Nov 6): it creates wallets, sends keyed and
hot-ticket transactions, cuts tickets, changes the hot policy and rotates trees. It is the only process that touches
seeds. Bun and TypeScript, no framework; it imports `pipeline/` by relative path.

Written with Claude Code (AI) for Vicky.

## Run it

Needs, once:

- Bun (`~/.bun/bin`), and `bun install` in both `pipeline/` and `backend/` (the backend imports the pipeline's source,
  which needs its own dependencies).
- The Rust signer CLI, for ticket cuts and hot signatures: `cd signer && cargo build --release` (the binary lands at
  `signer/target/release/signer`).
- The pipeline's deployment record with the real verifier, `pipeline/.data/deployment-1337.json`: new wallets use its
  implementation and factory. `pipeline/scripts/deploy-account.ts` writes it.
- A funded EOA key file (`~/.winterlock/devnet-eoa.key`, one 0x-prefixed hex line, mode 0600): it calls the factory for
  every new wallet and tops the wallet up when the faucet is dry.

Then:

```sh
(cd pipeline && bun install) && cd backend && bun install
bun src/main.ts          # or: bun run start
# winterlock backend: http://127.0.0.1:8787/api (data in ~/.winterlock/backend)
curl -s http://127.0.0.1:8787/api/status
curl -s http://127.0.0.1:8787/api/wallets
curl -s -X POST http://127.0.0.1:8787/api/wallets -H 'content-type: application/json' -d '{"height": 10, "spendLimitWei": "10000000000000000"}'
```

It listens on 127.0.0.1 only. A request must name `127.0.0.1:<port>` or `localhost:<port>` in its Host header (no Host,
or one that does not parse, is the same JSON 403), a request with an `Origin` header must come from that same origin,
and every POST body must be JSON with `content-type: application/json`, at most 64 KiB counted in bytes (a larger
`Content-Length` is refused before the body is read): a web page on another origin cannot drive a process that holds
seeds. Bun runs it with `development: false`, so an error is never Bun's page with a stack trace, only the generic 500
JSON, and with a 60 s idle timeout, so a slow read of the chain is not cut off. Request logs carry the method, path,
status and time, never a body.

At start it reads the transaction store, serves every wallet record it finds, and opens each wallet's journals: leaves a
stopped process left `reserved` are burned (they never reached a mempool), and lanes left `submitted` are followed to
their end in the background (`settleSubmitted`), their outcomes written into the store. A rotation left pending is
decided from the chain once its lane has ended; one whose lane ends without an outcome (`Unknown`) is looked at again
every 30 s in the same process until the chain decides it (switched or dropped), with no restart needed.

Stop it with Ctrl-C: the kernel drops every journal lock with the process.

## Environment

All optional.

| Variable | Default | What |
| --- | --- | --- |
| `WL_BACKEND_DIR` | `~/.winterlock/backend` | The backend's data: seeds, wallet records, ticket devices, the hashsig cache, the transaction store (see Files) |
| `WL_BACKEND_PORT` | `8787` | Port on 127.0.0.1; `0` picks a free one |
| `WL_DATA_DIR` | `<repo>/pipeline/.data` | The pipeline's deployment records, as `pipeline/scripts/lib/wallet.ts` reads them |
| `WL_SIGNER_BIN` | `<repo>/signer/target/release/signer` | The Rust signer CLI (`export-leaves`, `sign --ticket-file`) |
| `WL_EOA_KEY_FILE` | `~/.winterlock/devnet-eoa.key` | The funded EOA's private key |
| `WL_FUND_WEI` | `20000000000000000` (0.02 ETH) | A new wallet still below this once the faucet's payment shows (or the faucet is dry) is topped up to exactly this by the EOA, when the EOA can pay |
| `WL_NODE_URL` | `https://altmempool.forshtat.com` | The ethrex node (pipeline `config.ts`): reads, dry runs, the public mempool |
| `WL_GATEWAY_URL` | `https://altmempoolgateway.forshtat.com/rpc` | The sidecar (pipeline `config.ts`): the alt mempool, status, receipts, gas price, faucet, admission records. Since Nov 5 the gateway does not relay; use the miner's sidecar `https://altmempool.forshtat.com/rpc` |
| `WL_CHAIN_ID` | `1337` | The devnet's chain id (pipeline `config.ts`) |
| `WL_EXPLORER_URL` | `https://explorer.altmempool.wtf` | Explorer links (pipeline `config.ts`) |

The backend never sets `PQ_SEED`, and strips it from the CLI's environment: the CLI gets the seed only as
`--seed-file`, and only for `export-leaves`.

## Files

Under `WL_BACKEND_DIR` (directories 0700, files 0600, except the public hashsig cache):

| Path | What |
| --- | --- |
| `seeds/account-<n>.seed` | A wallet's master seed, created once by `POST /wallets`, never recreated or reused |
| `seeds/account-<n>.seed.chain.json` | The genesis pin: nothing signs on a chain whose genesis differs (a devnet reset) |
| `seeds/account-<n>.seed.journal-epoch<e>.json` (and `.lock`) | The wallet's cold journal for epoch `e`: every cold leaf, every exported ticket |
| `wallets/<address>.json` | The wallet record: the createAccount arguments, its current tree, every past tree, a pending rotation |
| `devices/<address>/journal-epoch<e>.json` (and `.lock`) | The ticket device's journal: every hot leaf it signed. Born on the epoch's first cut only: if it goes missing once tickets were cut, the device is unusable (409 `device_unusable` for cuts and hot sends) until the file is recovered, because a new journal would re-sign used tickets |
| `devices/<address>/tickets/epoch<e>-<from>-<to>.json` | One ticket cut (leaf secrets and paths, `to` inclusive). Kept apart from every journal: a journal refuses to open beside a file naming its tree |
| `hashsig-cache/` | Public leaf nodes, so a tree is built once |
| `txs.json` | The transaction store: every transaction the backend sent or saw refused (the lane board) |

A pipeline wallet (a record in `WL_DATA_DIR` whose seed file exists) keeps its seed and journals where the pipeline put
them; the backend writes its record back, atomically, only when a rotation starts, switches or is dropped. It reads the
file again first: when `deployment-<chain>.json` now names another account (`deploy-account.ts` made a new one), the
record goes to the pipeline's archive name `deployment-<chain>.<account>.json` and the current file is left alone.
Once the backend has rotated a pipeline wallet, the pipeline's scripts refuse its record (`accountSigner` and
`openJournal`: "rotated by the backend; the scripts sign at epoch 0 only"): only the backend signs for it.

## API

JSON under `/api`. Amounts are decimal strings of wei; nonce keys and the sequence are 0x hex.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /status` | | `{chainId, head, headAgeSeconds, stalled, fake}` for the screens' status line: the node's chain id and latest block, that block's age by the host clock, `stalled` when it is more than 60 s off (the 503 rule), `fake` for the local fake chain (chain id 31337). 502 when the node cannot be read |
| `POST /wallets` | `height` (2 to 12, default 10), `spendLimitWei` (the hot value cap, required), `hybrid` (only `false`), `chainIds` (1 to 16 distinct, this devnet's among them; default `[1337]`), `hotStart` (at least 6: at epoch 0 leaf 0 cannot sign, 4 cold leaves stay for admin calls and a keyed send needs one more; default `max(6, 2^h - 16)`, so height 2 is too small), `hotFeeCapWei` (default 0.002 ETH), `allowedTarget` (default the devnet genesis account) | `{address, root, epoch, funded}`. The account's owner is the EOA (the classical co-signer, should hybrid ever be turned on; it stays off) |
| `GET /wallets` | | `[{address, epoch, height, balanceWei}]` |
| `GET /wallets/:address` | | `{address, root, treeSeed, height, epoch, leavesUsed, leafCount, lanesInFlight, hybrid, locked, balanceWei, hotStart, hotValueCapWei, hotFeeCapWei, allowedTarget, tickets: {exported, used, left}, rotationPending}`, read from the chain and the journals. When tickets were cut but the device journal is missing, `tickets` is `{exported: n, used: 0, left: 0, unjournaled: n}`: none can be signed until the journal is recovered. `leaves` (Nov 6, read-only, for the screens' key register) is `{onChain, burned, inFlight, tickets}`: the current epoch's leaf numbers by state from the cold journal and the ticket device's journal (burned by the signer: expired, refused, an estimate's leaf, never sent; an exported leaf no ticket file holds), and `tickets: {from, to}` the band cut to the device, `to` inclusive, or null. A ticket in none of the lists is still on the phone; any other leaf is unused |
| `POST /wallets/:address/send` | `to`, `valueWei`, `data`, `mode` (`"keyed"` or `"hot"`), `expirySeconds` (1 to 86,400, default 90), `firstAttemptExpirySeconds` (1 to 86,400: the first attempt's deadline only, the demo's stuck payment; retries keep `expirySeconds`), `mempool` (`"alt"` or `"public"`), `maxFeePerGasWei` (first attempt only), `retries` (0 to 3: fresh-leaf attempts after an expiry). A call with data to the wallet itself is refused: admin calls go through `/rotate` and `/hot-policy` | `{txHash, leaf, nonceKeys, nonceSeq, status: "Submitted"}` once it is submitted; the send goes on in the background |
| `GET /wallets/:address/txs` | | The wallet's transactions, newest first, each as `GET /tx/:hash` answers but without `wire` |
| `GET /wallets/:address/lanes/plan?n=8&mode=keyed\|hot&valueWei=W&to=A&expirySeconds=S` | | Parallel lanes: what `n` lanes (1 to 64) sent at once would hold of the balance and take to relay, before any leaf is reserved (see Parallel lanes below). `mode` defaults to `keyed`, `valueWei` to 0, `to` to the account's allowed target, `expirySeconds` to 90. Answers `{wallet, n, mode, to, valueWei, expirySeconds, affordable, setAsideWei, shortfallWei, passes, etaSeconds, warnings, perLaneCostWei, perLane: {gasLimit, maxFeePerGasWei, gasCostWei, valueWei}, pendingLanes, pendingCostWei, unpricedLanes, balanceWei, lanesLeft, relay: {bundleSize, bundleIntervalSeconds, maxSubmitAttempts, useropsTTLSeconds, bundlingMode, testingMode, assumed, notes}}`. 400 for a missing, unknown, repeated or malformed parameter; 404 for an unknown wallet. A stalled chain is a warning here, not a 503 |
| `GET /tx/:hash` | | `{txHash, status, explorerUrl, receipt, simulation: {verifyGas, violations}, wallet, kind, leaf, nonceKey, nonceSeq, mode, mempool, to, valueWei, deadline, admission, timeline, retryOf, retriedAs, detail, maxCostWei, wire, createdAt, updatedAt}`; for a lane only a journal knows (a script's), the fields it cannot know are null. `maxCostWei` (decimal) is the most the transaction can be charged for gas while pending, which the sidecar sets aside for its payer: ethrex's `maxCost` from the dry run of exactly this transaction, else `maxFeePerGas` x `total_gas_limit` of the JSON sent; its whole set-aside is `maxCostWei + valueWei`. `wire` is the exact JSON sent (`eth_sendFrameTransaction`'s argument; for `mempool: "public"` the JSON of the raw transaction the node got), null when nothing was sent (a dry-run refusal). Both are null on records written before Nov 6 |
| `POST /wallets/:address/rotate` | `height` (2 to 12) | `{txHash, newRoot, epoch}`; the wallet switches once the chain shows the new epoch and root |
| `POST /wallets/:address/hot-policy` | `hotStart`, `valueCapWei` (0 is the kill switch), `feeCapWei`, `allowedTarget`, all required. A `hotStart` below the account's must leave 4 unused cold leaves below it after this call's own 2 (409 `leaves_exhausted` otherwise) | `{txHash, status: "Submitted"}` |
| `POST /wallets/:address/tickets` | `count` (1 to 64) | `{from, to, count}`, `to` inclusive. A cut starts where the device's tickets end; the epoch's first cut starts at the lowest hot leaf (at or above the account's `hotStart`) the cold journal has never seen, so a hot leaf a script signed directly is skipped. Every leaf of a cut must be free in the cold journal (409 `cannot_cut` otherwise, nothing cut) |

Transaction status: `Submitted` (being followed), `OnChain`, `Reverted` (included, a frame failed), `Included` (key
used, no receipt readable), `Expired` (leaf burned), `Refused` (leaf burned), `Unknown` (followed past its deadline
with no outcome; never paid again automatically).

How sends are built: a keyed send signs with the next unused cold leaf in `[0, hotStart)` (leaf 0 only from epoch 1);
a hot send with the next unused ticket of the wallet's ticket device. The verify frame declares 90,000 gas and the
message is ground until its chain work fits (`GRIND` in the pipeline's `config.ts`, measured behind the account's
proxy): normally the fee moves, one wei per try; with `maxFeePerGasWei` the fee stays exactly as asked and the last
frame's execution limit moves instead, one gas per try. (On the devnet a fee below the 7-wei base fee is refused at
admission and any fee above it is included, so a low fee cannot make a payment stuck there: spec, Nov 6.)
Every transaction is dry-run on the node first (`preflight`); the account's own rules refuse what breaks them (a hot
send over a cap, to another target, or with data), which is a 422 with the account's reason, and its leaf is burned.
A plain transfer declares 183,600 state gas when its target is an empty account. A keyed call with data, and both
admin calls, take their limits from `eth_estimateFrameTransactionGas`, which burns one cold leaf of its own each time
(a one-time key must never sign two messages).

The demo's stuck payment (spec, demos item 2 and script 1:20) is a short first deadline: `{"firstAttemptExpirySeconds":
4, "retries": 1}`. The first attempt's 4-second deadline should miss the devnet's 6-second block; then it is proven
`Expired` and its leaf (or ticket) is burned, and the retry goes out on a fresh leaf and key with the normal deadline,
`expirySeconds` (default 90). It is not certain: a few tries in a hundred still land, when the sidecar's relay pass
(every 10 s) and the next slot both fall inside the 4 s. Such a payment simply lands on its first attempt and nothing
is burned, so a recording of the scene may need a retake. Without `retries` the short deadline is simply the one
attempt's.

The last 4 unused cold leaves of an epoch are kept for two admin calls, the kill switch (`valueCapWei` 0) and a
rotation, each spending 2 (its estimate and the call): a keyed send that would leave fewer than 4 is 409
`leaves_exhausted`, and its retries draw only from the leaves below them. An admin call with fewer than 2 left is 409
`leaves_exhausted` before anything is spent, and so is a policy whose lower `hotStart` would leave fewer than 4 unused
cold leaves below it after its own 2. A wallet's admin calls run one at a time, each from its leaf check until it is
submitted or has failed, so a second one counts the leaves again after the first has taken its 2 (two at once with
2 leaves left: one lands, the other is 409 and spends nothing). A wallet whose account requires the ECDSA co-signature
(`hybridRequired`) cannot sign cold leaves here: keyed sends and admin calls are 409 `hybrid_unsupported`; hot tickets
need no co-signature and still go. Hot sends and cuts first check that the signer CLI runs (`--help`).

### Parallel lanes

A lane is one nonce key with a transaction pending; every send takes a fresh key at sequence 0, so `n` sends at once
are `n` lanes. The devnet's sidecar holds one pending transaction per (sender, key) and no per-sender cap for keyed
lanes the account pays for itself, with no stake (`vendor/mempool-workshop-sidecar`, `MempoolService/service.ts:374-407`,
`reputation.ts:87-95,138-143`). What the lanes share, and what the plan checks:

- Money. Each pending lane owes its maximum gas cost and its value, and the sum over every pending lane must fit the
  balance (`obligations.ts`, `service.ts:409-478`): a lane over it is refused ("cannot cover its pending frame
  transactions"), and New lanes are cancelled newest first when the balance drops. The plan's `setAsideWei` is
  `pendingCostWei` (the `maxCostWei + valueWei` of every record `Submitted` or `Unknown`) plus `n` times
  `perLaneCostWei`: the pipeline's `laneMaxCostWei` of a transfer built as `POST /send` builds it, with the placeholder
  entry priced as non-zero bytes, the epoch's costliest nonce key and the market's fee plus the 4,096 wei grinding can
  add, so an upper bound. Lanes in flight with no recorded cost (still being sent, a script's) are counted in
  `pendingLanes` and `unpricedLanes` and left out of the sum, with a warning; so are recently expired lanes, which the
  sidecar may still count until it drops them.
- Relay. At most `bundleSize` (4) New lanes per pass, a pass every `bundleInterval` (10 s), highest tip first and then
  in admission order. `relay` is read from the sidecar's `skandha_config` and `skandha_explorer_info`, else the defaults
  with `assumed: true` and a warning; `testingMode` relays 10 per bundle. One read serves every plan for 60 s in the
  backend process (`relayCacheMs`), a read that could not reach the sidecar too, so a screen asking every few seconds
  costs two sidecar calls a minute. Both report configured values: the live
  interval can differ (`debug_bundler_setBundleInterval`). `passes` is `ceil(n / bundleSize)` and `etaSeconds` an
  estimate, 28 s (one transaction New to OnChain, measured Nov 5) plus one interval per further pass, with a warning
  when it is past the lanes' deadline.
- Leaves: `lanesLeft` is the cold leaves keyed sends may still use (the last 4 stay for admin calls), or the tickets
  left for `mode=hot`. Reputation: a THROTTLED account keeps at most 4 pending (about 110 admissions without an
  inclusion). The public (ethrex) pool should hold this account to one pending transaction, because its verify frame
  reads its own storage; still to be probed on the devnet.

For hot lanes the plan also says what the account would refuse: a value above the hot cap, another target, a maximum
cost above the hot fee cap, the kill switch. `demo/lanes.ts` (`plan`, `burst`) prints all of this in plain words and
sends the burst; the pipeline's `explainRefusal` says what each refusal or drop means for the lane.

Every record keeps the exact JSON sent (`wire`, from the pipeline's `onSend`), and `GET /tx/:hash` serves it. A WOTS+
element at digit 0 is that chain's secret itself, so the JSON of a signed ticket shows a few of that ticket's secrets.
Storing and serving it is still safe, for three reasons. It holds only the signature the mempool already received:
`wire` is written when the JSON is sent, and stays null for a lane the node's dry run refused before anything left.
One WOTS+ signature cannot be turned into a signature on another message: a forger can only run each chain forward
from the revealed element, and any other message whose digits are all at or above the signed ones has a lower
checksum, so some checksum chain would have to run backward (a keccak preimage). And the leaf never signs again: the
journal burns it whether or not its key was consumed, so expired and refused lanes keep their JSON too.
`test/secrets.test.ts` leaves out exactly those published values and nothing else.

### Errors

`{"error": code, "detail": text}`, sometimes with more fields. A detail carries only public values (leaves, keys,
hashes, addresses, paths), never a seed, a ticket secret or a key.

| Status | Codes | When |
| --- | --- | --- |
| 400 | `bad_request` | A missing, unknown or malformed field; a hotStart the account would refuse (above its own, or leaving no cold leaf); a new wallet's hotStart below 6 |
| 403 | `forbidden` | Another Host or Origin |
| 404 | `unknown_wallet`, `unknown_tx`, `not_found` | |
| 405 | `method_not_allowed` | |
| 409 | `leaves_exhausted`, `tickets_exhausted`, `no_tickets` | No cold leaf beyond the 4 kept for admin calls (or, for an admin call, fewer than 2; or a lower hotStart that would leave fewer than 4 below it), no ticket left, or no ticket cut yet for this epoch |
| 409 | `lanes_in_flight`, `rotation_pending` | A rotation waits for every lane and every send that has started; while one is pending, sends, cuts and policy changes wait |
| 409 | `tree_mismatch` | The record's, the signer's and the chain's trees disagree (checked before the first signature of each epoch); no leaf spent |
| 409 | `journal_busy`, `journal_unusable` | A script holds the journal (one writer per journal), or it is missing or of another tree |
| 409 | `device_unusable` | The ticket device's journal is missing once tickets of the epoch were cut (exported in the cold journal, or files in `tickets/`): "recover <file>; a new journal would re-sign used tickets". A cut and a hot send both answer it; nothing is cut or signed. Also a device whose ticket files are of another tree or have a gap |
| 409 | `hybrid_unsupported` | The account requires the ECDSA co-signature on cold leaves, which the backend does not make; nothing spent |
| 409 | `cannot_send`, `cannot_cut`, `cannot_create`, `cannot_rotate`, `not_deployed`, `eoa_busy` | Another check failed; nothing was spent unless the detail says so |
| 422 | `refused` | The node's dry run or a mempool refused the signed transaction; its leaf is burned. The body adds `txHash`, `leaf`, `simulation` and `admission`, and `GET /tx/:hash` shows it as `Refused`. When the refusal came as a JSON-RPC error, its message is among `simulation.violations` |
| 500 | `internal`, `cut_failed`, `signer_unavailable` | A bug (the log has the cause); the CLI failed after the cut was marked exported (those tickets are wasted, never reused); or the signer CLI is missing or does not run, checked before any ticket is reserved or cut |
| 502 | `rpc_failed`, `not_mined` | The node or the sidecar could not be read, or the EOA's transaction was not mined in time |
| 503 | `chain_stalled` | The latest block's timestamp is more than 60 s from the host clock |

## Tests

Offline: the tests replace the pipeline's `node` and `gateway` and the backend's `eth` with an in-process fake chain
and sidecar (`test/fake-chain.ts`), and use temporary directories only. The ticket tests run the real CLI and fail,
never skip, when it is missing. For parallel lanes the fake can answer the sidecar's relay settings (`relay`, each ask
counted in `calls.relay`), hold alt lanes as New until `relayPass()` relays up to 4 of them into one block
(`batching`), and refuse a second public transaction with ethrex's own words (`publicRefusal =
ETHREX_ONE_PER_SENDER`); while `halted`, the latest block is two minutes old however it is read, so `GET /status` and a
send's 503 agree. On the fake, a short first deadline always misses its block (`missShortDeadlines`), so the stuck
payment's tests are certain where the devnet's run is not.

```sh
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
(cd signer && cargo build --release)
(cd pipeline && bun install)
cd backend && bun install && bunx tsc --noEmit -p . && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test
```

## Known limits

- A ticket cut whose CLI run fails after the mark leaves those leaves exported and wasted. A later cut stays
  contiguous with the device's tickets, so once the device holds some it gets no more in that epoch; rotate to start a
  new band. A failed first cut leaves the device no tickets, so the next first cut starts above the wasted leaves.
- A lost device journal is never recreated: the device stays unusable until the file is recovered, or the wallet
  rotates to a new epoch (a new band, a new journal).
- A rotation whose transaction ends `Unknown` (the node unreadable for the whole follow) stays pending, refusing sends,
  until the chain decides it: it is looked at again every 30 s, and at the next start.
- The reserve of 4 cold leaves holds two admin calls: once keyed sends have used everything else, the kill switch and
  a rotation both fit, but a third admin call in that epoch (say a second policy change) finds no leaf.
- A rotation that was dropped leaves the next epoch's journal; the next rotation of that wallet must use the same height
  (409 `cannot_rotate` otherwise), because one epoch's trees of two heights would share one-time keys.
- The public mempool path (`mempool: "public"`) is unverified on the devnet: ethrex's docs say its pool may admit
  several keyed transactions with disjoint keys from one sender.
- Hybrid co-signing is refused (plan, section 8).
