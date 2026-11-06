# web: the three use-case screens

The spec's three use cases as pages a judge can click through: **hot and cold**, **agent** and **session**, and a
start page that lists the backend's wallets and creates one. Plain HTML, CSS and JavaScript modules: no framework, no
build step. The browser talks only to `serve.ts`, which serves `public/` and forwards `/api/*` to the backend (spec:
the frontend only calls the backend). The backend holds the seeds and does everything on chain.

Written with Claude Code (AI) for Vicky.

## The screens

| Page | What it shows |
| --- | --- |
| `index.html` | The backend's wallets, with links to the three screens; a form that creates a wallet (`POST /api/wallets`) |
| `hot-cold.html` | Cold device: the key tree, the hot policy (Set policy), Cut tickets, Rotate root, a Transfer on a cold leaf, an Offline toggle. Phone: tickets left, Pay within the hot value cap, Simulate stuck payment |
| `agent.html` | A mock price (labelled mock) and the rule "if price falls more than 2 % in 30 s, buy in 4 tranches": Fire sends the 4 tranches at once as parallel lanes. The allowance card, and Server compromised: two payments the account refuses |
| `session.html` | A 6 by 6 dapp grid, each click one hot ticket of 0 wei on its own lane; the session request that grants tickets |

Every screen has:

- **Play scene**: the spec's scene for that screen, through the real API.
- **The lane board**: one row per transaction (lane = nonce key, leaf, action, amount, verify-frame gas, status
  timeline), read every 2 s. A click on a row opens its admission report or refusal reason, its receipt and its
  explorer link. An expired row says "expired, leaf burned" and links its retry, a fresh leaf on a fresh lane.
- **The Mempool switch**, alt or public: it sets each send's `mempool`.
- **The set-aside line**: the worst case the pending lanes hold. A record with the backend's `maxCostWei` counts its
  value plus that maximum cost, which is what the sidecar sets aside. Without it, a hot lane counts its value plus the
  hot fee cap (an upper bound) and a keyed lane its value only. The line says which.
- **The lane limits**, in the spec's words: 1 pending per lane (nonce key), no per-sender cap for keyed lanes the
  account pays for itself, relayed at most 4 per 10 s pass, so 8 lanes land over two or more blocks. The ERC-8421
  draft's 4 per key and 64 per unstaked sender are labelled as the draft's. The public mempool's one pending per sender
  is labelled not yet confirmed on the devnet.
- **The stalled-chain banner**: while the backend answers 503, or `GET /api/status` says stalled, sending is off.
- **The status line**: the backend's URL, the chain id, the latest block and its age, and a "Fake chain" band (Ink,
  the band carries the warning) on chain 31337.

What the screens send, and when they hold back:

- **Simulate stuck payment**, and the third payment of the hot-and-cold scene, sends
  `{"mode": "hot", "firstAttemptExpirySeconds": 4, "retries": 1}` and no fee field. The first attempt's 4-second
  deadline is shorter than the devnet's 6-second block, so it should miss its block and expire, its ticket burned.
  One retry goes out on a fresh lane with the normal 90-second deadline. It is not certain: a few tries in a hundred
  still land on the first attempt, when the sidecar's 10 s relay pass and the next slot both fall inside the 4 s, so a
  recording of the scene may need a retake. A low fee would not do: on this devnet a fee below the 7-wei base fee is
  refused at admission, and any fee above it is included (spec, Nov 6). Nothing is ever fee-bumped.
- **The parallel-lanes plan** (`GET /api/wallets/:address/lanes/plan`) shows before Fire on the agent screen (4 lanes,
  one tranche each) and before Grant on the session screen (every granted ticket at once, 0 wei each): "N lanes: P
  relay passes, about S s; set aside X of balance Y", then its warnings. It reserves nothing and turns no button off.
  It is asked when the screen's own query changes (lanes, mode, amount, target), and otherwise at most every 30 s,
  however often the wallet view refreshes (every 6 s). Its warnings are said in the screen's words, never the API's:
  no paths, status codes or reason codes ("No tickets left on the phone: cut some on the cold device."). A backend
  without the route (404 `not_found`) shows "not offered"; a plan that cannot be read says so, with the backend's own
  words in the line's tooltip.
- **A lost device journal**: when `GET /api/wallets/:address` reports `tickets.unjournaled`, or a send or a cut answers
  409 `device_unusable`, the phone, allowance and session cards say "N tickets were cut but are missing from the
  device journal: recover it". No screen offers a cut then: Cut tickets and Grant are off, and every Play scene stops
  before it cuts. The backend's 409 detail names the journal file to recover.
- Not built, so shown disabled and labelled: the recent-root countdown and Stop renewing (Level B), and End session
  (no endpoint).

## The look: the Ledger direction

