# Technical plan, Nov 4 to 7

Written Wednesday Nov 4, afternoon IST, after reading the ETHGlobal Mumbai FAQ and hacker guide. It supersedes the owner columns of the Feature levels table and the Work split and milestones section on the main tab: those still describe what is built, this tab says who builds it and when, given that only one of us is a registered hacker. The main tab is reconciled after Vicky has read this.

## 1. Situation and the rule we follow

- Vicky is the only accepted, staked hacker. Author did not apply. ETHGlobal's own FAQ, read Nov 4: every team member applies and stakes individually, the event is strictly in person, applications are closed at venue capacity, no walk-ins, no late staking even with a team, no substitutions. A submission that misrepresents what was built during the event is disqualified, prizes are revoked, and the team can be banned.
- So the project enters the **Extend Open Source** track. Author publishes a generic hash-based signature library before hacking begins. Vicky forks it and builds the EIP-8141 account, the frame-transaction pipeline, the backend, the wired screens and the demos during the event. Only the event work is judged; the library is disclosed as the starting point.
- The bright line: Author's last commit, anywhere in the project, lands before **Thursday Nov 5, 20:59 IST**. No commits, reviews, pull requests or pairing by Author from then until prizes are paid out. Every event commit is in Vicky's fork and authored by Vicky.
- To confirm at the EF workshop (Thursday 17:00, Workshop Room 2, Andrew Morris and Pierre Daix-Moreux): does an Extend Open Source entry whose base is a signature library, with the account and the mempool integration built during the event, qualify for the alt-mempool prize? Get the answer in writing on Discord. ETHGlobal's rules say partner-prize eligibility on continuity tracks may vary; the prize text itself has no track restriction. If the answer is no, section 9 applies.
- AI tools: the FAQ permits them with attribution. The README must say which files were written with Claude Code or similar, and the work must not be AI alone. Vicky drives any AI tool; Author does not.

## 2. Timeline (IST)

| When | What | Who |
| --- | --- | --- |
| Wed Nov 4, 15:00 to Thu Nov 5, 20:59 | Library built, tested, tagged, published (section 5) | Author |
| Thu 13:00 | Event registration opens, wristband | Vicky |
| Thu 17:00 to 17:30 | EF workshop: the eligibility question, the devnet to use, where to file divergences | Vicky |
| Thu 20:00 | Opening ceremony | Vicky |
| Thu 21:00 | Hacking begins. Fork created, project registered on the Hacker Dashboard, disclosure pasted | Vicky |
| Thu 21:00 to Sat 09:00 | 36 hours of event work (section 7) | Vicky alone |
| Sat 08:30 | Submission sent, 30 minutes before the 09:00 deadline | Vicky |
| Sat, when judging opens | Partner judging at the EF booth (section 10) | Vicky |
| Until prizes are paid | No work on the project by anyone, per the FAQ | Both |

## 3. Repository layout

Upstream, on Author's GitHub, working name hashsig (Author may rename), MIT or Apache-2.0:

```
contracts/   Foundry. src/HashSigVerify.yul (the verify function), src/HashSigVerifier.sol (wrapper),
             test/ (vectors, oracle, gas), lib/hashsigs-solidity (git submodule, AGPL, tests only, never linked)
signer/      Rust crate and binary hashsig: wots, derive, tree, entry, vectors, cli
vectors/     h10.json, produced by the CLI, consumed by Foundry now and by the TypeScript tests later
docs/        spec.md (this document exported), BRIEF.md, prototypes/hot-cold.html, agent.html, session.html
README.md    what it is, sizes, gas by height, how to run the tests, status: v0.1.0, pre-hackathon
LICENSE
```

Tag v0.1.0 marks the pre-event state. Nothing in upstream code refers to EIP-8141, TXPARAM, nonce keys, ERC-8421, hot tickets or recent roots. The docs folder may, because the spec is the disclosed design.

Fork, on Vicky's GitHub, the repository that is submitted. Added during the event:

```
account/     Foundry. src/Account.yul (the verify frame object, includes HashSigVerify.yul by concatenation),
             src/AccountProxy.sol (EIP-1167), src/Factory.sol, test/
pipeline/    Bun and TypeScript library: codec (vendored, commit pinned), builder, signer, rpc, submit, leaves
backend/     Bun HTTP, the API of Shared interfaces 5
web/         the three screens from docs/prototypes, wired to the backend
demo/        one script per scene, each printing the JSON it sends
README.md    rewritten for the project, with a section What existed before, pointing at v0.1.0
```

