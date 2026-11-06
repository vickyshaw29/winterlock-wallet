# Direction 3: the key tree

The wallet's 1,024 one-time keys are the interface. Every screen is built around one plate: the leaf field of
the current tree, drawn like a figure in a cryptographic specification. Each payment visibly spends one cell of it,
and the chain fills that cell in. The panes are the figure's annotations, the lane board is its table, and the
WOTS+ signature has a picture of its own: 67 chains, each with its digit.

Mock of the hot-and-cold screen: `3-keytree.html` (static, nothing wired; Pay runs the one moment).

## 1. Grounding

- **Subject.** A stateful hash-based wallet. The most characteristic thing in its world is the finite stock of
  one-time keys: the 2^10 leaves of the tree, the hot band at the end, and the rule that a leaf is spent once,
  by the chain, at approval. No other wallet has this thing, so it gets the first look.
- **Audience.** EF judges at the booth (they know XMSS and Merkle paths), Vicky giving the walkthrough, and
  anyone who has never seen a one-time key and needs to see why "never sign a leaf twice" matters.
- **Primary job.** Show at a glance which keys are spent, which are in flight, which sit on the phone, and what
  each lane did with its key; then let the person act (pay, cut, set policy, rotate) with the result visible on
  the same figure.
- **Vernacular and materials.** Scientific publishing (RFC 8391 and FIPS figures, STIX math setting, italic
  variables, set notation), instrument displays (cockpit legibility, exact readouts), cyanotype blueprints
  (Prussian blue on white), the perforated stub of a paper ticket, sodium-vapour light for "hot".

## 2. Token system

### Colour

Six named values; light first, dark beside it. Text pairs checked (WCAG ratios in brackets).

| Name | Light | Dark | Role |
| --- | --- | --- | --- |
| Frost | `#EEF3F5` | `#0B1E33` (Prussian night) | page ground. Cool, never cream; the dark ground is a clear deep blue, not a tinted near-black |
| Ink | `#000000` | `#EAF1F6` | text, and a leaf the chain has burned (pure black, no near-black stand-in) |
| Slate | `#3C5566` | `#A9C1D6` | secondary text, a tint of the ground's hue, never neutral grey (7.0 and 9.05) |
| Prussian | `#0A4D8C` | `#86BBF2` | the in-flight state only: a signed leaf whose lane is admitted or pending; primary buttons (7.65 and 8.34) |
| Sodium | `#F2B807` | `#F2B807` | the hot band's ground and the phone's tickets; always carries black or night text (11.6 and 9.3) |
| Frostline | `#9FB0B9` / strong `#6B818D` | `#3A5874` / strong `#5F7E9B` | hairlines; the strong line for inputs and the field's cell outlines (3:1 for components) |

Rules: Prussian means "in flight" and nothing else. Sodium means "hot band" and nothing else. Burned is ink.
There is no red: a refusal is a hatched leaf and a sentence, the same mark as an expiry, because both mean the
journal burned a leaf the chain never consumed.

### Type

- **STIX Two Text** (OFL; the face of scientific journals): the specification voice. Screen and section titles,
  the plate caption, prose hints, the big figures (balance, tickets left), and formulas. Variables are italic,
  as in mathematical setting, everywhere they occur: *key* = (*epoch* ≪ 32) ∣ *leaf*, 2^*h*, *i* ∈ [1008, 1023].
  That is a convention applied to every variable, not one word picked out for flair.
- **B612** (OFL; designed with Airbus for cockpit displays): the instrument voice. Controls, field labels,
  lane board cells, the status line. Sentence case, never tracked capitals.
- **B612 Mono**: hex only (addresses, lane keys, hashes, roots), where a reader compares characters. Leaf
  indexes, gas and amounts use B612 with tabular figures, not the mono: they are numbers, not labels.
