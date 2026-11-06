# Hot lanes on the alt mempool: how to build them, and the tooling around them

This was a read-only study on Nov 6, around 10:40 IST. I edited nothing and sent nothing to any network. Every claim below has a source. "Likely" means I read it in source code but nobody has run it. "Unverified" means no source settles it.

**Where the citations point** (all paths absolute):
- **SPEC** `/Users/vicky/Documents/winterlock/.claude/spec.md`
- **PLAN** `/Users/vicky/Documents/winterlock/.claude/plan.md`
- **AGENTS** `/Users/vicky/Documents/winterlock/AGENTS.md`
- **README** `/Users/vicky/Documents/winterlock/README.md`
- **PL** `/Users/vicky/Documents/winterlock/pipeline`
- **ACC** `/Users/vicky/Documents/winterlock/account/yul/Account.yul`
- **FC** `/Users/vicky/Documents/winterlock/fakechain` (untracked)
- **SC** `/Users/vicky/Documents/winterlock/vendor/mempool-workshop-sidecar/packages/executor/src`
- **SCR** `/Users/vicky/Documents/winterlock/vendor/mempool-workshop-sidecar`
- **WS** `/Users/vicky/Documents/winterlock/vendor/mempool-workshop`
- **BE** `/Users/vicky/Documents/winterlock-backend`: the feat/backend worktree. It is uncommitted and someone is editing it, so its line numbers are as of 10:37 IST.
- **ETHREX** https://github.com/forshtat/ethrex/blob/9aa3645d795945c64400f41a70aace0edfa7f383/docs/eip-8250.md (the devnet node's commit, SPEC:587)
- **ERC** https://github.com/ethereum/ERCs/pull/2028 (ERCS/erc-8421.md)
- **E8141** https://github.com/ethereum/EIPs/blob/master/EIPS/eip-8141.md
- **E8250** https://github.com/ethereum/EIPs/blob/81b976ac01591fed2eecb73fa574f27cd18db2e8/EIPS/eip-8250.md (the revision the devnet pins)
- **DOCS** https://docs.altmempool.wtf/guides/keyed-nonces/
- **PRIZE** https://ethglobal.com/events/mumbai/prizes/ethereum-foundation

## 0. How we do it (the answer first)

1. **A hot lane is a nonce key that has a transaction pending.** To get N transactions from one account into the mempool at once, give each one its own nonce key.
   - Our account already works this way. Every transaction uses one fresh key, `(epoch << 32) | leaf`, at sequence 0 (PL/src/builder.ts:11-28; ACC:54-61).
2. **The devnet's alt mempool lets those lanes sit side by side.**
   - The sidecar holds one pending transaction per (sender, key).
   - It puts no per-sender cap on keyed transactions that the account pays for itself, and these need no stake (SC/services/MempoolService/service.ts:374-407; SC/services/MempoolService/reputation.ts:87-95,138-143).
   - The only limit the lanes share is money: everything pending must fit the account's balance (SC/services/MempoolService/obligations.ts:5-33; service.ts:409-437).
3. **Lanes land in batches, in any order.** By default the miner relays at most 4 New transactions every 10 s, highest priority fee first (SC/services/BundlingService/service.ts:228-280,313-352; SC/config.ts:628,635). Eight lanes therefore need at least two passes.
4. **Most of the code already exists.** Concurrent sends get distinct leaves, each leaf signs once, and every lane is followed by its key on chain. An expired lane is retried on a fresh key, never with a fee bump (PL/src/submit.ts:292-440,505-540; PL/test/submit.test.ts:285-289). What is missing:
   - a burst driver;
   - a check of the money set aside, run before signing;
   - a relay plan;
   - a refusal explainer;
   - the scene-1 script with the public-mempool contrast.
5. **The tooling is those missing pieces**: one module and one CLI, written up in the README, plus two or three upstream issues.
   - Build and rehearse on fakechain now. The devnet has been halted at block 408,262 since 04:28 IST (SPEC:611).
   - Run four probes when the devnet comes back (section 5).
   - Effort: the must-have part is about 3.5 h; with docs and issues, about 5 h.

## 1. What a hot lane is in this stack

