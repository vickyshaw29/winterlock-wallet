# Handoff to OpenAI coding assistant: redesign Winterlock's three screens (Fri Nov 6, ~16:15 IST)

Local file, never committed. Written by Claude Code for Vicky, who will run OpenAI coding assistant with it.

## Your role

You are the best UI/UX designer in the world, and a senior front-end engineer who ships what you design. You have
designed trading terminals, payment apps and developer tools that people understand in five seconds and enjoy watching.
Your job is product clarity and life on screen, not decoration. You read the brief, look at the current screens, say
plainly what is wrong, propose one strong direction, get a yes, build it, and critique your own build from screenshots
until it is right. You hold yourself to the level of Linear, Stripe, Arc and Teenage Engineering, and you never ship
something that looks like a generic AI-generated dashboard.

## The job in one paragraph

Winterlock is a post-quantum smart wallet for an Ethereum hackathon (ETHGlobal Mumbai, Ethereum Foundation track
"Best use of the Frame Transaction Alternative Mempool"). The web app has three use-case screens (hot and cold, AI
agent, session keys) and a start page, already wired to a working backend that sends real transactions. Vicky (the
only hacker, who drives you) says the current screens look **"extremely confusing and dead."** Redesign them so a
judge at a booth understands each screen in five seconds and the screen feels alive. Keep every control working and
the test suite green. Feature freeze is **Sat Nov 7, 01:00 IST**; aim to finish by Fri 22:00 IST.

## Read first (absolute paths; your working copy has no AGENTS.md or .claude/)

1. `/Users/vicky/Documents/winterlock/AGENTS.md`: the rules every agent follows. Its `.claude/` paths mean
   `/Users/vicky/Documents/winterlock/.claude/`.
2. `/Users/vicky/Documents/winterlock/.claude/spec.md`, at least these sections:
   - "Goal and claim";
   - "Use cases", including "Screens: shared rules" (the design rules, relaxed on Nov 6, and the numbers the screens
     must show);
   - "Shared interfaces" item 5 (the backend API);
   - "Demo script".
3. `/Users/vicky/Documents/winterlock/.claude/plan.md`, sections 1 and 11 (hackathon rules) and 10 (the booth walkthrough).
4. The current screens: `/Users/vicky/Documents/winterlock-backend/web/` (README.md, `public/`, `test/`, `serve.ts`).
5. The design direction Vicky picked on Nov 6, "Ledger": `/Users/vicky/Documents/winterlock/.claude/briefs/ui-directions/1-ledger.md`
   and its mock `1-ledger.html`. The other two directions, `2-operations.*` and `3-keytree.*`, are beside them. The
   build brief that produced today's screens: `/Users/vicky/Documents/winterlock/.claude/briefs/ledger-build.md`.
6. Screenshots of the current state: in `/Users/vicky/Documents/winterlock/.claude/briefs/ui-current/`, the
   hot-and-cold screen at 1440 px light and dark and at 375 px, and the agent, session and start pages at 1440 px.

## What the product is (plain words)

- The wallet signs with **one-time keys** (hash-based, post-quantum). There are 1,024 numbered keys, called leaves.
- **Every transaction uses its own leaf.** The leaf number is also the transaction's **lane**, its own nonce key, so
  the chain burns the leaf when it approves the payment. A leaf can never be used twice, and nothing has to be stored.
- **Lanes run in parallel.** The alternative mempool holds one pending transaction per lane, so 8 payments can be
  pending at once. The public mempool holds one per sender, so there the second payment is refused.
- **A stuck payment never gets a fee bump**, because bumping would sign the same leaf twice. It waits out its deadline,
  its leaf is burned, and the retry goes out on a fresh lane.
- **Hot tickets.** The cold device (a laptop) cuts a few leaves as tickets for a phone, or an agent, or a dapp session.
  Each ticket pays at most a value cap, to one allowed address. The account itself refuses anything else, on chain.

**What each screen must make obvious** (spec "Use cases"):

