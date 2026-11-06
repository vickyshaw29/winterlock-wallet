# Fake chain mode: build brief (Nov 6, asked for by Vicky)

The real devnet stopped at block 408,262. Vicky wants to run the whole flow by hand anyway. Build a **local fake
devnet**: one Bun process that answers the same JSON-RPC calls as the ethrex node and the sidecar, so the pipeline's
scripts (and later the backend) run against it unchanged, by environment variables. It models in TypeScript what the
real devnet does for this project (the spec's Day-0 results and the pipeline's code) and what `account/yul/Account.yul`
checks. It does not run EVM code. Call it fake everywhere: in its client version, its explorer page, its README.

Where: a new Bun package `fakechain/` in `/Users/vicky/Documents/winterlock`, branch `feat/fakechain` (already checked
out). Import the pipeline by relative path; do not modify `pipeline/src`, `account/`, `signer/` or `backend/`. If a
pipeline change looks necessary, report it as a question instead. Never commit or push. Never send anything to the real
devnet, never read `~/.winterlock`, never touch `pipeline/.data`. A separate agent is building the backend in another
checkout (`/Users/vicky/Documents/winterlock-backend`): do not touch it.

## Read first

- `AGENTS.md`, `.claude/spec.md` (above all "Protocol facts", "Account contract", "Transaction format and signing
  flow", and "Day-0 checks on the devnet", whose results are the real devnet's behaviour), `.claude/plan.md`.
- `account/yul/Account.yul` (verifyFrame, hotPolicy, the admin functions, initialize) and `account/src/Factory.sol`.
- `pipeline/src/rpc.ts` (every method the pipeline calls and the shapes it parses: SimulationResult,
  normalizeNodeReceipt, gateway.status's not-found error, gateway.receipt), `submit.ts`, `genesis.ts`, `estimate.ts`
  (frameGasModel, inferStateGas, eth_estimateFrameTransactionGas), `config.ts`, `builder.ts` (nonceManagerSlot),
  `account.ts` (predictAccountAddress, proxyRuntimeCode), `codec/codec.ts` (decodeFrameTx, computeSigHash), `wots.ts`,
  `hashsig/keyring.ts` (verifyEntry), `admission.ts`, `leaves.ts`, `scripts/lib/wallet.ts`, `scripts/deploy-account.ts`,
  `scripts/hashsig-devnet.ts`, `test/fixtures/admission-records.json` (a real admission record: reuse its rule names).
- The backend will also call `eth_getTransactionByHash` and `eth_call` on the node: serve both.

## Isolation (the most important part)

- Chain id **31337**, never 1337: no transaction signed for the fake chain is valid on the real devnet.
- A fresh random genesis hash on every start. Seeds made for one fake run then refuse to sign on any other chain, and
  the real seeds (pinned to the devnet's genesis) refuse to sign here (`genesis.ts`).
- Every file in a fresh data directory per run, by default under the OS temp dir, printed at start: never inside the
  repo, never under `~/.winterlock`.
- Its own throwaway EOA key, generated per run, written with mode 0600, funded in genesis.
- `web3_clientVersion`: "fakechain/0.1.0 (local fake devnet, not ethrex)".

## Endpoints

- Node at `/`: eth_chainId, web3_clientVersion, eth_blockNumber, eth_getBlockByNumber (number, hash, timestamp,
  baseFeePerGas; "0x0" is genesis), eth_getCode, eth_getStorageAt and eth_getBalance (also at a block number: keep
  per-block state for at least the last 128 blocks, and answer an error for older ones instead of the real node's silent
  fallback to the latest state), eth_getTransactionCount (latest, pending), eth_call (the account's views, the
  factory's implementation() and predictAddress), eth_sendRawTransaction (EOA transactions; and type 0x06 frame
  transactions into the public pool), eth_getTransactionReceipt (node shape), eth_getTransactionByHash,
  ethrex_simulateFrameTransaction [raw, block, {trace}] (SimulationResult with canonicalMempoolValid,
  canonicalMempoolViolation, prefixShape, payer, maxCost, gasUsed, frames, executionStatus, executionError, and
  revertData carrying the account's revert string).
- Sidecar at `/rpc`: skandha_getGasPrice, eth_sendFrameTransaction (the wire JSON of `toWire`), skandha_frameTransactionStatus
  (-32600 "Frame transaction not found" for an unknown hash), eth_getFrameTransactionReceipt (sidecar shape; an error
  while not included), eth_estimateFrameTransactionGas (what estimate.ts reads, consistent with frameGasModel and
  inferStateGas), skandha_explorer_faucet (1 ETH: {txHash, amount}), skandha_explorer_getTransaction (a record with
  `admission` shaped like the fixture), and the eth_* reads the real sidecar proxies.
- Explorer at `/explorer/tx/<hash>`: a small HTML page (status, block, frames, admission checks) with a FAKE banner.

## Chain model

- Blocks every `--block-time` seconds (default 6, as the devnet). Timestamp = the host clock in seconds, so the
  pipeline's clock check passes. A fixed base fee (default 1 gwei); skandha_getGasPrice answers 2 gwei max fee and a
  1 gwei priority fee.
- NONCE_MANAGER and EXPIRY_VERIFIER hold exactly `NONCE_MANAGER_CODE` and `EXPIRY_VERIFIER_CODE` (config.ts), so
  `checkSystemContracts` passes. A key's nonce-manager slot (`nonceManagerSlot`) becomes 1 when the key is used at seq 0.
- The account implementation (code from `account/build/Account.bin` when present, else a marked placeholder) and a
  factory sit at fixed addresses. An EOA's createAccount call creates the account at `predictAccountAddress` with
  `proxyRuntimeCode(implementation)` and its storage modelled as Account.yul `initialize` stores it, with the factory's
  and initialize's refusals.
- Frame transactions, validated in the real order: structure and prefix shape (an optional expiry_verify, then
  self_verify); the prefix cap (declared prefix execution limits plus signature costs at most 100,000; refusal message
  exactly "validation prefix execution gas sum X + signature-verification cost Y = Z exceeds MAX_VERIFY_GAS 100000",
  code -32602); 1 to 16 nonce keys; nonceSeq below 2^64 - 1 (the devnet's static check); SECP256K1 entries verified by
  recovery over `computeSigHash`; the expiry frame (block timestamp past the 8-byte deadline: the frame reverts, so not
  includable); then the account's verify frame **modelled exactly on Account.yul verifyFrame and hotPolicy**: the same
  checks in the same order with the same revert strings ("nonce: epoch", "sig: hash-based check", "hot: value cap",
  ...), using the pipeline's TypeScript `verifyEntry` for the WOTS+ and Merkle steps. Verify-frame gas follows the
  measured model: 24,070 + 66.06 x WOTS+ chain steps (`wotsVerifySteps`) for hashsig_verify, plus 30,396 for the
  account's own checks on a cold leaf and 6,623 more on a hot leaf; above the declared limit the frame runs out of gas.
  A used key is refused with "Nonce mismatch: expected 1, got 0" (-32500).
- Inclusion: every block takes the pending frame transactions whose key is still unused, whose deadline is at or after
  the block's timestamp, whose max fee is at least the base fee (a lower fee stays pending until it expires: the
  stuck-payment scene), and that still validate. It consumes the key, runs the SENDER frames, charges the gas (the
  frameGasModel rules, max(actual, floor)) times the effective price to the payer, and writes the receipt. SENDER
  frames: value transfers (to an empty account they need 183,600 state gas from the frame's state limit, else the frame
  reverts); calls to the account itself modelled on Account.yul rotate, setHybrid, setHotPolicy and setOwner with the
  same rules and revert strings; a call to any other address succeeds with a fixed modelled gas. A failed SENDER frame
  shows as reverted in the receipt; the key stays used.
- Sidecar statuses: Pending on admission, Submitted at the next block, OnChain when included, Cancelled about 10 s after
  the deadline passed without inclusion (submit.ts waits for Cancelled or not-found before a retry).
- Mempool policies, modelled on the Day-0 findings and labelled as modelled: the alt mempool (sidecar) holds one pending
  transaction per (sender, key), any number of keys, and refuses a second on a pending key at the same fee ("Frame
  transaction cannot be replaced: fee too low"). The public pool (the node's eth_sendRawTransaction) holds one pending
  frame transaction per sender: a flag `--public-per-sender` (default 1), since ethrex's own docs say its pool may admit
  more.
- An admission record for every submission, accepted or rejected, with the fixture's rule names, verdicts from the
  model and the failing rule's detail.
- EOA transactions: legacy and EIP-1559 (viem's parseTransaction and signature recovery), chain id 31337 only, matching
  nonce, enough balance; to the factory with createAccount data creates the account; a plain transfer moves value;
  contract creation is refused with a clear message.

## Launcher `fakechain/run.ts`

Flags `--port` (8545), `--block-time` (6), `--height` (10), `--public-per-sender` (1). It creates a fresh data
directory, writes the throwaway EOA key, starts the chain, and creates a first account exactly as the real flow does:
a fresh seed `<data>/seeds/account-1.seed` (loadOrCreateSeed), the genesis pin beside it, a Keyring for generation 0,
the journal created before the account (as deploy-account.ts does), the EOA's createAccount transaction, hotStart
2^h - 16, value cap 0.01 ETH, fee cap 0.002 ETH, allowedTarget a fixed "shop" address funded in genesis, then 10 ETH
of funding. It writes the deployment record `<data>/pipeline-data/deployment-31337.json` in the `Deployment` shape of
scripts/lib/wallet.ts, so `scripts/hashsig-devnet.ts` and the backend find the account, and `<data>/env.sh` exporting
WL_CHAIN_ID=31337, WL_NODE_URL, WL_GATEWAY_URL, WL_EXPLORER_URL, WL_DATA_DIR, WL_BACKEND_DIR, WL_EOA_KEY_FILE and
WL_SEED_FILE. It prints how to use it. Ctrl-C stops it; a restart is a new world.

`fakechain/README.md`: what it is, what is modelled and what is real (the TypeScript signer and verifier, the pipeline
code), how to run it, which scripts work against it (scripts/hashsig-devnet.ts yes; deploy-account.ts and smoke.ts read
the real EOA key from a fixed path: never run them against it).

## Tests (offline; `fakechain/test/`; the server in-process on a random port; the env set before importing the pipeline)

The pipeline's real functions against the fake over HTTP: a cold sendKeyed lands OnChain with the right receipt and
balances; a flipped signature byte is refused ("sig: hash-based check"); leaf A's signature under leaf B's key is
refused; a hot ticket within the caps lands; over the cap, to another target, with data, over the fee cap and with the
kill switch are refused with the account's strings; a fee below the base fee with a short expiry ends Expired and
sendWithRetry lands the retry on a fresh leaf; eight keyed sends at once are all included; a second frame transaction
from one sender into the public pool is refused; setHotPolicy applies, raising hotStart is refused, rotate moves the
epoch and an old-epoch key is then refused ("nonce: epoch"); estimateCalls works; settleSubmitted finishes a lane; the
100k prefix refusal message; scripts/hashsig-devnet.ts runs end to end against a launched fake (spawned with env.sh's
variables) and passes; isolation: chain id 31337, and a seed pinned to another genesis refuses to sign. Put two model
rules back wrong once (for example skip the hot target check, accept a used key) and confirm a test fails.

Commands, with `export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"`:
`cd fakechain && bun install && bunx tsc --noEmit -p . && bun test`, and the pipeline's own suite must stay green:
`cd pipeline && WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test`.

Out of scope: wiring the backend to it (after the backend lands), the screens, any change to the spec or plan.
Start every new file with a one-line purpose comment and "Written with Claude Code (AI) for Vicky."
