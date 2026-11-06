# Design

Part of the [Winterlock README](../README.md). The verify frame line by line, hot tickets, the co-signature, chain slots, rotation, where the build differs from the design document, and the pipeline in a browser or a Snap.


## Keyed only

Every hash-signed transaction carries exactly one nonce key at sequence 0. The verify frame refuses everything else:
another key count (`Account.yul:55`), the legacy key 0 (`:57`), a non-zero sequence (`:58`), another epoch (`:59`), a
leaf outside the tree (`:61`).

There is no sequential mode. An expired transaction leaves a sequential nonce unchanged, so the retry would re-sign the
same leaf. A fresh key at sequence 0 can be burned instead.

Accounts are created by an EOA calling the factory (`account/src/Factory.sol`, `createAccount`). A deploy frame would
need about 546,000 state gas, above the devnet's 500,000 state cap, and would use the legacy nonce `[0]`, which the
verify frame refuses. Creating an account from the EOA measured 953,678 gas, with six storage slots written.

## The verify frame, step by step

The account is a 45-byte EIP-1167 proxy to one implementation, a standalone Yul object (`account/yul/Account.yul`). The
EIP-8141 opcodes are emitted with `verbatim` (`Account.yul:37-41`). Their operand orders come from the ethrex source at
the devnet's commit, and were confirmed on chain ([Day-0 results](devnet-evidence.md#day-0-results)). `account/scripts/build.sh` splices the
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

Inside the hash-based check (`account/yul/hashsig/HashSigVerify.yul`):

- index = (slot << h) | leaf (`:23`); per-leaf public seed P = keccak256(treeSeed ‖ uint32(index)) (`:32-36`).
- 15 randomization elements r_k = keccak256(0x03 ‖ P ‖ uint16(k)), k = 1 to 15, as in Quip's `WOTSPlus.sol` (`:39-46`).
- 64 message digits plus 3 checksum digits; each chain runs 15 − digit steps of keccak256(x XOR r) (`:50-68`). The step
  loop is unrolled by the bits of the step count (`:74-102`). This is where the gas goes.
- leaf node = keccak256(P ‖ uint256(chainId) ‖ pkHash) (`:104-109`); h + 4 path hashes up to the root (`:111-120`).

Every refusal reverts with a 32-byte ASCII reason (`Account.yul:240`), such as `nonce: epoch` or `hot: value cap`. The
node's simulation returns it as `revertData`, so a refused transaction names the rule it broke.

What the verify frame reads, and why each read is allowed in a static frame: its own storage, TXPARAM, FRAMEPARAM,
SIGPARAM, SIGDATACOPY, CHAINID and memory. The verify path uses no TIMESTAMP, NUMBER, BALANCE, GAS or SSTORE, and
makes no CALL. The compiled implementation contains no ORIGIN, TLOAD, TSTORE, CALLCODE, BLOBHASH or SELFDESTRUCT. The
proxy's GAS right before its DELEGATECALL passes the devnet's tracer.

The signature entry is 2,594 bytes at h = 10: version (1) ‖ chain slot (1) ‖ WOTS+ signature (67 × 32 = 2,144) ‖ path
(14 × 32 = 448). It travels in the transaction's own signature list as scheme ARBITRARY, which costs 100 gas toward the
prefix cap. The leaf index is not in the entry: it comes from the nonce key.

## Hot tickets

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

## Hybrid co-signature: off

The account can require an owner ECDSA signature beside the hash-based one (`Account.yul:66-72`): scheme SECP256K1,
empty msg (so it signs the canonical hash, not just any digest), signer equal to the stored owner. It is off
(`hybridRequired = 0`), and the backend refuses to create a hybrid wallet. Turning it on costs 2,800 gas of signature
cost and 85 more billed bytes (a 20-byte signer and a 65-byte signature), 5,440 gas at the calldata floor (computed).

## Chain slots

