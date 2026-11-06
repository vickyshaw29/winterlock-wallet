# Parallel lanes tooling: build brief (Nov 6, approved by Vicky: the narrow cut, real numbers, name "parallel lanes")

Source research (read it): `/private/tmp/claude-501/-Users-vicky-Documents-winterlock/659dcc9a-8920-4a15-a793-a15955424ccb/scratchpad/hotlanes-design.md`
and its corrections `.../scratchpad/hotlanes-critique.md` (the critique wins where they differ).

## The rule set (devnet sidecar, vendored code)

- A lane is one nonce key with a transaction pending. One pending per (sender, key); no per-sender cap for keyed lanes
  the account pays for itself, no stake (MempoolService/service.ts:374-407, reputation.ts:87-95,138-143).
- Lanes share: money (sum over pending of max cost + top-level value must fit the balance, obligations.ts:5-33,
  service.ts:409-478), relay throughput (at most bundleSize=4 New entries per bundleInterval=10 s pass, by tip then
  admission order, config.ts:628,635), the THROTTLED cap of 4 (about 110 admissions without inclusions), one journal
  writer, and a finite band.
- Public (ethrex) pool: our account gets 1 pending, because its verify frame reads the sender's storage (critique,
  "upgraded from likely"); still to be probed on the devnet.

## Build (in `/Users/vicky/Documents/winterlock-backend`, branch feat/backend; do not edit `web/`)

1. `pipeline/src/lanes.ts`, pure and tested:
   - `laneMaxCostWei(tx)`: what the sidecar counts for one pending lane: ethrex's total_gas_limit
     (max(intrinsic + sum exec + sum state, mandatory + floor + sum state), built on `frameGasModel` in estimate.ts)
     times maxFeePerGas, plus the top-level frames' value. Placeholder (zero) signature bytes priced as non-zero, so it
     is an upper bound before signing.
   - `planLanes({ n, perLaneCostWei, pendingCostWei, balanceWei, relay, expirySeconds })` ->
     `{ affordable, setAsideWei, shortfallWei, passes: ceil(n / bundleSize), etaSeconds, warnings }`;
     etaSeconds = 28 (one transaction, New to OnChain, measured Nov 5) + bundleInterval x (passes - 1), labelled an
     estimate; warn when the ETA exceeds the expiry and when the defaults were assumed.
   - `relayConfig(gatewayUrl)`: `skandha_config` (bundleSize, bundleInterval, maxSubmitAttempts, useropsTTL) and
     `skandha_explorer_info` (bundlingMode); on failure, the defaults (4, 10 s) with `assumed: true`. Note in a comment
     that the live interval can differ (testingMode, debug setters).
   - `explainRefusal(message)` -> `{ code, laneState, hint }` for the exact strings: "is already held by pending
     transaction" (key busy), "cannot be replaced: fee too low" (same slot: a signer bug, never bump), "already known"
     (duplicate: follow it), "cannot cover its pending frame transactions" (over budget), "can no longer cover" (evicted
     for balance), "Nonce mismatch: expected X, got Y" (compare: X > Y key already used; X < Y sequence ahead),
     "exceeds MAX_VERIFY_GAS" (prefix over 100k), "revalidation failed as of block" and "relayed N times without being
     included" (dropped: check the chain), "is throttled" / "is banned" (reputation), "validation frame N: reverted
     with data 0x..." (decode the 32-byte ASCII account reason, e.g. "hot: value cap"), "validation frame N: ran out of
     gas", "A pending frame transaction from this sender is already in the pool" (public pool: one per sender). Test
     each string against its source (vendor/mempool-workshop-sidecar; ethrex error.rs as quoted in the critique).
2. Backend:
   - Store `maxCostWei` on every transaction record (the preflight simulation's maxCost; else `laneMaxCostWei` of the
     signed transaction) and the sent wire JSON (`wire`, from onSend) on the record; GET /tx/:hash returns both, the
     txs list returns maxCostWei only.
   - `GET /api/wallets/:address/lanes/plan?n=8&mode=keyed|hot&valueWei=...&to=...` -> planLanes for this wallet:
     per-lane cost from a built, unsigned transaction (placeholders; no leaf reserved), pending cost from the wallet's
     in-flight records, balance from the chain, relay from relayConfig. 400 on bad input, 404 unknown wallet.
   - Fix the test fake: with `halted = true`, node.block('latest') and node.blockTimestamp must agree.
3. `demo/lanes.ts` (replace the bun-init stub in demo/; scene scripts belong in demo/, plan section 3), a CLI that talks
   to the backend (WL_BACKEND_URL, default http://127.0.0.1:8787):
   - `plan --wallet <addr> --n 8 [--mode keyed|hot] [--value-wei W] [--to A]`: prints the plan in plain words.
   - `burst --wallet <addr> --n 8 [--mempool alt|public] [--mode ...] [--value-wei W] [--force] [--json-out DIR]`:
     plan first (refuse if not affordable unless --force), then N concurrent POST /send; print each lane as it is
     answered (leaf, nonce key, hash, or the refusal with explainRefusal), then poll GET /tx until every lane is final;
     print the status timelines, the most lanes seen pending at once, the blocks and seconds taken, each admission
     summary; write each lane's exact sent JSON (record.wire) to DIR or print it (spec: scripts print the JSON they sent).
   - Tests: drive the CLI's functions against the real backend app in-process with its own fakes (like
     web/test/integration.test.ts): plan, a burst of 8 alt (all admitted, landing over two or more fake blocks), a public
     burst (1 admitted, the rest refused with the explained reason), an unaffordable plan refused, --json-out files.
4. Naming: "parallel lanes" in every new text.

Done means: pipeline, backend and demo suites green (tsc and tests), two fixes put back once and caught; backend
README documents the plan endpoint, maxCostWei and wire. Start every new file with a one-line purpose and "Written with
Claude Code (AI) for Vicky."