## 4. Interfaces frozen before the event

The fork depends on these. Author ships them in v0.1.0; changing one during the event means Vicky changes the fork's copy.

1. **Yul verify function.** `function hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, chainId) -> ok`. The entry argument is a memory pointer to the signature entry: version byte 0x01, chain slot byte, 2,144 signature bytes, 32 × (height + 4) path bytes. Returns 1 or 0 and never reverts; the caller decides what a 0 means. Uses about 3 KB of memory above entry + entryLen, reads no storage, makes no calls, and takes the chain id as a parameter so the caller reads CHAINID once. Steps 5 to 8 of the verify-frame algorithm on the main tab, exactly.
2. **Solidity wrapper** for tests and pre-flight checks: `HashSigVerifier.verify(bytes32 root, bytes32 treeSeed, uint8 height, uint256 chainId, bytes32 msgHash, bytes calldata entry) external pure returns (bool)`.
3. **Inclusion recipe.** The account's Yul object is built by pasting HashSigVerify.yul into its code section: `contracts/scripts/concat.sh <outer.yul> <out.yul>`, then `solc --strict-assembly --optimize`. The verbatim builtins for TXPARAM, FRAMEPARAM, SIGPARAM, SIGDATACOPY and APPROVE live only in the outer object, which is Vicky's.
4. **CLI.** Commands, inputs and outputs exactly as the Signer core table on the main tab: keygen, pubkey, sign, verify, vectors, export-leaves. Hex is 0x-prefixed lowercase. Exit 0 with one JSON object on stdout, or exit 1 with an object {error: code, detail: text} on stderr. Codes: bad\_seed, bad\_height, bad\_chain, leaf\_out\_of\_range, bad\_msg\_length, bad\_entry\_length, verify\_failed, leaf\_not\_in\_ticket. The seed comes from `--seed-file` or the PQ\_SEED variable, never from an argument.
5. **Vector file** vectors/h10.json: the minimum cases of Shared interfaces 1 (leaf 0, the last leaf, a middle leaf, the mutations, the wrong-chain case).
6. **Ticket file**, pinned here and copied into Shared interfaces when the main tab is reconciled. A JSON object with version 1, treeSeed, root, height, generation, chainId, slot, and leaves: a list of objects each holding leaf, secrets (67 hex strings of 32 bytes) and authPath (height + 4 hex strings of 32 bytes). `sign --ticket-file` refuses a leaf that is not in the file with leaf\_not\_in\_ticket.
7. **Not in the library:** the nonce key, frames, the entry's place in a transaction, the journal of exposed leaves. Those are Shared interfaces 3 and the pipeline, built in the fork.

## 5. Author: Wednesday 15:00 to Thursday 20:59 IST

In priority order. Hours are estimates for one person; A1 to A4 are the minimum, A5 to A7 drop first if time runs out.

| # | Task | Hours | Done means |
| --- | --- | --- | --- |
| A1 | Repository: licence, README skeleton, CI running cargo test and forge test, docs/ with the exported spec, the BRIEF and the three prototypes | 1 | CI green on an empty test |
| A2 | Rust derive and wots: seeds and secrets per the Cryptography formulas, Quip-format chains, digits and checksum, public key hash, sign, verify | 4 | Round-trip on 1,000 random messages; Quip's implementation as a dev-dependency accepts our signatures and derives the same public key hash |
| A3 | Rust tree, entry, cli: subtree per chain plus the 4-level slot layer, authentication path, entry encode and decode, keygen, pubkey, sign, verify, vectors, level cache | 4 | keygen at h = 10 under 1 s per chain, sign under 50 ms warm; vectors/h10.json written with every mutation case |
| A4 | HashSigVerify.yul and HashSigVerifier.sol with Foundry tests: every vector passes or fails as labelled; oracle test against WOTSPlus.sol from the submodule; gas per verify printed | 5 | forge test green; verify gas at h = 10 in the README |
| A5 | export-leaves and the ticket file; sign from a ticket file | 1 | A ticket file signs and verifies; a leaf outside the file is refused |
| A6 | Gas table by height (10, 12) and by digit distribution, worst case included; the calldata floor beside it | 1 | Table in the README |
| A7 | Toolchain notes into the Day-0 tab: solc version, the exact strict-assembly command, confirmation that a verbatim\_1i\_1o call compiles in a standalone object (compile only, no devnet) | 0.5 | Vicky can copy the command |
| A8 | Tag v0.1.0; write the disclosure paragraph below; 30-minute handover call with Vicky: CLI, the Yul interface, the vectors, how to paste the function | 0.5 | Last commit before 20:59 |