### Keys and sequences
- A frame transaction carries `nonceKeys` (1 to 16 keys, strictly increasing) and one `nonceSeq`.
  - It is valid only if every selected key's current sequence equals `nonceSeq`.
  - Payment approval then moves each key to `nonceSeq + 1` (E8250 L127-150).
  - Transactions on disjoint key sets are replay-independent (E8250 L16).
  - Key 0 is the legacy account nonce and may only appear alone, as `[0]` (E8250 L86-91).
- A key's sequence lives in NONCE_MANAGER at `keccak256(pad32(sender) ‖ key)` (PL/src/builder.ts:31; WS/src/steps/step_12_tx_keyed_nonces.ts:20-21). On the devnet that contract is at `0x…8250` (PL/src/config.ts:20-21).

### Two kinds of lane

| | Single-use lane (what our post-quantum account needs) | Sequential lane (what an ECDSA account can use) |
|---|---|---|
| Nonce fields | One fresh key at sequence 0, used once. | One fixed key carrying sequences 0, 1, 2… |
| In flight at once | One, once. A reused key is refused with "Nonce mismatch" (SPEC:590), and the account demands sequence 0 (ACC:58). | One at a time on the devnet. The next sequence on a pending key is refused as "already held by pending transaction" (SC/services/MempoolService/service.ts:374-407). Admission also simulates against the latest state with no pending-nonce queue (SCR/test/e2e/frameTxSelfRelayMultiTx.e2e.test.ts:38-51). So the lane is a serial queue. |
| Cost | The key's first use costs 20,000 execution gas inside the verify frame, plus a permanent NONCE_MANAGER slot (SPEC:618). | About 170 gas once the key exists (SPEC:618). |
| Example | Our account: `(epoch << 32) \| leaf` (PL/src/builder.ts:15-28). | Workshop step 12: keys 1 and 2 at their next sequence (WS/src/steps/step_12_tx_keyed_nonces.ts:11-33). Day 0 showed sequence 1 admitted on a key after sequence 0 landed (SPEC:590). |
| Replacement | Forbidden: it would be a second signature on a one-time key (SPEC:368). | A +10% fee bump is legitimate. |

In both kinds, the only way to get more parallel transactions is to use more keys.

### What each mempool allows

| Rule set | Per (sender, key) | Per sender | Staking |
|---|---|---|---|
| **Devnet sidecar (alt mempool)**, the one that actually runs | 1 pending. Any transaction sharing a key with a pending one in another slot is refused (SC/services/MempoolService/service.ts:374-407). | **Keyed transactions the sender pays for itself: no cap.** Linear `[0]` transactions: 4, counted among linear ones only. A third-party payer stays capped (SC/services/MempoolService/reputation.ts:87-95,130-143; SC/services/MempoolService/constants.ts:1). | Our lanes need no stake: the stake check is skipped for exempt keyed lanes (reputation.ts:138-143). A THROTTLED entity is capped at 4 pending, keyed ones included; a BANNED one is refused (reputation.ts:114-129; constants.ts:2). |
| ERC-8421 draft (not on the devnet) | 4, with contiguous sequences (ERC L42, L276-278) | 64 for an unstaked sender; no sender-wide cap for a staked ACTIVE one (ERC L43, L278) | Its rationale describes our pattern exactly, a fresh key at sequence 0, where only the sender-wide cap binds (ERC L333). |
| Public mempool, EIP text | – | One pending frame transaction per sender (E8141 L1154). EIP-8250 keeps that rule (E8250 L233, L249). | – |
| Public mempool, ethrex's own pool on the devnet | 1 holder per key | Several keyed transactions only if their key sets are fully disjoint **and** all four of these hold: the sender is contract code, not an EOA or a 7702 delegation; there is no deploy frame; the prefix read none of the sender's storage; the prefix did not read TXPARAM 0x0D. Otherwise one per sender. A `[0]` transaction and a keyed one are never pending together (ETHREX L56-96). | – |

**When the throttle kicks in.** An entity is throttled when `floor(opsSeen/10) > opsIncluded + 10`. Both counters decay by 1/24 per hour (SC/entities/ReputationEntry.ts:35-69; SC/config.ts:601-603).

**How the canonical (public) pool should treat our account.** Our verify frame reads its own storage: slots 0-2, plus 3-5 for hot leaves (ACC:48-51, 99-102). That fails condition 3, so ethrex should hold our account to one pending transaction. This is likely, from source only; SPEC:608 is still open and needs a probe.

