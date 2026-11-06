# Direction 2: the operations board

Winterlock runs payments the way a signal box runs trains: many lanes at once, each on its own track, each
consumed exactly once, all of them moving on one clock. This direction treats the lane board as a live
track diagram. Every lane is a row with the same three stations (admitted, pending, included) at the same
x position, so a glance down the board shows what is moving and where it stopped. A lamp lights while a lane
is in flight and goes out when its block lands. The chain's 6-second heartbeat is the only thing that moves
the chain side of the page.

Mock: `2-operations.html` (hot-and-cold screen, mempool and chain simulated in the page, no API).

## Subject, audience, job

- **Subject.** A post-quantum wallet whose one-time keys are leaves, each spent by the chain as a nonce key.
  Payments run as parallel lanes in the alt mempool. A stuck lane expires and its retry takes a fresh lane.
  The phone holds capped tickets; the laptop is the cold device.
- **Where the look comes from.** Live systems that run many things in parallel. A railway signal box's track
  diagram, where occupied track lights up. A departures board, where many services share one line format and
  change in batches. The station clock whose second hand waits at the top for the master impulse, then moves
  every clock at once. On this devnet that impulse is a block every 6 s.
- **Audience.** Ethereum Foundation judges at the booth, who read nonce keys and gas figures. Vicky driving
  the demo on a laptop. Anyone opening it on a phone.
- **Job.** See many lanes in flight at once. See each one land, get refused or expire, and why. Never lose
  count of tickets and leaves.

## Token system

### Colour

Five core colours, each with one role. The light theme is the "day shift" and the dark theme the "night shift".

| Token | Day shift | Night shift | Role |
| --- | --- | --- | --- |
| enamel | `#E3E8E4` | `#0E2A2F` | the desk (page): control-panel enamel by day, deep petrol by night |
| panel | `#F8FAF9` | `#133740` | the board, fields, tickets |
| ink | `#000000` | `#EDF6F3` | text, the track, landed lanes, primary buttons |
| lamp | `#F5B400` | `#FFC431` | a lane in flight, and nothing else |
| signal | `#C3162D` | `#FF7A7A` | refused, and the rotation warning |

Support tones, derived from the five: slate `#34443C` / `#A6C3BD` (secondary text), rule `#6B7C73` /
`#5F8589` (field borders, the unlit route ahead), hair `#C5D0CA` / `#24505A` (lines between lanes), wash
`#FBEFC8` / `#1C4852` (a lit row), spent `#000000` / `#6E9497` (a burned leaf).

Contrast (WCAG ratios, computed): day ink on enamel 16.9:1, slate on enamel 8.3:1, signal on panel 5.8:1
and on enamel 4.9:1, ink on a lit row 18.3:1, field borders on panel 4.2:1. Night ink on panel 11.6:1, lamp
text on a lit row 6.3:1, slate on a lit row 5.3:1, signal on panel 5.0:1, field borders on panel 3.2:1, a
burned leaf on panel 3.9:1. The day lamp fill is only 1.8:1 on panel, so every lit marker and cell carries a
2 px ink outline, and the state is always in words too. Day ink is true black, not a tinted near-black. The
night desk is a real colour (petrol), not black standing in for black.

### Type

- **B612** (designed for Airbus cockpit displays, SIL OFL) for all text and all numbers. Its figures are
  tabular by default, so gas and ETH columns align without a monospace face. Weights: 400 and 700 only.
- **B612 Mono** for hex only: lane ids, addresses, hashes, the root. A render test showed its comma and
  point take a full cell ("408, 262", "0. 25"), so it never sets a number.