- Scale (Bringhurst's classic progression): 11, 12, 14, 16, 21, 28, 36 px. Body 14/22 in B612, prose hints 16/26
  in STIX (serif gets the longer leading), plate caption 21, screen title 28, the balance 36. Measure under 72
  characters for every hint.

### Layout concept

A specification sheet with one figure. The leaf field sits in the middle as a square plate; the cold device and
the phone are its annotations, each tied to its band by a hairline leader: the cold pane to the cold band, the
phone pane to the sodium strip. Below the plate, a readout of the selected leaf (its key, its state, its
signature picture). The lane board runs full width under everything, as the figure's table. Text is left
aligned throughout; numbers right aligned in the board; the plate is centred in its column.

### Principles

1. **One glyph language.** A leaf has five marks and they mean the same thing on the plate, in the lane board's
   leaf cell, on the phone's tickets and in the session grid: outline (unused), Prussian ring (signed, in flight),
   ink square (burned by the chain: key consumed at approval), hatched square (burned by the journal: signed,
   refused or expired, never included), struck cell (void: leaf 0 at epoch 0 would be key 0, the legacy nonce,
   which the account refuses).
2. **Exact or silent.** Every number on screen is one the backend or the chain gave, or it is labelled example.
   The plate shows real state, never decoration: no particles, no glow, no fake activity.
3. **The figure answers.** Every action ends as a change on the plate: a ring appears, a square fills, a band
   moves, a new tree is drawn. Motion only shows that change, once.
4. **Annotation, not containers.** Panes are not cards. They are text blocks with hairline leaders and rules,
   on the same ground as the plate. One border-radius (2 px) for inputs and buttons, none elsewhere.
5. **Spend the boldness on the plate.** Everything around it is quiet B612 on frost.

## 3. Review against the brief and the tells

First plan, then what I changed:

- *Draft:* a navy blueprint page with white line art and a cyan accent. **Changed:** that is "near-black with one
  bright accent" in a blue coat, and it reads sci-fi. Now: cyanotype inverted, Prussian ink on frost in light
  mode, Prussian night only in dark mode, and the accent is a state (in flight), not a decoration.
- *Draft:* the panes as white cards with soft shadows around the plate. **Changed:** the SaaS-card kit. Now
  annotations with leaders on one ground; the only filled areas are leaves and tickets.
- *Draft:* red for refused, green for included. **Changed:** traffic-light status is the default of every
  dashboard and makes refusal look like an error page. Now the leaf's own mark carries the state (ink, hatch,
  ring), and colour carries only "hot" and "in flight".
- *Draft:* JetBrains Mono for every label, ALL-CAPS column heads, "LANE · LEAF · GAS" meta strings. **Changed:**
  B612 sentence-case labels, mono for hex only, meta written as sentences ("leaf 1014, burned: refused").
- *Draft:* an amber accent on cream for the hot band. **Changed:** too close to the cream-and-clay tell. Sodium
  sits only under the sixteen hot leaves and the tickets, on a cold ground, so it reads as heat inside winter.
- *Draft:* numbered section markers. **Removed:** the panes are not a sequence. The only numbers on screen are
  leaf indexes, levels of the authentication path and timeline steps, which are sequences.
