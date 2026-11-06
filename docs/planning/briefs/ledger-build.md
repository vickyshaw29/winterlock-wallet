# Ledger UI: build brief (Nov 6, ~13:55 IST; Vicky picked direction 1 "Ledger")

Rebuild the three screens (and the start page) in the Ledger direction, in `/Users/vicky/Documents/winterlock-backend/web/`
(branch feat/backend). Never commit, push or stage. Nothing to any network except loading the local servers; never
read `~/.winterlock`.

## Sources (read all first)

- The design: `/Users/vicky/Documents/winterlock/.claude/briefs/ui-directions/1-ledger.md` (tokens for light and dark,
  typography, wireframes for all three screens at laptop and 375 px, the lane board as a ruled ledger, the orchestrated
  moments, the anti-generic review) and its working mock `1-ledger.html` in the same folder (CSS, markup patterns,
  animations: the ticket tear, the ledger line, the cancellation stamp). Follow them; where the mock simplifies (it has
  no real data), follow the note.
- The process: Anthropic's frontend-design skill, https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md
  (build, then critique from screenshots and remove what does not serve the brief).
- The spec's relaxed design rule (`/Users/vicky/Documents/winterlock/.claude/spec.md`, "Screens: shared rules", Nov 6)
  and its Use cases section; `AGENTS.md`.
- The current screens and their tests: `web/public/*` (api.js, flows.js, scenes.js, lanes.js, board.js, ui.js, dom.js,
  format.js, market.js, hot-cold.*, agent.*, session.*, index.*, style.css), `web/test/*`, `web/serve.ts`, `web/lan.ts`.

## Must

- Every control of every screen keeps working exactly as now: the wiring (api.js, flows.js, scenes.js) keeps its
  behaviour; Play scene, Pay, stuck payment (4 s deadline), cold transfer, Set policy, Cut tickets, Rotate (two clicks),
  Offline, Fire, Server compromised, Grant/Decline, the grid moves, the Mempool switch, the 503 banner, the status line
  with the FAKE CHAIN badge, explorer links, row details, retry links, the lanes plan. The web suite stays green: update
  tests only where markup or class names change, never weaken an assertion; add tests for new view logic.
- Self-hosted fonts only: `web/public/fonts/archivo-latin.woff2` (Archivo variable, wdth 62-125, wght 100-900) and
  `besley-latin.woff2` (Besley variable, wght 400-900), with their OFL texts beside them. `@font-face` with
  `font-display: swap` and the latin unicode-range (U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
  U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD). Remove every Google
  Fonts reference. In `web/serve.ts`: serve `.woff2` as `font/woff2`, and set the CSP to `font-src 'self'` and
  `style-src 'self'` (no third-party host). Test that a font is served with that type and that no page references
  googleapis or gstatic.
- Real data, never mock numbers: the key register (1,024 cells) colours leaves from the wallet view and the transaction
  records (used on chain, burned by the signer, in flight, exported to the phone, hot band not cut, unused). If the API
  lacks something the design needs (for example the ticket device's band range), add it to the backend in the smallest
  way with a test (`backend/src/backend.ts` wallet view), and say so.
- Plain HTML, CSS and JS, no framework, no build step; light and dark from the note's tokens; 375 px and laptop;
  accessible: contrast in both themes, visible focus, `prefers-reduced-motion` (moments become instant), real buttons and
  labels; the spec's vocabulary only; no emoji or marketing copy.
- The moments, exactly as the note defines them and only there: a ticket tears off when a hot payment is sent; a ledger
  line is written when a lane is admitted; the chain's dated cancellation stamp lands when it is included ("burned, in
  block N"); a refusal or expiry is stamped by the signer.
- Check your own work in a headless browser (the designer used headless Chromium) at 375, 1024 and 1440 px, light and
  dark, against a running backend on the backend's test fakes (see `web/test/integration.test.ts` for how to start them)
  or against static fixtures; fix what looks wrong.

## Report

Files changed, test counts (web suite, both type-checks, and the backend suite if you touched it), any API addition,
what you checked in the browser and at which sizes, and anything left that needs Vicky.