One tree holds 16 chain slots of 2^h leaves. The same account address on two chains has two separate nonces, so
without slots, nonce 5 on two chains would sign two messages with one key. The chain id is hashed into every leaf from
CHAINID (`Account.yul:86`, `HashSigVerify.yul:104-109`), so a leaf built for one chain never verifies on another. The
slot byte only says where that chain's subtree sits (`HashSigVerify.yul:21-23`). Unlisted slots hold
EMPTY_SUBTREE = keccak256("nonce-bound-pq-wallet/empty-slot") (`pipeline/src/hashsig/tree.ts:11`). The demo lists one
chain, 1337, in slot 0.

## Rotation and admin calls

Admin calls are SENDER frames from the account to itself (`Account.yul:121-129`), signed by a cold leaf.

- `rotate(root, treeSeed, height)` installs a new tree and adds 1 to the epoch (`:133-147`). The new tree is built for
  generation = new epoch, so it shares no one-time key with the old one, and the installed tree is refused (`:139`).
  Rotation invalidates every pending lane, because their keys name the old epoch (`:59`), so the backend refuses to
  rotate while lanes are in flight.
- `setHotPolicy(hotStart, valueCap, feeCap, target)` (`:162-174`), with a guard that always leaves a cold leaf
  (`:236-238`).
- `setHybrid(bool)` refuses to turn on with no owner (`:153`); `setOwner(address)` refuses 0 while hybrid is on
  (`:180`).

## Differences from the design document

| The design says | The code does | Why |
| --- | --- | --- |
| WOTS+ randomization elements r[0..14] | r[1..15] (`HashSigVerify.yul:7,42`) | Quip's `WOTSPlus.sol` uses r[1..15], and the oracle tests pass |
| The vector file's `params.chains` | The Rust vector file writes `params.hashChains` | Not changed during the event |
| CLI `--seed` | No `--seed` flag: `--seed-file` or `PQ_SEED` only | The plan says never pass a seed as an argument, where process lists show it |
| `export-leaves` without a band | Needs `--hot-start` and refuses colder leaves | A ticket must be a hot leaf |
| `sign --ticket-file` with the tree flags | Refuses the tree flags | The ticket file carries them |
| `verify` prints `{ok: false, reason}` | Exits 1 with an error object | Not changed during the event |
| `vectors --seed --count` | Takes `--height`, `--chains` and `--out` only | Not changed during the event |
| A tree cache; sign under 50 ms warm | No cache: 0.36 s per signature from the seed at h = 10 | Not changed during the event |
| No WebAssembly | `signer-wasm/` exists, with tests but no build notes | Built early for a Snap; nothing uses it, because the pipeline and the Snap example sign in TypeScript |
| `hashsig_verify(entry, entryLen, msgHash, root, treeSeed, height, chainId)` | Takes the leaf too: `(…, height, leaf, chainId)` (`HashSigVerify.yul:15`) | The leaf comes from the nonce key, not from the entry |
| The demo's stuck payment is a low fee | A 4-second first deadline (`firstAttemptExpirySeconds: 4`, `retries: 1`) | On this devnet a fee below the 7-wei base fee is refused at admission and any fee above it is included, so a low fee cannot stick |
| 4 pending per lane, 64 per unstaked sender; eight lanes "in one or two blocks" | 1 per key, no per-sender cap for self-paying keyed lanes, at most 4 relayed per 10 s pass; "two or more blocks" | The devnet sidecar's real rules, from its code; 4 and 64 are the ERC-8421 draft's |
| Deployment by a deploy frame on the legacy nonce | An EOA calls the factory; the verify frame refuses `[0]` | A deploy frame needs about 546,000 state gas, over the 500,000 cap |
| Hybrid on by default | Off | The plan's default for the demo |
| At most four cold SLOADs | Three for a cold leaf, six for a hot leaf | The hot rules need slots 3 to 5 |
| A priority fee from the sidecar's quote | The quote raised to a 3 gwei floor (`WL_MIN_TIP_WEI`) | The sidecar relays the highest tip first, and its quote sat below other teams' fixed 2 gwei |

## Using the pipeline in a browser or a Snap

