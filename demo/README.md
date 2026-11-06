# demo

Scene scripts for the demo (plan, section 3). Each one drives the backend's HTTP API and prints the exact JSON it sent
(spec, demos). Written with Claude Code (AI) for Vicky.

## Parallel lanes: `lanes.ts`

Scene 1 of the demo script (0:45): many hash-signed transfers from one account at once, each on its own nonce key.
`plan` says what `n` lanes would hold of the wallet's balance and take to relay; `burst` checks that plan, sends the
`n` lanes at once, prints each lane as the backend answers it, follows every lane to its end, then prints the status
timelines, the most lanes seen pending at once, the blocks and seconds taken, each admission report, and the exact
JSON each lane sent.

```sh
export PATH="$HOME/.bun/bin:$PATH"
(cd backend && bun src/main.ts) &            # the backend holds the seeds and the journals, and makes every signature
cd demo
bun lanes.ts plan  --wallet 0x… --n 8
bun lanes.ts burst --wallet 0x… --n 8                    # the alt mempool (the sidecar)
bun lanes.ts burst --wallet 0x… --n 8 --mempool public   # the node's own pool: one pending per sender
bun lanes.ts burst --wallet 0x… --n 8 --json-out out/    # the sent JSON to files instead of the terminal
```

| Flag | Default | What |
| --- | --- | --- |
| `--wallet` | | The wallet's address, as `GET /api/wallets` lists it |
| `--n` | | Lanes sent at once, 1 to 64 |
| `--mode` | `keyed` | `keyed` (cold leaves) or `hot` (the wallet's tickets: cut some first with `POST /api/wallets/:address/tickets`) |
| `--value-wei` | `0` | Each lane's value, in wei |
| `--to` | the account's allowed target | Each lane's recipient |
| `--mempool` | `alt` | `burst` only: `alt` (the sidecar) or `public` (the node's own pool) |
| `--force` | | `burst` only: send even when the plan says the balance does not cover the lanes |
| `--json-out DIR` | | `burst` only: write each lane's sent JSON to `DIR/lane-<i>-<hash>.json` instead of printing it |

`WL_BACKEND_URL` names the backend (default `http://127.0.0.1:8787`). Exit codes: 0 done (whatever the lanes' outcomes,
a public-mempool refusal included), 1 when the plan or the backend refused, or the backend did not answer the plan, 2
for a usage error, 3 when a lane of the burst got no answer and no record of the wallet's accounts for it. A burst
that the plan finds unaffordable is not sent at all (nothing signed, no leaf used) unless `--force` is given.

A send whose answer is lost may still have been sent: the backend may have signed and submitted it before the
connection failed. Such a lane (no answer at all, an answer cut off, the backend's generic 500, or an answer that is not
the backend's) is printed as "no answer: may have been sent", never as not sent. After the sends, the burst reads
`GET /api/wallets/:address/txs` and takes in every record created since the burst began that no answer named (a lost
answer's lane, or another client's sent meanwhile): each is a "found" lane, followed and printed like the others,
admission report and sent JSON included, and counted apart. While a lost answer is not accounted for, the list is read
again at each poll, and for 10 s more once every other lane has ended. A lane still unaccounted for then is said so,
with exit 3: look at the wallet's records and the explorer before sending again, because its leaf may be spent.

What the numbers mean (backend/README.md, Parallel lanes): each lane holds its maximum gas cost plus its value against
the balance while it is pending, so the plan's set-aside is everything already pending plus `n` times an upper bound
for one lane. The sidecar relays at most 4 New lanes per pass, a pass every 10 s by default, so 8 lanes take at least
2 passes; the time to the last landing is an estimate, 28 s for one lane (measured Nov 5) plus 10 s per further pass.
The plan says when it assumed the sidecar's defaults because it could not read them. Each refusal is explained with
the pipeline's `explainRefusal`: what it says about the lane and what to do (never a fee bump: a one-time key signs
once).

The backend is the only signer: run bursts through it, never beside a script that holds the same journal. On the
devnet, point the backend at the miner's sidecar (`WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc`): since Nov 5
the gateway admits but does not relay (spec, Day-0).

## Tests

Offline: the CLI's functions run against the real backend app in process, on its fake chain and sidecar
(`backend/test/fake-chain.ts`), listening on a random loopback port; `test/setup.ts` points every chain endpoint at
loopback port 1 first. They cover a plan, a burst of 8 on the alt mempool (all admitted, all pending at once, landing
over two blocks of four), a public burst (one admitted, seven refused with the explained reason), an unaffordable plan
refused and `--force`, `--json-out`, a burst larger than the band, lost answers (one dropped after the backend sent its
lane and one replaced by a 500: both found, followed and exit 0; one that never reached the backend: unaccounted, exit
3, never called not sent), and the arguments.

```sh
export PATH="$HOME/.bun/bin:$PATH"
(cd pipeline && bun install) && (cd backend && bun install)
cd demo && bun install && bunx tsc --noEmit -p . && bun test
```