- Scale (px): 12 (labels), 12.5 (hints), 13.5 (notices), 14 (body), 15.5 (lane ids), 19 to 21 (console and
  board titles), 24 (the ticket's leaf), 54 (tickets left). Sentence case everywhere. No all-caps, no
  eyebrow labels, no monospace labels.
- Final build: self-host both families as woff2 under `web/public/fonts`, so the screens make no
  third-party request (CROPS). The mock links Google Fonts.

### Shape, space, motion

- Spacing on a 4/8 rhythm: 4, 8, 12, 14, 18, 24, 28, 36 px. Rows get 12 to 14 px of padding; nothing is cramped.
- Radius follows hierarchy: the board 14 px (the one framed object, a display bezel), fields and buttons
  7 px, tickets 8 px, band cells 3 px, markers round. No shadows, no gradients.
- Rules: each console sits under a 3 px ink rule (a region of the desk, not a card). Hairlines appear only
  between lanes.
- Motion: ease `cubic-bezier(.3,.7,.2,1)`. A marker travels between stations in 550 ms, a torn ticket flies
  in 820 ms, rows shuffle in 380 ms, and landing lanes ripple top to bottom 120 ms apart. The block line
  flashes for 900 ms and a changed digit rolls for 340 ms. The dial sweeps for 5.52 s, then waits 0.48 s at
  the top for the block. With `prefers-reduced-motion` every animation and transition is off; the state
  still changes on the same clock, in place.

## Principles

1. **What moves is lit; what landed is ink.** Lamp amber means "in flight" and nothing else: no amber
   buttons, no amber decoration. When a lane lands, its lamp goes out.
2. **Status is a place on the track.** Every row has the same stations at the same x, so markers line up
   in columns like a track diagram. The words next to the track say the same thing, so colour is never alone.
3. **The chain sets the tempo.** All chain-side motion happens on the block: the dial reaches the top, the
   block number rolls, the lanes in that block land together. Between blocks the board is still.
4. **One framed object.** Only the lane board has a frame. The phone and the cold device are consoles on the
   desk.
5. **Numbers are instruments.** Tabular figures, units always written (ETH, gas, s), digits roll only when
   the value really changed.
6. **The spec's words only:** leaf, lane, hot band, ticket, hot policy, expiry, burned, rotation, admitted,
   included, refused, plus the existing screens' pending, block and set aside.

## Layout

Left-aligned throughout; text measures under 80 characters except the board's footnote. The page is a CSS
container, so the desk responds to its own width, and the board is a second container whose rows reflow by
the board's width.

Track symbols used below: `o` start, `+` station tick, `@` lit marker (in flight), `#` landed (ink square),
`O` hollow marker (burned), `|` red signal (refused), `[` deadline stop (expired), `:` the block line.

### Hot and cold, laptop (1480 px and wider): phone, board, cold device

```
Winterlock   Hot and cold   Agent   Session
================================================================================================
Wallet          Balance        Epoch   Leaves used    Tickets on the phone
0x66a503…D38A   9.947698 ETH   0       12 of 1,024    3 of 10
13:22:37  Cold device sent 0.25 ETH on lane 0x2 (leaf 2): admitted.             <- the log line
[Play scene]  The cold device cuts tickets if the phone has fewer than 7, then goes offline; …

========== .--------------------------------------------------------------. ============
Phone      | Lane board                    (dial) block 408,262   @ 1 lane | Cold device [ ] Offline
the ticket | Each row is one lane: a nonce key…  chain 1337, a block every 6 s | Key tree
device…    | Mempool [alt|public]  Parallel lanes: one pending per lane …    | Height 10  Epoch 0
           | Set aside for pending: 0.250198 ETH on 1 lane (…)               | Leaves used 12 of 1,024
3  of 10   | Lane   Leaf      Action                  Amount        Gas      | Root 0x9b31e0…7f4c2a
tickets…   |          admitted        pending          included            | Hot band, 1008 to 1023
.-.------. | 0x2    2         pay 0x5544…16f9         0.25 ETH   86,940     | [#][#][#][#][#][#][#][ ][ ][ ]
|:|leaf  | | o--+============@ . . . . . . : pending for 9 s       explorer | [.][.][.][.][.][.]
|:|1015  | | 0x3f6  1014 hot  hot ticket to 0x53c9…6356  0.001 ETH  -        | 7 burned, 3 on the phone,
|:|lane  | | o-O|                          : refused: target not allowed    | 6 not cut
|:|0x3f7 | | 0x3f4  1012 hot  hot ticket to 0x2c58…C537  0.01 ETH   88,019   | ---------------------------
'-'------' | o--+--------------+-----------# included in block 408,230      | Transfer: To, Amount,
To (read)  | … nine rows, newest first                                       | [Send from cold]
Amount     | footnote: how parallel lanes run on this devnet                 | Hot policy: caps, target,
[Pay] [Simulate stuck payment]                                               | hot start, [Set policy]
> Why the stuck payment expires                                              | Tickets for the phone:
Set aside for pending: …                                                     | Count [6] [Cut tickets]
           '--------------------------------------------------------------' | Rotation (red warning)
                                                                              | [Rotate root]
================================================================================================
backend (via this server)   chain 1337   latest block 408,262, 2 s ago
Prototype. Mempool and chain simulated in page.
```

From 900 to 1479 px the phone stays left of the board and the cold device becomes a band of groups under
both (key tree, transfer, hot policy, tickets, rotation side by side). The board's rows switch to one line
each once the board itself is at least 1000 px wide; then the block line runs unbroken through every row.

### Hot and cold, 375 px: phone, board, cold device

```
Winterlock  Hot and cold  Agent  Session
=========================================
Wallet            Balance
0x66a503…D38A     9.947698 ETH
Epoch  Leaves used   Tickets on the phone
0      12 of 1,024   3 of 10
13:22:37  Cold device sent 0.25 ETH on
          lane 0x2 (leaf 2): admitted.
[Play scene]
The cold device cuts tickets if …
=========================================
Phone
3  of 10
.-.-------------------------------------.
|:| next ticket, leaf 1015              |
|:| lane 0x3f7                          |
|:| up to 0.01 ETH, only to 0x2c58…C537 |
'-'-------------------------------------'
To, the allowed target  [read-only]
Amount, ETH             [0.001]
[Pay] [Simulate stuck payment]
> Why the stuck payment expires
.---------------------------------------.
| Lane board                            |
| (dial) block 408,262   @ 1 lane       |
| Mempool [alt|public]                  |
|    admitted   pending   included      |
| 0x2  leaf 2              0.25 ETH     |
| pay 0x5544…16f9          gas 86,940   |
| o--+=========@ . . . . . . :          |
| pending for 9 s           explorer    |
| 0x3f6  leaf 1014 hot    0.001 ETH     |
| …                                     |
'---------------------------------------'
=========================================
Cold device                  [ ] Offline
… groups stacked
```

### Agent, laptop

```
Winterlock   Hot and cold   Agent   Session
================================================================================================
Wallet …   Balance …   Epoch 0   Leaves used …   Tickets 4 of 16
14:05:02  Block 408,270 included lanes 0x3f8 and 0x3f9.
[Play scene]  Cuts tickets if the agent has fewer than 6; the mock price falls and the rule fires …

========== .--------------------------------------------------------------. ============
Market     | Lane board                     (dial) block 408,270  @ 2 lanes | Allowance
mock price,| Mempool [alt|public]                                         | 4 of 16 tickets left
not a feed | Lane   Leaf      Action                    Amount    Gas      | Value cap 0.01 ETH
2,412.08   |          admitted        pending          included          | Target 0x2c58…C537
-2.4 % in  | 0x3fb  1019 hot  hot ticket to 0x2c58…C537  0.01 ETH  87,642  | Max loss: tickets left times
30 s       | o--+============@ . . . . . . : pending for 2 s              | the caps, only to 0x2c58…C537
(spark,    | 0x3fa  1018 hot  …                                          | Expires in -   (proposed)
window lit)| o--+============@ . . . . . . : pending for 2 s              | [Renew from cold device]
Rule text  | 0x3f9  1017 hot  …                                          | [Stop renewing]  (off)
[x] Rule armed | o--+-----------+-----------# included in block 408,270   | Set aside for pending …
[Drop the mock price 3 %] [Fire now]                                       | [Server compromised]
Parallel-lanes plan: 4 lanes, 1 relay pass, about 28 s                     |
Event log  | …                                                           |
14:05:02 rule fired, lanes 0x3f8 to 0x3fb                                 |
           '--------------------------------------------------------------'
```

At 375 px: market (with Fire), board, allowance, event log. The allowance shows the agent's tickets as the
same perforated stack as the phone, fanned to the count left.

### Session, laptop

```
========== .--------------------------------------------------------------. ============
Dapp       | Lane board                     (dial) block 408,281  @ 3 lanes | Wallet
each click |                                                              | Session request
is one     | Lane   Leaf      Action                  Amount   Gas         | 20 actions, 0 ETH,
transaction| 0x3fc  1020 hot  hot ticket to 0x2c58…C537  0 ETH  86,811  | the game contract, 2 h
+--+--+--+--+--+--+ | o--+============@ . . . . . : pending for 1 s         | [Grant tickets] [Decline]
|  |@ |  |# |  |  | | …                                                   | --------------------------
+--+--+--+--+--+--+ |                                                     | Session
|# |  |@ |  |X |  | |                                                     | tickets left, counting down
+--+--+--+--+--+--+ |                                                     | caps, Expires in - (proposed)
 … six rows   |                                                             | [End session]  (not built)
moves 8  included 5  refused 0                                              | Set aside for pending …
```

Grid cells: `@` lit (that move's lane is in flight), `#` ink (included), `X` struck (refused), blank (free).
At 375 px: the grid, the board, then the wallet sheet.

## The lane board

```
Lane    Leaf        Action                      Amount       Gas
          admitted              pending                    included
            +                     +                           +
0x3f7 > 1015 [hot]  hot ticket to 0x2c58…C537    0.001 ETH   87,028
o-------+=====================@ . . . . . . . . . . . . . . . :     pending for 4 s        explorer
```

- **Columns** stay: lane (the nonce key, bold mono, also the disclosure button), leaf (with a small
  perforated "hot" tag for ticket leaves), action, amount, gas (verify-frame gas), and the status timeline,
  drawn as a track plus words.
- **Stations** at fixed fractions of the track: admitted 14 %, pending 56 %, included 94 %. The header
  carries the station names with ticks that point down at them.
- **States.** Signed: marker at the start, row lit; this lasts only while the request is out. Admitted: the
  marker reaches the first station. Pending: the marker waits at the pending station, the row is lit, and
  the words count the seconds. Included: the marker becomes an ink square on the block line, the lamp goes
  out, and the words say "included in block 408,265". Refused: the track stops at a red signal before
  admission, with the reason ("exceeds value cap", "target not allowed", or "the public mempool holds one
  pending per sender") and "leaf burned". Expired: the marker stops at a deadline stop. The words say
  "expired, leaf burned" and link "retried as lane 0x3fa". The retry row links back "retry of lane 0x3f9,
  not re-signed: a fresh leaf on a fresh lane".
- **The block line** is a dashed vertical at the included station. On a wide board it is one line through
  every row; on narrower boards each row carries its segment. When a block lands it flashes lamp-coloured
  once.
- **Three widths, by the board's own size:** under 600 px each lane is a four-line block (facts, action and
  gas, track, words). From 600 px the facts take one line with the track and words under them. From 1000 px
  everything sits on one line.
- **Details.** The lane id opens a drawer with the admission report (pass and fail per rule), the receipt,
  the timeline with clock times, the facts (transaction, lane, leaf, mode, mempool, to, verify gas, max
  cost) and "Open in the explorer". A click anywhere on the row does the same.
- **Around the rows:** "Set aside for pending" under the head, the Mempool switch with a one-line rule
  that changes with it, and the devnet's lane limits as a footnote.

## The one orchestrated moment per key action

| Action | The moment |
| --- | --- |
| **Pay** (the signature moment, working in the mock) | The phone's top ticket (leaf 1015, lane 0x3f7) tips at its perforation and flies into a new row at the top of the board. The other rows make room. The count rolls 3 to 2, and leaf 1015 lights in the cold device's hot band. The marker runs to admitted, then pending, and waits, lit. On the next block the dial reaches the top and the block number rolls. The block line flashes, the lanes in that block land in a top-to-bottom ripple, and leaf 1015 burns: an ink fill rises through its cell. If Pay comes before the first relay pass (about 13 s after load), the phone's lane lands in the same block as the cold device's 0.25 ETH lane. |
| Simulate stuck payment | Same tear. A dotted deadline stop sits ahead of the lit marker and the words count down the 4 s. The block passes without it, the marker hits the stop, the leaf burns, and the next ticket tears by itself onto a fresh lane, linked both ways. |
| Refused (public mempool, or caps) | The marker stops at a red signal before admission; the leaf burns at once and the log line turns red with the reason. |
| Block landing (the chain, every 6 s) | The only moment nobody triggers. The dial and the rolling block number always move; flash and ripple happen only when a lane lands. |
| Cut tickets | The cut leaves turn from "not cut" to "on the phone" one after another (80 ms apart), and the phone's stack grows. |
| Send from cold, Set policy | A cold row drops in at the top (no ticket: the cold device signs from the seed) and runs the same track. Set policy changes the caps, the ticket's printed terms and the phone's cap line when it is included. |
| Rotate root | The first press arms it: the button fills signal red and reads "Confirm: rotate root" for 6 s. While a lane is in flight the log says the backend refuses. |
| Offline | The cold console dims and its rule turns dashed; the phone keeps paying. |
| Mempool switch | The one-line rule under it changes (one pending per lane, or one pending per sender) and the log explains it; lanes sent afterwards carry a "public" tag. |
| Agent: Fire | Four tickets tear from the allowance stack 90 ms apart into four lit lanes. They land over one or two blocks, so the ripple comes in two waves. |
| Agent: Server compromised | Two lanes run straight into red signals: "exceeds value cap", "target not allowed". The max-loss line recomputes. |
| Session: a grid click | The cell lights as its lane is admitted. When the block lands, the cell and its lane go dark in the same ripple. In public mode the cells behind a pending one are struck through as refused. |

## Review against the brief and the generic tells

What I first reached for, and what changed:

1. **First instinct:** a near-black board with amber dot-matrix type (a Mumbai platform indicator), split-flap
   flips on every status, all-caps headers like a real departures board. That is tell 2 (near-black plus
   one bright accent), all-caps labels and motion everywhere. **Now:** an enamel desk with true black ink by
   day and petrol by night; digits roll only when they change; the only chain-side motion is the block.
2. **Status pills** (green, amber, red) per row: the generic dashboard, with meaning carried by colour
   alone. **Now:** status is a position on a track plus words; colour is only lit or signal; landed lanes
   go quiet.
3. **Three rounded cards with soft shadows** (tell 4). **Now:** no cards and no shadows; consoles sit under
   a heavy rule; only the board is framed, and radius follows hierarchy.
4. **Hairlines, zero radius, dense columns everywhere** (tell 3, the broadsheet). **Now:** heavy section
   rules, hairlines only between lanes, generous rows, one rounded bezel.
5. **The block number as a hero stat** (big number, small label). **Now:** the hero is the board; the block
   number is an instrument in the board's head beside its dial.
6. **A monospace face for every number.** **Now:** B612's tabular figures; mono only for hex, after the
   render test showed B612 Mono's comma.
7. **An amber Pay button.** **Now:** amber is reserved for "in flight"; buttons are ink.
8. **Auto-scrolling to the new row on a phone.** **Now:** no scroll jump; off screen the ticket simply
   tears away, and the log line names the lane.

Checked against the brief's list: no Inter, no gradients, no nested cards, no grey text on colour, no icon
tiles, no cramped padding, no all-caps, no monospace labels, no middle-dot strings, no tinted near-black,
no cream and terracotta, no arrows on links.

## What makes it unlike common AI UIs

- **Status is spatial.** The board is a track diagram. A column of lit markers at "pending" reads like the
  waiting line on a departures board, and you see eight lanes land over two blocks as two waves.
- **A real clock drives it.** The dial, the rolling block number and the landing ripple come from the
  chain's 6 s heartbeat (in the build, from `GET /api/status`), not from hover effects or page-load fades.
  When the chain stalls, the dial stops before the banner even appears.
- **A control room's palette.** Enamel and true black by day, petrol by night, one lamp colour with one
  meaning.
- **B612, a cockpit display face,** instead of the usual Inter or Geist.
- **One skeuomorphic object, because it is the product's unit:** the ticket, perforated, printed with its
  leaf, lane and caps, torn off on Pay.

## How it maps onto the existing controls

Hot and cold (`web/public/hot-cold.html`): every control stays; only places and styling change.

| Existing | In this direction |
| --- | --- |
| `header.top` brand and screen nav | top bar; the current screen underlined 3 px |
| `#banner`, `#banner-retry` (stalled chain) | a signal-red bar under the top bar, "Try again" kept |
| `#wallet-head` | the wallet strip; "lanes in flight" moves into the board head beside the clock |
| `#notice` (`role="status"`) | the log line: clock time, then one sentence; red when it reports an error |
| `#scene-fields`, `#play` and its hint | the run line: Play scene and the same paragraph |
| `#phone-pane` | Phone console: left at 900 px and wider, first on a phone |
| `#ticket-count`, `#ticket-note`, `#device-issue` | the big "3 of 10", the note, the device warning; plus the ticket stack (next leaf, lane, terms) |
| `#pay-form`: `#pay-to` (read-only), `#pay-amount`, `#pay-cap`, `#pay-problem` | unchanged, with the cap checked inline |
| `#pay`, `#stuck` and the stuck hint | Pay (ink) and Simulate stuck payment (outline); the hint moves into "Why the stuck payment expires", a disclosure with the same text |
| `#phone-set-aside` | unchanged, under the phone |
| `.board`, the Mempool radios | the board head: title, dial and block, lanes in flight, Mempool switch with its rule line |
| `#set-aside`, `#lane-limits` | under the board head, and the board's footnote |
| `#lanes` (Lane, Leaf, Action, Amount, Gas, status timeline) | same columns; the timeline becomes track plus words; the lane id opens the admission report; retry links and explorer links stay |
| `#cold-pane`, `#offline` | Cold device console (right, a band below, or last); offline dims it and dashes its rule |
| `#tree-summary` | Key tree facts plus the hot band strip and its legend (burned, on the phone, not cut, in flight) |
| `#transfer-form` (`#transfer-to`, `#transfer-amount`, `#transfer`, `#transfer-problem`) | Transfer group, unchanged |
| `#policy-form` (`#policy-value`, `#policy-fee`, `#policy-target`, `#policy-start`, `#policy-set`) | Hot policy group, unchanged |
| `#cut-form` (`#cut-left`, `#cut-count`, `#cut`) | Tickets for the phone, unchanged |
| `#rotate-form` (`#rotate-height`, `#rotate`, the warning) | Rotation: the warning in signal red, two-click confirm |
| footer `#status` (backend, chain, block age, FAKE CHAIN) | footer; FAKE CHAIN becomes a signal-red "fake chain" tag in sentence case |

Agent (`agent.html`): Market keeps `#price`, `#change`, `#spark` (the 30 s window shaded in lamp only while
the rule is armed), `#spark-readout`, `#rule-text`, `#armed`, `#drop`, `#fire`, `#fire-hint` and
`#fire-plan`. Allowance keeps `#allowance`, `#device-issue`, `#max-loss`, `#agent-set-aside`, the disabled
"Expires in", "Renew from cold device" and "Stop renewing" with their "proposed (Level B)" note, and
`#compromised`. The event log `#log` keeps its order, set in B612 with clock times. The board and Mempool
switch are as above.

Session (`session.html`): `#grid` (6 by 6, each cell a button whose state mirrors its lane),
`#moves`, `#moves-in` and `#moves-out` stay. So do the sheet's `#request`, `#grant-note`, `#grant-plan`,
`#grant` and `#decline`; the card's `#left`, `#left-note`, `#device-issue`, `#caps` and
`#session-set-aside`; the disabled "End session" with its "not built" note; and the comparison line.

## Building it into `web/`

- `style.css`: the tokens above replace `:root`; consoles, board, track and ticket rules come from the mock.
  Layout uses container queries (page and board); no framework, no build step.
- `board.js`: replace the timeline list with the track. A row's `data-state` is `statusOf()` (admitted and
  pending light the row), `--p` is the station of the latest step, and the step's block number feeds
  "included in block N". The words are the existing labels.
- `ui.js`: set the dial's phase from `GET /api/status` (`headAgeSeconds` mod 6) on each status poll, and
  pause the hand while the chain is stalled.
- `hot-cold.js`: the stack shows the lowest unused ticket (the one the device signs next); the hot band
  comes from `hotStart`, `tickets` and the in-flight hot records.
- Nothing new is needed from the backend: steps with block numbers, `maxCostWei`, `retryOf` and `retriedAs`
  already exist.

## Notes on the mock

- **Data** is the brief's, with one change. The mid-flight lane is the cold device's 0.25 ETH transfer on
  lane 0x2 (leaf 2), pending when the page opens: the two devices with lanes in flight at once, as the spec's
  hot-and-cold story says. That keeps the phone at 3 of 10 tickets, and leaves used reads 12 of 1,024: the
  brief's 11 plus that cold leaf. A hot mid-flight lane would have made it 2 of 10 tickets instead.
- **Simulation:** a block every 6 s and a relay pass every 10 s (the first 15 s after load) carrying up to 4
  lanes. Public lanes go straight to the next block. A stuck lane is never relayed and expires at the first
  block after its 4 s deadline. Fees (about 1 gwei times 193,882 gas) and the admission rule wording are
  illustrative.
- **To try:** press Pay within about 13 s of opening and both devices' lanes land in one block. Simulate
  stuck payment shows the expiry and retry. Switch to public and pay twice for the refusal. Play scene runs
  the whole story in about 30 s. Add `?theme=dark`, or use the footer's preview control.
- **Verified:** a test drove the page's own script in a simulated DOM (linkedom, time sped up 20 times)
  with reduced motion on and off: every control, the stuck path, the public refusal and the full Play scene,
  with no script errors. Quick Look renders checked 1512, 1440, 1280 and 375 px in both themes. Headless
  browsers are blocked in this sandbox, so the animations themselves are untested on screen: look at Pay
  once in a real browser.