| Screen | The story | The moment that must land |
| --- | --- | --- |
| Hot and cold (it leads the demo video) | The phone pays three times while the laptop is offline; the payments land out of order; one gets stuck and is retried on a fresh lane. Switch the mempool to public and the second payment is refused | Lanes running in parallel; the stuck payment's leaf burned and the retry on a new lane |
| Agent | A trading agent with 20 tickets fires 4 tranches in the same second on a price drop. Then "Server compromised": two payments outside the policy, both refused by the account | 4 lanes at once; the two refusals ("exceeds value cap", "target not allowed"); max loss bounded |
| Session | A dapp gets a session of N tickets. Each grid click is one transaction on its own lane, landing out of order. In public mode the moves stall | Moves landing out of order, fast |

Each scene runs in under 30 seconds with at most 3 clicks (the Play scene button).

## Vicky's verdict, and the problems we see (diagnosis, not a design)

- **Confusing.**
  - Above the fold sit eight labelled facts, a five-line paragraph and four admin forms (Transfer, Hot policy, Tickets,
    Rotation). Nothing says what to press first.
  - Long explanations in small, low-contrast green text (Play scene, the stuck payment, session hints) read like docs.
  - Internals sit in the main flow: "set aside for pending", a "Parallel-lanes plan" bullet list, "This backend does not
    say which ticket is next", disabled "proposed (Level B)" buttons (Renew, Stop renewing, End session) with "not
    built" notes.
  - The ticket card shows an empty red bar where its number should be.
  - The 1,024-cell key tree is tiny and reads as noise.
- **Dead.**
  - The live part, the lane board, is below the fold on a laptop, so pressing Pay changes nothing you can see.
  - Nothing moves when idle, although the chain makes a block every 6 s.
  - Green on green, with every element at the same weight and no colour for states.
  - The agent's event log is empty, and its "fire 4 tranches" moment is not dramatic.

Directions we would consider (yours to accept or beat):
- **A "live stage" layout.** The one primary action on the left; the live lanes always visible on the right, each lane
  moving admitted → pending → included with a deadline countdown; a stamp when the chain burns the leaf; the leaf's cell
  flipping in the key tree.
- **A live block ticker** in the header, pulsing each block.
- **One short line per explanation,** with a "why?" toggle for the rest.
- **A closed "Cold device settings" drawer** for policy, tickets and rotation.
- **The "proposed (Level B)" controls** (Renew from cold device, Stop renewing, End session) are in the spec's screen
  lists, so they stay. Group them quietly under one clearly labelled "proposed, not built" note; never remove them.
- **Play scene as a guided story,** with a caption strip ("2/4: the third payment misses its block…").
- **Colour by state:** pending, included, refused, burned.

## Hard constraints (from the spec's "Screens: shared rules"; do not break)

- **Code:**
  - Plain HTML, CSS and JavaScript modules. No framework, no build step, no new dependency, no download (no bun add, npm,
    CDN). Ask Vicky before any download, naming the file, source and size.
  - Fonts are self-hosted only, already in `web/public/fonts/`: Archivo variable (wdth 62–125, wght 100–900) and Besley
    variable (wght 400–900), with their OFL licences. You may drop either one; you may not add a third-party request.
  - Do not weaken `web/serve.ts` or `web/lan.ts`. Keep the CSP of `'self'`, the 127.0.0.1-only binding, the Host
    check, the `/api/*` proxy's guards and LAN mode's one-time code. Touch `serve.ts` only to serve a new static file
    type, with a test.
- **Layout:**
  - Works at 375 px with no sideways scroll, and on a laptop (1024 and 1440 px).
  - Light and dark.
  - Accessible: AA contrast, visible focus, `prefers-reduced-motion` respected, real buttons and labels.
- **Lane board:**
  - Every screen has one, with columns lane, leaf, action, amount, gas and a status timeline.
  - Row details (admission report, receipt, explorer link) and retry links stay.