A wallet whose validation reads no storage would likely get concurrency in ethrex's pool. The workshop's ExampleWallet is one: its owner is immutable (WS/contracts/src/ExampleWallet.sol:17-27). So the public-versus-alt contrast is specific to accounts like ours.

**The relay path ignores ethrex's pool.**
- The sidecar hands each transaction to ethrex through `ethrex_submitPrivilegedFrameTransaction`.
- That call bypasses ethrex's admission: no fee check, no reservation check, no expiry check.
- It is tried in one payload build only (SC/services/BundlingService/relayers/privileged.ts:5-18; ethrex `crates/blockchain/blockchain.rs` L257-279 at 9aa3645d).
- So ethrex's one-per-sender fallback does not throttle alt lanes. That matches Day 0, where two keyed transactions from one EOA landed in one block (SPEC:591).

### Money: the "set aside for pending" line
- Each pending transaction owes:
  - its payer, the maximum gas cost (ethrex's simulated figure, or else frame limits × maxFeePerGas);
  - its sender, the value of its top-level frames.

  For a self-paying account the two add up on the same balance (SC/services/MempoolService/obligations.ts:5-33).
- At admission, a lane that would push the total over the balance is refused with "`<addr>` cannot cover its pending frame transactions…" (service.ts:409-437).
- Every block, if the total exceeds the balance, New entries are cancelled newest first. Submitted entries are left alone (service.ts:439-478).
- The EIP text and the draft also reserve cost per payer (E8141 L1163; ERC L226-228).
- This sum is exactly the screens' "set aside for pending" line (SPEC:84).

### A lane's life
- **Admission order:**
  1. chain id;
  2. sum of frame limits at most 25,000,000;
  3. recent-root window;
  4. one traced ethrex simulation;
  5. key conflict, replacement, balance and reputation;
  6. one gossip publish (SC/modules/eth.ts:150-207; SC/config.ts:645).

  The simulation runs before the key check, so the signed bytes of a refused lane have already been seen. The pipeline burns that leaf (PL/src/submit.ts:412-419).
- **Relay:**
  - Every 10 s the cron reconciles, then relays (SC/services/BundlingService/service.ts:497-514).
  - It picks up to 4 New entries, sorted by tip only. The key list is appended at admission, so equal tips relay in admission order (SC/services/MempoolService/service.ts:125-131,293-296; SC/entities/FrameTxMempoolEntry.ts:213-216).
  - Our grinder changes only maxFeePerGas (PL/src/submit.ts:356), so our lanes relay in the order they were admitted.
  - The selection is global, so other people's higher tips go first.
  - Status moves New, Pending, Submitted (SC/services/BundlingService/service.ts:177-201), then OnChain or Reverted. A missed block puts the lane back to New.
  - After more than 3 relays it is Cancelled with "relayed N times without being included in a block" (BundlingService/service.ts:325-343; SC/config.ts:634).

What happens to one lane, and to the others:

| Event | Alt mempool (sidecar) | Public (ethrex) | Our pipeline |
|---|---|---|---|
| A lane lands | Its key reads 1. Every remaining New lane is re-simulated each block (SC/services/BundlingService/reconciliation.ts:93-114,423-470). A plain transfer changes nothing the other lanes read. A landed `rotate()` or `setHotPolicy()` would cancel lanes whose verify frame reads the changed slots. | Removes the included transaction and revalidates its dependents (E8141 L1171). | Key used two blocks deep: OnChain, Reverted or Included (PL/src/submit.ts:161-170,434-437). The backend already refuses rotation while lanes are in flight (BE/backend/src/backend.ts:663-680). |
| A lane expires | The sidecar has no deadline logic. Re-simulation fails and the lane is Cancelled with "revalidation failed as of block N" (reconciliation.ts:451-461). A Submitted lane that missed its block is relayed again first and may end as "relayed N times…" instead (likely: reconciliation.ts:100-111). | Drops a transaction whose deadline is behind the new head (ethrex `blockchain.rs` L3771-3777). | Expired when the key is still unused at a block past the deadline (submit.ts:171-173). Burn the leaf, then retry on the next leaf once the sidecar has dropped the dead attempt (submit.ts:491-532). |
| A different transaction arrives in the same slot | It replaces the lane given +10% on both fees, or with no bump once 300 s have passed since the entry's last update (FrameTxMempoolEntry.ts:175-202; SC/config.ts:620). The old one is watched for late inclusion (service.ts:254-266). Identical bytes while the lane is live get "already known" (service.ts:487-502). | Exact key set and same sequence: a fee bump. A partial overlap is refused (ETHREX L61). | Never, for a one-time key. Only the journal prevents it (PL/src/leaves.ts:1-3). |
| A transaction shares a key with a pending one | Refused: "nonce key 0x… is already held by pending transaction 0x…" (service.ts:399-404) | `FrameTxSenderAlreadyPending` (ETHREX L61) | Cannot happen: keys come from distinct leaves. |
| A lane is Cancelled | It can still land, through the watch list (reconciliation.ts:181-236). The same bytes may be sent again (FrameTxMempoolEntry.ts:175-176). A transport error to ethrex during revalidation cancels every New lane on that node (reconciliation.ts:451-461; SC/services/FrameTxSimulationService/index.ts:84-88). | – | Status never decides anything (submit.ts:128-136). |

## 2. How we implement it on our pipeline

### What already exists
- **Lane naming:** `nonceKeyFor`, `keyedNonce` and `nonceManagerSlot` (PL/src/builder.ts:11-31). The 100k prefix cap is enforced at build time (builder.ts:124-125).
- **Lane allocator for our account:** `LeafJournal.reserveNext`.
  - The record is on disk as "reserved" before the call returns.
  - States only move forward (PL/src/leaves.ts:48-55,175-202).
  - There is one writer per file, enforced with flock, and only one journal per tree in a directory (leaves.ts:5-14).
- **Parallel safety:** concurrent `sendKeyed` calls in one process get distinct leaves, because nothing awaits between the peek and the reservation (submit.ts:332-368). A test covers four at once (PL/test/submit.test.ts:285-289).
- **Per-lane follow:** `waitForInclusion` reads NONCE_MANAGER two blocks below the head (submit.ts:76-83,137-187; PL/src/config.ts:43-44).
- **Per-lane retry:** `sendWithRetry` sends the next leaf with fresh fees after the sidecar drops the dead attempt (submit.ts:491-540). `settleSubmitted` handles lanes left open by a crash (submit.ts:446-464).
- **Public pool:** `node.sendRawPublic` exists but nothing calls it (PL/src/rpc.ts:259-260). In the feat/backend worktree, `sendKeyed` has an `alt` / `public` switch and an `onSubmitted` hook (BE/pipeline/src/submit.ts:225-247,440-480). POST /send runs in the background, and four parallel sends take four keys (BE/backend/src/backend.ts:459-495; BE/backend/test/send.test.ts:41-42). The web Fire button sends all tranches at once (BE/web/public/flows.js:141-148).
- **Gas model:** `frameGasModel` (PL/src/estimate.ts:28-46).
- **Local fake devnet:** fakechain models:
  - one pending per key;
  - the 10% / 300 s replacement rule;
  - balance obligations;
  - 4 relays per pass, 3 attempts, requeue and revalidation;
  - a public pool with a per-sender cap (FC/README.md:79-82; FC/src/constants.ts:34-44).

  It does not have `skandha_config` or `skandha_subscribe` (FC/src/methods.ts:183-200), reputation, or EOAs (FC/README.md:88-90).

### What to add

**New file `/Users/vicky/Documents/winterlock/pipeline/src/lanes.ts`**, a wrapper only, with no change to the hardened send path:
```ts
planLanes({ sender, n, calls, fees, inFlight })  // -> { perLaneMaxWei, setAsideWei, balanceWei, affordable, passes, etaSeconds, warnings }
fireLanes({ n, base: SendKeyedParams, attempts }) // n x sendKeyed (or sendWithRetry), Promise.allSettled, one journal instance
explainRefusal(message)                          // -> { code, laneState, fix }
relayConfig(url)                                 // skandha_config, else the defaults
```

1. **`planLanes`: the set-aside check, run before any leaf is reserved.**
   - Per lane, cost = gas limit × maxFeePerGas + value. Gas limit = `max(intrinsic + Σexec + Σstate, mandatory + floor + Σstate)`, as fakechain models ethrex (FC/src/frameTx.ts:90-97), built on `frameGasModel`.
   - Price the zero-byte placeholder signatures as non-zero bytes. That makes the figure an upper bound.
   - For hot lanes, use valueCap + feeCap, which the account enforces (ACC:98-110).
   - Compare the sum over in-flight lanes plus the new ones with the balance. Refuse the burst locally instead of having the sidecar refuse it after signing.
   - After the preflight simulation, record ethrex's own `maxCost` (PL/src/rpc.ts:183), which is the figure the sidecar uses (obligations.ts:24-27).
   - Known gap: lanes from another device, such as a hot device, are invisible locally even though the sidecar counts them. The upstream sender filter (section 3) would close this.
   - Example, assuming a 2 gwei max fee and the default limits (PL/src/config.ts:37-41): about 211k gas, so about 0.00042 ETH per lane plus its value.
2. **`relayConfig` and the relay plan.**
   - `skandha_config` returns bundleSize, bundleInterval, maxSubmitAttempts and useropsTTL (SC/modules/skandha.ts:86-146).
   - passes = ceil(n / bundleSize).
   - Expected time to the last landing ≈ 28 s (measured for one transaction, SPEC:610) + 10 s per extra pass. That gives about 38 s for 8 lanes and about 58 s for 16. This is an estimate.
   - Warn if that exceeds the 90 s expiry (PL/src/config.ts:37).
3. **`fireLanes`: parallel submission.**
   - n × `sendKeyed` in one process through `Promise.allSettled`. Use `sendWithRetry` instead if each lane should retry.
   - Capture each lane's wire JSON through `onSend` (submit.ts:404), since SPEC:480 requires scripts to print the JSON they sent.
   - Record the largest number of lanes seen non-final at the same time. Workshop step 12 proves overlap only by a null receipt (WS/src/steps/step_12_tx_keyed_nonces.ts:34-35).
   - Submit to the miner's sidecar through `WL_GATEWAY_URL` (PL/src/config.ts:12). Since Nov 5 the gateway admits but never relays (SPEC:610).
4. **`explainRefusal`: exact strings to lane states.**

   | Message contains | Lane state | Source |
   |---|---|---|
   | "is already held by pending transaction" | key busy | service.ts:399-404 |
   | "cannot be replaced: fee too low" | same slot: a signer bug, never bump | service.ts:509-511 |
   | "already known" | duplicate: follow it | service.ts:498-500 |
   | "cannot cover its pending frame transactions" | over budget | service.ts:431-432 |
   | "can no longer cover … as of block" | evicted for balance | service.ts:473 |
   | "Nonce mismatch" | key already consumed | SPEC:590 |
   | "exceeds MAX_VERIFY_GAS" | prefix over 100k | SPEC:603 |
   | "revalidation failed as of block" or "relayed N times without being included" | dropped: check the chain | reconciliation.ts:456; BundlingService/service.ts:340 |
   | "is throttled" / "is banned" | reputation | reputation.ts:114-129 |

**New file `/Users/vicky/Documents/winterlock/pipeline/scripts/lanes.ts`**, the CLI.
- `plan --n 8`
- `burst --n 8 [--mempool alt|public]` is scene 1 (SPEC:473; PLAN:107). It prints, for each lane: leaf, key, hash, the JSON sent, the status timeline, the admission report (PL/src/admission.ts:33-76), and NONCE_MANAGER before and after.
- Later: `status --keys a..b` and `watch`.

**Small changes to existing files:**
- Export the module from `PL/src/index.ts`.
- Add a `skandha_config` stub to `FC/src/methods.ts` that returns the sidecar defaults (about 10 min).
- Optionally, store `maxCost` on the backend's TxRecord (BE/backend/src/store.ts:13-46). Then the board's set-aside line can drop "plus the fees of N keyed lanes, which the API does not report" (BE/web/public/lanes.js:216-225).

### Lane bands per device, so devices never collide
- **Our account:**
  - The cold band is `[1, hotStart)`; the hot band is `[hotStart, 2^h)`. The plan's hot band is 16 leaves with hotStart = 1008 (PLAN:123).
  - Export disjoint ticket ranges, one per hot device. The cold journal marks them "exported" first (PL/src/leaves.ts:220-231), and each device keeps its own journal (BE/pipeline/src/tickets.ts).
  - Disjoint leaves give disjoint keys, so devices can never hit a key conflict or a double signature.
- **One process owns the cold journal** (leaves.ts:5-14). The backend and a script cannot both sign from the cold band. Fire bursts either through the backend's POST /send, as the web does, or from the CLI with the backend stopped.
- **ECDSA sequential lanes (future):** give each device a disjoint key range. Read nextSeq per key from NONCE_MANAGER and keep one transaction in flight per key.

### Limits to enforce on our side

| Limit | Why | Where |
|---|---|---|
| One key per transaction, sequence 0 | The account requires it (ACC:55-58) | Exists: `keyedNonce` |
| Never send a second, different transaction into a pending slot | The sidecar would accept it with +10%, or with no bump after 300 s (FrameTxMempoolEntry.ts:175-202) | Exists: the journal |
| Sum of (max cost + value) over in-flight lanes ≤ balance | service.ts:409-478 | New: `planLanes` |
| Prefix ≤ 100,000 including signature costs | SC/services/UserOpValidation/utils/validationPrefix.ts:10 | Exists: builder.ts:124-125 |
| Expiry long enough for ceil(N/4) relay passes | SC/config.ts:628,635 | New: the relay plan |
| No rotate or setHotPolicy while lanes are in flight | Revalidation cancels lanes that read the changed slots (reconciliation.ts:423-463) | Exists in the backend (backend.ts:663-680) |
| Submit to a node that relays | SPEC:610; the gateway runs in manual mode (SCR/deploy/devnet/README.md:428-434,459) | New: a health gate |
| Watch reputation: about 110 admissions without inclusions makes the account THROTTLED, capped at 4 | ReputationEntry.ts:60-68; reputation.ts:121-129 | New: a warning in `plan` |
| Hot lanes: each at or under the value and fee caps; exposure is N × (valueCap + feeCap) | ACC:98-110 | Exists: account and screens |
| Never call `debug_bundler_*` setters on the shared devnet | They affect everyone (SCR/deploy/devnet/devnet-readme.md:413-421; WS/AGENTS.md:62) | Rule |

## 3. Developer tooling options

| Option | Value for a developer | Value for the judges | Hours | Risk |
|---|---|---|---|---|
| (a) `lanes.ts`, single-use keys only | Fills a real gap: hegota-support only builds, signs and does RPC (https://unpkg.com/@forshtat/hegota-support@0.0.1/README.md L8-16, 143-146), and workshop step 12 hard-codes two keys | Area 2 asks for "a viem/ethers SDK…, an admission simulator, mempool monitoring" (PRIZE) | 2-2.5 | Low: it wraps `sendKeyed` |
| (a+) Add sequential lanes for ECDSA and EOA accounts | High: general developers | Higher for area 2 | +2.5, plus about 2 for EOA support in fakechain | Medium: the follow logic assumes "consumed = seq ≠ 0" (submit.ts:82); seq 0 is hard-coded (submit.ts:320); config is read from env at import and the clients are singletons (PL/src/config.ts:5-16; PL/src/rpc.ts:206,232) |
| (b) CLI: `plan` and `burst` | Repeatable runs that print the JSON sent | It is scene 1 | 1-1.5 | Low |
| (b) CLI: `status`, `watch`, `doctor` | Monitoring. `watch` could use `skandha_subscribe ["explorerEvents", sinceSeq]` (SCR/docs/sidecar_explorer.md:673-690) | "Mempool monitoring" | 0.5 + 1 + 1 | Low |
| (c) Lane board UI | Already exists in feat/backend (BE/web/public/lanes.js, board.js); an exact set-aside needs `maxCost` stored | The screens are the demo | 0.75 | Low, but it touches the backend, which is in progress |
| (c) Upstream explorer lane view | The Pool screen filters by status only (SCR/packages/devnet-ui/src/ui/screens/PoolScreen.tsx:75-95) | Area 2 | 3-4, plus review time | High: may not merge before judging |
| (d) Issues | See below | Counts toward SPEC:577 and the "Filed findings" item (SPEC:680) | 0.5-0.75 | Low |
| (d) Workshop "hot lanes" step PR | N transactions at once from ExampleWallet; overlap proved from statuses; a busy-key refusal; relay batches | Area 2 | 2.5-3 | Cannot be run while the devnet is halted. The workshop sends through the gateway (WS/src/lib/frameTx/send.ts:11-14), which does not relay (SPEC:610). It cannot show a public contrast for a wallet that reads no storage. It is third-party event work, so it must be disclosed, and Vicky opens it (AGENTS:19) |
| (d) Sidecar PR: sender filter | `skandha_explorer_listTransactions` filters by status only (SC/modules/explorer.ts:108-139) | Area 2 or 3 | 2 | Medium |
| (e) README "Lanes" section | The rules table with sources, the numbers, how to run on fakechain and on the devnet | Explaining design and trade-offs is a qualification requirement (PRIZE) | 0.75 | Low: part of V7 (PLAN:111) |

**Issues worth filing:**
1. The sidecar needs a sender filter on `listTransactions`.
2. The workshop's `WS/src/lib/explain.ts:117` describes ethrex's storage rule, while step 12 sends to the sidecar.
3. `explainRejection` only maps OP-011 and STO (WS/src/lib/frameTx/send.ts:55-65).
4. One transport error during revalidation cancels every New lane (reconciliation.ts:451-461).

**Recommended cut.** About 5 of the roughly 10 hours, leaving about 5 for the backend, screens and README in progress.
- **Must, about 3.5 h:**
  - `lanes.ts` with `planLanes`, `fireLanes`, `explainRefusal` and `relayConfig`, tested on fakechain (2 h);
  - the CLI's `plan` and `burst` (1 h);
  - two clean fakechain rehearsals, plus the `skandha_config` stub (0.5 h).
- **Should, about 1.5 h:**
  - the README "Lanes" section;
  - three issues;
  - the devnet probes once it is back.
- **Could, only if V6 is done by Fri 21:00 (PLAN:116):**
  - `status` and `watch`;
  - `maxCost` in the backend;
  - one 16-lane run;
  - the workshop PR.
- **Not before the freeze:**
  - sequential ECDSA lanes;
  - a simulator covering all four rule sets;
  - the explorer view PR;
  - the config refactor;
  - identical-bytes sending and resending after Cancelled (both need a decision first).

The reasoning: there is one EF prize per project (SPEC:579), and our claim is area 1. So the tooling should make the post-quantum wallet's lanes visible and explainable, which is cheap, rather than become a separate generic SDK, which is expensive. Every AI-written file goes into the README's AI-attribution section (AGENTS:18; README:20-36).

## 4. The judge demo, under 60 seconds

Before recording: the devnet is producing blocks, `skandha_config` has been read, and `lanes plan --n 8` shows the balance, the per-lane set-aside and the number of passes.

1. **0:00-0:10.** Say: "Each payment is its own lane: its own nonce key at sequence 0. The chain consumes a key once, so each one-time key signs once." Show the 8 keys from the plan. They are printed live, for example leaves 4-11 as keys 0x4-0xb.
2. **0:10-0:20, public mempool** (`eth_sendRawTransaction`). Expect 1 accepted and 7 refused. **Only include this beat if the probe confirms it.** Fresh leaves burn the 7 refused ones (BE/web/public/ui.js:101).
3. **0:20-0:50, alt mempool** (the miner's sidecar).
   - Eight lanes are admitted in the same second.
   - The board shows them landing in batches of 4: New, then Submitted, then OnChain, over two or more blocks.
   - Each key's NONCE_MANAGER slot goes 0 → 1, and the account's legacy nonce does not move.
4. **0:50-0:60.** The numbers in the table below.

| Number | Value | Kind | Source |
|---|---|---|---|
| Lanes | 8 keys, sequence 0, one transaction each | Design | PL/src/builder.ts:15-28 |
| Alt rule | 1 pending per key; no per-sender cap for keyed lanes the account pays for itself | Code | service.ts:374-407; reputation.ts:87-95 |
| Public rule | 1 per sender (EIP text). For our account, 1 accepted and 7 refused | Rule; expected, not yet probed | E8141 L1154; ETHREX L76-90 |
| Relay | At most 4 per 10 s pass, so 8 lanes need at least 2 passes | Defaults; read the live values | SC/config.ts:628,635 |
| One transaction, New to OnChain | About 28 s | Measured Nov 5 | SPEC:610 |
| Signature entry | 2,594 bytes | Spec | SPEC:235 |
| Verify frame | 89,006 gas of 94,900 declared, 420 chain steps | Measured, block 407,107 | README:11 |
| Prefix cap | 100,000 = 5,000 expiry + 94,900 verify + 100 for the hash-based (ARBITRARY) signature entry | Rule | validationPrefix.ts:10; PL/src/config.ts:32-39 |
| Whole transaction | 186,245 gas | Measured, block 407,107 | README:11 |
| First use of a key | 20,000 gas inside the verify frame | Measured | SPEC:618 |
| Set aside | Sum of (max cost + value), compared with the balance | Computed live | obligations.ts:5-33 |
| Expiry | 90 s; a stuck lane retries on a fresh key, never with a fee bump | Design | PL/src/config.ts:37; submit.ts:505-510 |

Do not show "4 pending per lane, 64 per sender" unless it is labelled as the ERC draft. Do not say "in one or two blocks" either, unless `skandha_config` shows bundleSize ≥ 8.

## 5. How to verify

**On fakechain, now.**
- Run `cd fakechain && bun run.ts`, then source `env.sh` (FC/README.md:13-20).
- Check:
  - 8 distinct keys, all admitted;
  - 4 relayed per `--bundle-interval`;
  - exactly one public pending with `--public-per-sender 1` (FC/README.md:27,82);
  - "cannot cover" when underfunded.
- Fakechain cannot check:
  - ethrex's real four-condition rule (it uses a flat cap);
  - reputation;
  - EOAs;
  - the real relay-before-revalidate order: fakechain revalidates requeued entries in the same pass (FC/src/sidecar.ts:250-259).
- A fakechain run proves the logic only, never devnet acceptance (FC/README.md:7-9).

**On the devnet, when it returns.** Write each result into the Day-0 list.
1. `skandha_config` on the miner and on the gateway, and `skandha_explorer_peers` (both read-only).
2. Two lanes from our account through `eth_sendRawTransaction`. If both are admitted, drop the public beat and fix the notice text in BE/web/public/ui.js:101.
3. An 8-lane burst to the miner's sidecar: count admissions, passes, blocks and seconds.
4. One short-expiry lane, as PL/scripts/retry-demo.ts:26 does: record which drop reason appears.

## 6. Open questions for Vicky

1. **Spec versus code (AGENTS:12).** SPEC:85 (also :37 and :69) gives "4 pending per lane, 64 per unstaked sender". Those are draft numbers (ERC L42-43). The devnet runs 1 per key with keyed lanes uncapped (SPEC:148; service.ts:374-407). Should every number on the screens and in the README be labelled by rule set?
2. **SPEC:142 budget numbers.** It gives 250k / 2.5M under BUDGET-010. The draft now says 100k / 1M (ERC L38-39), and the sidecar enforces a flat 100k. SPEC:145 says "docs say one per (sender, nonce key)", but the docs now say 4 for the draft and 1 for the sidecar (DOCS). Fix the wording?
3. **SPEC:559 "eight … in one or two blocks".** With the default relay that is at least 2 passes. Change it to "two or more blocks"?
4. **SPEC:608.** Keep the public-mempool beat only after the probe? Reword it to: "the EIP says one per sender, and ethrex enforces that for our account because our validation reads account storage."
5. **Scope.** Tooling beyond scene 1 is in neither the spec nor the plan (PLAN:116). Which cut is approved? Are sequential ECDSA lanes wanted at all?
6. **The public contrast costs leaves.** Fresh leaves burn N−1 per run. The alternative sends the same signed bytes to both mempools, but `sendKeyed` currently burns a leaf on any deliberate refusal (PL/src/submit.ts:412-419). Approve the change?
7. **Resend after Cancelled?** The sidecar allows resending identical bytes for a lane it cancelled before the deadline. That would save a leaf, but SPEC:465 says Cancelled burns the leaf.
8. **The name.** "Hot lanes" is not in the screens' vocabulary (SPEC:83), where "hot" means the hot band. Use "lanes" or "parallel lanes" in the README and video?
9. **Which branch.** `submit.ts` differs between the two worktrees: the mempool switch and `onSubmitted` exist only in BE. Build `lanes.ts` after feat/backend merges?
10. **Upstream work.** File the issues now (SPEC:577)? Open a workshop PR during the event?
11. **If the devnet stays down.** The prize accepts "code that submits one" (PRIZE). Is a fakechain recording, labelled as fake, acceptable for the video?
12. **16 lanes.** "Lanes at scale" (SPEC:679) needs at least 4 passes, about 58 s by estimate. Put it in the video, or in the README only?