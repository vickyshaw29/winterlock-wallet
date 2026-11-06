# Nonce-Bound PQ Wallet Spec

Nov 1, 2026 · @Yash Sharma

Build spec for the ETHGlobal Mumbai 2026 submission to the Ethereum Foundation "Best use of the Frame Transaction Alternative Mempool" track. Written for Vicky and for any reviewer, human or AI. Every protocol constant here was read from the EIP text or the alt mempool docs on 2026-11-01; items marked VERIFY are unconfirmed on the hackathon devnets.

**Revised 2026-11-03** after a four-reviewer audit (two Claude Fable agents, two OpenAI coding assistant gpt-6-astra agents) whose claims were re-verified against the EIP texts, the ERC-8421 draft, the sidecar and ethrex sources, the ETHGlobal rules and the prize page. Hash-signed transactions are now keyed-only, the budget story is corrected, and the section "Review findings and devnet facts" records what changed and why.

Review findings, devnet facts and judge Q&A: Review findings (Nov 3)

## Goal and claim

We build a post-quantum smart account for EIP-8141 frame transactions whose one-time signing keys are named by the account's own nonce keys. The account never writes storage to track used keys: the protocol's consumption of the nonce key at payment approval is the key-consumption record. The verify frame is designed to fit a 100,000-gas declared budget on every message, so the account runs unstaked; the alternative mempool is what makes it usable, because only there can several keyed transactions from one sender be pending at once.

The signature scheme is hash-based (WOTS+ one-time signatures under a Merkle tree, the same family the Ethereum Foundation chose for its post-quantum consensus work). Hash-based schemes are the most conservative post-quantum choice, but every deployment so far needs a trusted counter that says which one-time key was already used. We remove that counter: leaf i of the key tree can only authorize the transaction with nonce i, and the protocol guarantees nonce i is consumed once.

EIP-8141 forces this pattern rather than merely allowing it. The verify frame runs as a static call, so an account cannot record a used key during validation at all, and a write in a later SENDER frame comes after approval, when two pending transactions in two lanes could already both have passed against the same leaf. The one state change the protocol performs atomically with payment approval is the nonce consumption, so we make that the key-consumption event. An ERC-4337 account could index leaves by its EntryPoint nonce too, and Winterlock proposes one WOTS key per Safe nonce; what frame transactions add is that nothing else is possible, and that the consumption is protocol-atomic.

**Claim, stated exactly:** to our knowledge this is the first hash-based-signature account implemented on frame transactions whose one-time-key index is the protocol's own nonce key, consumed atomically by payment approval, with no account storage write per signature. We do not claim the idea of nonce-indexed one-time keys: QRL's wallets used the transaction nonce to pick the next XMSS key (with on-chain usage tracking), EIP-8310 defines leaf = f(slot) for validator keys, and Winterlock (Safe forum, 2026-10-09) proposes an EIP-1271 WOTS owner with one key per Safe nonce. We do not claim the first hash-based account on Ethereum (Quip, ERC-4337, mainnet 2026-09-17) nor the first on frame transactions (NiceTry's FORS+C FrameAccount with an enforced rotation frame). See Prior art.

**Target track and area.** Ethereum Foundation, "Best use of the Frame Transaction Alternative Mempool", $5,000, area one: "applications that need frame transactions with verification budget higher than 100k (e.g. PQ-secure smart wallets)". Qualification: an admitted transaction on the devnet explorer and the ability to explain design, code and trade-offs.

**What we demo.** One account, one key tree, on a live devnet, every scene with its admission report on screen: several hash-signed transfers pending at once on separate nonce keys while the public mempool holds one per sender; a stuck transaction expiring and the retry landing on a fresh key; a hot ticket from an exported ticket file, then the tickets running out and a hot transaction refused; the declared-versus-used gas gauge with signer-side grinding; and the measured gas table including the calldata floor. If Day 0 shows the devnet runs per-entity budgets, the first scene also shows the same payload refused by the canonical rules and admitted by the alt mempool.

**Out of scope.** Lattice schemes (ML-DSA, Falcon), EIP-8288 mempool-side aggregation, mainnet deployment, key backup and recovery UX beyond a seed file.

## Use cases

Three flows where lanes and hot tickets are the best tool, in the order the demo shows them: hot and cold wallet, an AI agent reacting to the market, session keys. Each is one screen in the frontend, with the same lane board underneath. Prototype screens were generated on Nov 4 from the notes here, by Author's decision. ETHGlobal's Classic-track rule bars pre-existing project-specific designs and assets, so they are disclosed in writing together with this spec, and the repo frontend is written after kick-off.

### Hot and cold wallet

**Story.** The seed lives on a laptop that is usually off. Once a week the laptop cuts ten tickets to the phone, each capped at a small amount, target fixed to one address. During the week the phone pays without the laptop, each payment on its own lane. A stuck payment expires and burns its ticket; the next payment uses a fresh ticket on a fresh lane.

**Why this design.** The hot side is post-quantum, and its ceiling is enforced by the account, not by an app setting. Tickets are single-use because leaf i signs only on lane i and the account requires sequence 0. A lost phone costs at most the unused tickets times the value cap, to one address.

**Why the alt mempool.** The phone and the laptop never coordinate, and both can have transactions pending at once because each is on its own lane. The public mempool holds one pending frame transaction per sender, so the two devices would fight for one slot. ERC-4337 allows four pending user operations per unstaked sender (ERC-7562 `SAME_SENDER_MEMPOOL_COUNT`); the devnet's alt mempool holds one pending transaction per (sender, nonce key) and puts no per-sender cap on keyed lanes the account pays for itself (Nov 6, Vicky: the devnet sidecar's real rule, from its code; 4 per key and 64 per unstaked sender are the ERC-8421 draft's numbers, not the devnet's).

**Screen.** Two panes, cold device and phone, with the lane board underneath.

- Cold pane: tree summary (height, leaves used, hot band, root), hot policy (value cap, fee cap, allowed target) with a Set policy button, Cut tickets, Rotate root with the warning "rotation invalidates every pending lane", and an offline toggle that greys the pane.
- Phone pane: ticket counter "7 of 10", a pay form with the cap enforced inline and the target read-only, a "set aside for pending" line, and a Simulate stuck payment button whose row goes expired, ticket burned, resent on a fresh lane, "not re-signed".
- Scene: the phone pays three times while the laptop is offline, rows land out of order, one expires. Switch the mempool to public: the second and third payments are refused.

**Limits.** One allowed target. Large transfers go through the cold device. Refills need the cold device.

### AI agent reacting to the market

**Story.** A trading agent holds twenty tickets with a value cap and one allowed contract, the router. When the price moves it fires four tranches in the same second, each on its own lane. Its authority is the recent-root hot authority of the Cryptography section (Level B): it expires by itself about 13 h after the cold device last published it, unless the cold device renews it.

**Why this design.** An agent needs bounded delegation, and a stack of one-time tickets is the natural shape of an allowance. A compromised server can spend at most the unused tickets times the cap, to the router, until the authority expires. No long-lived key exists on the server.

**Why the alt mempool.** Four tranches in one second means four pending at once. In the public mempool one is pending and three are refused until it is included. The agent and the human both have transactions in flight with no coordination.

**Screen.** A market panel (ETH price sparkline, change over 30 s), the allowance card, an event log and the lane board.

- Allowance card: tickets left, value cap 0.1 ETH, target router, "expires in" as a live countdown, Renew from cold device and Stop renewing buttons, set aside for pending. At zero the Fire button disables and the log says "authority expired".
- Agent rule as plain text: "If price falls more than 2 % in 30 s, buy in 4 tranches of 0.1 ETH." It fires on the mock price or on a Fire button; the log shows the trigger, the four lanes, and each inclusion.
- Compromise scene: a Server compromised button sends 1 ETH to a new address; the lane board shows two refused rows, "exceeds value cap" and "target not allowed", and the card shows "max loss 1.4 ETH to router until expiry".

**Limits.** One allowed contract. Renewal needs the cold device. The recent-root countdown is Level B and depends on the Day-0 probe that the verify frame can read the transaction's recent-root references.

### Session keys

**Story.** A dapp asks the wallet for a session: 20 actions, value 0, one contract, valid for two hours. The wallet grants 20 tickets. The dapp fires actions as fast as the user acts, each on its own lane, with no waiting for the previous one to be mined. The session ends when the tickets run out, when the user ends it, or when the authority expires.

**Difference from ERC-4337 session keys.** An ordinary session key is one key with a policy around it; if it leaks, the policy is all that stands until the session ends. Ours is 20 one-time keys: the chain burns each on use through its lane, a leak costs at most the unused tickets inside the caps, and with the recent-root version the session cannot outlive the window.

**Why the alt mempool.** Actions arrive faster than blocks. One pending per sender stalls the game at every move; the devnet's alt mempool holds one pending per nonce key, with no per-sender cap for keyed lanes the account pays for itself (Nov 6, Vicky: the devnet sidecar's real rule, from its code; 4 per key and 64 per unstaked sender are the ERC-8421 draft's numbers, not the devnet's).

**Screen.** A dapp area with the wallet's session sheet beside it, the lane board underneath.

- Dapp area: a 6 by 6 grid where each click is one transaction, labelled so, with a move counter.
- Session request sheet: 20 actions, 0 ETH, the game contract, expiry 2 h; Grant 20 tickets or Decline. After grant it becomes the session card: tickets left counting down, the caps, the countdown, End session which burns the unused tickets, and the one-line comparison above.
- Scene: eight moves in two seconds land out of order across blocks. Public mode: one pending, seven refused, the game shows the moves as "waiting".

**Limits.** Value 0 and one contract, which fits games and order books and not a general wallet. The ticket count bounds the session.

### Screens: shared rules

One product, three screens. Opus agents generated the prototypes from this section on Nov 4, one agent per screen in parallel, with a Fable review pass; the three prototypes are linked at the end of this section. The repo frontend is written after kick-off with normal commit history, and the prototypes are disclosed as pre-existing work.