The pipeline has two entries. `@winterlock/pipeline` (`pipeline/src/index.ts`) is for Bun (its file journal locks with `bun:ffi`): the backend, the scripts and the tests use it, unchanged. `@winterlock/pipeline/core` (`pipeline/src/core.ts`) runs anywhere JavaScript runs, a browser page or a MetaMask Snap included: it builds frame transactions, grinds them to fit the 90k verify limit, signs them in two passes with the WOTS+ keyring, keeps the journal of exposed leaves, and sends and follows them, with no Node or Bun API, no `process` and no file system.

```ts
import { GRIND, Keyring, MemoryJournal, createPipeline, keyringSigner } from "@winterlock/pipeline/core";

const p = createPipeline({ chainId: 1337n, nodeUrl, gatewayUrl });  // its own network: nothing global, nothing from env
const signer = keyringSigner(new Keyring({ seed, generation: 0, height: 10, chains: [1337n] }));
const journal = MemoryJournal.open(stored, { wallet, chainId: 1337n, epoch: 0, height: 10, treeSeed: signer.treeSeed }, { store });
await p.sendKeyed({ journal, band: { from: 1, to: 1008 }, sender: wallet, calls, verifyGas: 90_000n,
  signatures: (leaf) => [{ kind: "hash", signer, leaf }], grind: GRIND.cold, preflight: true });
```

- `MemoryJournal` keeps the journal's rules (a leaf is handed out once, a missing journal is never recreated empty, statuses only move forward, one writer) and saves through a store the host gives it, such as a Snap's `snap_manageState`. Such a store is asynchronous, so the send path waits for it (`Journal.durable`) before a leaf signs and before a transaction leaves; a failed save stops it handing out leaves. The rules, and what a host must add (one journal instance for its whole life, a rotation after restoring an older copy), are listed in `pipeline/src/journal.ts`.
- Every path that reserves or settles leaves (`sendKeyed`, `estimateCalls`, `settleSubmitted`) refuses a journal of another chain or wallet, and a pipeline's node must answer its own chain id: with pipelines on several chains, one leaf must never sign on a chain whose journal does not know it.
- `bun run build` in `pipeline/` writes `dist/core.js` (one ES module, about 230 KB, viem and the hashes inside) and its type declarations in `dist/types/`. It refuses to finish if the bundle references a Node or Bun API, or if the core does not typecheck against browser types alone.
- Proof, in `pipeline/test/`: `core-bundle.test.ts` scans the browser bundle, then runs a bundled end-to-end scenario (keyring, grind, two-pass signature, a journal with an async store, a full send against a stand-in chain) under SES lockdown in a compartment with only a Snap's globals, and checks it signs the same bytes as in Bun. `package.test.ts` packs the package, installs it into an empty project, typechecks that project and runs it in plain Node (`dist/core.js`) and in Bun. `journal.test.ts` covers `MemoryJournal`, a store that fails, and pipelines side by side.
- `pipeline/examples/browser/`: `bun examples/browser/serve.ts`, then http://127.0.0.1:15190. The page builds a height-10 tree from a throwaway seed (about 2 s), grinds and signs a transfer, and checks the 2,594-byte entry against the root. Its Content-Security-Policy allows no connection, so nothing can be sent.
- `pipeline/examples/snap/`: an example MetaMask Snap, not a wallet. It takes its seed from `snap_getEntropy`, salted with an account nonce created at install (a reinstall gets a new tree, never the old one's leaves), keeps one journal in `snap_manageState`, handles requests one at a time, answers only `http://127.0.0.1:15190`, signs, and sends against a stand-in chain. On a real chain a send's follow phase can outlast MetaMask's 60 s request limit, so a real Snap would answer once the transaction is submitted and settle it in a later request. `bun run build` in `pipeline/`, then `bun install && npm test` in the example typechecks it, builds it with MetaMask's Snaps CLI (which also evaluates the bundle in its sandbox) and runs it in MetaMask's Snap simulator (`@metamask/snaps-jest`).
- Found while building it: a bare SES compartment throws on `Date.now()`. A Snap's `Date` works, so the SES test gives the compartment one, as MetaMask does. MetaMask's test stack (`@metamask/utils` 12, Oct 2026) ships ES-module-only packages that Jest 29 cannot require, so the example converts them with SWC (`test/esm-to-cjs.cjs`).