Vicky picked direction 1, "Ledger" (design note `.claude/briefs/ui-directions/1-ledger.md`, local): the wallet as a book
of numbered one-time keys. A ledger-green page and six inks, each with one owner (Print for what the form asks, Ink
for what is true now, Serial red for numbers the key tree prints, Stamp violet for burned); Besley for those numbers,
Archivo for everything else; no monospace. The lane board is a ruled ledger: a double rule under an amount that moved,
a strike where none did, and on every final line a cancellation stamp, "burned, in block N" when the chain consumed the
key or "burned, by the signer" when the leaf never reached it. Motion only on the moments the note names (a ledger line
written when a lane is admitted, the stamp landing at inclusion, a ticket tearing off when a hot payment is sent), each
once, never on load, and instant under `prefers-reduced-motion`.

- `public/style.css`: tokens (light and dark), fonts, the shared frame, controls, the register, the stub strip and the
  ledger. Each page adds its own file (`hot-cold.css`, `agent.css`, `session.css`, `index.css`).
- `public/board.js`: the ledger; `public/register.js`: the key register (one cell per leaf, coloured from the wallet
  view's `leaves` and the lane records), the stub strip and the ticket tear.
- Review aids in the URL: `?theme=dark` or `?theme=light`, `?motion=reduce`.

## Run them

Needs, once: Bun (`~/.bun/bin`); `bun install` in `pipeline/`, `backend/` and `web/`; and the Rust signer CLI
(`cd signer && cargo build --release`), which the backend uses for ticket cuts and hot signatures.

### With the backend on the devnet

```sh
export PATH="$HOME/.bun/bin:$PATH"
# shell 1: the backend (backend/README.md: it needs its EOA key file and the pipeline's deployment record)
cd backend && bun src/main.ts            # winterlock backend: http://127.0.0.1:8787/api
# shell 2: the screens
cd web && bun serve.ts                   # or: bun run start
# then open http://127.0.0.1:5173/
```

The public gateway stopped relaying on Nov 5: start the backend with the miner's sidecar,
`WL_GATEWAY_URL=https://altmempool.forshtat.com/rpc bun src/main.ts`. While the devnet is halted, the screens show
the stalled banner and send nothing.

### With the fake chain

`fakechain/` (on the branch `feat/fakechain` until it is merged) is a local FAKE devnet in one process, chain 31337,
with the devnet's 6-second blocks and the sidecar's relay of 4 lanes per 10 s pass (see `fakechain/README.md`). Each
start is a new world in a temp folder, with a funded first account. The backend points at it through the `env.sh` it
writes; `serve.ts` needs nothing from it.

```sh
export PATH="$HOME/.bun/bin:$PATH"
# shell 1: the fake chain; it prints its data folder and the env.sh to source
cd fakechain && bun install && bun run.ts
# shell 2: the backend, with every WL_* from that env.sh
source /var/folders/…/fakechain-XXXXXX/env.sh
cd backend && bun src/main.ts
# shell 3: the screens
cd web && bun serve.ts
# then open http://127.0.0.1:5173/ : the status line carries the "Fake chain" band
```

Take every `WL_*` of the backend from that `env.sh`, and set none on the command line: the backend has no fake-chain
guard, so in a mixed environment it can reach the real devnet. Only the chain pin (chain 31337 and the run's genesis)
stops a seed from signing on the wrong chain. Not yet tried by hand end to end with these screens (Nov 6).

## Environment

`serve.ts` reads two variables; the rest belong to the backend (and the pipeline it imports), listed here so one page
says what a run depends on. All are optional.

| Variable | Read by | Default | What |
| --- | --- | --- | --- |
| `WL_BACKEND_URL` | `serve.ts` | `http://127.0.0.1:8787` | The backend that `/api/*` is forwarded to; its port must be the backend's `WL_BACKEND_PORT` |
| `WL_WEB_PORT` | `serve.ts` | `5173` | The screens' port on 127.0.0.1; `0` picks a free one |
| `WL_BACKEND_PORT` | backend | `8787` | The backend's port on 127.0.0.1 |
| `WL_BACKEND_DIR` | backend | `~/.winterlock/backend` | The backend's data: seeds, wallet records, ticket devices, the transaction store |
| `WL_DATA_DIR` | backend | `<repo>/pipeline/.data` | The pipeline's deployment records |
| `WL_SIGNER_BIN` | backend, integration tests | `<repo>/signer/target/release/signer` | The Rust signer CLI |
| `WL_EOA_KEY_FILE` | backend | `~/.winterlock/devnet-eoa.key` | The funded EOA that creates every wallet |
| `WL_FUND_WEI` | backend | `20000000000000000` (0.02 ETH) | A new wallet still below this after the faucet (or with the faucet dry) is topped up to it by the EOA |
| `WL_NODE_URL` | pipeline | `https://altmempool.forshtat.com` | The ethrex node: reads, dry runs, the public mempool |
| `WL_GATEWAY_URL` | pipeline | `https://altmempoolgateway.forshtat.com/rpc` | The sidecar: the alt mempool, status, receipts, gas price, faucet, admission records |
| `WL_CHAIN_ID` | pipeline | `1337` | The chain id; the fake chain is 31337 |
| `WL_EXPLORER_URL` | pipeline | `https://explorer.altmempool.wtf` | Explorer links on the lane board |

The fake chain's `env.sh` exports `WL_CHAIN_ID`, `WL_NODE_URL`, `WL_GATEWAY_URL`, `WL_EXPLORER_URL`, `WL_DATA_DIR`,
`WL_BACKEND_DIR` and `WL_EOA_KEY_FILE`, all pointing into its own run, and `WL_SEED_FILE`, which only the pipeline's
scripts read. The backend never passes a seed in `PQ_SEED`; it strips it from the signer CLI's environment.

`serve.ts` listens on 127.0.0.1 only and answers only requests addressed to its own host and port, with no Origin or
its own: forwarding drops the browser's Host and Origin, so it makes the backend's two checks for itself first. Only
the content type travels on. Pages get a content security policy: scripts, styles, fonts and data from this origin
only, no third-party host (CROPS). The two fonts are self-hosted in `public/fonts/` (Archivo and Besley, latin subsets,
SIL OFL 1.1, their licence texts beside them) and served as `font/woff2`.

## Tests

```sh
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
(cd signer && cargo build --release)                          # the integration tests cut tickets with the real CLI
(cd pipeline && bun install) && (cd backend && bun install)   # the integration tests run the backend's own code
cd web && bun install
bunx tsc --noEmit -p . && bunx tsc --noEmit -p public         # or: bun run typecheck
bun test
```

Offline: `test/setup.ts`, preloaded by `bunfig.toml`, points `WL_NODE_URL` and `WL_GATEWAY_URL` at loopback port 1,
sets `WL_CHAIN_ID` 1337 and `WL_EXPLORER_URL`, and removes `PQ_SEED`, `WL_BACKEND_DIR`, `WL_DATA_DIR` and
`WL_EOA_KEY_FILE`, before anything loads. The integration tests replace the chain with the backend's in-process fake
(`backend/test/fake-chain.ts`, not `fakechain/`) and use temporary folders only. The suite takes about 20 s: the
stuck payment waits out its real 4-second deadline.

| File | What it checks |
| --- | --- |
| `format.test.ts` | Amounts, gas, hashes, nonce keys as lanes, times |
| `lanes.test.ts` | Rows from the backend's records, the status timeline, retry links, the set-aside line with and without `maxCostWei` |
| `board.test.ts` | The lane board drawn on a fake DOM: the ledger's amount rules, the stamps, the moments once per lane |
| `register.test.ts` | `register.js`: each leaf's state from the wallet view's `leaves` and the records, the next ticket, the stub strip (an unchanged stub keeps its moment through a second draw), the moments once, the tear skipped where it cannot run |
| `ledger-hot-cold.test.ts` | The hot-and-cold screen in the Ledger direction: the ticket's serial and machine line, the register and the stubs, when the ticket tears, the folds below 600 px |
| `ledger-agent.test.ts` | The agent screen: the count, the stub strip, Max loss ruled again after Server compromised only, the stubs Fire lifts, the day book's serials |
| `ledger-session.test.ts` | The session screen and the start page: the punch board's states and moments, the card's count and stubs, the start page's wallet lines |
| `flows.test.ts` | The exact body each button sends, the inline checks, the device journal's words, the lane limits' words, the plan's words (every backend warning in the screens' words, no API wording), the status line, the API client |
| `screens.test.ts` | The three page scripts on a fake DOM parsed from their own HTML, against a fake API: what each click sends, the cards, the plan (asked again only when its query changes or after 30 s), the banner |
| `pages.test.ts` | Every id a script asks for, no inline script or style, the attribution line, the wording rules (no low fee, draft numbers labelled, parallel lanes) |
| `serve.test.ts` | `serve.ts`: forwarding, the Host and Origin checks, static files |
| `integration.test.ts` | The real backend app with its fake chain, `serve.ts` in front, driven by the pages' own client and flows: wallets, keyed and hot sends, cuts, the stuck payment, refusals, tickets_exhausted, a lost device journal, the plan and the real backend's warnings in the screens' words, the 503 banner |

## Known limits

- The public mempool's one pending per sender is not yet confirmed on the devnet: ethrex's docs say its pool may admit
  several keyed transactions with disjoint keys from one sender.
- The plan's time is an estimate: 28 s for one lane (measured Nov 5) plus 10 s for each further relay pass.
- `index.ts` is the `bun init` stub and is not used: `serve.ts` is the entry point.
