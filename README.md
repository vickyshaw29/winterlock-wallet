# winterlock-wallet

PQ Wallet using ERC-8250 (Keyed Nonce) and EIP-8141 (Alt-Mempool).

## Devnet evidence

The explorer keeps its history in memory and loses it on restart, so every link below also has its hash and block.

| What | Transaction | Block |
| --- | --- | --- |
| Pipeline smoke test (V2): built, signed and sent by `pipeline/`, keyed nonce `0x200000001` at sequence 0, leading expiry frame, test EOA with native ECDSA | [`0x31cc7937…2464af`](https://explorer.altmempool.wtf/tx/0x31cc7937cb5d7ba3f48e1f7e5b75ee6070ff34f8396a4685e87b866cee2464af) | 405,073 |

Devnet: chain 1337, node `altmempool.forshtat.com`, gateway `altmempoolgateway.forshtat.com/rpc`.

## AI attribution

Vicky drives every AI tool and authors every commit. Files written with Claude Code (Anthropic), reviewed and run by Vicky:

- Scaffolding in commit `3b5fe45` ("boilerplate using claude"): the initial `backend/`, `contracts/`, `demo/`, `pipeline/` (a Rust stub, replaced by the TypeScript pipeline in V2), `signer/` and `web/` stubs, the root `.gitignore` and the submodule setup.
- `pipeline/src/config.ts`, `rpc.ts`, `builder.ts`, `signer.ts`, `leaves.ts`, `submit.ts`, `index.ts`
- `pipeline/test/codec.test.ts`, `builder.test.ts`, `leaves.test.ts`, `signer.test.ts`, and `pipeline/test/fixtures/devnet-sighash.json` (two devnet transactions and their on-chain sig hashes, fetched by a Claude-written script)
- `pipeline/scripts/smoke.ts`, `pipeline/package.json`, `pipeline/.gitignore` (`pipeline/tsconfig.json` is a copy of `demo/tsconfig.json`)

Not written by us: `pipeline/src/codec/codec.ts` and `pipeline/src/codec/FrameTx.ts` are copied from [mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar) at commit `2e22ff0a`, MIT, Copyright (c) 2023 Etherspot; Claude Code added only the header comments and changed one import path.