- *Checked against:* Inter for everything (no), purple-to-blue gradients (none: no gradients at all), nested
  cards (none), grey text on coloured grounds (secondary text is a tint of its ground's hue; sodium carries black),
  rounded icon tiles (no icons), cramped padding (8 px base grid, 24 px between groups, 48 px around the plate),
  all-caps labels (none), mono small labels (no), middle-dot meta (no), tinted near-black (pure black ink),
  cream and terracotta (no), arrows appended to buttons (no).

## 4. The plate (the leaf field)

- 32 by 32 cells, filled column by column: leaf *i* sits in column ⌊*i*/32⌋, row *i* mod 32, so each column is a
  subtree of height 5 and the stock reads left to right like a tape, cold leaves spent from the left. The hot band
  (leaves `hotStart` to 1023) is then the lower half of the last column, a sodium strip on the plate's right edge,
  right beside the phone's annotation; its bracket in the right gutter reads *i* ∈ [1008, 1023]. Column ticks on
  top give the first leaf of every eighth column (0, 256, 512, 768), row ticks on the left the offset (0, 8, 16, 24),
  in STIX numerals.
- Caption above: "Key tree, epoch 0", then one sentence: "1,024 one-time keys for chain 1337. Leaf *i* signs only
  on lane *key* = (*epoch* ≪ 32) ∣ *i*, at sequence 0, and the chain burns that key when it approves the payment."
  Legend below, one entry per mark, in the plate's own glyphs.
- Hover or focus a cell (arrow keys move within the plate, which is one tab stop): the readout shows leaf, key
  (*key* = (0 ≪ 32) ∣ 1014 = 0x3f6), state in words, the lane it signed, and for a signed leaf its signature
  picture. A lane row selected on the board selects its leaf on the plate, and the other way round.
- **Signature picture.** The WOTS+ signature as a material: 67 columns of 16 cells, one per chain (64 message
  digits, a gap, 3 checksum digits). In each column the cells up to the digit are ink (the hashing the signer did,
  which the signature reveals the result of), the cells above are outline (the 15 − *d* steps the verifier hashes
  to reach the chain end). Every signature has a different skyline because every sig hash has different digits; it
  is drawn from the transaction's own sig hash, not invented. Under it: "2,144 bytes, 67 chains, *w* = 16" and the
  authentication path as 14 rungs (levels 0 to 9 in the chain's subtree, 10 to 13 the slot layer).
- **Rotation as a new tree.** The rotation block shows the next epoch's plate as an outline thumbnail. On Confirm,
  the current plate's in-flight rings turn to hatches with "invalidated by rotation", the thumbnail slides into
  the plate's place, the caption's epoch increments, and the old plate stays one step back as a small drawing
  ("epoch 0, 12 of 1,024 used") so the history is still readable.

## 5. Wireframes

### Hot and cold, laptop (1280 px and up)

```
 Winterlock     Hot and cold   Agent   Session                        chain 1337, block 408,262, 4 s ago
 ────────────────────────────────────────────────────────────────────────────────────────────────────────
 0x66a503…D38A      9.947698 ETH      epoch 0      11 of 1,024 leaves used, 1 in flight      3 of 10 tickets
 [Play scene]  The cold device cuts tickets if the phone has fewer than 7, then goes offline; ...

                                     Key tree, epoch 0 (STIX 28, the caption)
  Cold device   [ ] Offline ───────  0   256  512  768        (column ticks)
   the laptop: cold band 1 to 1007  0 ⧄□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□
  Key tree                            ■□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□   (leaf 1 burned,
   height 10, root 0xd0c4…b691ae      ◌□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□    leaf 2 in flight)
  Transfer (any address, no cap)      ...
   To [0x…], Amount [ ] [Send from cold]
  Hot policy                       16 □□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□■ │ hot band
   Value cap [0.01] Fee [0.002]       □□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□▨ │ i ∈ [1008, 1023] ──── Phone
   Target [0x2c58…] Start [1008]      □□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□▤ │                  3 of 10
   [Set policy]                       □□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□░ │                  stubs 1008 … 1017
                                      (the sodium column: ■ burned, ▨ refused, ▤ ticket, ░ not cut)
                                                                                      To [0x2c58…C537, read-only]
                                                                                      Amount [0.001] cap 0.01 ETH
                                                                                      [Pay] [Simulate stuck payment]
                                                                                      set aside for pending: ...
   [Set policy]                      Legend: □ unused  ◌ in flight  ■ burned by the chain
  Tickets for the phone                      ▨ burned by the journal  ⧄ void (key 0)
   6 hot leaves not cut  [10][Cut]   Readout: leaf 1014, key 0x3f6 = (0 ≪ 32) ∣ 1014,
  Rotation (epoch 1 thumbnail)        burned by the journal: refused, target not allowed
   [11] [Rotate root]                 Signature ▁▃█▅▂▇▁▄ ... (67 columns)   path: 14 rungs

  LANE BOARD                                                      Mempool (alt | public)
  set aside for pending: 0.25 ETH on 1 lane (values only) ...
  Lane    Leaf        Action                        Amount       Gas      Status
  0x3f6   ▨ 1014 hot  hot ticket to 0x53c9…6356    0.001 ETH        —     ◌ admitted ✕ refused  target not allowed
  0x2     ◌ 2         pay 0x5544…16f9              0.25 ETH         —     ◌ admitted ◌ pending +1.2 s
  ...
 ────────────────────────────────────────────────────────────────────────────────────────────────────────
 backend (via this server)   chain 1337   latest block 408,262, 4 s ago        Prototype. Mempool and chain simulated in page.
```

(The capitals in the sketch mark blocks only; the build sets every heading in sentence case.)

### Hot and cold, 375 px

```
 Winterlock                    ≡ screens
 0x66a503…D38A   9.947698 ETH
 epoch 0, 11 of 1,024 used, 1 in flight
 3 of 10 tickets
 [Play scene]
 ┌ plate, full width, 32 × 9 px cells ┐
 │ ⧄■◌□□□□□...                        │
 │ ...                                │
 │ ...□□□□□□□□□□□□□□□□□□□□□□□□□□□□□▤  │  ← last column, lower half: the sodium hot band
 └────────────────────────────────────┘
 Legend (two lines)   Readout (leaf, key, state)
 Signature: 67 columns at 4 px
 Phone (first: it is the daily device)
  ticket stubs, 3 of 10, pay form, [Pay] [Stuck]
 Cold device (offline toggle at the top)
  key tree, transfer, hot policy, cut, rotation
 Lane board: each lane a block
  0x3f6  leaf ▨ 1014 hot   0.001 ETH   gas —
  hot ticket to 0x53c9…6356
  ◌ admitted  ✕ refused: target not allowed
```

At 375 px the leaders become a sodium or plain band marker at the top of each pane (the same mark as the band
it annotates), and the phone pane comes before the cold pane, because the phone is the device in the hand.

### Agent, laptop

```
 header and wallet line as above; [Play scene]
  MARKET (mock price)           ALLOWANCE PLATE                          ALLOWANCE
  2,412.06  −2.31 % in 30 s     hot band only, drawn large:              tickets 14 of 20, value cap 0.1 ETH
  ╱╲__╱‾╲__  (sparkline,        20 tickets as 2 rows of 10 cells          target 0x…router (allowed target)
   last 30 s in Prussian)       ■■■■◌◌◌◌░░                                max loss if the server is taken:
  If price falls more than      ░░░░░░░░░░                                 14 × (cap + fee cap), to the router
  2 % in 30 s, buy in 4         each tranche rings one cell at once;      Expires in —  [Renew] [Stop renewing]
  tranches.                      cells burn out of order as lanes land     proposed (Level B), not built
  [x] Rule armed [Drop 3 %]                                              [Server compromised]
  [Fire now]  plan line          then the whole tree, small, beside it    EVENT LOG (STIX, timestamped lines)
 LANE BOARD (as hot and cold)
```

The four tranches are the plate's moment: four Prussian rings appear in the same frame, then fill one by one in
the order the chain includes them. Server compromised: two more cells hatch, each with a short leader to its
reason ("exceeds value cap", "target not allowed") written beside the plate.

### Agent, 375 px

```
 wallet line, [Play scene]
 Market: price, change, sparkline, rule sentence, [x] armed [Drop] [Fire]
 Allowance plate (2 × 10 cells, 24 px each) and the allowance facts
 [Server compromised], expiry row (disabled, proposed)
 Event log (last 8 lines, scrolls)
 Lane board blocks
```

### Session, laptop

```
 header, wallet line, [Play scene]
  DAPP: each click is one transaction      WALLET: session request
  6 × 6 grid of game cells; a cell you     20 actions, 0 ETH, the game contract, expiry 2 h
  played wears its leaf's mark:            [Grant 20 tickets] [Decline]
  ◌ waiting for inclusion, ■ included,     then the session card: tickets left as a 20-cell
  ▨ refused (public mempool), with the     strip that burns from the left, the caps,
  leaf number in the corner               Expires in — [End session] (not built), the comparison line
  moves 8, included 6, refused 0
 LANE BOARD
```

The game grid and the ticket strip are the same object seen twice: playing cell (3, 4) rings ticket 1012 in the
strip, and both fill when the lane is included. In public mode the seven waiting moves show the ring with a
dashed stroke and the word waiting; refused ones hatch.

### Session, 375 px

```
 wallet line, [Play scene]
 Session sheet (or card) first: grant, then the 20-cell strip
 6 × 6 grid at 52 px cells (fits 343 px with 4 px gaps)
 moves, included, refused
 Lane board blocks
```

## 6. The lane board

- A real table at laptop width: Lane (B612 Mono, the nonce key in hex), Leaf (the leaf's mark, the index, a
  sodium "hot" chip on hot leaves), Action (sentence: "hot ticket to 0x53c9…6356", "pay 0x5544…16f9"),
  Amount (right aligned, tabular), Gas (verify-frame gas, right aligned, "—" while unknown), Status.
- The status cell is a horizontal timeline in the leaf's own marks: ring at admitted, ring at pending, ink square
  at included (with the block number), hatch at expired or refused. Each step shows its offset (+1.2 s), the
  latest in Ink, earlier ones in Slate. A refusal adds its reason as a sentence after the hatch.
- Rows separate by a single Frostline hairline. Selecting a row (click, Enter or Space) opens the admission
  report under it, set in STIX: the rules the sidecar checked, pass or fail, the receipt, the timeline with clock
  times, the explorer link; and selects the leaf on the plate.
- Under 640 px each lane is a block of labelled lines (label in Slate B612 12 px above each value), the status
  timeline on its own line.

## 7. The one orchestrated moment per key action

Each action has exactly one moment, played on the plate, under 1.2 s, and replaced by an instant state change
under `prefers-reduced-motion: reduce`.

| Action | Moment |
| --- | --- |
| Pay (the mock plays this) | The next ticket stub tears off the phone strip (an 8° tilt and drop, 320 ms) and the counter decrements; a Prussian ring contracts onto its leaf on the plate (420 ms); the new lane row arrives with a Prussian tint that fades (900 ms). At inclusion the ring closes into an ink square from the centre (380 ms), and the row's gas and block appear. On the public mempool, with lane 0x2 still pending, the same click ends in a hatch instead: refused, one pending per sender |
| Simulate stuck payment | Ring on the plate; at the deadline the ring hatches over 360 ms ("expired, leaf burned"), and a second ring appears on the next ticket with "retry of lane 0x…, not re-signed" |
| Send from cold | The next cold leaf rings; it fills on inclusion. Nothing else moves |
| Cut tickets | The cut range on the hot strip gains perforations one by one, left to right (20 ms per cell), and the same stubs appear on the phone |
| Set policy | The sodium strip redraws to the new hot start; lowering it grows the strip leftward. The cap numbers flip once |
| Rotate root (confirmed) | The new tree replaces the plate (described in section 4); pending rings hatch with "invalidated by rotation" |
| Mempool switch to public | No motion. The board's header rule thickens and the lane limits sentence changes to the public mempool's one per sender |
| Fire now (agent) | Four rings in the same frame; they fill in inclusion order |
| Server compromised (agent) | Two cells hatch with leaders to their reasons |
| Grant (session) | The 20 stubs appear on the session strip, perforated left to right |
| A move (session) | The grid cell and its ticket ring together; they fill together |

Nothing animates on load, on hover or on scroll. Polling updates change marks in place, without motion, so the
only movement on screen is the answer to something the person did.

## 8. What makes it unlike common AI UIs

- The hero is the product's own data structure, drawn exactly: 1,024 real leaves with their real states, not a
  big-number KPI row or a gradient banner.
- One glyph system carries state across the whole product (plate, board, tickets, game grid), instead of colour
  badges. A refusal is a hatched key, which is what it is.
- Scientific typesetting (STIX, italic variables, set and shift notation) beside cockpit-display UI type (B612);
  no Inter, no Plex, no default mono labels.
- The panes annotate a figure with leader lines instead of sitting in a card grid.
- The signature is shown as a material: a skyline of 67 Winternitz chains, different for every payment.
- Cold palette with a sodium band and Prussian state colour, no cream, no terracotta, no neon, no gradients.

## 9. Mapping onto the existing controls

Every id in `hot-cold.html`, `agent.html` and `session.html` keeps its element and behaviour; only placement and
styling change. `style.css` is replaced; the JS modules keep their ids and gain a `plate.js` that draws the leaf
field from the wallet view and the lane records.

| Existing | Where it goes |
| --- | --- |
| `.top` brand and `nav.screens` | header line; the current screen marked by an ink underline |
| `#banner`, `#banner-retry` | full-width Ink bar above the wallet line (text in Frost) |
| `#wallet-head` (wallet, balance, epoch, leaves used, lanes in flight, tickets, rotation) | one line of STIX figures with B612 labels; on mobile two lines |
| `#notice` | under the wallet line, STIX 16 px, with its clock time |
| `#scene-fields`, `#play` and hint | under the notice: button, then the hint at 72 characters |
| `#cold-pane`, `#offline`, `#cold-fields` | left annotation, leader to the cold band; Offline greys the annotation and dashes its leader |
| `#tree-summary` | the plate's caption and legend (height, epoch, leaves used, hot band, root), repeated as text in the cold pane |
| `#transfer-form`, `#transfer-to`, `#transfer-amount`, `#transfer`, `#transfer-problem` | cold pane, first block |
| `#policy-form` (`#policy-value`, `#policy-fee`, `#policy-target`, `#policy-start`, `#policy-set`) | cold pane; the hot start field draws the sodium strip's edge |
| `#cut-form`, `#cut-left`, `#cut-count`, `#cut` | cold pane; the range to cut is previewed as perforations on the strip |
| `#rotate-form`, `#rotate-height`, `#rotate` (two clicks) | cold pane, with the epoch thumbnail; the armed state is an Ink button |
| `#phone-pane`, `#ticket-count`, `#ticket-note`, `#device-issue` | right annotation, leader to the hot band; stubs drawn from the ticket range |
| `#pay-form`, `#pay-to` (read-only), `#pay-amount`, `#pay-cap`, `#pay-problem`, `#pay`, `#stuck` | phone pane; the cap check stays inline |
| `#phone-set-aside`, `#set-aside`, `#lane-limits` | under the phone's form, and under the board's head |
| `.board`, `#lanes`, the Mempool radios | full-width table under the plate, its head with the segmented switch |
| `#status` footer | one line, plus "Prototype. Mempool and chain simulated in page." on prototypes only |
| Agent: `#price`, `#change`, `#spark`, `#spark-readout`, `#rule-text`, `#armed`, `#drop`, `#fire`, `#fire-hint`, `#fire-plan`, `#allowance`, `#max-loss`, `#agent-set-aside`, the disabled expiry row, `#compromised`, `#log` | market annotation left, allowance plate centre, allowance facts and log right |
| Session: `#grid`, `#moves`, `#moves-in`, `#moves-out`, `#sheet`, `#request`, `#grant-note`, `#grant-plan`, `#grant`, `#decline`, `#card`, `#left`, `#left-note`, `#caps`, `#session-set-aside`, the disabled End session row | grid left, session sheet and ticket strip right |

## 10. Build notes

- Fonts: STIX Two Text, B612 and B612 Mono are all SIL OFL 1.1. The build self-hosts the woff2 files (CROPS: no
  third-party request); the mock links Google Fonts.
- The plate is 1,024 `<span>` cells in one CSS grid (about 30 KB of DOM), drawn once and updated by class; it is
  one `role="group"` with an `aria-label`, one tab stop, arrow keys to move between leaves and Enter to open the
  lane that signed one; the readout is `aria-live="polite"`. Each state also has a text equivalent in the legend and the readout, so colour is never
  the only signal (ring, square and hatch differ in shape).
- Light and dark from `prefers-color-scheme`, with `[data-theme]` overrides; focus is a 2 px Prussian outline with
  2 px offset in both themes.
- Motion: CSS transitions on `transform` and `clip-path` only, all under `@media (prefers-reduced-motion:
  no-preference)`.