- Vocabulary from this spec only: leaf, lane, hot band, ticket, hot policy, expiry, burned, rotation, recent root, admitted, included, refused. No invented feature.
- Mempool behaviour the screens must get right: public mode refuses a second submission while one is pending; alt mode runs lanes in parallel and out of order; no fee bump anywhere; expiry burns the leaf and the retry is a fresh lane; rotation invalidates pending lanes; a "set aside for pending" line shows the worst-case cost reserved per pending transaction.
- Numbers from this spec: entry about 2,594 bytes, calldata floor about 166k, verify about 60k actual and 90k declared, 190k to 200k total; 1 pending per lane (nonce key) and no per-sender cap for self-paying keyed lanes on the devnet sidecar, relayed at most 4 per 10 s pass by default (the ERC-8421 draft's 4 per key and 64 per unstaked sender are labelled as the draft's) (Nov 6, Vicky: the devnet sidecar's real rule, from its code; 4 per key and 64 per unstaked sender are the ERC-8421 draft's numbers, not the devnet's); devnet recent-root window about 13 h. Anything else is labelled "example".
- Design (relaxed Nov 6 by Vicky, for a distinctive UI that does not look like common AI-built UIs; the redesign follows Anthropic's frontend-design process): palette, typefaces, layout and motion are free, chosen from one of three design directions she picks. What stays: plain HTML, CSS and JavaScript with no framework and no build step; works at 375 px and on a laptop; accessible (contrast, visible focus, reduced motion); light and dark; open-licence fonts, self-hosted (no third-party requests, for CROPS); a lane board on every screen with columns lane, leaf, action, amount, gas and a status timeline; every control of each screen; no emoji or marketing copy. (Before Nov 6: a neutral paper-and-ink palette with one accent; Inter and JetBrains Mono; hairlines, 4 px radii, 8 px grid; no gradients, illustrations or hero sections.)
- Every screen has a Mempool switch, alt and public, and a deterministic in-page simulation (pending about 1 s, included after 3 to 8 s, out of order), with the footer "Prototype. Mempool and chain simulated in page."
- Each scene runs in under 30 seconds with at most three clicks.

Prototypes, generated Nov 4, reviewed, shared palette and type (IBM Plex Sans and Mono, one stamp-ink accent), each a single HTML file with the mempool simulated in page:

- [Hot and cold](https://claude.ai/artifact/BYbFgLBff8RycMDmzs6kng): cold pane and phone pane, Play scene runs the three payments, the stuck payment and the public-mempool refusals in about 22 s.
- [Agent on a leash](https://claude.ai/artifact/9S5rUjuRYxaJdFvBqSxfNM): the rule fires four tranches on four lanes about 7 s after load; Server compromised, Stop renewing and Jump to last 10 s run the other scenes.
- [Session tickets](https://claude.ai/artifact/PyjE81TvSQbjmShqtAsaaq): Grant 20 tickets, then Play 8 moves; switch the mempool to public and play again for the stall.

The links are private until shared. The source files live with Author and go into the project repo at kick-off, disclosed as pre-existing work.

## Protocol facts the design depends on

Everything below was read from the EIP texts and the alt mempool docs on 2026-11-01. The devnet client is a fork of ethrex that follows an earlier draft of ERC-8421, so rule ids and limits can differ; the Day-0 section lists what to confirm.

**EIP-8141 frame transactions (Draft).** Transaction type 0x06. Payload `[chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes]`. A frame is `[mode, flags, target, limits, value, data]` with `limits = [execution, state]`. A signature entry is `[scheme, signer, msg, signature]`.

| Item | Value |
| --- | --- |
| Frame modes | 0 DEFAULT (caller is the entry point sentinel 0xaa), 1 VERIFY (static call), 2 SENDER (caller is tx.sender) |
| Approval scopes in flags bits 0-1 | 0x1 PAYMENT, 0x2 EXECUTION, 0x3 EXECUTION\_AND\_PAYMENT |
| Frame subclasses we use | expiry\_verify = VERIFY/0x0 to EXPIRY\_VERIFIER; deploy = DEFAULT/0x0; self\_verify = VERIFY/0x3 to self; user\_op = SENDER |
| APPROVE opcode | 0xaa, stack (offset, length, scope); ends the frame; payment scope sets payer and increments the nonce |
| EXPIRY\_VERIFIER | 0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf, frame data = 8-byte big-endian unix timestamp, reverts if block.timestamp is later |
| Signature schemes | 0x0 ARBITRARY (100 gas, signer must be empty, bytes read with SIGDATACOPY); 0x1 SECP256K1 (2,800 gas, v‖r‖s, low-s); 0x2 P256 (6,700 gas) |
| msg field | empty = signs the canonical sig hash; 32 bytes = explicit digest |
| Sig hash | keccak256(0x06 ‖ rlp(tx)) where each empty-msg signature's bytes are replaced by their length |
| TXPARAM 0xb0 selectors | 0x01 NONCE, 0x02 SENDER, 0x08 SIG\_HASH, 0x09 FRAME\_COUNT, 0x0A CURRENT\_FRAME\_INDEX, 0x0B SIGNATURE\_COUNT |
| FRAMEPARAM 0xb3 selectors | 0x02 MODE, 0x04 DATA\_LENGTH, 0x08 VALUE (others exist; see EIP) |
| SIGPARAM 0xb4 / SIGDATACOPY 0xb5 | resolved signer, scheme, msg, and (0x03) data length of a signature entry; SIGDATACOPY copies ARBITRARY bytes only. VERIFY exact selector numbers against the EIP before coding the Yul |
| Intrinsic gas | 12,000 + 475 per frame + calldata (16 gas per nonzero byte) + signature scheme costs |
| Max frames | 64 |

Public-mempool rules that matter: MAX\_VERIFY\_GAS is 100,000 over the validation prefix; only the prefix shapes `[self_verify]` and `[deploy, self_verify]` are accepted, with a leading `expiry_verify` skipped when matching; in VERIFY frames SLOAD is allowed only on the sender's own storage, CALL only to existing contracts, and TIMESTAMP, NUMBER, BALANCE, GAS and SSTORE are banned. Replacement is keyed on (sender, nonce) and needs a 10% fee bump.

**EIP-8250 keyed nonces (Draft).** Replaces `nonce` with `nonce_keys` (list of up to 16 strictly increasing uint256) and `nonce_seq` (uint64). Both are signed.

| Item | Value |
| --- | --- |
| Empty key list | legacy account nonce; `nonce_seq` must equal it |
| Sequential keyed | every key's current sequence must equal `nonce_seq`; each is set to `nonce_seq + 1` on payment approval |
| Single-use keyed | `nonce_seq == 2^64 - 1`; every key must be unused (0); each is set to max and is exhausted forever |
| NONCE\_MANAGER | 0x8250968C12e01A19d6F667b9B2F3b3A4d0e51cB7, code is `revert(0,0)`, only the protocol writes it, slot = keccak256(pad32(sender) ‖ key) |
| TXPARAM 0x01 | returns `nonce_seq` (equals the legacy nonce only when the key list is empty) |
| TXPARAM 0x0D | sender's pre-state legacy nonce |
| TXPARAM 0x0E | number of nonce keys |
| TXPARAM 0x0F | keccak256(len ‖ keys) |
| TXPARAM 0x10 | nonce\_keys\[0\], or 0 when the list is empty |
| First use of a key | 97,920 state gas (charged from the frame's state limit, not the verify budget) plus 12,100 execution gas per key |
| Public mempool | still one pending transaction per sender; multiple pending per key is left to mempool policy |

**ERC-8421 alternative mempool (Draft, docs at docs.altmempool.wtf).**

| Item | Canonical mempool | Alt mempool |
| --- | --- | --- |
| Validation gas budget | 100,000 total | 250,000 per unstaked entity, 2,500,000 per staked entity (BUDGET-010) |
| State gas in prefix | 500,000 cap | no cap, payer solvency reserves it |
| Storage readable in VERIFY | sender's own | sender's own plus sender-associated slots; staked entities any |
| Pending per sender | 1 | the draft says 4 per (sender, key) and 64 per unstaked sender; the devnet sidecar's code holds 1 per (sender, nonce key) with no per-sender cap for self-paying keyed lanes, relayed at most 4 per 10 s pass by default (Nov 6, from the vendored sidecar: MempoolService/service.ts:374-407, reputation.ts:87-95, config.ts:628,635) |
| Stake | none | lock-up in a staking registry, never slashed; not needed for this design |

**Devnet reality, verified 2026-11-03 from the published sidecar and ethrex sources.** The table above quotes the current drafts; the devnet pins older revisions. The sidecar enforces a flat 100,000 verification budget over the whole prefix (expiry frame included) plus signature costs, with no staked branch, and a 500,000 state cap, the same as the public mempool. It rejects nonce\_seq = 2^64 - 1 (MAX\_NONCE\_SEQ = 2^64 - 2); the legacy nonce is the key list \[0\] and key 0 may only appear alone; a key's first use costs 20,000 execution gas; NONCE\_MANAGER is 0x...8250; the codec's fee list has three fields plus a trailing recentRootReferences list; computeSigHash replaces empty-msg signature bytes with empty bytes; the expiry verifier constant is a placeholder. Pending: one per (sender, key), four linear per sender, keyed uncapped. The full comparison, with sources, is in the Review findings tab. Every row is a Day-0 probe; the hackathon devnets may run newer builds.

Sidecar RPC we use: `eth_sendFrameTransaction`, `eth_estimateFrameTransactionGas`, `eth_getFrameTransactionReceipt`, `skandha_frameTransactionStatus` (states New, Pending, Submitted, OnChain, Finalized, Cancelled, Reverted), `skandha_explorer_faucet` (1 ETH per address per hour). The node exposes `ethrex_simulateFrameTransaction` with `{"trace": true}` for admission reports. The frame tx codec (`computeSigHash`, `encodeRawFrameTx`) lives in the sidecar repo at `packages/executor/src/services/FrameTxService/codec.ts`.

Hackathon devnets: `devnet1/2/3.altmempool.wtf` with `gateway1/2/3.altmempool.wtf`, explorer at `altmempoolexplorer.forshtat.com per the prize page (explorer.altmempool.wtf is also listed); its history is in memory and cleared on restart`. The earlier devnet used chain id 1337 and 6-second blocks; VERIFY for the hackathon instances.

## Prior art and what is new

Hash-based accounts exist on Ethereum today. Our novelty is narrow: the key index comes from the protocol nonce, so validation writes nothing. Cite all of the below in the README; judges will know Quip.

| Project | What it is | How it tracks used keys | Transport | Measured gas | Notes |
| --- | --- | --- | --- | --- | --- |
| [Quip Network hashsigs-solidity](https://github.com/quipnetwork/hashsigs-solidity) | WOTS+ verifier library in keccak: n = 32, w = 16, 67 chains, 2,144-byte signature, 64-byte on-chain key (publicSeed, publicKeyHash) | Stateless library; wrapper example stores a cursor or bitmap per key | Direct calls, ERC-1271 | Stateful wrapper 190,792 (256-bit), 117,759 (128-bit) | AGPL-3.0; Oak Security audit dated 2026-09-24 |
| [Quip ethereum-sdk](https://github.com/QuipNetwork/ethereum-sdk) | Production ShrincsWallet: stateful tree (4,096 leaves deployed) plus stateless FORS-C fallback; hybrid owner ECDSA and hash-based signature on the userOp path | Used-leaf bitmap and an action nonce written in validation (SSTORE per tx); explicit key rotation | ERC-4337 v0.7 EntryPoint only | Wrapper overhead \~7.7k per validation | Deployed Ethereum mainnet 2026-09-17; no EIP-8141 or 7702 |
| [Skale xmss-solidity](https://github.com/skalenetwork/xmss-solidity) | RFC 8391 XMSS verifier, SHA-256, formally checked | README tells the caller to keep a leafUsed mapping | Library | \~745k | MIT |
| [OpenZeppelin community PR #301](https://github.com/OpenZeppelin/openzeppelin-community-contracts/pull/301) | Draft keccak XMSS ERC-7913 verifier, n = 16 | Not addressed | Library | None published | Author notes it is AI-generated and unreviewed |
| [poqeth (ePrint 2025/091)](https://eprint.iacr.org/2025/091.pdf) | Benchmarks of PQ verification on Ethereum | n/a | n/a | Hash-based \~295k | Academic |
| [pq-dksap](https://github.com/ivanmmurciaua/pq-dksap) | ML-KEM stealth receive, ML-DSA spend over EIP-8141 frame txs | n/a (lattice, reusable key) | EIP-8141 testnet | Not published | Proof of concept |
| [QuantumCanary](https://github.com/identity-md-launches/launch-1213-src-quantumcanary-sol) and BitMEX Research canary | Nothing-up-my-sleeve secp256k1 address as a quantum alarm | n/a | n/a | n/a | Concept exists; our wiring to account lockdown is new |
| Winterlock (Safe forum proposal, 2026-10-09) | Proposed EIP-1271 Safe owner verifying WOTS signatures against a Merkle tree; SPHINCS+ for recovery; optional STARK-batched verification | "Each key is valid for one Safe nonce only"; separate key slots planned for flows that sign more than once per nonce | Safe owner contract (ERC-1271), not frame transactions | none; proposal only, no code yet | Closest prior statement of the nonce-indexed idea; cite it. Safe's nonce is contract state, ours is consumed by the protocol |
| NiceTry (Solvency-Labs / RivaLabs, ethresear.ch 24273 and 24526, 2026-03 to 2026-05) | ERC-4337 account rotating the signer every operation; now FORS+C few-time signatures as primary, WOTS+C kept as comparison; a FrameAccount path for EIP-8141 that requires the next frame to be the rotation frame | Rotation write in a SENDER frame after approval; FORS+C chosen because it degrades gracefully under bounded reuse | 4337 UserOp; frame-transaction path pending its opcode bridge | WOTS+C about 73k, FORS+C about 35k verify on Sepolia (their figures) | The only other hash-based design on frame transactions we found. Their rotation write tolerates the two-lanes race by using a few-time scheme; we remove the race by consuming the nonce key |
| QRL (Quantum Resistant Ledger) | XMSS-based chain since 2018 | Wallets use the transaction nonce to pick the next one-time key; the chain also tracks used OTS indices on chain | its own protocol | n/a | Historical prior art for nonce-guided key selection; cite it |
| EIP-8310 (2026-06-19) | Post-quantum keystore for stateful leanXMSS validator keys | Synchronized mode leaf = f(slot); signer-side high-water mark; reserved disjoint leaf ranges; durable state authority | consensus layer | n/a | The consensus-layer analogue of our idea; its warning that recovering a seed is not the same as safely resuming signing applies to us |

**What is new here, and only this.**

1. Leaf index equals the account nonce (legacy mode) or the nonce key itself (single-use keyed mode). No bitmap, no cursor, no per-signature SSTORE. Quip's action nonce advances per signature too, but they still keep a bitmap and run in ERC-4337 validation where writes are allowed. In an EIP-8141 verify frame their pattern cannot run; the ERC-8421 draft's pre\_verify frame would allow an attributed write before approval, so avoiding account writes is a simplification we chose, not the only possible architecture.
2. The signature travels in the protocol's own signature slot (scheme ARBITRARY) and is read by SIGDATACOPY, not as calldata to an EntryPoint.
3. Parallel one-time keys through EIP-8250 keyed nonces, with each key consumed exactly once by the protocol.
4. Replacement is forbidden by design and replaced with expiry frames, so a leaf is never signed twice.
5. Fits a 100k declared verification budget on every message once the signer grinds the message digits; the published sidecar enforces the same flat 100k as the public mempool, so the alt mempool is needed for parallel keyed lanes and hot tickets, not for raw gas. Quip's 4337 wallet never meets either cap because a bundler signs the outer transaction.
6. Delegation with a lifetime the chain enforces: the hot band's permission is an EIP-8272 recent root the account publishes, so hot tickets expire with the 8,191-slot window, the mempool sees the expiry, and revocation needs no rotation (Level B). A certified hypertree binds subtree certification to a single-use nonce key, so the stored root never changes and growth never invalidates a pending lane (Level C).

**Deliberate reuse.** We adopt Quip's WOTS+ wire format bit for bit (chain function, PRF, checksum, key hash) so their Solidity, Rust and TypeScript libraries can serve as test oracles for the one-time-signature layer. We write our own verifier and tree. Their code is AGPL-3.0; we do not link it into our build, we only run it in tests.

## Cryptography

One-time layer: WOTS+ over keccak256 in Quip's exact wire format. Many-time layer: our own Merkle tree over per-leaf WOTS+ keys. The message is the protocol's canonical sig hash, nothing else.

**WOTS+ parameters (normative reference: `contracts/WOTSPlus.sol` in hashsigs-solidity).**

| Parameter | Value |
| --- | --- |
| Hash H | keccak256 |
| n (hash and message length) | 32 bytes |
| w (Winternitz parameter) | 16 |
| Message chains | 64 (one per base-16 digit of the 32-byte message) |
| Checksum chains | 3 |
| Total chains | 67 |
| Signature | 67 × 32 = 2,144 bytes |
| Randomization elements | r\[0..14\] derived from the public seed by Quip's PRF: keccak256(0x03 ‖ seed ‖ uint16(i)) |
| Chain step at position j | c = keccak256(c XOR r\[j\]) |
| Checksum | sum over the 64 digits of (15 minus digit), shifted left 4 bits, taken as 3 base-16 digits |
| Public key hash | keccak256 of the 67 chain ends concatenated (2,144 bytes) |

Copy these from the Solidity file, not from this table, when writing the Rust and the Yul. The table is a summary; the file is the contract.

**Key derivation (ours).** All secrets come from one 32-byte master seed `S`.

| Quantity | Definition |
| --- | --- |
| Generation | g = the account epoch the tree is built for (0 at creation, +1 per rotation). Every secret below includes g, so a rotated tree never reuses a one-time key. One master seed serves one account only; a new deployment, including after a devnet reset, gets a new seed |
| Tree seed | T = keccak256(0x02 ‖ S ‖ uint32(g)) |
| Full leaf index | i = (slot << h) \| leaf, with slot in 0..15 the chain slot and leaf the per-chain index from the nonce |
| Per-leaf public seed | P\_i = keccak256(T ‖ uint32(i)), i the full leaf index |
| Per-leaf, per-chain secret | sk\_{i,j} = keccak256(0x01 ‖ S ‖ uint32(g) ‖ uint32(i) ‖ uint8(j)) for j in 0..66 |
| Leaf i public key hash | pk\_i = WOTS+ public key hash computed from sk\_{i,\*} with seed P\_i |
| Leaf node | L\_i = keccak256(P\_i ‖ uint256(chainId) ‖ pk\_i), chainId the chain assigned to the leaf's slot |
| Internal node | keccak256(left ‖ right) |
| Root | the single node at height h + 4 |
| Empty slot | EMPTY\_SUBTREE = keccak256("nonce-bound-pq-wallet/empty-slot") stands at height h for every slot with no chain listed at keygen |

A per-leaf public seed costs the verifier one extra keccak and avoids a multi-target weakness that a single seed across 2^h leaves would introduce. It stays compatible with Quip's verify function, which takes the seed as an input.

**Tree parameters.** Height h is the per-chain subtree height and is stored in the account; the tree adds 4 slot bits above it, so the root stands at height h + 4 and one tree holds 16 chain slots of 2^h leaves each. Demo trees use h = 10 (1,024 leaves per chain) so key generation in Rust takes about a second per chain; the README states h = 20 as the production shape. Authentication path: h + 4 sibling hashes ordered from leaf level upward. Bit k of the full leaf index chooses the side at level k (0 means our node is the left child).

**Cross-chain key separation.** The same account at the same address on two chains has a separate nonce on each, so without separation nonce 0 on Ethereum and nonce 0 on Polygon would sign two different sig hashes with the same one-time key. Two WOTS+ signatures from one leaf reveal every chain at the lower of the two positions, and a third message whose digits all sit above them is forgeable: for the easiest 10 to 20 percent of leaf pairs after roughly 2^35 to 2^37 hashes, median pair about 2^60 (reviewer computation over message and checksum digits, Nov 3). Any reuse is unacceptable; the forged transaction would also be a valid fee-bump replacement of ours. The tree therefore has 16 chain slots above the per-chain subtrees. The slot byte in the signature entry only locates the subtree; the chain id hashed into every leaf is the binding. The verifier takes it from CHAINID, so a leaf built for one chain never verifies on another, whatever the slot byte says. Slots are assigned at keygen from an ordered chain list; unlisted slots hold EMPTY\_SUBTREE, and adding a chain later is a rotation. The root is the same on every chain, so the factory call data and the CREATE2 address are the same on every chain. The transaction itself was never replayable across chains, since the sig hash commits to the chain id; the key leak is what the slots prevent.

**Signature entry layout (scheme ARBITRARY, signer empty, msg empty).**

| Offset | Length | Content |
| --- | --- | --- |
| 0 | 1 | Version byte, 0x01 |
| 1 | 1 | Chain slot, 0 to 15: which 2^h-leaf subtree this chain uses |
| 2 | 2,144 | WOTS+ signature, chain 0 first |
| 2,146 | 32 × (h + 4) | Authentication path, leaf level first |

Total length is 2,274 + 32h, so 2,594 bytes at h = 10 and 2,914 at h = 20. The leaf index is not in the signature; the verifier derives it from the nonce. The slot byte only says where the chain's subtree sits; the chain id hashed into the leaf is what binds the key to this chain. The public key is not in the signature; the verifier recomputes it.

**Message.** The 32-byte value TXPARAM(0x08) returns, the canonical sig hash. It already commits chain id, sender, nonce fields, every frame, fees and the lengths of the signature entries, so no extra domain separation is needed for transactions. Separating the keys themselves between chains is the tree's job (Cross-chain key separation), not the message's. ERC-1271 message signing is out of scope precisely because it would need a separate leaf domain.

**Hybrid co-signature.** Signature entry 0 is scheme SECP256K1 with empty msg (65 bytes, v ‖ r ‖ s, low-s). The protocol verifies it before any frame runs; the account checks that SIGPARAM(0x02) msg is empty (canonical hash) and that the resolved signer equals the stored owner. Without the msg check an owner signature over any unrelated explicit digest would pass. Cost 2,800 gas. Entry 1 is the hash-based entry above.

**Security level.** n = 32 gives 256-bit classical and about 128-bit quantum preimage security (Grover), which is the level the EF's own hash-based consensus work targets. Reducing n to 16 halves the chains and the gas but drops quantum security to about 64 bits; we do not do this, and the README says why.

**Expected cost (estimates until measured on Day 0).** Verify-frame execution: about 506 chain steps on an average message, 990 worst, 45 best (exact enumeration of the digit distribution), at roughly 75 to 80 gas per step in Yul, plus about 20k fixed (cold storage reads, SIGDATACOPY, seed and masks, key hash, 14 path hashes): about 58k to 60k average, 94k to 99k worst at h = 10. The signer grinds free bits of the transaction until the chain work fits the limit it declares, so the declared verify limit stays at or below 90k on every message. The user's bill is not the verifier: elided signature bytes are priced as non-zero at 16 gas each (41.5k for a 2,594-byte entry) and the EIP-7976 floor is 64 gas per byte, about 166k for the entry alone, so a transfer costs roughly 190k to 200k total regardless of hashing. Quip's 190,792 is wrapper call gas for a different composite profile with two storage writes; compare verify execution to verify execution and total to total, and label every column. The README gas table has four columns per profile: declared verify limit, measured verify execution, intrinsic including signature bytes and the floor, and receipt gas\_used.

### Recent roots and the certified hypertree

Two additions use EIP-8272 recent roots, which the hackathon devnets run, to give hot authority a lifetime that both the chain and the mempool see, and to let the tree grow by certified subtrees instead of a root rotation that invalidates every pending lane. The first is Level B, the second Level C. Neither touches the chain-side hashing, so the oracle test still anchors everything.

**Recent-root hot authority (Level B).** A hot leaf is accepted only while a value the cold device published is inside the recent-root window. The verify frame cannot read time, block numbers or slots, so a recent root is the only clock it has.

- **The value.** A = keccak256(0x04 ‖ address(this) ‖ config ‖ hotValueCap ‖ hotFeeCap ‖ allowedTarget), over the storage words the verify frame already loads for a hot leaf. Nothing new is stored, and any policy change changes A.
- **Publishing.** `renewHot()`, an admin call from a cold leaf in a SENDER frame, calls RECENT\_ROOT\_ADDRESS with 64 bytes salt ‖ A, salt HOT\_SALT = keccak256("nonce-bound-pq-wallet/hot"). The contract files it under source\_id = keccak256(address(this) ‖ HOT\_SALT) at the current consensus slot S; it is referenceable from S + 1 for 8,191 slots, about 13.6 h at the devnet's 6 s slots and about 27 h at 12 s. `setHotPolicy` publishes after writing, so a new policy is live in the next slot. Each write that lands on a ring index the account has not used before costs one new storage slot, 97,920 state gas under EIP-8037, within the alt mempool's 500k state cap.
- **The hot transaction.** It carries one recent-root reference, (source\_id, S, A). On the devnet the references are a trailing field of the envelope, up to 16, which the sidecar checks for the window before simulation and the client checks for commitment during simulation; the current EIP-8272 text instead puts them in a canonical VERIFY frame of 72-byte tuples ahead of the account's frames. The signature hash covers them either way. The devnet's RECENT\_ROOT\_ADDRESS is shown as 0x…8272 in the sidecar readme, against 0x8272D9679689Ea2f307140CdF9002D27dC00Ffff in the EIP text: read it from the devnet on Day 0.
- **Verify-frame check**, two steps added for a hot leaf: find the reference (FRAMEDATACOPY of the canonical frame's tuple after a FRAMEPARAM check of target, mode, status and data length, or a TXPARAM read if the devnet exposes envelope references that way), then require source\_id == keccak256(address(this) ‖ HOT\_SALT) and root == A recomputed from storage. The account does not check the slot; the protocol already proved it is inside the window. Cost under 1k gas. Cold leaves skip both steps.
- **Lifetime, visible to the mempool.** The node records the reference on admission, does not relay a transaction whose reference is about to expire, and evicts a pending one when the reference leaves the window; the explorer files such failures under its recent-root rule. The signer journals an evicted ticket as burned, as for any expiry. Renewal is one `renewHot()` before the window closes: a fresh entry, no root change, no pending lane touched.
- **Revocation.** Stop renewing and the band dies with the window. For an immediate stop, `setHotPolicy` with a new cap: A is recomputed from current storage, so references to the old A fail at once, while pending cold lanes never read A and are untouched. Rotation is no longer the way to revoke hot tickets, so the mass invalidation the review flagged leaves this flow.
- **Budget.** The reference costs the protocol check plus 72 bytes under the calldata floor, about 4.6k; a canonical frame's limits.execution would count toward MAX\_VERIFY\_GAS. A hot transaction declares expiry 5k, the reference as measured, and verify at most 85k, re-budgeted on Day 0; hot transactions ride the alt mempool regardless.
- **Dependency.** This needs the verify frame to read the references. If Day 0 finds no way to read them on the devnet, Level B is held: the protocol would still expire the transaction with the window, but the account could not tell which root was referenced, so a hot device could satisfy the check with any live root. The agent screen's countdown then stays labelled as proposed.

Under the hypertree below, the same check generalises to one salt per published subtree.

**Certified hypertree (Level C).** One tree per chain slot is finite, and replacing its stored root invalidates every pending lane. The hypertree keeps the stored root R fixed and makes it the root of a top tree whose leaves certify subtrees.

- **Layout.** Top tree of height t = 4 + s: 16 chain slots times 2^s subtrees per chain, j = (slot << s) | k; demo s = 2, t = 6. Subtree j is a tree of height h over leaves hashed exactly as today, chain id included. Full leaf index f = (j << h) | i; an ordinary transaction keeps the key form (g << 32) | f. A certification uses K\_cert(j) = (1 << 191) | (g << 32) | j: the top bit of the 192-bit key says "certify", the rest names the generation and the top leaf. Subtree keys always have that bit clear.
- **Certification transaction.** Signed by top leaf j, nonce key K\_cert(j) at sequence 0, frames \[expiry\_verify\] \[self\_verify\] \[SENDER `certify(j, S_j, hot)`\]. The verify frame dispatches on the key's top bit: WOTS+ over the signature hash with top leaf j, t siblings up to R, and the entry's j must match the key's j. `certify()` in the SENDER frame checks TXPARAM key\[0\] == K\_cert(j) again and stores S\_j at keccak256(0x05 ‖ j), with a hot flag in a bitmap word at storage slot 6; S\_j is in the signed calldata, so the top leaf's signature covers it. The nonce key is the only value both frames read and the chain consumes exactly once, so top leaf j signs exactly one certificate, and nothing but a top leaf can certify: a hot device holding subtree tickets cannot publish its own subtree.
- **Ordinary transaction from subtree leaf (j, i).** The entry carries j and the h siblings of the subtree only; the verify frame loads S\_j (one SLOAD) and checks the path against it. Entry size and verify gas are those of today's single tree; the top path is paid once per subtree, at certification. Capacity per chain becomes 2^s times today's for the same per-transaction cost: 4,096 leaves at s = 2 and h = 10.
- **Hot subtrees.** A subtree certified hot also needs a live publication: `republish(j)` writes S\_j to the recent-root contract under salt keccak256("nonce-bound-pq-wallet/subtree" ‖ uint32(j)), and its leaves pass only with a reference to that entry, checked as in Level B. Renewal is `republish(j)` from any cold leaf; no top leaf is spent. `revokeSubtree(j)` zeroes S\_j for an immediate stop.
- **Lifecycle.** Rotation becomes certification of a new subtree. R never changes, a certification writes one slot of its own, and pending lanes of other subtrees read nothing that changed, so nothing is invalidated. Generation g still increments only on a seed-level rotation.
- **Cost.** Certification: a verify like any transaction plus t siblings, and 97,920 state gas for the new slot, alt mempool only. Per-chain keygen grows with the number of subtrees; build each subtree when it is certified and cache it; the journal records certified subtrees, their hot flag and the exposed top leaves.
- **Demo.** Certify a hot subtree live while another subtree has lanes pending, show those lanes untouched, show the explorer reference, revoke, show the next hot lane refused.

**Two key-space tricks, noted and not scheduled.**

- **Leaf hash as the nonce key.** Key = (g << 32) ‖ the low 160 bits of the leaf hash L\_i instead of the leaf index. The verify frame already computes L\_i from the public key it reconstructs, so one comparison binds the lane the chain consumes to the exact key that signed, with no index in the entry, and the lane number reveals nothing about tree position. Cost: the signer keeps a leaf-to-key map, and a lane cannot be read off the explorer as a leaf index. Not for the hackathon: the index form keeps the demo legible.
- **A WOTS+C counter in the key's free bits.** The key has 192 bits and the current form uses 64. A 32-bit counter c in bits 64 to 95 is covered by the signature hash for free. The signer grinds c until the message digest's checksum takes a fixed value, and the verify frame skips the checksum chains, as in SPHINCS+C (Kudinov, Hülsing, Ronen, Yogev, 2022). Expected cost a few thousand hashes per signature; gain the three checksum chains of 67 and simpler code. Not for the hackathon: the chain-side oracle has no WOTS+C mode, so there would be no independent check.

## Account contract

One account implementation behind a minimal proxy. The verify path is a standalone Yul object that emits the EIP-8141 opcodes (TXPARAM, FRAMEPARAM, SIGPARAM, SIGDATACOPY, APPROVE) with `verbatim`, because vanilla solc cannot emit them; the workshop's alternative is one helper contract per opcode, which costs a call each and is the last resort. A dispatcher routes on the caller: ENTRY\_POINT means a VERIFY or DEFAULT frame, the account itself means an admin SENDER frame, anything else is a plain ETH receipt. TXPARAM is never executed outside a frame transaction, where it halts. There is no execute function: SENDER frames call targets directly with the account as caller.

**Storage layout.**

| Slot | Field | Type | Meaning |
| --- | --- | --- | --- |
| 0 | root | bytes32 | Merkle root of the current key tree |
| 1 | treeSeed | bytes32 | T, from which per-leaf public seeds derive |
| 2 | config | packed | owner (160 bits) ‖ height (8) ‖ epoch (32) ‖ flags (8): bit 0 hybridRequired ‖ hotStart (32): first hot leaf of each chain slot |
| 3 | hotValueCap | uint256 | max total wei a hot-ticket transaction may send; zero disables hot tickets |
| 4 | hotFeeCap | uint256 | max total fee a hot-ticket transaction may declare (TXPARAM max fee, or maxFeePerGas times the gas limits on the devnet revision) |
| 5 | allowedTarget | address | the one recipient hot tickets may pay (demo scope; a Merkle allowlist later) |

**Nonce modes and leaf index.**

| Mode | Condition read in the verify frame | Leaf index | Cost beyond the signature |
| --- | --- | --- | --- |
| Keyed (the only hash-signed mode) | TXPARAM(0x0E) == 1 and TXPARAM(0x10) != 0 and TXPARAM(0x01) == 0 (also accept 2^64 - 1 once Day 0 shows the devnet supports the sentinel) | key = TXPARAM(0x10); require key >> 32 == epoch; leaf = key & 0xffffffff; require leaf < 2^height; hot = leaf >= hotStart | first use of the key: 20,000 execution on the devnet revision; 97,920 state plus 12,100 execution in the current EIP |
| Legacy nonce, key list \[0\] | TXPARAM(0x0E) == 1 and TXPARAM(0x10) == 0 | reject; not used: accounts are created by an EOA call to the factory (decided Nov 6) | n/a |
| Anything else |  | reject |  |

Keyed mode is the only hash-signed mode. Every leaf is named by its own nonce key, which the protocol consumes at payment approval, so no two transactions can ever validate against one leaf, in any order, from any device. The earlier sequential mode is withdrawn: an expired transaction leaves the account nonce unchanged, so a retry would have re-signed the same leaf, and the forgery that follows would have been a valid fee-bump replacement. The legacy nonce domain is not used: accounts are created by an EOA call to the factory (decided Nov 6), and the verify frame refuses key 0. Gaps in the keyed band are harmless: a never-used leaf is just a never-used key.

**Verify frame algorithm.** Runs as a static call. Only reads: own storage, TXPARAM, FRAMEPARAM, SIGPARAM, SIGDATACOPY, memory. Ends with APPROVE scope 0x3 or reverts.

1. Dispatch: this path runs only when the caller is ENTRY\_POINT (a VERIFY or DEFAULT frame). A plain call with empty data is an ETH receipt and returns. TXPARAM is never executed outside a frame transaction, where it halts.
2. Load root, treeSeed, config (owner, height, epoch, flags, hotStart), hotValueCap, hotFeeCap and allowedTarget. Pack them so this costs at most four cold SLOADs.
3. Nonce mode: require TXPARAM(0x0E) == 1, TXPARAM(0x10) != 0 and TXPARAM(0x01) == 0 (also accept 2^64 - 1 once Day 0 shows the devnet supports the sentinel). key = TXPARAM(0x10); require key >> 32 == epoch; leaf = key & 0xffffffff; require leaf < 2^height; hot = leaf >= hotStart.
4. Signature shape: the expected count is 2 when hybridRequired is set and the leaf is not hot, else 1; require TXPARAM(0x0B) equals it. With 2: entry 0 must be scheme SECP256K1, its SIGPARAM(0x02) msg must be empty, and its resolved signer must equal owner. The ARBITRARY entry p: SIGPARAM(0x03) length must equal 2,146 + 32 × (height + 4); copy it with SIGDATACOPY; require the version byte is 0x01 and the slot byte is below 16. Check the scheme before reading a signer: SIGPARAM(0x00) halts on an ARBITRARY entry.
5. msg = TXPARAM(0x08). index = (slot << height) | leaf. Derive P\_leaf = keccak256(treeSeed ‖ uint32(index)) and the 15 randomization elements from P\_leaf as WOTSPlus.sol defines.
6. Split msg into 64 base-16 digits, compute the 3 checksum digits. For each of the 67 chains, run the chain from the signature element forward (15 minus digit) steps at the positions WOTSPlus.sol defines. Hash the 67 chain ends into pk.
7. node = keccak256(P\_leaf ‖ uint256(CHAINID) ‖ pk). For k in 0..height+3: sibling = path\[k\]; if bit k of index is 0 then node = keccak256(node ‖ sibling) else node = keccak256(sibling ‖ node).
8. Require node == root.
9. Hot policy, only when hot: require hotValueCap > 0. For every frame after this one: FRAMEPARAM mode must be SENDER, data length 0, resolved target equal to allowedTarget; no DEFAULT frame anywhere after the prefix. Sum the FRAMEPARAM values with checked arithmetic and require the sum is at most hotValueCap. Require the transaction's declared maximum fee (TXPARAM max fee, or maxFeePerGas times the gas limits on the devnet revision) is at most hotFeeCap.
10. APPROVE(0x3).
11. Level B, hot leaf only: locate the transaction's recent-root reference, require source\_id == keccak256(address(this) ‖ HOT\_SALT) and root == A recomputed from the hot-policy storage words; reject a hot leaf without it.
12. Level C: if bit 191 of the nonce key is set, verify as a certification: top leaf j from the key, t siblings up to the stored root, entry's j equal to the key's j; otherwise load the subtree root S\_j named in the entry and verify the subtree path against it.

The frame must stay inside the public-mempool opcode rules even though we target the alt mempool: no TIMESTAMP, NUMBER, BALANCE, GAS, no CALL to other contracts, SLOAD only on own slots. CHAINID is not on the EIP's banned list and is read once. The devnet tracer also bans ORIGIN, TLOAD, TSTORE, BLOBHASH and CALLCODE (reviewer finding from the ethrex source; confirm on Day 0). Memory use is about 3 KB.

**Admin functions** (require msg.sender == address(this), which only a SENDER frame of this account satisfies):

| Function | Effect |
| --- | --- |
| rotate(bytes32 newRoot, bytes32 newTreeSeed, uint8 newHeight) | sets root, treeSeed, height; epoch += 1. The new tree must be built as generation = new epoch, so it shares no secret with the old one; the hot band starts over. Rotation is per chain: each deployment installs a new root on its own schedule, and a tree's slot for a chain is only ever used on that chain. After any seed-only restore, rotate before signing. Refuses a root or treeSeed equal to the installed one (Nov 6): re-installing a tree under the next epoch would reopen its used leaves |
| setHybrid(bool) | toggles hybridRequired; refuses turning it on while owner is 0 (Nov 6) |
| setHotPolicy(uint32 hotStart, uint256 valueCap, uint256 feeCap, address allowedTarget) | sets the hot-ticket band and caps; a zero value cap disables every hot ticket, which is the kill switch. hotStart may be kept or lowered, never raised within an epoch (Nov 6): raising it would turn exported hot tickets into cold leaves with no caps, so the band shrinks only by rotating. hotStart 0, or 1 at epoch 0, is refused (here and at creation): it leaves no cold leaf for admin calls |
| renewHot() | Level B: publishes the hot authority A as a recent root under the account's hot salt; setHotPolicy does the same after writing the policy. Hot leaves pass only with a live reference to A |
| certify(uint32 j, bytes32 subtreeRoot, bool hot), republish(uint32 j), revokeSubtree(uint32 j) | Level C: certify is accepted only on the certification nonce key for j and stores the subtree root; republish writes a hot subtree's root as a recent root from any cold leaf; revokeSubtree zeroes it |
| setOwner(address) | rotates the classical co-signer; refuses 0 while hybrid is on (Nov 6) |
| receive() | accepts ETH |

**Factory.** `createAccount(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt)` deploys with CREATE2 so the address is known before funding. The deploy frame (DEFAULT mode, target = factory, data = that call) must be the first frame after an optional expiry frame, and the created code must land at tx.sender, so the TS side computes the salt and address with the same formula. The frame needs state gas for the new account (183,600) plus 1,530 per byte of proxy code (68,850 for 45 bytes) plus 97,920 per initialised storage slot, so about 546k with three slots: above the public mempool's 500k state cap and above the published sidecar's identical cap; the ERC-8421 draft removes the cap. Decided Nov 6: accounts are created by a funded EOA calling the factory, never by a deploy frame. Measured from the EOA: 953,678 gas with six initialised slots, and the verify frame refuses the legacy nonce [0] a deploy frame would use. Estimate with `eth_estimateFrameTransactionGas`.

## Transaction format and signing flow

A normal transfer is three frames: expiry, self-verify, one or more SENDER frames. Signing is two passes because the protocol hashes signature lengths, not signature bytes.

**Frame list for a transfer.**

| # | Subclass | mode | flags | target | limits.execution | limits.state | value | data |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | expiry\_verify | 1 | 0x0 | EXPIRY\_VERIFIER | 5,000 (measure once; the frame counts toward the 100k prefix sum) | 0 | 0 | 8-byte big-endian unix timestamp, now + 90 s |
| 1 | self\_verify | 1 | 0x3 | null (self) | declared per transaction after grinding, at most 90,000 (the published sidecar rejects a prefix sum above 100,000) | 0 on the devnet revision, where the key's first use is 20,000 execution gas; 110,000 if the current EIP's 97,920 state charge turns out to be live | 0 | empty |
| 2.. | user\_op | 2 | 0x0 | recipient or contract | per call | 0 for existing accounts; at least 183,600 when the target is a new account | wei | calldata |

**Deployment transaction.** Same list with a deploy frame inserted before self\_verify: mode 0, flags 0x0, target = factory, data = `createAccount(...)`. Use an EIP-1167 minimal proxy to a shared implementation so the code deposit is 45 bytes, not kilobytes; state gas is priced per byte (1,530 each), so a full contract would cost millions of state gas to deploy. DELEGATECALL into the implementation is fine inside the static verify frame, and storage stays the account's own, so the SLOAD rule holds. VERIFY on the devnet that the sidecar's trace accepts DELEGATECALL to the implementation in the prefix. Before building, check eth\_getCode(sender): if code exists, omit the deploy frame (the EIP's front-running note). Not used (decided Nov 6): this shape is above the 500k state cap, and the verify frame refuses its legacy nonce \[0\], so accounts are created by an EOA call to the factory. Every transaction of the account is keyed.

**Signature entries.** Order is fixed. With hybrid on: entry 0 is `{scheme: 1, signer: owner, msg: empty, signature: 65 bytes}`, entry 1 is `{scheme: 0, signer: empty, msg: empty, signature: 2,274 + 32h bytes}`. With hybrid off: only the ARBITRARY entry. ECDSA-only path: only the SECP256K1 entry.

**Nonce fields.**

| Mode | nonceKeys | nonceSeq |
| --- | --- | --- |
| Deployment (legacy nonce) | not used: accounts are created by an EOA call to the factory (decided Nov 6). On the devnet the legacy nonce is `[0]` (Day-0) | n/a |
| Keyed (every hash-signed transaction) | one key: (epoch << 32) ‖ leaf | 0 (fresh key; the account requires TXPARAM(0x01) == 0). The 2^64 - 1 sentinel is rejected by the devnet client |

**Fees.** `maxFeePerGas` and `maxPriorityFeePerGas` from `skandha_getGasPrice`; `maxFeePerBlobGas` 0; no blobs. (Nov 6, Vicky) A tip floor: the priority fee is at least `WL_MIN_TIP_WEI`, 3 gwei by default on chain 1337, with the max fee raised by the same amount. The devnet sidecar relays the highest priority fee first, 4 per 10 s pass, and its quote fell below teams that fix 2 gwei, so oracle-priced lanes waited past their deadline. Bursts of parallel lanes use a 180 s deadline (`demo/lanes.ts --expiry-seconds`); single transactions keep 90 s. The devnet codec has these three fee fields and a trailing recentRootReferences list; the current EIP has \[max\_fee, max\_priority\_fee\_per\_gas\]. The vendored codec at the pinned commit is the truth.

**Two-pass signing.**

1. Choose the leaf; the chain slot is fixed by the chain id through the keygen chain list. Take the lowest unused leaf of the keyed band from the local journal; nonce key = (epoch << 32) | leaf, nonceSeq = 0. Write the leaf as consumed to local state before anything else, so a crash cannot reuse it.
2. Build the transaction JSON with placeholder signatures of the exact final lengths: 65 zero bytes for ECDSA, 2,274 + 32h zero bytes for the hash-based entry.
3. sigHash = `computeSigHash(tx)` from the sidecar codec. The pinned sidecar codec replaces empty-msg signature bytes with empty bytes (the current EIP commits to their length instead); with either rule the placeholders yield the final hash. Fix fees, limits, frames and the expiry before this step, and never re-sign a changed digest on the same leaf.
4. ECDSA-sign sigHash with the owner key; write y-parity byte then r then s into entry 0; enforce low-s.
5. Call the Rust CLI: `sign --chain-id <chainId> --leaf <leaf> --msg <sigHash>`; write the returned entry bytes into entry 1.
6. Encode with `encodeRawFrameTx` and submit with `eth_sendFrameTransaction` to the gateway. Keep the returned hash.
7. Poll `skandha_frameTransactionStatus` until OnChain or the expiry passes. On OnChain, fetch `eth_getFrameTransactionReceipt` and build the explorer link.

**Expiry instead of replacement.** If the status is not OnChain one block after the expiry timestamp, the transaction is dead. Mark the leaf burned locally, pick the next leaf on a fresh nonce key, rebuild with fresh fees and a new expiry, and submit. Read eth\_getFrameTransactionReceipt first: a stale status is not proof of non-inclusion, and an included transaction consumed its key even if a later frame reverted. Never resubmit the same nonce fields with higher fees; that would sign the same leaf twice.

**Example JSON (keyed mode, hybrid on, h = 10, devnet codec fields), fields as the sidecar readme names them.**

```json
{
  "chainId": "0x539",
  "nonceKeys": ["0x100000003"],
  "nonceSeq": "0x0",
  "sender": "0xACC0...",
  "frames": [
    {"mode": 1, "flags": 0, "target": "0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf", "limits": {"execution": "0x1388", "state": "0x0"}, "value": "0x0", "data": "0x00000000690C2A5E"},
    {"mode": 1, "flags": 3, "target": null, "limits": {"execution": "0x15f90", "state": "0x0"}, "value": "0x0", "data": "0x"},
    {"mode": 2, "flags": 0, "target": "0xBEEF...", "limits": {"execution": "0x5208", "state": "0x0"}, "value": "0xde0b6b3a7640000", "data": "0x"}
  ],
  "signatures": [
    {"scheme": 1, "signer": "0x0WNER...", "msg": "0x", "signature": "0x<65 bytes>"},
    {"scheme": 0, "signer": "0x", "msg": "0x", "signature": "0x01 00 <2144 bytes> <448 bytes>"}
  ],
  "fees": {"maxPriorityFeePerGas": "0x3b9aca00", "maxFeePerGas": "0x3b9aca00", "maxFeePerBlobGas": "0x0"},
  "blobVersionedHashes": [],
  "recentRootReferences": []
}
```

The chain id, nonce encoding and expiry timestamp above are illustrative; the devnet's real values come from Day-0.

## Signer core (Rust)

A stateless Rust crate plus a CLI that speaks JSON on stdin and stdout. It derives everything from the master seed, never tracks which leaves were used (the pipeline's journal does, and that journal is authoritative: chain state only gives a lower bound), and never prints a secret.

**Crate layout.**

| Module | Responsibility |
| --- | --- |
| wots | Quip-format WOTS+: randomization elements, chain, digits and checksum, public key hash, sign, verify |
| derive | Master seed to tree seed, per-leaf public seed, per-leaf per-chain secrets, all keyed by the full leaf index (formulas in Cryptography) |
| tree | Build a 2^h subtree per listed chain and the 4-level slot layer above them, EMPTY\_SUBTREE in unlisted slots, root, authentication path for a leaf, Merkle verify |
| entry | Encode and decode the signature entry bytes (version, signature, path) |
| vectors | Emit test vectors including deliberate mutations |
| cli | Subcommands below; hex values are 0x-prefixed lowercase |

Dependencies: a keccak crate (tiny-keccak or sha3), serde and serde\_json, clap. No ECDSA; the owner key stays on the TypeScript side. No randomness anywhere; the same seed always yields the same tree.

**CLI commands.**

| Command | Input | Output |
| --- | --- | --- |
| keygen | --seed, --height, --generation, --chains (chain ids in slot order) | {treeSeed, root, height, chains, leafCountPerChain} |
| pubkey | --seed, --height, --generation, --chains, --chain-id, --leaf | {publicSeed, publicKeyHash, leafNode} for oracle checks against WOTSPlus.sol |
| sign | --seed or --ticket-file, --height, --generation, --chains, --chain-id, --leaf, --msg (32 bytes) | {slot, leaf, signature (2,144 bytes), authPath (h + 4 items), entry (full entry bytes)} |
| verify | --tree-seed, --root, --height, --chain-id, --leaf, --msg, --entry | {ok: true or false, reason} mirroring the Yul exactly, used as a pre-flight check before submission |
| vectors | --seed, --height, --count, --out | writes the vector file described in Shared interfaces |
| export-leaves | --seed, --height, --generation, --chains, --chain-id, --from, --to, --out | writes a ticket file: the leaf secrets and authentication paths for that range, no seed; the hot device signs from it with sign --ticket-file; the cold journal marks the range as exported |

The seed is read from `--seed`, from the `PQ_SEED` environment variable, or from a file path; the backend uses the file path form so seeds never appear in process lists.

**Tree caching.** Building a tree is the only expensive step: per listed chain, 2^h leaves × 67 chains × 15 keccak calls. At h = 10 that is about one million hashes per chain and runs in well under a second single-threaded. The CLI caches all levels to `<cache dir>/<keccak(treeSeed)>.levels` after the first keygen so sign and pubkey are instant. At h = 20 a full build is about one billion hashes per listed chain; it is not needed for the demo and the README gives the number as the production cost.

**Performance targets.** keygen at h = 10 under 1 s per listed chain; sign under 50 ms with a warm cache; verify under 50 ms.

**Oracle check that proves the format.** A Foundry test loads Quip's `WOTSPlus.sol`, calls its `verify` with our publicSeed, publicKeyHash, message and signature from `pubkey` and `sign`, and expects true. Then the same inputs run through our own Yul verifier and expect the same. Mutated signatures (one byte flipped, wrong leaf, wrong path element, wrong version byte) must fail in both. This is the first test written; nothing else starts until it passes.

**Not in the crate.** Used-leaf tracking, nonce selection, ECDSA signing, RPC. The crate does not know the chain exists.

## Pipeline, backend and frontend (Vicky)

TypeScript on Bun. Three packages and a bot. The pipeline is a library with no HTTP; the backend wraps it; the frontend only calls the backend.

&#91;embedded content: components and one transaction's path · 9 boxes, 7 numbered steps\]

Numbers follow one transfer from the browser to inclusion; the dashed line is the status path back to the backend.

**Package `pipeline` (library).**

| Module | Responsibility |
| --- | --- |
| codec | Vendored copy of the sidecar's `codec.ts` (computeSigHash, encodeRawFrameTx, JSON to RLP). Pin the commit hash in a comment. Never hand-roll RLP |
| builder | Assembles frames (expiry, optional deploy, self\_verify, SENDER frames) and nonce fields (legacy \[0\] for the deployment transaction, a fresh key at sequence 0 for everything else); computes the counterfactual address with the factory's CREATE2 formula |
| signer | Two-pass flow from the Transaction format section: placeholders, sigHash, ECDSA with viem or noble-secp256k1 (low-s), shell out to the Rust CLI for the hash-based entry |
| rpc | Thin JSON-RPC client for the gateway, the sidecar and the ethrex node (method list below) |
| submit | Send, poll status, detect expiry, return a result object with explorer link |
| leaves | Local journal of exposed leaves per wallet and generation, written before signing, never cleared, authoritative over chain state; exported ticket ranges are marked as spent |

**RPC methods used.**

| Method | Host | Purpose |
| --- | --- | --- |
| skandha\_explorer\_faucet \[address\] | sidecar | 1 ETH per address per hour |
| skandha\_getGasPrice | sidecar | fee fields |
| eth\_estimateFrameTransactionGas \[partialTx\] | sidecar | per-frame execution and state limits before signing |
| eth\_sendFrameTransaction \[tx\] | gateway | submit; returns the tx hash |
| skandha\_frameTransactionStatus \[hash\] | sidecar | New, Pending, Submitted, OnChain, Finalized, Cancelled, Reverted |
| eth\_getFrameTransactionReceipt \[hash\] | sidecar | per-frame status and gas after inclusion |
| ethrex\_simulateFrameTransaction \[rawTx, block, {trace: true}\] | ethrex node | admission report with gas used and any rule violation; the canonical-rejection demo reads this |
| eth\_getTransactionCount, eth\_getCode, eth\_getBalance | proxied through the sidecar | nonce, deployment check, balances |

**Status machine per transaction.** Draft → Signed (leaf reserved) → Submitted → OnChain, or Submitted → Expired (one block past the expiry timestamp) → leaf burned → new Draft with the next leaf on a fresh nonce key, after the receipt has been checked. Cancelled or Reverted from the sidecar also burns the leaf. No state ever moves a transaction back to Draft with the same leaf.

**Package `backend` (HTTP, Bun).** Holds demo seeds in files under a data directory, runs the pipeline, and exposes the API in Shared interfaces. It is the only process that touches seeds. It persists wallets, epochs and used leaves to JSON on disk after every change.

**Package `web` (frontend).** One page. Create wallet, fund, send (recipient, amount, mode: keyed or hot ticket), a transactions table with status, explorer link and the admission report of each transaction, and a wallet panel showing root, epoch, height, leaves used out of 2^h, lanes in flight, hybrid flag, hot caps and tickets remaining. No wallet-connect, no styling beyond readable.

**Demos the pipeline must drive, each as one script.**

1. Keyed lanes: four to eight keyed transfers submitted within one second, all pending at once in the alt mempool, then all OnChain; print each key and each admission report; submit the same payload to the public mempool and show it holds one per sender.
2. Expiry on a fresh key: a transfer whose first attempt has a 4-second deadline, so it misses its block, shown Expired; check the receipt; resend on a fresh key; print the burned key. (Changed Nov 6 with Vicky's approval: on this devnet a fee below the 7-wei base fee is refused at admission and any fee above it is included, so a low fee cannot make a payment stuck.)
3. Hot ticket: sign from an exported ticket file for the allowed target under the caps and show the admission report; then a hot transaction over the cap, or to another target, refused at admission; then the tickets run out.
4. Gas gauge: for one message, the chain-step count and the declared limit as the grinder runs; the four-column gas table filled from receipts.
5. Budget probe, only if Day 0 shows per-entity budgets are live: the same payload refused by the canonical rules and admitted by the alt mempool, both reports side by side.
6. Use-case screens: the hot-and-cold, agent and session screens, each run as its 30-second scene with the mempool switch flipped to public at the end (see Use cases).

Each script prints the exact JSON it sent, so the demo video can show it.

## Shared interfaces (frozen before coding)

Five things cross the boundary between the two halves. Change any of them only by editing this section first.

**1. Test vector file** (`vectors/h<height>.json`, produced by the Rust CLI, consumed by Foundry and by the TypeScript tests).

```json
{
  "version": 2,
  "params": {"hash": "keccak256", "n": 32, "w": 16, "chains": 67, "height": 10, "slotBits": 4, "chainIds": [1337]},
  "masterSeed": "0x...32 bytes",
  "treeSeed": "0x...",
  "root": "0x...",
  "cases": [
    {
      "name": "leaf0-valid",
      "chainId": 1337,
      "slot": 0,
      "leaf": 0,
      "publicSeed": "0x...",
      "publicKeyHash": "0x...",
      "message": "0x...32 bytes",
      "signature": "0x...2144 bytes",
      "authPath": ["0x...", "0x..."],
      "entry": "0x0100...",
      "expected": true
    },
    {"name": "leaf0-flipped-byte", "chainId": 1337, "slot": 0, "leaf": 0, "entry": "0x0100...", "message": "0x...", "expected": false},
    {"name": "leaf0-wrong-leaf-index", "chainId": 1337, "slot": 0, "leaf": 1, "entry": "0x0100...", "message": "0x...", "expected": false},
    {"name": "leaf0-bad-version", "chainId": 1337, "slot": 0, "leaf": 0, "entry": "0x0200...", "message": "0x...", "expected": false},
    {"name": "leaf0-wrong-chain", "chainId": 1, "slot": 0, "leaf": 0, "entry": "0x0100...", "message": "0x...", "expected": false}
  ]
}
```

Minimum cases: leaf 0, leaf 2^h - 1, a middle leaf, and for each of those the three mutations above plus a wrong-path-element mutation, and one wrong-chain case: the valid leaf 0 entry verified under another chain id must fail. The masterSeed in a committed vector file is a throwaway.

**2. CLI contract.** Commands and fields exactly as in the Signer core table. All hex is 0x-prefixed lowercase. Exit code 0 with a JSON object on stdout on success; exit code 1 with `{"error": "<code>", "detail": "..."}` on stderr on failure. Error codes: `bad_seed`, `bad_height`, `leaf_out_of_range`, `bad_msg_length`, `bad_entry_length`, `verify_failed`. Add bad\_chain for a chain id that is not in the keygen list. No other output on stdout, ever.

**3. Byte layouts.** Signature entry: version byte 0x01, then the chain slot byte (0 to 15), then 2,144 signature bytes, then 32 × (h + 4) path bytes (Cryptography). ECDSA entry: 65 bytes, y-parity (0 or 1) then r then s. Single-use nonce key: (epoch << 32) | leaf as a uint256, where leaf is the per-chain index without the slot bits; nonceSeq is 0.

**4. Contract ABI the pipeline calls.**

| Contract | Function | Who calls it |
| --- | --- | --- |
| Factory | createAccount(bytes32 root, bytes32 treeSeed, uint8 height, address owner, uint32 hotStart, uint256 hotValueCap, uint256 hotFeeCap, address allowedTarget, bytes32 salt) returns (address) | the deploy frame |
| Factory | predictAddress(same args) view returns (address) | builder, to get the counterfactual sender |
| Account | rotate(bytes32, bytes32, uint8), setHybrid(bool), setHotPolicy(uint32, uint256, uint256, address), setOwner(address) | SENDER frames targeting self |
| Account | root(), treeSeed(), height(), epoch(), hotStart(), hotValueCap(), hotFeeCap(), allowedTarget(), owner(), hybridRequired() views | frontend wallet panel |

**5. Backend API** (JSON over HTTP, all under `/api`). Extended Nov 6 with Vicky's approval for the three use-case screens: rows and fields marked (Nov 6) are new, and nothing earlier changed. Amounts are decimal strings of wei; nonce keys and the sequence are 0x hex.

| Method and path | Body | Returns |
| --- | --- | --- |
| POST /wallets | {height, hybrid, spendLimitWei, chainIds (defaults to the devnet's chain id)}; (Nov 6) optional hotStart, hotFeeCapWei, allowedTarget | {address, root, epoch, funded: bool} (creates seed, keygen, faucet, deploy tx). (Nov 6) The deploy tx is the EOA's createAccount call (decided Nov 6), funding falls back to the EOA when the faucet is dry, spendLimitWei is the hot value cap, and hybrid true is refused while plan section 8 keeps hybrid off |
| GET /wallets (Nov 6) |  | [{address, epoch, height, balanceWei}]. (Nov 6, Vicky) Only wallets that can sign on this chain: a wallet whose seed's genesis pin names another chain (a devnet reset) or whose address has no code is left out, and the backend logs why once |
| GET /status (Nov 6) |  | {chainId, head, headAgeSeconds, stalled, fake}: the screens' status line; fake is true on chain 31337, the local fake chain |
| GET /wallets/:address |  | {root, treeSeed, height, epoch, leavesUsed, leafCount, lanesInFlight, hybrid, locked, balanceWei}; (Nov 6) plus hotStart, hotValueCapWei, hotFeeCapWei, allowedTarget, tickets {exported, used, left}, rotationPending. locked stays false: the canary that would set it is cut. (Nov 6) Plus leaves {onChain, burned, inFlight, tickets}, read-only, for the screens' key register: the current epoch's leaf numbers by state from the cold journal and the ticket device's journal (burned: by the signer, so expired, refused, an estimate, never sent), and tickets {from, to}, the band cut to the ticket device (to inclusive), or null; a ticket in none of the lists is still on the phone, any other leaf is unused |
| POST /wallets/:address/send | {to, valueWei, data, mode: "keyed" (default) or "hot" (ticket device), expirySeconds}; (Nov 6) optional mempool: "alt" (default, the sidecar) or "public" (the node's eth\_sendRawTransaction), maxFeePerGasWei for the first attempt, firstAttemptExpirySeconds (a short deadline for the first attempt only: the stuck payment of the demo), retries: fresh-leaf attempts after an expiry (default 0) | {txHash, leaf, nonceKeys, nonceSeq, status}. (Nov 6) Answered once the transaction is submitted or refused; GET /tx/:hash follows it to its outcome |
| GET /wallets/:address/txs (Nov 6) |  | the wallet's transactions, newest first, each as GET /tx/:hash returns it but without wire: the lane board |
| GET /wallets/:address/lanes/plan (Nov 6) | query n, mode, valueWei, to, expirySeconds | {affordable, setAsideWei, shortfallWei, passes, etaSeconds, warnings}: the parallel-lanes plan before a burst (money: every pending lane's max cost plus value must fit the balance; relay: at most bundleSize per pass); reserves no leaf, signs nothing |
| GET /tx/:hash |  | {status, explorerUrl, receipt, simulation: {verifyGas, violations}}; (Nov 6) plus wallet, leaf, nonceKey, mode, mempool, to, valueWei, deadline, admission, timeline, retryOf, retriedAs; (Nov 6) maxCostWei (the gas part of what the sidecar sets aside for the lane, ethrex's maxCost; for a self-paying lane the set-aside is maxCostWei + valueWei) and wire (the exact JSON sent); (Nov 6, Vicky) grind {field, steps, maxSteps, tries} or null, for the gas gauge: the field varied, the chain steps of the signed message, the most the declared verify limit allows, and the chain steps of every message tried in order (the last is the one signed), also on a refusal; and gas {declaredVerifyGas, verifyGas, intrinsicGas, floorGas, billedBytes, gasUsed}, the four gas columns in decimal gas, each null when unknown (no JSON sent, no receipt): intrinsic and floor from ethrex's billing of the JSON sent (floor = mandatory + 64 per billed byte) |
| POST /wallets/:address/rotate | {height} | {txHash, newRoot, epoch}. (Nov 6) Refused while lanes are in flight; the new epoch takes effect once the transaction is OnChain |
| POST /wallets/:address/hot-policy (Nov 6) | {hotStart, valueCapWei, feeCapWei, allowedTarget} | {txHash, status}: setHotPolicy in a SENDER frame signed by a cold leaf; valueCapWei 0 is the kill switch |
| POST /wallets/:address/tickets (Nov 6) | {count} | {from, to, count}: the next count unused hot leaves, exported to the ticket device with export-leaves (to is inclusive) and marked exported in the cold journal first |

Errors are `{"error": code, "detail": text}` with HTTP 400 for input and 502 for RPC failures. (Nov 6) Also 404 for an unknown wallet or transaction; 409 for a conflict with the wallet's state (no leaf or ticket left, lanes in flight, a rotation pending); 422 when the node or a mempool refused the signed transaction, whose leaf is then burned, with the simulation or admission report in the body; 503 while the chain is stalled (the latest block's timestamp more than 60 s from the host clock).

Transaction status values (Nov 6): Submitted (being followed), OnChain, Reverted (included, a frame failed), Included (key used, no receipt readable), Expired (leaf burned), Refused (leaf burned), Unknown (followed past its deadline with no outcome; never paid again automatically).

## Demo script and qualification checklist

The demo is under three minutes, on the live devnet, terminal plus the one-page frontend. Every claim on screen has an explorer link.

**Script (2:45).**

1. 0:00 One sentence: hash-based keys are one-time; we name each key by its nonce key, which the protocol consumes at approval, so the account never writes state to stay safe. Show the verify frame for two seconds.
2. 0:20 Create wallet: seed generated, tree built, counterfactual address funded, deployment admitted. Explorer link and admission report.
3. 0:45 Eight hash-signed transfers on eight nonce keys fired in one second: all pending at once in the alt mempool, then landing over two or more blocks, at most 4 relayed per 10 s pass by default (Nov 6). Submit the same to the public mempool: one pending per sender. Both reports side by side.
4. 1:20 A transfer with a 4-second deadline misses its block and expires (Nov 6: a low fee cannot stick on this devnet); the pipeline checks the receipt, burns that key and resends on a fresh key. Say the sentence: we never sign a leaf twice, so we never fee-bump.
5. 1:45 Hot ticket from the exported ticket file: one payment lands; the next one over the cap is refused at admission; the tickets run out.
6. 2:15 The gas gauge: declared limit versus used as the signer grinds; the four-column table with the calldata floor.
7. 2:40 Close on the README: the claim, prior art, trade-offs, and the divergences we filed upstream.

**EF qualification checklist.**

- [ ] Admitted hash-signed transaction with its explorer link in the README, captured by hour 12, plus its hash and receipt (the explorer's history is in memory and cleared on restart)
- [ ] Public repo under MIT or Apache-2.0 with a README a judge can run from (Quip's AGPL code only in tests, not linked)
- [ ] README section "Design": nonce binding, keyed mode, expiry policy, hybrid, hot tickets, with the verify-frame algorithm and the one-page security argument
- [ ] README section "Trade-offs": the table from this spec's Risks section
- [ ] README section "Prior art": the table from this spec, Quip first
- [ ] README section "Gas": measured verify gas per mode and per height, canonical cap and alt budget beside them
- [ ] Every team member can walk through the Yul verifier line by line and explain why each read is allowed in a static frame
- [ ] Demo video, 3 minutes max, uploaded before the deadline
- [ ] Workshop attended: Ethereum Foundation, Thursday 5 Nov, 5:00 PM IST, Workshop Room 2
- [ ] This spec disclosed in writing to ETHGlobal as pre-existing design before kick-off; commits from hour 0 in both halves; no history rewrite
- [ ] Divergences found on Day 0 filed as issues on the sidecar or ethrex repositories and linked in the README

**Also submit to the CROPS prize.** One EF prize per project, judges place us. The same README needs the CROPS section (C, O, P, S, one or two lines each) and no third-party trackers in the frontend. That costs one hour; one EF prize per project, and the judges decide the placement.

## Day-0 checks on the devnet

Run these in the first two hours, before any project code, against devnet1 and its gateway. Each answer goes into this section as a one-line result. A wrong assumption here costs more than any bug later.

**Results, Thu Nov 5, 21:00 to 22:30 IST (block V1).** Probed on the workshop devnet: node `altmempool.forshtat.com`, sidecar `/rpc`, gateway `altmempoolgateway.forshtat.com/rpc`. devnet1, devnet2 and gateway1 `.altmempool.wtf` resolved in DNS but refused TLS from two machines, so they were not probed; rerun there if they become the hackathon devnets. Probe scripts: `~/Documents/winterlock-probes/` (outside the repo; written with Claude Code). Test EOA `0xe8CC33DDd7Aa454c2Ce7f9473CC51d68352dD57d`, probe account `0xd5a2ce68f6a5059d04e763f30d31c0f4f7fd7aaa`, EIP-1167 proxy to it `0x13075a0f56d6a793eba4493d866e6502052abe87`.

- [x] Chain id, block time and the ethrex `web3_clientVersion` of the hackathon devnets (the older devnet was 1337 and 6 s) → **1337, 6 s (measured over 10 blocks); node `ethrex/v23.0.0-eip8141-tracer-9aa3645d795945c64400f41a70aace0edfa7f383`, sidecar `skandha/v4.1.1`**
- [x] Nonce encoding the sidecar accepts for legacy mode: empty `nonceKeys` per EIP-8250, or `["0x0"]` per the sidecar docs → **`["0x0"]`. `[]` is refused: "nonceKeys count must be between 1 and 16" (-32602). The `[0]` tx (EOA, seq 0) landed, account nonce 0 → 1**
- [x] TXPARAM selectors 0x0D, 0x0E, 0x0F, 0x10 exist on the devnet client (send a tiny verify frame that reads each and approves) → **all of 0x00 to 0x11 exist (one stack input, the selector), values logged on chain and matching (Nov 6, block 405,513): 0x00 = 6, 0x06 = max cost, 0x09 frame count, 0x0A current frame, 0x0B = 2 entries, 0x0C state gas left = 0, 0x0D pre-state legacy nonce = 1 for a contract, 0x0E = 1, 0x0F = keccak256(be32(len) ‖ be32(key0)), 0x10 = the key, 0x11 recent-root reference count = 0**
- [ ] Single-use keyed mode works: a tx with one key and `nonceSeq = 2^64 - 1` is admitted and the same key is rejected afterwards → **sentinel not sent: the sidecar's static check refuses it ("nonceSeq must be < 2\*\*64 - 1"). Key at seq 0 admitted and landed; the same key at seq 0 afterwards refused, "Nonce mismatch: expected 1, got 0" (-32500); NONCE\_MANAGER slot for (sender, key) reads 1. The same key at seq 1 is admitted (sequential keyed), so the account must require seq 0**
- [x] The alt mempool's pending policy: how many keyed transactions per sender can be pending at once (docs say one per key, no per-sender cap) → **two keyed txs on two keys pending at once from one EOA, both landed in the same block (more not tried). A second tx on a pending (sender, key) at the same fee is refused, "Frame transaction cannot be replaced: fee too low"; per the sidecar README a 10% fee bump would replace it, so only the signer can prevent a second signature on a pending leaf**
- [ ] EXPIRY\_VERIFIER is deployed at 0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf and a leading expiry frame is accepted in the prefix → **not at that address (no code). Deployed at `0x0000000000000000000000000000000000008141` (the sidecar's constant): 26 bytes that require 8 bytes of calldata and revert if block.timestamp is later. A leading expiry frame to 0x…8141 is accepted: prefix shape still `SelfVerify`, the expiry frame used 3,051 gas (V2 smoke tx, block 405,073)**
- [x] What nonce the first self\_verify after a deploy-frame deployment sees (0, 1 or 2), so leaf-index gaps are known → **moot: no deploy-frame deployment (decided Nov 6)**
- [x] DELEGATECALL from a minimal proxy to an implementation is accepted by the sidecar's trace rules inside the verify frame → **accepted: an EIP-1167 proxy (GAS then DELEGATECALL) admitted and landed; APPROVE from the delegated code approves the frame. Verify execution 23,227 through the proxy against 20,170 direct, so about 3,060 gas for the proxy**
- [ ] Maximum transaction size the gateway accepts; a 2.9 KB signature entry (2,914 bytes at h = 20) must pass → **a 2,594-byte ARBITRARY entry beside a 65-byte owner ECDSA entry is admitted and included (h = 10 size); 2,914 not tried yet**
- [x] Exact SIGPARAM selector numbers and the operand order of SIGPARAM and SIGDATACOPY from the EIP-8141 text, pasted into this section → **from the ethrex source at 9aa3645d (`opcode_handlers/frame_tx.rs`, `opcodes.rs`), confirmed on chain: SIGPARAM 0xB4 pops sigIndex (top) then param; 0x00 resolved signer (halts on ARBITRARY), 0x01 scheme, 0x02 msg (0 when empty), 0x03 length. SIGDATACOPY 0xB5 pops memOffset (top), dataOffset, length, sigIndex; ARBITRARY only, zero-fills past the end. RECENTROOTREFLOAD is 0xB6. FRAMEPARAM 0xB3 pops frameIndex (top) then param: 0x00 target, 0x01 gas limit, 0x02 mode, 0x03 flags, 0x04 data length, 0x05 status (past frames only), 0x06 allowed scope, 0x08 value. The ethrex `docs/eip-8141.md` at the same commit still describes a SIGPARAM 0x04 copy, which halts: file it. All 18 reads Account.yul needs, SIGDATACOPY included, pass the sidecar's tracer inside a VERIFY frame (317 gas besides the 20,000 key cost)**
- [ ] `eth_estimateFrameTransactionGas` returns sane limits for a tx whose verify frame burns about 60k to 95k
- [ ] Measured verify gas of the Yul verifier through `ethrex_simulateFrameTransaction` with trace, for h = 10 across the message distribution, including the worst digits
- [x] Faucet rate and whether addresses can be funded before deployment (counterfactual funding) → **1 ETH per `skandha_explorer_faucet` call on the gateway; the once-per-hour limit is from the docs, not tested. A code-less address (our EOA) was funded, so counterfactual funding works**
- [x] Explorer link format for a frame transaction hash → **`https://explorer.altmempool.wtf/tx/<hash>` (also served at `altmempoolexplorer.forshtat.com`). The page shows status, "seq 0 on key 0x…", the frames and the per-rule admission report; data via `skandha_explorer_getTransaction` on the gateway**
- [ ] Whether the on-site alt mempool team wants admission reports in a particular format for judging
- [x] CHAINID inside the verify frame passes the sidecar's trace rules (it is not on the EIP-8141 banned list, but the sidecar may be stricter) → **passes (read in the probe account's VERIFY frame, tx admitted)**
- [x] Budget probe: submit a prefix declaring 120k and read the rejection string, then 95k; record which budget rules the devnet runs, and ask Alex and Pierre whether per-entity budgets are live → **120k refused: "validation prefix execution gas sum 120000 + signature-verification cost 100 = 120100 exceeds MAX\_VERIFY\_GAS 100000" (-32602); 95k admitted. Flat 100k over the declared prefix limits plus signature costs, no per-entity budget. Still to ask Alex and Pierre about the hackathon devnets**
- [ ] nonceSeq probe: one keyed transaction at sequence 0 and one at 2^64 - 1; record both verdicts → **seq 0 admitted; 2^64 - 1 not sent, refused by the sidecar's static check per its code**
- [ ] Legacy encoding probe: nonceKeys \[\] versus \[0\], and the values TXPARAM 0x0E and 0x10 return for each → **`[]` refused, `[0]` accepted (above). TXPARAM values read only for a keyed tx (0x0E = 1, 0x10 = the key), not yet for `[0]`**
- [x] eth\_getCode at 0x81413f0cF12e9b6a49B1D0439E081c577D57FfFf; if empty, drop the expiry frame, document the client-side timeout and file it → **empty, but the verifier is live at 0x…8141, so keep the expiry frame and target 0x…8141; file the address divergence**
- [x] Receipt gas\_used versus verify-frame execution for one transfer: the calldata floor in numbers → **193,882 gas used for owner ECDSA + 2,594-byte entry + one transfer, with a verify frame of 20,317 (stub check, no hashing), block 405,523. The ethrex code (`transaction.rs` at 9aa3645d; its docs say 15,000 and are wrong) charges intrinsic 12,000 + 475 per frame + 6,000 per value-carrying frame + scheme costs (100 ARBITRARY, 2,800 SECP256K1), data at 4/16 gas per zero/non-zero byte including signature bytes, and a floor of 64 gas per byte; the gas limit charged up front is max(standard, floor + Σ limits.state), and gas used = max(actual, floor), so a ~60k WOTS check should still land under the floor**
- [ ] Additional finding, public mempool: **ethrex's `docs/eip-8250.md` says its own txpool admits several pending keyed transactions from one sender when their key sets are disjoint. Scene 1's "public mempool holds one per sender" may not reproduce through `eth_sendRawTransaction`: probe it before building the scene**
- [x] Additional finding, verify-frame costs (ethrex source): **frame entry 100 (sender warm), the proxy's DELEGATECALL to a cold implementation 3,000, cold SLOAD 2,100, the fresh key's 20,000 inside APPROVE; the expiry frame pays a 3,000 cold-target entry charge from its own limit. Measured on the deployed account: cold 30,677, hybrid cold 30,798, hot 37,300, all before any hashing**
- [x] Additional finding, relay: **from about 23:40 IST on Nov 5 the gateway admitted frame transactions but never relayed them (status New until expiry, unknown to the miner; `skandha_explorer_peers` empty on both). Submitting to the miner's own sidecar at `altmempool.forshtat.com/rpc` works (New, Submitted, OnChain in about 28 s); the pipeline switches with `WL_GATEWAY_URL`. Report it in the event Discord**
- [x] Additional finding, chain halt: **the devnet stopped producing blocks at block 408,262 (timestamp 2026-11-05 22:58:46 UTC, 04:28 IST Nov 6). Still stopped at 05:56 IST: the node, the miner's sidecar and the gateway all answer that head, and devnet1/2/3 and gateway1 still refuse TLS. The host clock was checked against time.apple.com (offset under 1 ms). The pipeline refuses to send while the head's timestamp is more than 60 s from the host clock, so nothing was sent and no leaf was used. Report it in the event Discord**
- [x] A standalone Yul object with verbatim compiles under our toolchain and its TXPARAM read executes on the devnet; otherwise the solc fork, otherwise the helper contracts → **yes, no fork or helpers needed (Nov 6, block 405,590). solc 0.8.38 (installed by Foundry's svm at `~/Library/Application Support/svm/0.8.38/solc-0.8.38`), `solc --strict-assembly --optimize --bin <file>.yul`, default EVM version (emits PUSH0; the devnet runs it). Wrappers, first verbatim argument on top: `txparam(p)` = `verbatim_1i_1o(hex"b0", p)`; `frameparam(param, frame)` = `verbatim_2i_1o(hex"b3", frame, param)`; `sigparam(param, sig)` = `verbatim_2i_1o(hex"b4", sig, param)`; `sigdatacopy(mem, data, len, sig)` = `verbatim_4i_0o(hex"b5", mem, data, len, sig)`; `approve(scope)` = `verbatim_3i_0o(hex"aa", 0, 0, scope)`. A hybrid tx (owner ECDSA + 2,594-byte entry) passed 14 checks in the VERIFY frame, including SIGDATACOPY of the whole entry, for 1,379 gas besides the 20,000 key cost; 7 of 7 logged values matched. Probe: `~/Documents/winterlock-probes/yul/probe.yul`**
- [x] ORIGIN, TLOAD, TSTORE and CALLCODE absent from the proxy and implementation bytecode → **absent (Nov 6, `cast disassemble` of `account/build/Account.bin` at main `cbba437`: 1,992 instructions, none of ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT). The 45-byte proxy uses only CALLDATASIZE, CALLDATACOPY, RETURNDATASIZE, RETURNDATACOPY, PUSH1, PUSH20, DUP1, DUP3, SWAP1, SWAP2, GAS, DELEGATECALL, JUMPI, JUMPDEST, RETURN and REVERT; its GAS comes right before DELEGATECALL, which the tracer accepted (Day-0 DELEGATECALL probe)**
- [ ] Stake flow tried once: addStake on the NaiveStakingRegistry with 0.01 ETH from the account, in case a staked scene is needed
- [ ] A fresh master seed for this deployment, the genesis hash stored beside it; a new seed after any devnet reset → **genesis of chain 1337 on Nov 6: `0x196a1589ac71e2f305b1fbc7bfd23e55367f9fd6eb9da97e2f572c2791e17bbc`. `pipeline/src/genesis.ts` pins it in `<seed file>.chain.json` and refuses to sign on any other genesis. The seed itself waits for the hashsig CLI**
- [ ] Recent roots: eth\_getCode at the devnet's RECENT\_ROOT\_ADDRESS (0x…8272 per the sidecar readme, 0x8272D9679689Ea2f307140CdF9002D27dC00Ffff per the EIP) is non-empty, and a 64-byte write salt ‖ root from the account is referenceable in the next slot → **code: 144 bytes at `0x…8272`, none at the EIP address. Write-and-reference not tried yet**
- [ ] Recent roots: can the verify frame read the transaction's references? Try TXPARAM selectors above 0x10 and FRAMEDATACOPY of a leading recent-root frame; if neither works, ask Alex and Pierre, and hold Level B until it does → **likely yes, not yet run by us: the sidecar's own e2e account (`test/e2e/sharedSenderPool.ts`) reads reference 0's source\_id in its VERIFY frame with `RECENTROOTREFLOAD` (0xb6, inputs index and field)**
- [x] Additional finding, nonce keys: **NONCE\_MANAGER has 5 bytes of code (`revert(0,0)`) at `0x…8250`, none at the EIP address. A key's first use costs 20,000 execution gas inside the VERIFY frame of a contract account (20,170 at seq 0 against 170 at seq 1, same tx otherwise), so with the 90k verify limit about 67k is left for WOTS and the path after the key and the proxy. An EOA's receipt shows 100 for its verify frame either way**
- [x] Additional finding, simulation: **`ethrex_simulateFrameTransaction` on the devnet returns `canonicalMempoolValid` and `canonicalMempoolViolation`, not the `valid` and `violation` the sidecar's devnet-readme names; the field reports the public mempool's verdict, which the canonical-versus-alt scene can show directly**
- [x] Additional finding, historical state (Nov 6, head about 407,500): **the node serves real state for about the last 126 blocks only. For an older block number, `eth_getStorageAt`, `eth_getBalance` and `eth_getCode` silently answer with the latest state, with no error: block 400,000 shows account 1's code, which did not exist then (EIP-4788 ring-slot check, and the nonce key of tx 0x38b51a31 reading 1 at block 407,106, before it landed). The pipeline decides inclusion and expiry from the nonce manager two blocks below the head, inside the window; even a fallback to latest state cannot fake an expiry, since a used key never becomes unused**
- [x] Additional finding, signing: **an ARBITRARY signature entry (signer and msg empty) is accepted and costs 100 gas toward the prefix cap; TXPARAM(0x08) on chain equals the vendored codec's `computeSigHash` (checked on two txs), so the WOTS message is exactly that value**
- [ ] Recent roots: a reference to a slot older than 8,191 is refused with the explorer's recent-root rule, and the sidecar's per-block eviction of expiring references is confirmed in its code, since the window cannot be waited out

## Trade-offs and risks

Judges require that we explain trade-offs. This table goes into the README verbatim.

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

**Risks and mitigations.**

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Yul verifier disagrees with the Rust signer on some messages | Medium | Vector file with edge leaves and mutations is the first test; Quip's verifier as oracle on the WOTS+ layer |
| Sidecar nonce encoding differs from the EIP | High | Day-0 check 2; the builder has one function that encodes nonce fields |
| A declared prefix sum above 100k is rejected by the published sidecar (flat cap, no staked branch) | High | Grind and declare at most 90k; expiry at 5k; staked fallback (0.01 ETH, no delay on the devnet); ask which budget rules the hackathon devnets run |
| Devnet reset mid-event | Medium | Scripted deploy from a clean state in under five minutes |
| Expiry verifier not deployed on the devnet | Low | Drop the expiry frame and document the policy as client-side timeout only |
| The single-use sentinel is rejected by the devnet client | Certain | Fresh key at sequence 0; the account requires TXPARAM(0x01) == 0 |
| Judges ask why not just a bitmap in a SENDER frame | Certain | Answer: a write after approval cannot stop two pending txs with the same leaf across lanes; the nonce can |
| A stolen hot device spends its remaining tickets | By design | Exposure is tickets times (value cap plus fee cap); keep the count small; the cold side sets the cap to zero or rotates |
| Signer asked to sign for a chain not in its keygen list | Low | The CLI returns bad\_chain; the verifier rejects a leaf hashed for another chain id |
| This spec counts as pre-existing design under the ETHGlobal Classic rules | Certain | Disclose it in writing to ETHGlobal before kick-off and in the submission; commit from hour 0; keep the history |
| A devnet reset replays leaf 0 with the same seed | Medium | Fresh master seed per deployment; store the genesis hash beside the seed and refuse to sign if it changes |
| Vanilla solc cannot emit the EIP-8141 opcodes | Certain | Standalone Yul with verbatim, else the community solc fork, else the workshop's helper contracts (then the account nonce starts at 8) |
| The latest EIP texts and the devnet revision disagree (fees, signature hash, nonce encoding, first-use cost, addresses) | Certain | Pin the sidecar codec and the ethrex notes; a native-signature probe transaction before the first hash-signed one |

## Feature levels

Level A is the floor shown to the judges, Level B moves the result, Level C is engineering prowess. The Nov 3 review moved admission reports, the Day-0 probe table, grinding and the security argument into Level A, and cut the canary, the ECDSA-only path and the EOA upgrade.

| Level A, Friday night | Owner | Done means |
| --- | --- | --- |
| Day-0 probe table | both | the devnet table in Review findings filled with measured values, copied into the README |
| Rust signer and CLI | Author | keygen, sign, verify, export-leaves, vectors; the oracle test passes against Quip's WOTSPlus.sol and against our Yul |
| Account contract | Author | Yul verify path with keyed mode, bands, chain slots and hot policy; proxy and factory; measured gas |
| Signer-side grinding | Author | declared verify limit at most 90k on every message |
| Pipeline and backend | Vicky | vendored codec, two-pass signing, gateway submit, status, receipt, explorer link, journal; thin API and panel |
| Admission reports | Vicky | the simulate-with-trace report shown for every transaction |
| Demo scenes 1 to 4 | both | creation, keyed lanes beside the public mempool's one-per-sender, expiry on a fresh key, gas gauge |
| Submission pack | both | README with claim, prior art, trade-offs, four-column gas table, CROPS section, licence; the disclosure sent; the video |

| Level B, Saturday noon | Owner | Why |
| --- | --- | --- |
| Hot tickets | both | the headline feature: exported ticket file, caps, the refusal scene |
| Use-case screens | Vicky | hot and cold, agent, session: three screens on one lane board, repo version written after kick-off from the Nov 4 prototypes |
| Recent-root hot authority | Author | the hot band signs only while a root the cold device published is inside the 8,191-slot window; the agent screen's countdown becomes real; depends on the Day-0 probe that the verify frame can read the references |
| Lanes at scale | Vicky | 8 to 16 pending at once, all admitted, reports on screen |
| Filed findings | Author | the Day-0 divergences filed on the sidecar or ethrex repositories (area 3 of the track) |
| Staked scene | Author | one addStake frame, only if a budget scene needs it |
| MetaMask Snap | Vicky | only if everything above is live by Saturday morning; otherwise cut |

| Level C, Saturday afternoon | Owner |
| --- | --- |
| Gas-versus-digits chart from the traces | Author |
| One-page security argument in the README | Author |
| Differential rig across Rust, Yul and Quip on thousands of messages | Author |
| w = 64 as a staked-tier exhibit | Author |
| Certified hypertree: top tree certifies subtrees on the certification nonce key, rotation without invalidating pending lanes, hot subtrees published as recent roots | Author |

Cut: quantum canary, ECDSA-only path, in-place EOA upgrade, native multisig, leaf hash as nonce key, stateless-signer demo, SPHINCS fallback, ERC-1271 messages, lattice schemes, EIP-8288 aggregation, a browser extension.

## Work split and milestones

**Superseded on Nov 4.** Only Vicky is a registered hacker, so the owners and hours below no longer hold. The current split, by person and by hour, is on the tab Technical plan (Nov 4–7): Author publishes a generic signature library before Thursday 21:00 IST, Vicky builds the account, pipeline, backend, screens and demos during the event on the Extend Open Source track. The deliverables below still describe what gets built.

Two people, two lanes, one shared vector file. The author owns everything that touches a secret or a byte layout; Vicky owns everything that touches the network or a user. Project code is written only during the event; before the whistle we read, install tooling, run the workshop steps and finish this spec.

| Area | Owner | Deliverables |
| --- | --- | --- |
| Rust signer crate and CLI | Author | wots, derive, tree, entry, vectors, CLI; vector file for h = 10 |
| Account and factory contracts | Author | Solidity plus Yul verify frame, Foundry tests on the vectors, oracle test against WOTSPlus.sol, gas report |
| Cryptographic review and README design section | Author | Trade-offs table, security level, prior-art table |
| Pipeline library | Vicky | codec vendoring, builder, two-pass signer, rpc, submit, leaves store |
| Backend and frontend | Vicky | API from Shared interfaces, one-page UI, persistence |
| Demo scripts and the admission-report view | Vicky | four demo scripts, watcher |
| Day-0 checks | Both, first two hours | results written into this doc |
| Demo video and submission | Both, last four hours |  |

&#91;embedded content: 36 hours in four phases, two lanes, three gates\]

Phases are equal bands, not to scale. The diamonds are the gates from the milestone list; the qualifying transaction sits inside phase two at hour 10.

**Milestones that gate each other.**

1. Hour 2: Day-0 answers written down. Nothing below starts until the nonce encoding and the selector numbers are confirmed.
2. Hour 6: Vector file exists and the oracle test passes against Quip's verifier. Vicky's signer module can now be tested against real entries.
3. Hour 10: Account deployed on devnet1 through a deploy frame; a legacy-mode hash-signed transfer is OnChain. Explorer link into the README. This is the qualification milestone.
4. Hour 16: Single-use keyed lanes and the expiry path work end to end. Frontend shows the wallet panel.
5. Hour 22: Hot tickets and the demo scripts run clean twice in a row.
6. Hour 28: README complete, including CROPS section. Feature freeze.
7. Hour 32: Demo video recorded. Remaining time is rehearsal of the judge walkthrough and buffer.

If milestone 3 slips past hour 14, cut hot tickets and the gas gauge; keyed transfers with admission reports alone still qualify.

## Open questions for Vicky and reviewers

Answer in comments on this doc. Each one changes code, so settle them before hour 2.

- [ ] Disclose this spec and the three Nov 4 UI prototypes to ETHGlobal as pre-existing design before kick-off, as the rules require. Who sends it, and when?
- [ ] Hybrid co-signer on by default for cold transactions?
- [ ] Tree height 10 or 12 for the demo?
- [ ] Hot band size for the demo: 8, 16 or 64 tickets?
- [ ] MetaMask Snap: Level B only after Level A is live on Saturday morning, or cut now?
- [ ] Accept the single-use sentinel as well if Day 0 shows the devnet supports it, or sequence 0 only?
- [ ] CLI shelled out or WebAssembly? WebAssembly only matters if the Snap stays.
- [ ] Who records the video and who drives the terminal during judging?
- [ ] Reviewer question: is there any read in the verify algorithm that the devnet tracer would reject, which we have missed?
- [ ] Reviewer question: is there any way to reach one leaf through two different nonce keys, or through a rotation, that the generation and band rules do not close?
- [ ] Which use-case screen leads the video: hot and cold, or the agent?
- [ ] Hot authority: publish A from setHotPolicy automatically, or only from an explicit renewHot()?
- [ ] Hypertree: subtrees per chain, s = 2 or s = 4, and whether subtrees are built lazily at certification time

## References

All pages were opened on 2026-11-01 and the facts above come from their text, not from summaries.

- [ETHGlobal Mumbai: Ethereum Foundation prizes](https://ethglobal.com/events/mumbai/prizes/ethereum-foundation)
- [EIP-8141: Frame Transaction](https://eips.ethereum.org/EIPS/eip-8141)
- [EIP-8250: Keyed Nonces for Frame Transactions](https://eips.ethereum.org/EIPS/eip-8250)
- [EIP-8272: Recent Roots for Frame Transactions](https://eips.ethereum.org/EIPS/eip-8272)
- [Alt mempool docs (ERC-8421)](https://docs.altmempool.wtf/) and [rules](https://docs.altmempool.wtf/rules/)
- [Alt mempool starter page](https://www.altmempool.wtf/)
- [Mempool workshop sidecar (ethrex fork, RPC, codec)](https://github.com/forshtat/mempool-workshop-sidecar)
- [Mempool workshop tutorial](https://github.com/forshtat/mempool-workshop)
- [ethrex EIP-8141 tracer branch](https://github.com/forshtat/ethrex/tree/eip8141-tracer)
- [Quip Network hashsigs-solidity (WOTS+ normative format)](https://github.com/quipnetwork/hashsigs-solidity)
- [Quip Network ethereum-sdk (production wallet, invariants, deployments)](https://github.com/QuipNetwork/ethereum-sdk)
- [Skale xmss-solidity](https://github.com/skalenetwork/xmss-solidity)
- [OpenZeppelin community XMSS draft PR #301](https://github.com/OpenZeppelin/openzeppelin-community-contracts/pull/301)
- [poqeth: efficient post-quantum signature verification on Ethereum](https://eprint.iacr.org/2025/091.pdf)
- [pq-dksap proof of concept](https://github.com/ivanmmurciaua/pq-dksap)
- [QuantumCanary Solidity concept repo](https://github.com/identity-md-launches/launch-1213-src-quantumcanary-sol)
- [RFC 8391: XMSS](https://datatracker.ietf.org/doc/html/rfc8391)
- [EF Mandate blog post (CROPS)](https://blog.ethereum.org/2026/03/13/ef-mandate)
- [Ethereum post-quantum hub](https://pq.ethereum.org/)
- Winterlock proposal on the Safe forum: forum.safefoundation.org/t/post-quantum-owners-for-safe-hash-based-signers-winterlock/7165
- NiceTry and ephemeral keys on frame transactions: ethresear.ch/t/24273 and ethresear.ch/t/24526 (RivaLabs, Solvency-Labs/NiceTry)
- ERC-8421 draft text: github.com/ethereum/ERCs/pull/2028; discussion ethereum-magicians.org/t/29800
- Workshop repository with the devnet pins: github.com/forshtat/mempool-workshop; sidecar: github.com/forshtat/mempool-workshop-sidecar (codec at packages/executor/src/services/FrameTxService/codec.ts, prefix rules at packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts)
- ethrex EIP-8250 implementation notes: github.com/forshtat/ethrex/blob/eip8141-tracer/docs/eip-8250.md; the devnet-pinned EIP-8250 revision: github.com/ethereum/EIPs/blob/81b976ac01591fed2eecb73fa574f27cd18db2e8/EIPS/eip-8250.md
- EIP-8037 state gas pricing; EIP-7976 calldata floor; EIP-8310 post-quantum keystore
- ETHGlobal rules on pre-existing work: ethglobal.com/rules; the EF prize page: ethglobal.com/events/mumbai/prizes/ethereum-foundation

Team reading and watching thread for Nov 2 to 5: Prep thread (Nov 2–5)
