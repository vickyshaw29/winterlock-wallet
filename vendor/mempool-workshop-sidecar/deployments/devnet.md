# Devnet deployments

Real mainnet contracts, deployed onto the public EIP-8141 devnet
(`https://altmempool.forshtat.com`, chain ID `1337`) by replaying their original mainnet
deployment transactions — not imitations, not a mock ABI. This is the canonical record of what
is live there and where it came from. Full usage docs: [devnet-readme.md](../deploy/devnet/devnet-readme.md)
(connecting, RPC endpoints) and [deploy/predeploy/README.md](../deploy/predeploy/README.md) (the
tool that did this, and how to add a protocol or restore the library after a devnet restart).

## How this works

[`deploy/predeploy/`](../deploy/predeploy/) is a standalone tool that fetches a protocol's real
deployment transaction(s) from Etherscan and replays them onto the devnet from a dedicated
deployer key, rewriting any mainnet contract addresses it references to their devnet
counterparts. A fresh chain plus a fixed deployment order gives every contract the same address
every time. Design: [2026-09-21-devnet-predeploy-design.md](../docs/superpowers/specs/2026-09-21-devnet-predeploy-design.md).
Build: PR #2 in the former `forshtat/framepool` repository (this repository starts from a squashed history, so the PR is not carried over).

## Canonical addresses

The devnet was reset to a fresh genesis on 2026-10-08 and every protocol below was replayed with
`deploy/predeploy` in one `run --all`. The replay only changed addresses that depend on the
deployer's earlier nonce history: Railgun (proxy, implementation and both Poseidon libraries),
Universal Router and the staking registry. The rest are unchanged. State that was not part of the
predeploys is gone: the WETH9 / USDC pool and its liquidity position, and the Tornado Cash
deposits and withdrawals from the liveness checks below. The transaction hashes in those sections
describe the earlier chain.