- **Controls:** every control of every screen stays on its screen and keeps working exactly as now. **Keep every
  existing id unchanged**, including those of the disabled "proposed" controls. The full list is in `1-ledger.md`
  section 7. It includes:
  - Play scene, Pay, Simulate stuck payment (4 s first deadline), Send from cold, Set policy, Cut tickets;
  - Rotate root (two-click arm), Offline, Fire / Rule armed / Drop the mock price, Server compromised;
  - Grant / Decline, the 6×6 grid;
  - the Mempool switch (alt and public), the stalled-chain banner, and the status line with a FAKE CHAIN mark on
    chain 31337.
- **Truth on screen:**
  - Every number, state and animation shows real backend state. Nothing simulated or time-faked on the wired
    screens: no progress bar that moves on a timer, no invented activity, no placeholder numbers. A lane's progress
    follows its real status, a countdown uses the record's real `deadline`, and the block ticker uses the real head
    from `GET /api/status`.
  - The agent's price stays a labelled mock, as today; it is the only simulated thing.
  - Claims in copy come only from the spec or from the measured evidence in
    `/Users/vicky/Documents/winterlock/.claude/briefs/README-draft.md` (sections 6.4 to 6.8). Keep the existing
    labels ("mock", "the ERC-8421 draft's", "FAKE CHAIN", "proposed") unless that evidence changes them. Example: the
    public pool's one-per-sender is now measured (section 6.6), so its "not yet confirmed on the devnet" label may say
    so. If unsure, ask Vicky.
- **Words:**
  - The spec's vocabulary only: leaf, lane, hot band, ticket, hot policy, expiry, burned, rotation, recent root,
    admitted, included, refused.
  - No emoji, no marketing copy.
  - Real data, never mock numbers. The agent's price is a labelled mock; that is the one exception.
- **Numbers to show where relevant** (spec): entry about 2,594 bytes; calldata floor about 166k; verify about 60k actual
  and 90k declared; 190k–200k total; 1 pending per lane (nonce key) with no per-sender cap for the account's own lanes;
  relayed at most 4 per 10 s pass, so 8 lanes land over two or more blocks. The ERC-8421 draft's "4 per key, 64 per
  unstaked sender" may appear only labelled as the draft's.
- **Changing the direction:** Vicky picked "Ledger". If you want a different direction, show her a mock first and get
  her yes (AGENTS.md rule 1).

## Where the code is, and its state

- **Work in** `/Users/vicky/Documents/winterlock-backend`, a git worktree on branch **`feat/ledger-ui`**.
  - Its head is `02d8731`, "the Ledger UI direction and the wallet view's leaves": the stopped Ledger rebuild,
    committed by Vicky on Nov 6 at 16:08 on top of what PR #8 merged. Your work goes on top of it, uncommitted.
  - Run `git -C /Users/vicky/Documents/winterlock-backend branch --show-current` before you start. Other sessions
    share worktrees.
  - Don't touch the main checkout `/Users/vicky/Documents/winterlock` or `/Users/vicky/Documents/winterlock-lanes`.
- **What the Ledger work (`02d8731`) holds.** Suites green when it was stopped: web 189 tests, backend 113, both
  type-checks clean.
  - `web/public/register.js`: the key register's leaf states, a pure function, tested in `web/test/register.test.ts`.
  - Per-screen CSS: `hot-cold.css`, `agent.css`, `session.css`, `index.css`, with shared tokens in `style.css`.
  - Ticket strip, tear animation, ledger-line and cancellation-stamp code in `board.js` and `hot-cold.js`.
  - The fonts' `@font-face`, and the CSP and woff2 MIME type in `serve.ts` (tested).
  - New tests: `web/test/ledger-*.test.ts`.
  - One backend addition, already in the spec: `GET /api/wallets/:address` now returns
    `leaves {onChain, burned, inFlight, tickets}` (`backend/src/backend.ts` `leafStates`, tested).
- **Keep, rework or replace freely.** Keep what serves the new design (the data plumbing, `register.js`, the tests);
  replace the layout and the copy.
- **Files you may edit:** everything under `web/`, plus the AI-attribution section of `README.md`. Nothing else: not
  `backend/`, `pipeline/`, `demo/`, `fakechain/`, `account/`, `signer/` or `vectors/`, and not the spec or the plan.
