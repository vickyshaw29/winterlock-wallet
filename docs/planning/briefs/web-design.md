# V6 screens: build brief (Nov 6, Vicky said go; speed matters, testing must be real)

Build the three use-case screens of the spec as plain HTML, CSS and JavaScript, wired to the backend API, in
`/Users/vicky/Documents/winterlock-backend/web/` (git worktree, branch `feat/backend`). Another agent may later fix the
backend in the same worktree: touch only `web/`. Never commit, push or stage. Nothing may be sent to any network:
the devnet is halted, and every test runs offline.

## Read first

- `/Users/vicky/Documents/winterlock/AGENTS.md`, `/Users/vicky/Documents/winterlock/.claude/spec.md` and `.claude/plan.md`
  (the worktree has no `.claude/`). In the spec: "Use cases" (the three stories and their screens) and "Screens:
  shared rules"; "Shared interfaces" item 5, the backend API as extended Nov 6 (the contract you call). The Nov 4
  prototypes the spec links cannot be read here: build from the spec text.
- The backend you call: `backend/src/app.ts` (routes, Host and Origin checks), `backend/src/backend.ts`,
  `backend/README.md`, and its tests (`backend/test/helpers.ts`, `fake-chain.ts`) for the exact response shapes.

## What to build

- `web/serve.ts` (Bun): serves the static files and forwards `/api/*` to the backend (default `http://127.0.0.1:8787`,
  env `WL_BACKEND_URL`), dropping the browser's Origin and Host so the backend's checks see a local caller. Listens on
  127.0.0.1 only (default port 5173, env `WL_WEB_PORT`). The browser talks only to this server (spec: the frontend only
  calls the backend).
- `web/public/`: `index.html` (picks a wallet from GET /api/wallets and links the three screens), `hot-cold.html`,
  `agent.html`, `session.html`, one shared `style.css`, shared ES modules (`api.js`: a typed-by-JSDoc client for every
  endpoint with the spec's error shape; `lanes.js`: the lane board; `format.js`: wei, gas, hashes, times). No framework,
  no build step, no CDN script. Fonts: the spec says Inter and JetBrains Mono; load them from Google Fonts with a system
  fallback, so a page still works offline.
- Design (spec, Screens: shared rules): neutral paper-and-ink palette with one accent, light and dark (prefers-color-scheme);
  Inter for UI text, JetBrains Mono for addresses, lane ids, gas and amounts; hairlines, 4 px radii, an 8 px grid; no
  gradients, emoji, illustrations, hero sections or marketing copy; every page works at 375 px wide; vocabulary from the
  spec only (leaf, lane, hot band, ticket, hot policy, expiry, burned, rotation, admitted, included, refused).
- Every screen has: the wallet header; a **lane board** (columns lane = nonce key, leaf, action, amount, gas = verify-frame
  gas when known, status timeline), fed by polling GET /api/wallets/:address/txs every 2 s; a **Mempool switch** (alt or
  public), which sets the send body's `mempool`; a "set aside for pending" line: the worst-case cost of the pending lanes
  (from what the API returns; label it if it is an estimate); explorer links for every transaction; the admission report
  or the refusal reason of a row when it is clicked. No fee bump anywhere. An expired row shows "expired, leaf burned",
  and its retry is a new row on a fresh lane, linked by retryOf/retriedAs. While the backend answers 503 (chain stalled),
  a banner says so and sending is disabled.
- **Hot and cold** (first, best): the cold pane (tree summary: height, leaves used, hot band, root; hot policy: value cap,
  fee cap, allowed target, with Set policy (POST hot-policy); Cut tickets (POST tickets); Rotate root with the warning
  "rotation invalidates every pending lane" (POST rotate); an Offline toggle that greys the pane, client side only).
  The phone pane: tickets "N of M" from GET /wallets/:address `tickets`, a pay form with the target read-only and the
  value cap enforced inline (the account enforces it too), and a Simulate stuck payment button: a hot send with a
  maxFeePerGasWei below the market, expirySeconds 30 and retries 1, so the row expires, its ticket is burned and the
  retry lands on a fresh lane.
- **Agent**: a market panel with a mock price (label it mock) and the rule "If price falls more than 2 % in 30 s, buy in
  4 tranches"; Fire sends 4 hot sends at once to the allowed target, each within the value cap (read it from the wallet;
  never hard-code 0.1 ETH); a Server compromised button sends one hot payment over the cap to a new address, which the
  account refuses: show the 422's reason. The recent-root countdown and Stop renewing are Level B, not built: show them
  disabled and labelled "proposed (Level B)".
- **Session**: a 6 by 6 grid where each click is one hot send of 0 wei to the allowed target (the account allows no
  calldata on hot leaves, so a move carries none); a session request sheet that cuts tickets (POST tickets, at most what
  the hot band has left) as "Grant N tickets"; a move counter; when tickets run out the backend answers 409
  tickets_exhausted: show it. End session (burning unused tickets) has no endpoint: show it disabled, "not built".
- A small status line on every screen: the backend URL and, if the backend has GET /api/status (it may be added later),
  the chain id and how old the latest block is; on chain 31337 a clear "FAKE CHAIN" badge.

## Testing (real, offline)

- `bun test` in `web/`: unit tests for format.js and the lane-board state (rows from API records, ordering, retry links,
  status timeline); an integration test that starts the real backend app in-process with the backend's own test fakes
  (backend/test/helpers.ts and fake-chain.ts; import them, do not copy), starts web/serve.ts in front of it on random
  ports, and drives the API through the proxy as each screen does (create or load a wallet, send keyed and hot, cut
  tickets, the stuck payment with its retry, a refusal, tickets_exhausted, the 503 banner condition), checking the
  shapes the pages read. Use a DOM library only as a test dependency if you need it; prefer keeping logic in modules
  you can test without a DOM.
- Run `bunx tsc --noEmit` if you add a tsconfig for the JS (checkJs), and the backend suite once at the end to show you
  changed nothing there. Commands need `export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"`.
- Put two bugs back once (for example a retry not linked to its expired row, a status mapped wrong) and confirm a test
  fails; report which.

Out of scope: any change to the backend or the pipeline (report what the screens need as a question instead), the
devnet, the README. Start every new file with a one-line purpose comment and "Written with Claude Code (AI) for Vicky."
