Twelve of the plan's claims need fixing. None changes the design: one fresh key per lane at sequence 0, sent to the miner's sidecar, followed by chain state, never fee-bumped. Most other citations check out. I read the vendored sidecar and pipeline code, and fetched only plain web pages: ethrex at commit 9aa3645d, EIP-8141 master, EIP-8250 at 81b976ac, the ERC-8421 PR #2028 diff, the docs keyed-nonces page, the prize page and the hegota-support README. Copies are in /private/tmp/claude-501/-Users-vicky-Documents-winterlock/659dcc9a-8920-4a15-a793-a15955424ccb/scratchpad/critic-fetch/.

**Corrections, most important first**

1. **Sequential-lane refusal (section 1 table).** The next sequence on a pending key is not refused with "already held by pending transaction". ethrex's simulation runs before the key check and refuses it with "Nonce mismatch: expected N, got N+1". Sources: SC/modules/eth.ts:182-192; SCR/test/e2e/frameTxSelfRelayMultiTx.e2e.test.ts:38-51. So "Nonce mismatch" does not always mean "key already consumed": the refusal explainer must compare expected with got.

2. **"The only limit the lanes share is money" (section 0, item 2) is overstated.** Lanes also share:
   - relay throughput: 4 per pass, chosen across all senders;
   - the THROTTLED cap of 4;
   - the storage their verify frames read;
   - one journal writer;
   - a finite band: the hot band is 16 leaves (PLAN:123).

   "Land in any order" (item 3) also contradicts the plan's own FIFO finding. Lanes go in admission order across passes, and ethrex applies relayed transactions first, in queue order (ethrex payload.rs:628-641). Only lanes within one pass can swap, because dispatch is fire-and-forget (BundlingService/service.ts:189-198).

3. **Revalidation.** Every New lane is re-simulated every block (reconciliation.ts:465-477), and only lanes that now fail are cancelled. It is not "lanes that read the changed slots": every lane reads slot 2. The limits-table entry "No rotate or setHotPolicy while lanes are in flight: exists in the backend" is half wrong. The backend guards rotate only (BE backend.ts:693-694); hotPolicy has no such guard (backend.ts:651-675). Lowering hotStart turns pending cold lanes hot, they fail the hot checks and get cancelled (ACC:62).

4. **`relayConfig` cannot rely on `skandha_config` alone.**
   - It has no bundlingMode field (skandha.ts:96-166); that is in `skandha_explorer_info` (explorer.ts:95).
   - It reports the configured bundleSize and interval, not the live ones. testingMode forces 10 per pass (executor.ts:225-227), and `debug_bundler_setBundleInterval`, which anyone can call on the devnet (devnet-readme.md:413-421), changes the live interval (BundlingService/service.ts:151-156).

5. **Where the money check gets its numbers is unspecified.**
   - The journal stores no value or maximum cost (leaves.ts:24-33), and the sidecar exposes no maxCost (FrameTxMempoolEntry.ts:242-287).
   - The plan's formula does equal ethrex's `total_gas_limit` (ethrex transaction.rs:2610-2638), so the check can recompute it exactly from each signed transaction.
   - It must count what the sidecar counts. A landed lane stays counted until the next reconcile tick while the balance has already dropped (MempoolService/service.ts:100-104,417-437; reconciliation.ts:93-114). A chain-expired attempt stays counted until the sidecar cancels it (submit.ts:491-503).

6. **The refusal explainer misses the account's own refusals.**
   - A verify revert arrives as "validation frame N: reverted with data 0x…". Decode the 32-byte ASCII reason (validators/frameTx.ts:226-228; ACC:17-18,240); this covers the hot over-cap and wrong-target refusals of scene 3.
   - Out of gas arrives as "validation frame N: ran out of gas" (frameTx.ts:224-225).
   - The public-mempool refusal reads "A pending frame transaction from this sender is already in the pool" (ethrex error.rs:165-166).