- **Behaviour you must not change:**
  - what each control sends and when: the request paths and bodies built in `web/public/api.js` and `flows.js`;
  - each Play scene's steps, their order and their timings (`web/public/scenes.js`);
  - what a status or refusal means.
  You may move these calls into new markup. You may not change their arguments or logic. `web/test/flows.test.ts`
  checks what the buttons send: leave its assertions as they are.
- **If you believe the backend or the API must change,** stop and ask Vicky. Only after her explicit yes: write the
  spec line first (Shared interfaces 5, marked "(Nov 6)"), then the smallest read-only addition, with a test.

## Data you can use (all real)

Read `web/public/api.js` and the spec's Shared interfaces 5. In short:

| Endpoint | What it gives |
| --- | --- |
| `GET /api/status` | chain id, head block, its age, stalled, fake |
| `GET /api/wallets/:address` | balance, epoch, height, leaves used, lanes in flight, hot policy, tickets {exported, used, left}, leaves {…} |
| `GET /api/wallets/:address/txs` | every lane, newest first: status, leaf, nonce key, mode, mempool, value, deadline, timeline, admission report, receipt, retryOf / retriedAs, maxCostWei |
| `GET /api/wallets/:address/lanes/plan` | what n lanes would hold and how many relay passes they take |
| `POST /api/wallets/:address/send` | `mode` keyed or hot, `mempool` alt or public, `firstAttemptExpirySeconds`, `retries` |
| `POST …/tickets`, `…/hot-policy`, `…/rotate` | admin calls |

Transaction statuses: Submitted, OnChain, Reverted, Included, Expired (leaf burned), Refused (leaf burned), Unknown.
For reference only (you cannot load them: they live on the real backend you must not touch), today's real records on
account 3, written up with every hash in `README-draft.md` sections 6.4 to 6.8, include:
- the 8-lane burst that landed in 2 blocks of 4 (2,272 and 2,275);
- a stuck payment and its retry (block 2,293);
- a hot ticket (block 2,300);
- two refusals by the account's own checks ("account: hot: value cap", "account: hot: frame target").

## How to run it safely

- **Never open, load, fetch, screenshot or automate anything on port 8787 or 5173,** not even headless and not even
  to look. They are Vicky's backend and screens on the **real devnet**, account 3; a page there polls the real backend,
  and any Pay, Play scene, Fire or Grant sends real transactions and spends leaves. Never point anything at
  `altmempool.forshtat.com`, `altmempoolgateway.forshtat.com` or `*.altmempool.wtf`.
- **Browser automation (CDP clicks, Play scene) only against your own stack** at `http://127.0.0.1:15173`, after
  checking that its status line shows the FAKE CHAIN mark (chain 31337).
- **Never read `~/.winterlock`** or `/Users/vicky/Documents/winterlock/pipeline/.data`.
- **Your own stack on the local FAKE chain**, with practice data only:
  ```sh
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
  cd /Users/vicky/Documents/winterlock-backend/fakechain && bun run.ts --port 18545 --block-time 3   # prints an env.sh path; wait for "ready"
  # in one shell:
  source <that env.sh> && cd ../backend && WL_BACKEND_PORT=18787 WL_SIGNER_BIN=/Users/vicky/Documents/winterlock-backend/signer/target/release/signer bun src/main.ts
  # another shell:
  cd /Users/vicky/Documents/winterlock-backend/web && WL_WEB_PORT=15173 WL_BACKEND_URL=http://127.0.0.1:18787 bun serve.ts   # http://127.0.0.1:15173/
  ```
  Every `WL_*` variable must come from that `env.sh`. When done, stop the stack:
  `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`.