| Protocol | Address | Notes |
|---|---|---|
| LINK (Chainlink token) | `0x7BF399a347FC0757e668058f11D3B696932353e4` | 1,000,000,000 LINK, all held by the deployer. Runtime bytecode identical to mainnet's. |
| USDT (Tether) | `0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9` | 6 decimals. 1,000,000,000 USDT minted to the deployer, who owns the token and can mint more with `issue(amount)`. Deployment needed 22.4M gas — this devnet accepts transactions above the usual 16.7M per-transaction cap. Bytecode identical to mainnet's. |
| BAYC (Bored Ape Yacht Club) | `0x4F07c6E07C502f43373E5ecb42adBb92b41e192d` | Mainnet deploys with the sale closed; an extra step opens it, so `mintApe(n)` works (0.08 ETH per ape, 10,000 max). Bytecode identical to mainnet's. |
| Tornado Cash (0.1 ETH pool) | `0xF8d72424D07721aB219cdbd2852657F3301673fC` | Replayed exactly as originally deployed (Dec 2019) — before a later governance-only verifier swap and operator renouncement. Deposits and withdrawals work identically to the current mainnet pool; the difference is only in the admin-only `updateVerifier`/`changeOperator` functions, whose key (the real historical Tornado deployer's) nobody here controls either way. Depends on its own Hasher (`0x4500a5B572903a1DE1615d13A366cF2B324675E2`) and Verifier (`0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01`), also predeployed. |
| USDC | `0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5` | Full current version (FiatTokenV2_2 — permit/EIP-3009 support), deployed the way mainnet's own upgrade history actually happened: the original 2018 proxy and implementation deployed and genuinely upgraded, not a shortcut. 1,000,000,000 USDC minted to the deployer, who holds every role (`masterMinter`/`pauser`/`blacklister`/`owner`) and can mint more with `configureMinter`/`mint`. The proxy's own admin role was renounced to a burn address after the upgrade — a real transparent-proxy requirement, not optional (see the tool's `usdc.ts` for why). Bytecode identical to mainnet's. |
| WETH9 | `0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6` | Canonical, unmodified WETH9. No premint — wrap real devnet ETH with `deposit()`. Bytecode identical to mainnet's. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | **The real mainnet address**, not a devnet-only one — the first contract this tool has landed at its actual mainnet address, because its deployment goes through Arachnid's deterministic CREATE2 proxy, which is already at the same address in this devnet's genesis. `DOMAIN_SEPARATOR` legitimately differs from mainnet's own (it is computed from `block.chainid` and baked in as an immutable), which is the *correct* behavior for signatures against this instance, not a defect. |
| Uniswap v4 PoolManager | `0x6bF9Aa9c04fd001385742d61f6818C3236429848` | Deployed through the real `UniswapV4DeployerCompetition` contract mainnet actually used (also predeployed, at `0x0dB99C0cf58da6eA5924c11e7f37b63f7764fAb9`), whose `deploy()` enforces the exact real PoolManager bytecode by hash. Does **not** land at mainnet's real vanity address (`0x000000000004444c5dc75cB358380D2e3dE08A90`) — that address came from a winning salt only the real competition organizer ever held; this devnet copy deploys with a zero salt instead, landing at an address specific to this devnet's own factory instance. `owner` (protocol-fee administration only, never needed for ordinary pool use) is baked into the bytecode as the real mainnet Uniswap governance address; nobody here controls it. |
| Railgun (shielded-pool contracts) | `0x06a7dfbc3b95dcdfeca1c2cf8dbb0c8fdb194213` | Full `RailgunSmartWallet` behind its real `PausableUpgradableProxy`, all 91 real Groth16 verifying keys registered (one per `(nullifiers, commitments)` circuit shape, `(1,1)` through `(13,1)`/`(1,13)`) — every `getVerificationKey` call reads back byte-identical to mainnet's. Real fees: 0.25% shield, 0.25% unshield. Depends on two Poseidon hashing libraries (unverified generated bytecode, same class of dependency as Tornado's Hasher): PoseidonT3 (`0xc7b570ae47857f326925199a9bdbf46504feca59`, 2-input, used by the Merkle tree logic) and PoseidonT4 (`0xc41a355ff69c03b6e267f6334b4e13372a4a597c`, 3-input, used by `shield()`'s note commitment hash — found live via a real `shield()` call). A real shield followed by a real private unshield (`transact()`, a genuine Groth16 proof against Railgun's own circuits) has been proven end-to-end; see [Liveness verification](#liveness-verification). Unlike USDC's proxy, this one never blocks its own admin from reaching the implementation — no renouncement dance needed — but it does gate *every* non-proxy-native call (including the admin's) behind `notPaused`, so `unpause()` has to run before even the first initializer call. Deployer holds owner/admin/treasury throughout. |
| Uniswap v4 PositionManager | `0x5bF24B2CD6f4cc0057F4BeD53264d591620Af57B` | Real creation bytecode (identical to mainnet's, confirmed by code size), deployed through Arachnid's proxy like Permit2 — but with **fresh constructor arguments**, not a byte-for-byte replay: the real ones reference mainnet's PoolManager/WETH9 addresses, which this devnet's own copies don't share. `poolManager`/`permit2`/`WETH9` are re-encoded with our own devnet addresses (`permit2` happens to already be the real address either way); `tokenDescriptor` is left at its real, unreachable-here mainnet address (`0xd1428Ba554F4C8450b763a0B2040A4935c63f06C`) — it only serves NFT `tokenURI()` metadata rendering, nothing core to minting or managing positions. |
| Uniswap v4 StateView | `0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB` | Real creation bytecode, same CREATE2-via-Arachnid-proxy-with-fresh-args pattern, constructor is just `poolManager` (our devnet address). |
| Uniswap v4 Quoter (V4Quoter) | `0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D` | Same pattern as StateView. |
| Universal Router | `0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be` | Real creation bytecode (identical to mainnet's), a plain top-level creation (no CREATE2 factory) — its `poolManager`/`WETH9`/`v4PositionManager` constructor arguments are rewritten to our devnet addresses automatically by the engine's existing address map, no protocol-specific code needed. Its other constructor arguments — `v2Factory`, `v3Factory`, `v3NFTPositionManager`, and `SPOKE_POOL` (confirmed live to be Across Protocol's SpokePool, a cross-chain bridge contract from an unrelated ecosystem this router also integrates) — are real mainnet addresses with no devnet counterpart, left as-is. v4 swaps/quotes/liquidity all work; the router's legacy v2/v3 command paths and cross-chain bridging would revert, since those dependencies don't exist on this chain. |
| NaiveStakingRegistry (ERC-8421 `IStakingRegistry`) | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` | **Not a mainnet replay** — the only row in this table that isn't: ERC-8421 isn't live on any public network, so there is no real deployment to replay. Freshly-compiled, custom bytecode (`deploy/predeploy/src/protocols/staking-registry-deployment.ts`), no admin/owner — every function only ever touches `msg.sender`. The deploy step itself calls `addStake(86400)` with 0.001 ETH as a smoke test, so the deployer already holds a small stake. See [devnet-readme.md's walkthrough](../deploy/devnet/devnet-readme.md#testing-a-staked-entity-end-to-end) for how to stake/unstake an entity and see the effect on frame-transaction admission. |

Deployer (owns everything above except Uniswap v4's PoolManager `owner`; a published throwaway
key, never use it on a real network):

```
address:     0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0
private key: 0xcbb754e47d54ec3bf76954e8e4df02e68d1484c703e47d29f189e32904545191
```

Addresses are stable across a devnet restart as long as nothing else has sent from the deployer
key: it always starts at nonce 0 and the tool always deploys in the same order. `deploy/predeploy`
now guards this itself — it refuses to deploy if it detects the deployer's on-chain nonce moved
without its knowledge, rather than silently shifting every later address.

All six protocols originally scoped for this devnet expansion (Tornado Cash, USDC, Uniswap v4
core + periphery, Railgun) are now deployed. This file will gain a row per protocol, with its
address and notes, as more land.

## Pools

Unlike everything in the table above, a pool has no address or bytecode of its own — it's state
living inside the PoolManager singleton, identified by a pool ID (`keccak256` of its `PoolKey`).
The predeploy tool only deploys *infrastructure*; pools and their liquidity are created
separately, the same way a real user would (`PositionManager.initializePool` + `modifyLiquidities`
to mint a position). One is live today, created and funded live to confirm the whole v4 stack
(PoolManager/PositionManager/StateView/Quoter/Universal Router/Permit2/WETH9/USDC) actually
interoperates, not just that the bytecode matches mainnet's:

| Pool | Pool ID | Details |
|---|---|---|
| WETH9 / USDC | `0x784bd7879f8155eda79b7834d53c2f19ace60aed221fe33ef03ce660eff60648` | `currency0` WETH9 (`0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6`), `currency1` USDC (`0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5`), fee 3000 (0.3%), tick spacing 60, no hooks. Initialized at 1 WETH = 3000 USDC. Funded with a real liquidity position (deployer-owned, `PositionManager` token ID 1) covering ticks `-202260` to `-190260` (~1 WETH + ~3,003 USDC). Verified live end-to-end with a real swap through Universal Router (100 USDC → ~0.0329 WETH via its `V4_SWAP` command), which moved the pool's tick from `-196260` to `-196085` — real AMM state, not a static fixture. |

This pool (and any other pair a tester wants) can be recreated or extended the same way — there's
no predeploy step for it; it's ordinary contract usage against the infrastructure above.

## Liveness verification

Bytecode matching mainnet doesn't prove a contract's actual logic works end-to-end on this
devnet — the Uniswap v4 pool above and the Tornado Cash zk-SNARK withdrawal below were both
verified by performing the real operation live, not just by checking deployed code.

**Tornado Cash — full deposit + zero-knowledge withdrawal**, using the real, original v2.0
circuit and proving key (matching this pool's genuine 2019 verifying key, not the later
governance-updated one):
- Deposit: `0xa46d206c127730055c33960e7b38e913c2e9f8bb402d92a07a684050734b6f0f`
- Withdraw: `0x7b8a301737f805a9068ebf7ac43877e35d8a30163d25393e4b4a35eaccea0507` — a real Groth16
  proof, verified by the real deployed `Verifier` contract, paying out 0.1 ETH to a fresh,
  never-used address (not a same-account round trip — genuine anonymity-set withdrawal).
  Independently confirmed: recipient balance is exactly 0.1 ETH; `isSpent(nullifierHash)` is
  `true`.

Getting a real proof to verify took real debugging, worth recording: the published proving key
(`withdraw_proving_key.bin`, from tornado-core's own GitHub release) is only distributed in
`websnark`'s WASM-era binary format. `websnark`'s own WASM prover produces a proof that's
mathematically well-formed (a valid curve point) but cryptographically wrong — a real bug in that
2019, browser-era tool, not in this devnet. Reimplementing the proving step in pure JS
(`snarkjs`'s own prover) against a hand-parsed copy of the same key initially failed too, for a
different reason: the key's bulk point tables legitimately contain points at infinity (the
identity element) as real entries, and treating every entry as a normal affine point silently
corrupts them. That parsing was validated byte-for-byte (all ~145,000 entries, every array) against
[`websnark-rs`](https://github.com/Robert-MacWha/websnark-rs)'s independently-produced, known-good
JSON conversion of the same key format before it was trusted — the fix (detect a zero x-coordinate
as the point at infinity) made the real proof verify on the first try after that.

**Railgun — real shield, then a real private unshield (`transact()`)**, using
`@railgun-community/engine` (the real, actively-maintained Railgun SDK) directly for all note
construction, encryption, balance scanning, and Groth16 proof generation — no hand-rolled
cryptography:
- Shield: `0x1f34986efcc1c01d96b6a5bc36468f53a9b57a5bf6b3a539676089960c6fcbc1` — 100 USDC shielded
  (99.75 USDC net after the real 0.25% shield fee).
- Unshield: `0x055c755241b803611ca0ec826026e879bae2250b9b45b05db0b0891120a2947d` — a real Groth16
  proof (generated fresh against Railgun's real, IPFS-hosted circuit for the `(1,1)`
  nullifier/commitment shape, using modern `snarkjs`), verified by the real deployed
  implementation, unshielding the full 99.75 USDC private balance back out. Independently
  confirmed from the transaction's own events: `99.500625` USDC paid out (the unshield
  recipient) plus `0.249375` USDC fee (the treasury) — exactly `99.75 × 0.9975`, the real 0.25%
  unshield fee, both landing on the deployer since it holds both roles here. Re-running the same
  unshield correctly reverts with `"RailgunLogic: Note already spent"` — the contract's real
  nullifier double-spend protection, confirmed working.

Two real bugs surfaced getting there, neither in the SDK or this devnet's execution client:
- A missing predeploy dependency: `shield()` delegatecalls into a second Poseidon hashing library
  (3-input, distinct from the 2-input one `initializeRailgunLogic` needed for the Merkle tree) to
  compute the note's commitment hash, and it had never been predeployed. Found live via
  `debug_traceCall` (the same technique that found the first missing Poseidon library earlier),
  fixed by predeploying it (`PoseidonT4`, see the table above) and patching its address into the
  implementation's init code, then a `--force` redeploy of the whole protocol (91 verification
  keys included, no gas-price drama this time thanks to the ceiling fix below).
- A key-derivation mistake in this session's own shield script (not the SDK): it derived
  spending/viewing keys via `WalletNode.fromMnemonic(mnemonic)` directly, but Railgun's real
  wallets derive them via `deriveNodes(mnemonic, index)`, which uses *separate* derivation paths
  for spending vs. viewing - a real, non-obvious pitfall. A note shielded with the wrong
  derivation is encrypted for a key no correctly-derived wallet, including a real one, can ever
  read - not a devnet-specific problem, a genuine correctness trap in ad hoc SDK usage. Caught
  when a freshly, correctly-derived wallet couldn't decrypt its own just-shielded note; fixed by
  switching to `deriveNodes`; the original mis-shielded 99.75 USDC is now permanently orphaned in
  the proxy (harmless on a throwaway devnet, and it's exactly why the live proxy balance shown in
  the table above doesn't net to zero after the unshield above - two shields went in, only the
  correctly-keyed one could ever come back out - the proxy's live USDC balance is 99.75 USDC,
  not zero, for exactly this reason).

**Uniswap v4 — WETH9/USDC pool**: see [Pools](#pools) above.

## Engine capabilities added along the way

- **`patches`** (added for Tornado Cash): byte-replaces a mainnet address literal baked directly
  into a contract's init code — as opposed to `argWords`/the constructor-argument rewrite, which
  only ever touch ABI-encoded constructor arguments. Needed because Tornado's pool references its
  Hasher as a compile-time bytecode constant (pre-`immutable` Solidity), not a constructor
  parameter. See `deploy/predeploy/src/address-map.ts`'s `patch()` method.
- **Graceful fallback for an unverified Etherscan source** (also for Tornado Cash: its Hasher
  isn't verified): `fetch` now treats the whole creation input as init code with no constructor
  arguments, rather than failing outright.
- **No new step kind needed for USDC.** The originally-assumed `call` step kind (replaying a
  historical mainnet call transaction byte-for-byte) turned out to be unnecessary: the existing
  `custom` step, combined with `ctx.address()`'s runtime resolution of an earlier step's devnet
  address, already covers "deploy the real proxy and implementation, then call the real upgrade
  and initializer functions fresh, with our own values" — the same pattern BAYC's `open-sale`
  step established. Also surfaced a real transparent-proxy trap worth knowing for any future
  upgradeable-proxy protocol: the proxy's admin cannot call the implementation through it at all
  (confirmed live: `Cannot call fallback function from the proxy admin`), and once admin is
  renounced, `implementation()`/`admin()` can no longer be read correctly by anyone either. See
  `deploy/predeploy/src/protocols/usdc.ts`'s class doc comment.
- **`ctx.record`** (added for Uniswap v4's Permit2 and PoolManager, both deployed via a CREATE2
  factory rather than a plain creation): lets a `custom` step register a devnet address it
  computed some other way — a receipt never carries a `contractAddress` for a contract created
  internally via CREATE2, only for the outermost creation. Confirmed by reproducing Permit2's
  real mainnet address exactly from its real historical salt and bytecode, using viem's
  `getContractAddress`. See `deploy/predeploy/src/types.ts`'s `StepContext.record`.
- **Gas-price ceiling** (found deploying Railgun's 91 verification keys): the devnet's
  `eth_gasPrice` turned out to be reactive to recently-paid prices, not the chain's real EIP-1559
  base fee (which stayed a flat 7 wei throughout). This tool's own policy of paying
  `2 * eth_gasPrice` fed back into that same quote, driving it from ~2 gwei to over 33,000 gwei
  within a single run and repeatedly exhausting the deployer's balance — a self-inflicted runaway,
  not real congestion. `planGasPrice` now takes a hard ceiling (`GAS_PRICE_CEILING_WEI`, 200 gwei —
  still ~28,000x the real base fee) so a poisoned oracle can no longer compound without bound. See
  `deploy/predeploy/src/gas.ts` and `src/config.ts`.
- **No new mechanism needed for Uniswap v4's periphery** (PositionManager/StateView/Quoter/
  Universal Router): existing capabilities combined in a new way. The three CREATE2-via-Arachnid
  contracts reuse Permit2's pattern, but — unlike Permit2 — do take constructor arguments that
  reference mainnet addresses this devnet doesn't share (PoolManager/WETH9), so instead of
  replaying real trailing constructor-argument bytes verbatim, only the (address-independent)
  init code is predeployed and fresh arguments are ABI-encoded at deploy time from `ctx.address()`
  lookups. Universal Router is a plain `create` step whose constructor arguments the engine's
  existing automatic address rewriting already handles with zero protocol-specific code, as long
  as it deploys after PositionManager in the same protocol (so PositionManager's mainnet→devnet
  mapping already exists when Universal Router's own arguments get rewritten).