7. **"Eight admitted in the same second" will not happen with N copies of `sendKeyed`.** Contending sends reserve leaves one storage read apart (submit.ts:338-368), and each also runs a traced preflight (BE backend.ts:617). Either read all N keys first and then reserve them with no await between, or drop the claim.

8. **The demo numbers are not the lanes' numbers.** Lanes declare 90,000 (BE backend.ts:44; retry-demo.ts:23), so the prefix is 95,100, not 100,000 = 5,000 + 94,900 + 100. The gas limit is about 206k per lane, not 211k. At 90k behind the proxy only about 88,643 is usable (config.ts:63-72), so README:11's 89,006-of-94,900 must be labelled as that one transaction.

9. **"Cancelled can still land through the watch list" is wrong.** The watch list only detects a late inclusion (reconciliation.ts:181-236). A Cancelled entry is never relayed again (BundlingService/service.ts:313-347).

10. **Two missed gotchas when sending to the miner.**
    - The faucet runs only on the gateway (SCR/deploy/devnet/README.md:488-490), so with `WL_GATEWAY_URL` pointed at the miner, funding fails.
    - The explorer reads the gateway (SPEC:600), and p2p was empty on both nodes (SPEC:610). The explorer links for lanes sent to the miner may show nothing there, so check that the README links resolve.

11. **Minor points.**
    - The linear cap of 4 applies only to the sender bucket. Our self-pay shape has no sender role (eth.ts:194-198), so its payer bucket's 10 + … applies (reputation.ts:130-137; ReputationService.ts:203-218).
    - Reputation decays only after whole idle hours, because every update resets the clock (ReputationEntry.ts:40-51,84-88). The roughly 110-admission throttle budget is cumulative while the account is active.
    - "Halted since 04:28" is unverified: SPEC:611 only records it still stopped at 05:56 IST.

12. **Scene scripts belong in demo/ (PLAN:51), not pipeline/scripts.**

**Upgraded from "likely" (now confirmed in source, still needs the devnet probe)**

Our account should get 1 lane admitted and N−1 refused in ethrex's public mempool. ethrex records a read of the sender's storage when the reading frame's storage owner is the sender, and through the proxy that is the account (stack_memory_storage_flow.rs:255-279; vm.rs:4272-4300). That makes it ineligible for parallel lanes (blockchain.rs:4431-4445), and its later lanes are refused (mempool.rs:1000-1012).

**Checked and correct**

- Admission order, the key-conflict rule and the self-pay keyed exemption (no stake needed).
- The balance obligations and newest-first eviction.
- The relay defaults: 4 per pass, every 10 s, cancelled after 4 relays.
- The replacement rule: +10% on both fees, or none after 300 s.
- The relay bypassing ethrex's admission, and ethrex's four-condition gate.
- All cited lines of EIP-8141, EIP-8250, ERC-8421, the docs, the prize page and the spec and plan.
- The pipeline and fakechain references.

**Verdict**

Adopt the recommendation with these corrections. It is the right approach, and keeping the tooling narrow suits an area-1 entry, since the event gives one EF prize per project.

The 3.5 h must-have is optimistic. The mempool switch and `onSubmitted` exist only in the uncommitted feat/backend `submit.ts`, which differs from main by 123 lines. Budget merge time, or wait for that branch to land. Items 5 to 7 add about 1 h. The cheaper path is to drive N parallel `POST /send` calls to the backend, which already holds the journal and has the mempool switch, and to print each sent JSON from `eth_getFrameTransactionByHash`. That leaves only the money check and the refusal explainer as new code.

The plan's "about 5 of the roughly 10 hours" has no source. PLAN:107 gives scene 1 a share of a 4 h block, and anything beyond scene 1 is Level B (PLAN:116), so it needs Vicky's approval. Qualification is already met by README:11, so a fakechain recording would only stand in for the lanes scene.