- **Screenshots in headless Chromium** (already installed, nothing to download):
  ```sh
  CHS=/Users/vicky/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell
  "$CHS" --headless --disable-gpu --hide-scrollbars --window-size=1440,900 --virtual-time-budget=8000 --screenshot=out.png "http://127.0.0.1:15173/hot-cold.html"
  # dark: add --blink-settings=preferredColorScheme=0
  ```
  - Shoot at 375, 1024 and 1440 px, light and dark.
  - To click Play scene and catch the moments mid-animation, drive it over CDP: add `--remote-debugging-port=<port>`
    and use a small Bun WebSocket script.
  - Keep screenshots and scratch scripts outside the repo.
- **Tests:**
  - All must stay green.
  - Never weaken, delete or loosen an assertion (no `toContain` where there was `toBe`, no wider timeouts or bounds).
  - Never `.skip`, `.todo` or `.only` a test, and never delete a test file.
  - Change a test only where its markup really changed, and say which in your report.
  - Add tests for new view logic.
  - Run them with:
  ```sh
  cd /Users/vicky/Documents/winterlock-backend/web && bunx tsc --noEmit -p . && bunx tsc --noEmit -p public && \
    WL_NODE_URL=http://127.0.0.1:1 WL_GATEWAY_URL=http://127.0.0.1:1 bun test
  # if you touch the backend: the same in ../backend (bunx tsc --noEmit -p . && bun test)
  ```
  The web tests run on a fake DOM (`web/test/fake-dom.ts`). Guard browser-only APIs (`element.animate`, `matchMedia`)
  so the code runs there.

## Process

1. **Propose before building.**
   - Write a short design note: the problems as you see them, the direction, the layout of each screen at 1440 and
     375 px, the colours by state, the type, and what moves and when.
   - Build one static mock page of the hot-and-cold screen, outside the repo (for example in `/tmp/winterlock-mock/`).
     Its numbers come from `README-draft.md` sections 6.4 to 6.8 or from your fake stack, and it says "mock" on the
     page. Never link it from the app or copy it
     into `web/`.
   - Show Vicky screenshots at 1440 and 375, light and dark, and wait for her yes.
2. **Build** all four pages on the real wiring, hot-and-cold first, since it leads the video.
3. **Critique from screenshots** at every size, as Anthropic's frontend-design process does: build, look, remove what
   does not serve the story, fix. Shoot a Play scene in progress on the fake stack, so the moments are seen working.
4. **Run the tests,** then update `web/README.md`.
5. **AI attribution** (hackathon rule, plan section 1). In `/Users/vicky/Documents/winterlock-backend/README.md`,
   section "AI attribution", add a line naming the files you wrote or redesigned: "written with OpenAI coding assistant, driven
   and reviewed by Vicky". Only add: never delete or reword the existing Claude Code lines. If you substantially
   rewrite a file that a Claude Code line names, name it in your OpenAI-assistance line as "redesigned with OpenAI coding assistant" and leave the
   Claude line as it is. Fonts stay under "Not written by us".

## Rules

- Git is read-only for you: `status`, `diff` and `log` only. No `add`, `commit`, `stash`, `reset`, `checkout`, `switch`,
  `restore`, `clean`, `merge`, `rebase`, `cherry-pick` or `push`, and no branch changes. Vicky authors every commit.
- Nothing to any network except your 127.0.0.1 servers. No downloads without Vicky's OK.
- Never pick between the spec, the plan and the code silently: if they disagree, stop and ask Vicky (AGENTS.md).
- Short answers in easy words when you report to Vicky. She must explain every part to the judges.

## Done means

- In five seconds, a stranger can say what each screen shows and what to press. The primary action is unmistakable,
  and the lanes are visible next to it on a laptop.
- The screen feels alive: the chain ticks, lanes move through their states, and leaves burn visibly. Motion is
  meaningful and calm, and instant under reduced motion.
- Every control works; Play scene runs each story end to end on the fake stack with no console errors.
- No sideways scroll at 375 px; AA contrast in light and dark.
- The web suite and both type-checks are green (backend too if touched), with no assertion weakened.
- Report back with:
  - the list of files changed;
  - the test counts;
  - screenshot paths (375, 1024 and 1440 px, light and dark, plus mid-scene shots);
  - anything that needs Vicky.