If A5 does not land, Vicky writes export-leaves in the fork (about two hours added to V5), or hot tickets are cut.

Author may run the sidecar's own published scripts, unchanged, against the devnet before Thursday and write what they show into the Day-0 tab. No probe code is committed anywhere.

**Disclosure paragraph**, which Vicky pastes into the submission and sends to ETHGlobal in writing before Thursday 21:00: “This project extends hashsig (link, tag v0.1.0), a generic WOTS+ and Merkle tree signature library in Rust and Yul with test vectors, by \[Author's GitHub handle\], who is not a hackathon participant. The repository also holds a design document and three static UI prototypes, all committed before Nov 5, 21:00 IST. Everything else, the EIP-8141 account and factory, the frame transaction pipeline, the backend, the wired frontend, the demo scripts and the README, is built during the hackathon by \[Vicky\]. The library author makes no commits after the tag. AI tools used: \[list\].”

## 6. Vicky: before Thursday 21:00, no project code

- Install Bun, Foundry and the Rust toolchain (to build the CLI), and clone the sidecar repository at the pinned commit. Run the workshop steps against the devnet as published. Fund an EOA from the faucet and keep its key in a file.
- Read on the main tab: Account contract, Transaction format and signing flow, Pipeline, Shared interfaces, Day-0 checks. Read the library README and run its tests.
- Thursday 17:00 workshop: ask the eligibility question (section 1), which devnet to build on, whether per-entity budgets are live, and where to file divergences.
- Settle the defaults in section 8.
- Prepare the Hacker Dashboard entry: track Extend Open Source, repository = the fork, the disclosure paragraph in the description.

## 7. Vicky: Thursday 21:00 to Saturday 09:00 IST

Thirty-six hours, alone, with two sleep blocks. Each block has a done-means and a cut rule. Explorer links are pasted into the README the moment they exist, because the explorer's history is in memory and is cleared on restart.

| Block | Time | Work | Done means | Cut rule |
| --- | --- | --- | --- | --- |
| V0 | Thu 21:00 to 21:15 | Fork, dashboard entry, disclosure pasted, first commit | Fork exists with one commit by Vicky |  |
| V1 | Thu 21:15 to 23:00 | Day-0 probes, the short list: chain id, block time, client version; legacy nonce encoding; TXPARAM 0x08, 0x0B, 0x0E, 0x10 exist; sequence 0 accepted and the same key refused afterwards; EXPIRY\_VERIFIER code present; faucet rate; explorer link format; the rejection string for a 120k prefix; DELEGATECALL accepted in the prefix | Answers written into the Day-0 tab | Unanswered by 23:00: assume the spec's value and move on |
| V2 | Thu 23:00 to Fri 03:00 | Pipeline core: vendored codec.ts with the commit pinned, rpc, builder, two-pass signer (ECDSA plus the CLI shell-out), submit, status, receipt, explorer link, leaves journal | A frame transaction from the workshop's example account, built by our pipeline, is admitted; its link is in the README |  |
| Sleep | Fri 03:00 to 07:00 |  |  |  |
| V3 | Fri 07:00 to 13:00 | Account.yul: dispatch, packed SLOADs, nonce mode, signature shape, SIGDATACOPY, hashsig\_verify, hot-policy loop, APPROVE; proxy; factory. Deploy implementation and factory from the EOA. Create the account by deploy frame if the budget allows, else by an EOA call to the factory. First hash-signed keyed transfer, iterated on ethrex\_simulateFrameTransaction traces | **Qualification milestone, Fri 13:00:** an admitted hash-signed transaction; link, hash and receipt in the README | Not admitted by Fri 17:00: cut hot tickets and the frontend wiring; the demo is the CLI scenes plus the static prototypes |
| V4 | Fri 13:00 to 17:00 | Scenes 1 to 3: creation; eight keyed transfers at once beside the public mempool's one per sender; expiry on a fresh key with the burned leaf printed; the admission report for every transaction | Each script runs clean twice |  |
| V5 | Fri 17:00 to 21:00 | Hot tickets: setHotPolicy by SENDER frame; export-leaves to a ticket file; sign from it; the over-cap, wrong-target and tickets-exhausted refusals; the gas gauge and the four-column gas table from receipts | Scene 4 runs clean twice; gas table in the README | Behind schedule: keep the gas table, drop the refusal scenes |
| V6 | Fri 21:00 to Sat 01:00 | Backend API (the five endpoints) and web: the hot-and-cold screen wired to the backend and the live lane board, then agent, then session. The in-page simulation is replaced by polling the backend; the mempool switch submits to the public gateway | Hot-and-cold scene runs in the browser against the devnet | Agent and session stay prototypes with a simulated label |
| Freeze | Sat 01:00 | Feature freeze |  |  |
| V7 | Sat 01:00 to 03:00 | README: the claim, what existed before (v0.1.0), design, trade-offs, prior art, gas table, how to run, AI attribution, divergences filed | A judge can run it from the README |  |
| Sleep | Sat 03:00 to 05:30 |  |  |  |
| V8 | Sat 05:30 to 07:00 | Video from the 2:45 script on the main tab, hot-and-cold leading; submission form; one EF prize, the alt mempool | Submitted by 08:30 |  |
| V9 | Sat 07:00 to 09:00 | Buffer; rehearse section 10 |  |  |

Level B and Level C are not in the event plan. Only if V6 is done by Friday 21:00: lanes at scale (16 pending at once), then the recent-root hot authority if Day 0 showed the verify frame can read references.

## 8. Decisions to settle before Thursday (proposed defaults)

| Question | Proposed |
| --- | --- |
| Tree height | 10 |
| Hot band | 16 leaves per chain, hotStart = 1008 |
| Hybrid co-signer | off for the demo (hybridRequired = 0), described in the README as a flag; it costs Vicky an ECDSA path with no new story |
| Single-use sentinel | sequence 0 only |
| Chain list at keygen | the devnet's chain id only; 4 slot bits stay |
| CLI | shelled out from the pipeline; no WebAssembly; the Snap is cut. (Nov 6, 17:15 IST, Vicky: the MetaMask Flask Snap is back in, in `snap/`: the cold wallet inside the Snap, seed from snap_getEntropy salted with the genesis hash and an install nonce, signing through the pipeline core in TypeScript, so still no WebAssembly; the account is created by the user's MetaMask EOA calling the factory) |
| Video lead | hot-and-cold |
| Terminal and video | Vicky |
| Level B and C | out, per section 7 |

## 9. Fallback if the EF team says a continuity entry does not qualify

Vicky enters the Classic track from an empty repository. The library is used as a public dependency at tag v0.1.0 and named in the README as third-party open source by a non-participant. The prototypes and the brief are not used, because project-specific designs are barred on Classic; the UI is a plain page built during the event, which adds about two hours to V6. Everything else in section 7 stands. The risk is that a judge regards the library as project-specific; the README says who wrote it and when, and the judges decide.

## 10. Booth walkthrough, which Vicky gives without notes

1. One-time WOTS+ keys under a Merkle tree, XMSS-shaped: entry 2,594 bytes at height 10, signature 2,144 of them.
2. The nonce key is the leaf index at sequence 0. The chain consumes it once, so a reused leaf is refused by consensus. The signer state that makes XMSS dangerous off chain lives in the nonce here.
3. Why the alt mempool: keyed lanes let many hash-signed transactions from one account pend at once; the public mempool holds one per sender and would force fee bumps, which would mean signing a leaf twice.
4. What the verify frame reads and why each read is allowed in a static frame; declared limit at most 90k after grinding; the calldata floor of about 166k on top.
5. Expiry instead of replacement: a stuck transaction dies by the expiry frame, the leaf is burned, the retry takes the next leaf on a fresh key.
6. Hot tickets: leaves above hotStart exported to a phone as secrets plus path; the caps live in the account, not the ticket.
7. What is new against Quip: nonce-bound leaves, no stored used-leaf state, keyed lanes, the hot band.
8. What existed before the event and what was built during it, with the tag and the commit history.

## 11. Working rules during the event

- Author: no commits, pull requests, reviews, pairing or screen sharing on project code, upstream or fork, from Thursday 20:59 until prizes are paid. Questions about the library are answered in public only, as GitHub issues on the upstream repository or in the event Discord.
- Vicky: every commit authored by Vicky in the fork; no history rewrite; a bug found in the library is fixed in the fork's copy; the README's AI attribution is kept current; each milestone's explorer link is saved the moment it exists.
- Both: after submission, nothing changes until prizes are distributed.
