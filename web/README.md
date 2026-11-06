# Winterlock web app

The wallet workspace uses React, TypeScript and Vite, with Tailwind CSS, shadcn/ui components built on Base UI,
TanStack Query, React Hook Form and Zod. Vicky explicitly approved this stack in place of the original no-framework
frontend constraint. The Bun backend still owns seeds, ticket journals, signing and transaction submission.

## Run

Install dependencies in `pipeline/`, `backend/` and `web/`, and build the Rust signer with
`cd signer && cargo build --release`. Start the backend following `backend/README.md`, then:

```sh
cd web
bun install
bun run dev            # Vite with the guarded API proxy, http://127.0.0.1:5173
```

For the production bundle:

```sh
bun run start          # build, then serve dist/ on the same local address
# or independently:
bun run build
bun run preview
```

The server preserves `/`, `/index.html`, `/hot-cold.html`, `/agent.html` and `/session.html`, including `?wallet=` links.
An unknown wallet in the URL displays its error instead of choosing another account.
`WL_WEB_PORT` changes the local web port; `WL_BACKEND_URL` defaults to `http://127.0.0.1:8787`.
Development uses a fixed port; the production server also accepts port 0 to choose an available one.

For local wallet testing, start `fakechain/run.ts`, source **every** `WL_*` variable from that run's generated `env.sh`
in the backend shell, and start `backend/src/main.ts`. The frontend labels this network **Local simulation · no EVM**.
It is never evidence of devnet execution. Each fake-chain run owns separate temporary keys and data.

The existing optional `bun serve.ts --lan` mode also serves the compiled app. It retains its private-address check,
secret link, HttpOnly cookie and Host/Origin guard; follow the printed hotspot instructions.

## Screens and behavior

| Screen | Implemented actions |
| --- | --- |
| Wallets | List accounts and create an account with optional policy/tree settings |
| Pay | Hot payment with cap validation; exact fee ceiling and ticket consequence; short-deadline demonstration; cold transfer, policy update, ticket cut, root rotation with confirmation, cold offline toggle |
| Agent | Explicitly arm a one-shot mock-price rule; four concurrent tranches; bounded allowance and max loss; two outside-policy test payments; observed event log |
| Session | Grant or decline a ticket request; 36 dapp cells, each sending exactly 0 wei with no calldata; independent cells can submit concurrently, with a duplicate fence on each cell |

Each use-case screen has the mempool switch, a Play scene action and a lane board with the six required columns.
Lane inspection opens the admission checks, raw timeline, retry links, gas measurements, receipt and exact wire payload.
Missing gas and receipts stay unknown; successful execution is determined by the receipt. A reverted frame consumes its
key but does not appear as a successful dapp move. The Flask link opens the separate Snap app at `localhost:15190`.

Amount parsing and transaction bodies reuse the tested exact-integer helpers in `public/flows.js` and `format.js`.
The API client preserves structured errors, including a 422's hash, leaf and simulation evidence.
Signing is triggered only by explicit actions or a rule the user armed. POSTs are never retried by the frontend.
The stuck-payment demonstration requests one backend retry on a fresh leaf after expiry; it never re-signs or fee-bumps.
Concurrent bursts retain every result, including partial failures. Both wallet and history are refreshed after a success
or failure because a refused submission may already have burned its ticket.

A lost device journal disables hot signing and ticket cutting until a fresh authoritative wallet view confirms recovery.
A stalled-chain response disables signing until fresh status confirms the chain is moving. Read-only history remains
available. A transport failure reports an unknown outcome and asks the user to inspect the board before another action.
Rotation waits for inclusion before changing the displayed epoch. Proposed recent-root expiry, renewal and End session
controls remain visibly disabled and labelled.

Read queries are scoped to the wallet: transactions poll every 2 seconds, wallet state every 6, network status every 10
and lane plans every 30. A plan also refreshes when its inputs or ticket counts change. Polling never overwrites drafts.

## Interface

Production styles live in `src/styles/`; semantic Tailwind tokens map to the same light/dark palette. Manrope and IBM
Plex Mono are self-hosted, with upstream SIL OFL licences in `src/styles/fonts/`. Runtime resources stay on the local
origin. Appearance persists and respects the system setting, with `?theme=light` and `?theme=dark` for review.
Reduced motion follows the system preference. All critical controls have visible keyboard focus and labelled inputs.
Base UI dialogs provide focus containment, Escape dismissal and focus return.

Payment and cold panels retain natural heights. History uses a consistent **320 px** scroll area, sticky headers and
a pinned lane column on narrow screens. Below 1000 px, task tabs expose Pay / Cold device / Activity, Run agent /
Allowance / Activity, and Session / Dapp / Activity. They preserve inputs and live state, support arrow keys and
Home/End, and participate in browser Back/Forward navigation. Session grants open the Dapp view on mobile.

Design notes and reference prototypes are local-only under `.claude/`, excluded by `.git/info/exclude`.
`bun run prototype` opens the locally archived reference when present. `public/` retains the pre-migration frontend and
its helper/integration coverage. It is not copied into `dist/`; only imported production code and assets are bundled.

## Proxy and build

`serve.ts` serves `dist/` and forwards `/api/*` through the same loopback-only proxy used before the migration.
The Vite middleware applies the same incoming Host and Origin checks before forwarding, strips browser credentials,
limits request bodies to 64 KiB, returns structured JSON errors and disables API caching. Missing production assets
and source-file paths return 404 rather than the SPA document. `/web/config` retains the local backend address.

The production content security policy allows scripts, styles, fonts and requests from the same origin, without
`unsafe-inline`. Vite development adds a process-local nonce for injected development styles/scripts and permits
its own local HMR socket. The production server keeps the stricter policy. Screens are loaded in separate chunks.

## Verification

```sh
bun run typecheck       # server, legacy typed helpers/tests, and strict React TypeScript
bun test                # existing helper, server, DOM-controller and real-backend integration coverage
bunx playwright install chromium
bun run test:browser    # production build + isolated real-backend browser suite
```

The Bun preload points chain endpoints at loopback port 1 and removes developer wallet paths. The browser server
in `e2e/server.ts` imports that isolation before loading a real backend, uses its in-process fake RPC and temporary
data, invokes the real Rust signer, and serves the compiled React bundle through the production proxy on port 5190.
It does not use a developer's running backend. Playwright and axe cover exact amounts, duplicate submission,
wallet creation, cold policy/rotation, expiry with a fresh-leaf retry, agent partial outcomes, session grants and
concurrent cells, device-journal loss, stalled-chain recovery, responsive task navigation and accessibility in both
appearances. Browser artifacts are ignored in `test-results/`.

Verified after migration: **189 Bun tests and 22 Playwright tests pass**, including 66 axe scans with no violations.
Strict TypeScript checks and the Vite production build pass.

The legacy tests remain useful for the reused transaction helpers; the Playwright suite verifies the React application.
The fake RPC does not execute the EVM. Live devnet acceptance remains a separate integration check.

## Attribution

The original API/helpers and legacy frontend were written with Claude Code for Vicky. The React migration, production
styles, Vite/proxy integration, browser checks and this documentation were written with OpenAI coding assistant, directed by Vicky.
The shadcn/ui Button, Input and Dialog sources were adapted from its Base UI registry; their MIT notice is retained in
`src/components/ui/LICENSE.md`. Font licences remain beside their upstream assets. See the root README for file-level
AI attribution. Design-only artifacts remain outside tracked source.
