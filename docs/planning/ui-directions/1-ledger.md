# Direction 1: Ledger (the instrument)

One of three UI directions for the redesign Vicky allowed on Nov 6 (spec, Screens: shared rules). The mock beside this
note, `1-ledger.html`, draws the hot-and-cold screen with the mempool and the chain simulated in the page. Written with
Claude Code (AI) for Vicky, following Anthropic's frontend-design process: plan, review against the brief and the
generic AI tells, revise, build, critique from screenshots.

**The idea.** The wallet is a book of numbered instruments. The cold device holds the book of 1,024 serial-numbered
leaves, the phone holds a strip of tickets cut from it, and every payment tears off one ticket and is written as a line in
a ruled ledger. When the chain burns the leaf, it cancels that line with a dated stamp.

**Why it fits.** Winterlock's claim is that every one-time key has a serial number and the chain voids it exactly once.
For a century, cheque books, ticket books and cancellation stamps have meant exactly that, so the metaphor teaches the
protocol rather than decorating it.

**Why it is not a common AI UI.** It has no cards, gradients, dark-and-neon palette, Inter or monospace. Instead there
is a ledger-green page and two inks, each with one owner: red serials printed by the key tree and violet cancellations
made by the chain. Numbers are set in a Clarendon. Motion happens only when a ticket tears or a leaf is burned.

## 1. Grounding

- **Subject:** a post-quantum smart wallet. Its one-time keys are numbered leaves, and its payments are parallel lanes.
- **Audience:** the EF alt-mempool judges at the booth, developers who know ERC-4337 and Quip, and Vicky driving a
  30-second scene.
- **Primary job:** make "one serial-numbered key per payment, burned by the chain" visible and felt, and show lanes
  running in parallel.

The visual vocabulary comes from physical financial instruments. The words on screen stay the spec's.

| Instrument | In Winterlock | On screen |
| --- | --- | --- |
| Cheque book of numbered leaves | the key tree, 1,024 leaves at height 10 | the register: one cell per leaf, leaf 0 at the top left |
| Serial number printed in red by a numbering machine | the leaf and its lane (nonce key = epoch << 32, OR the leaf) | every leaf and lane number, in Besley, in Serial red |
| The machine-readable line at the foot of a cheque: bank, account, cheque number | chain id, wallet, lane | the machine line on the ticket, `⑈0x3f7⑈ ⑆1337⑆ 0x66a503…D38A⑈`; the symbols are SVG, and screen readers get a sentence |
| Perforation, where a leaf may leave the book | the hot band, the leaves the cold device may export | the dotted spine between the cold and phone panes; holes on tickets and stubs |
| Ticket book with counterfoils | hot tickets cut to the phone | the stub strip and the next ticket |
| Limits printed on an instrument | hot policy: value cap, fee cap, allowed target | printed on the ticket under the amount box |
| The bank's dated cancellation stamp | the chain consuming the nonce key at payment approval | a violet stamp: "burned, in block 408,215" |
| A spoiled cheque, voided by its owner | refused or expired, never on chain, journaled as burned | a violet stamp: "burned, by the signer" |
| A ruled ledger: a double rule under a final figure, a strike through a void entry | the lane board | a double rule under an included amount, a strike when no money moved |

Words like cheque, counterfoil, MICR, void and paid appear only in this note, never on screen.

## 2. Tokens

### Colour: six inks, each with one owner

The rule that makes the system work: green tells you what the form asks, black tells you what is true now, red is a
number the key tree printed, and violet is a mark the chain or the signer made.

| Token | Light | Dark | Owner and use |
| --- | --- | --- | --- |
| Ledger | `#E6EEE2` | `#10291E` | the page. Light is accountant's ruled stock; dark is the ledger's bottle-green binding |
| Stock | `#FFFFFF` | `#183A2B` | paper objects: tickets, stubs, fields, the open voucher |
| Print | `#2E5C3E` | `#9CC7A8` | pre-printed matter: labels, column heads, section titles, hints, fine print. Rules and perforations use it at 26 to 62 % |
| Ink | `#000000` | `#F1F5EE` | what is true now: values, amounts, statuses, buttons, the focus ring |
| Serial | `#C4122F` | `#F5A1A7` | numbers the key tree prints: leaves, lanes, the hot band, the ticket serial. Never used for errors |
| Stamp | `#4B2B80` | `#C7AEF5` | burned: the cancellation stamp and burned cells and stubs. Multiply-blended in light mode, so it reads as ink on paper |

These are derived values, not new colours:

- **rule:** Print at 26 % over Ledger, for hairlines and register outlines.
- **rule-strong:** Print at 62 %, for the header double rule, perforation dots and the read-only underline.
- **hole:** Ledger, for the holes punched through stock.

There is no grey and no muted text colour. Hierarchy comes from size, weight and which ink a word is printed in.

Contrast (WCAG 2.2; all text is 14 px or larger):

| Text | Light, on Ledger / on Stock | Dark, on Ledger / on Stock |
| --- | --- | --- |
| Ink | 17.7 / 21.0 | 14.0 / 11.3 |
| Print | 6.4 / 7.5 | 8.2 / 6.6 |
| Serial | 5.1 / 6.0 | 7.8 / 6.3 |
| Stamp | 9.0 / 10.7 | 7.9 / 6.4 |

Field borders and the focus ring are Ink, so every control boundary is well above 3:1.

### Type

Two families, both under the SIL Open Font License. The build self-hosts the latin subsets: Archivo roman variable is
87 KB and Besley roman variable is 35 KB. No italics are used.

- **Besley**, Owen Earl's revival of Robert Besley's 1845 Clarendon. Clarendon is the face of nineteenth-century
  commercial printing (tickets, cheques, receipts). Here it prints the numbers that identify a key:
  - the ticket serial: 800, 48 px (36 px at 375);
  - leaf and lane numbers in the ledger and on the stubs: 700;
  - the ticket count: 700, 36 px;
  - the wordmark: 800, 24 px;
  - headings: 600, with pane titles at 24 px and section titles at 18 px in Print.
- **Archivo**, by Omnibus-Type: variable weight (100 to 900) and width (62 to 125 %). It sets everything else, and its
  width axis gives each job its own width:
  - 100 % for reading: body, labels, values, buttons;
  - 72 to 92 % for condensed matter: the stamp, column heads, tags, the dense status timeline;
  - 125 % for the machine line on the ticket.
- **No monospace anywhere.** Archivo's tabular figures align gas and amounts. Hidden zeros pad each fraction, so
  decimal points line up down the amount column. Addresses keep their checksum case.
- **Scale**, Bringhurst's classic steps (size / line height):
  - 12 / 16: tags and the stamp's second line;
  - 14 / 20: labels, hints, the timeline, fine print;
  - 16 / 24: body, ledger cells, fields, buttons;
  - 18 / 24: values and section titles;
  - 24 / 32: pane titles, the balance, the amount being written;
  - 36 / 40: the ticket count;
  - 48 / 48: the ticket serial.
- **Case:** sentence case everywhere. No capitals and no letter-spaced labels.

### Space, rules, radii, depth

- **Grid:** 8 px, with a 24 px line. Page gutters are 40 px (16 px at 375), and a 48 px perforated spine separates the
  panes.
- **Rules carry meaning:**
  - a hairline between lanes;
  - a double rule under the column heads, and under an amount that was included (final);
  - a strike through an amount that was refused or expired (void);
  - dotted perforation where leaves may leave the cold device;
  - a full-width double Ink rule when a rotation closes an epoch.
- **Radii by kind:** 0 for the page and the ledger, 4 px for die-cut paper (ticket, stub strip, voucher), 2 px for
  controls.
- **Depth:** no shadows. Paper objects get a 1 px rule ring.

### Motion

| Token | Value | Used for |
| --- | --- | --- |
| press | 180 ms, ease-out | a serial printing on a new ledger line; a register cell filling |
| roll | 240 ms, cubic-bezier(.2,.7,.2,1) | the ticket count and serial advancing like a numbering-machine wheel |
| tear | 500 ms, same curve | the ticket lifting off along its perforation; the next ticket rises in 280 ms |
| stamp | 380 ms, cubic-bezier(.18,.9,.32,1.28) | the cancellation stamp landing: it starts at 1.9 times its size and 10 degrees off, with one slight overshoot |
| rule | 260 ms, after 120 ms | the double rule or the strike drawing under an amount |

With `prefers-reduced-motion`, every state change happens at once: no ghost ticket, no roll and no landing. Colour
and text still change, so no information is lost. The mock honours the OS setting and also `?motion=reduce`.

## 3. Layout concept

**The instrument.** The screen is one sheet split by a perforation:

- the cold device on the left: the book and its register;
- the phone on the right: the tickets cut from the book;
- between them, the dotted line along which the tickets were cut.

The lane board below is the ledger page that every lane is written into, newest line on top. At 375 px the perforation
turns horizontal and everything stacks in the same order.

**Alignment:**

- Text is left-aligned and ragged.
- Numbers are right-aligned, with decimal points aligned.
- Serials are left-aligned at the start of each line, like the cheque-number column of a register.
- Nothing is centred except the stamp's two lines.

**The hero** is the next ticket, not a balance: a red 48 px serial on white stock with its perforation, the amount box
you write in, the caps printed under it, and the machine line. The boldness goes there and into the stamp; everything
else stays quiet.

### Hot and cold, laptop (1280)

```
Winterlock    Hot and cold   Agent   Session
──────────────────────────────────────────────────────────────────────────────────────────────
wallet          balance         epoch  leaves used    lanes in flight  tickets
0x66a503…D38A   9.947698 ETH    0      12 of 1,024    1                3 of 10
13:09:41  Sent 0.25 ETH from the cold device on lane 0x2 (leaf 2): admitted.

[ Play scene ]  The cold device cuts tickets if the phone has fewer than 7, then goes …

Cold device                          [ ] Offline  ┆  Phone      the backend's ticket device: …
                                                  ┆
Key tree                                          ┆  3 of 10
▫▣▢▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫ ┆  tickets left of those cut; 7 used or burned
      … 64 × 16 cells, one per leaf …             ┆  ┌────┬────┬────┬────┬────┬────┬────┲━━━━┱────┬────┐
▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▣▣▣▣▣▣▣■■■□□□□□□ ┆  │1008│1009│1010│1011│1012│1013│1014┃1015┃1016│1017│
▣ burned  ▢ in flight  ■ on the phone  □ hot band ┆  └────┴────┴────┴────┴────┴────┴────┺━━━━┹────┴────┘
height 10  epoch 0  leaves used 12 of 1,024       ┆   (1008 to 1014 carry a small violet stamp frame)
hot band leaves 1008 to 1023 (16)  root 0x5d1e…a9c3 ┆ ┌ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ┐
                                                  ┆  │ 1015                       hot ticket │
Transfer                │ Hot policy              ┆  │ To, the allowed target                │
Large transfers go …    │ Value cap   Fee cap     ┆  │ 0x2c58A1F4e9B03d7C6a5E2f8D1b4C9e0A7…  │
To     [0x5544…      ]  │ [0.01    ]  [0.002   ]  ┆  │ Amount, ETH                           │
Amount [0.05 ]          │ Allowed target          ┆  │ [ 0.001                          ETH ]│
[ Send from cold ]      │ [0x2c58…C537         ]  ┆  │ Hot value cap 0.01 ETH per payment, … │
                        │ Hot start [1008]        ┆  │ ⑈0x3f7⑈   ⑆1337⑆   0x66a503…D38A⑈     │
                        │ [ Set policy ]          ┆  └───────────────────────────────────────┘
────────────────────────┼──────────────────────── ┆  [ Pay ]  [ Simulate stuck payment ]
Tickets for the phone   │ Rotation                ┆  The stuck payment's first try gets only …
6 hot leaves not cut …  │ ▌Rotation invalidates   ┆  set aside for pending: 0.25023 ETH on 1 lane …
Count [6] [Cut tickets] │ ▌every pending lane.    ┆
                        │ New tree height [10]    ┆
                        │ [ Rotate root ]         ┆

Lane board                                                          Mempool [▓alt▓| public ]
set aside for pending: 0.25023 ETH on 1 lane (its value plus the maximum cost …)
Lane   Leaf      Action                          Amount      Gas     Status
══════════════════════════════════════════════════════════════════════════════════════════════
0x2    2         pay 0x5544…16f9 [alt]           0.25  ETH   85,904  admitted   explorer
                                                                     ✓admitted ✓pending +1.1 s ○expiry in 84 s
──────────────────────────────────────────────────────────────────────────────────────────────
0x3f6  1014 hot  hot ticket to 0x53c9…6356 [alt] 0̶.̶0̶0̶1̶ ETH   —       refused, leaf burned  ╔═══════╗
                                                                     target not allowed    ║burned ║
                                                                     — refused             ║by the ║
                                                                                           ║signer ║
──────────────────────────────────────────────────────────────────────────────────────────────
0x3f4  1012 hot  hot ticket to 0x2c58…C537 [alt] 0.01  ETH   88,019  included   explorer   ╔═══════╗
                                                 ════                ✓admitted ✓pending    ║burned ║
                                                                     ✓included +6.2 s      ║408,215║
… six more lines, then the lane-limits paragraph as fine print
──────────────────────────────────────────────────────────────────────────────────────────────
backend (via this server)   chain 1337   latest block 408,312, 2 s ago   Prototype. Mempool …
```

### Hot and cold, 375

```
Winterlock
Hot and cold   Agent   Session
─────────────────────────────────
wallet           balance
0x66a503…D38A    9.947698 ETH
epoch  leaves used  lanes in flight
0      12 of 1,024  1
tickets 3 of 10
13:09:41 Sent 0.25 ETH from the cold
device on lane 0x2 (leaf 2): admitted.
[ Play scene ]
The cold device cuts tickets if …

Cold device           [ ] Offline
Key tree
▫▣▢▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫
 … 64 × 16 at 4 px: a texture that
   still shows the hot band …
▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▣▣▣▣▣▣▣■■■□□□□□□
legend (two lines), facts (two rows)
Transfer …         (the four forms
Hot policy …        stack in one
Tickets for the phone …   column)
Rotation …
∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘    ← the perforation, now horizontal
Phone
the backend's ticket device: …
3 of 10
┌────┬────┬────┬────┬────┬────┬────┐
│1008│1009│1010│1011│1012│1013│1014│
┢━━━━╈────┬────┘   (the strip wraps)
┃1015┃1016│1017│
┌ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ┐
│ 1015              hot ticket │
│ To, the allowed target       │
│ 0x2c58A1F4e9B03d7C6a5E2f8D…  │
│ [ 0.001                ETH ] │
│ Hot value cap 0.01 ETH …     │
│ ⑈0x3f7⑈  ⑆1337⑆              │
│ 0x66a503…D38A⑈               │
└──────────────────────────────┘
[ Pay ] [ Simulate stuck payment ]
The stuck payment's first try …
set aside for pending: …

Lane board
Mempool [▓alt▓| public ]
set aside for pending: …
0x3f6   leaf 1014 hot   ╔════════╗
                        ║ burned ║
hot ticket to 0x53c9…   ║ by the ║
6356 [alt]              ║ signer ║
0̶.̶0̶0̶1̶ ETH              gas —
refused, leaf burned   explorer
target not allowed (account: …)
— refused
─────────────────────────────────
```

### Agent, laptop

There is no perforation between these panes: nothing on this screen is cut from them. The agent's tickets were cut on
the cold device, so the perforation appears only around their stub strip.

```
(masthead, account line, notice and Play scene as on hot and cold)

Market                               │ Allowance                     │ Event log
mock price, simulated in this page,  │ the agent's hot tickets       │ trigger, lanes, inclusions
not a market feed                    │                               │
Mock ETH price                       │ 14 of 20                      │ 12:10:01  fall of 3.1 % in 30 s
3,412.50        −3.1 %               │ ┌──┬──┬──┬──┬ … ┬──┬──┐       │ 12:10:01  4 tranches, lanes
┌────────────────────────────────┐   │ └──┴──┴──┴──┴ … ┴──┴──┘       │           0x3fa to 0x3fd
│ ink line on stock; the last    │   │ value cap 0.1 ETH  fee cap …  │ 12:10:06  0x3fc included
│ 30 s under a hatched band      │   │ target 0x2c58…C537            │ 12:10:08  0x3fa included
└────────────────────────────────┘   │ ─────────────                 │ …
Hover or focus the line to read …    │ Max loss: 1.4 ETH, to … only  │
┌────────────────────────────────┐   │ set aside for pending: …      │
│ If price falls more than 2 %   │   │ Expires in —                  │
│ in 30 s, buy in 4 tranches.    │   │ [Renew from cold device] [Stop renewing]   (disabled)
└────────────────────────────────┘   │ Recent-root expiry: proposed (Level B), not built. …
[x] Rule armed  [Drop the mock price 3 %]  [Fire now]
Parallel-lanes plan: 4 lanes: 1 relay pass, about 28 s; set aside …
                                     │ [ Server compromised ]  Sends two payments outside …

Lane board (the same ledger)
```

### Agent, 375

```
Market
mock price, simulated in this page …
3,412.50   −3.1 %
┌──────────────────────────────┐
│ sparkline; last 30 s hatched │
└──────────────────────────────┘
┌──────────────────────────────┐
│ If price falls more than 2 % │
│ in 30 s, buy in 4 tranches.  │
└──────────────────────────────┘
[x] Rule armed
[Drop the mock price 3 %] [Fire now]
Parallel-lanes plan …
─────────────────────────────────
Allowance
14 of 20
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘ (2 rows)
value cap   fee cap   target
─────────────
Max loss: 1.4 ETH, to 0x2c58… only
Expires in — [Renew …] [Stop …]
[ Server compromised ]
─────────────────────────────────
Event log
12:10:01  fall of 3.1 % in 30 s
…
Lane board (blocks, as on hot and cold)
```

### Session, laptop

Here the perforation is meaningful again: the wallet cuts tickets that go to the dapp.

```
(masthead, account line, notice and Play scene as on hot and cold)

Dapp                                  ┆ Wallet
each click is one transaction         ┆ the session the dapp asked for
                                      ┆
     A    B    C    D    E    F       ┆ Session request
 1   ◯    ◉    ◯    ◯    ◯    ◯       ┆ actions 20   value each 0 ETH   contract 0x2c58…C537
 2   ◯    ◯    ⊙    ◯    ◯    ◯       ┆ expiry 2 h, proposed (Level B)
 3   ◯    ◯    ◯    ◯    ◉    ◯       ┆ Cuts 20 tickets for this session.
 4   ◯    ◉    ◯    ◯    ◯    ◯       ┆ [ Grant 20 tickets ]  [ Decline ]
 5   ◯    ◯    ◯    ◯    ◯    ◯       ┆ ───────────────────────────────────────
 6   ◯    ◯    ◯    ◯    ◯    ◯       ┆ Session
◯ open  ⊙ punched, in flight          ┆ 12 of 20
◉ included (violet ring)  ⊘ refused   ┆ tickets left; the chain burns each one on use
moves 8   included 6   refused 0      ┆ ┌──┬──┬──┬ … ┬──┐  20 stubs, 8 with a violet frame
A move is a hot ticket of 0 wei …     ┆ value per move 0 ETH  account value cap …  fee cap …
                                      ┆ set aside for pending: …
                                      ┆ Expires in —   [ End session ]  (disabled, not built)
                                      ┆ An ordinary session key is one key with a policy …

Lane board (the same ledger)
```

### Session, 375

```
Dapp
each click is one transaction
   A   B   C   D   E   F
1  ◯   ◉   ◯   ◯   ◯   ◯
…  (44 px targets, 6 across)
moves 8  included 6  refused 0
∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘ ∘
Wallet
Session request
actions 20  value each 0 ETH
contract 0x2c58…C537  expiry 2 h …
[ Grant 20 tickets ] [ Decline ]
Session
12 of 20
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐ (2 rows)
caps, set aside, Expires in, End session
Lane board (blocks)
```

## 4. The lane board as a ledger

**Columns** are unchanged: Lane, Leaf, Action, Amount, Gas, Status. The heads are condensed Archivo in Print, over a
double rule.

| Column | What it shows |
| --- | --- |
| Lane, Leaf | Besley 700 in Serial red, so the ledger line, the stub and the register cell show the same number in the same ink. A hot lane's leaf carries a small red "hot" tag |
| Action | "hot ticket to 0x2c58…C537", the mempool tag (alt is outlined, public is filled black), and the retry links ("retry of lane 0x3f9", "retried as lane 0x3fa") |
| Amount | tabular and decimal-aligned, with ETH in Print. Included: a double rule under the figure (money moved, final). Refused or expired: struck through (no money moved). Pending: no rule |
| Gas | verify-frame gas, tabular. "—" when the account refused before it approved |
| Status | see below |

**The status cell** holds, in order:

- the state in words (admitted, included, "refused, leaf burned", "expired, leaf burned"), with the explorer link
  beside it;
- for a refusal, the reason ("target not allowed") with its code in Print;
- the timeline, as bookkeeper's ticks:
  - a tick per step, with its offset: admitted, pending +1.1 s, included +5.2 s;
  - a dash for refused or expired;
  - a ring for the live "expiry in 84 s";
  - the current step in bold.

**The stamp** appears on every final line, at the end of the status cell (top right of the block at 375). It has two
lines: "burned", then either "in block 408,215" when the chain consumed the key, or "by the signer" when the
transaction never reached the chain and the signer journals the leaf. Settled stamps sit at a small fixed angle derived
from the leaf number (−4 to +2 degrees), so a column of them looks hand-stamped but never random.

**The voucher.** Clicking a line (or pressing Enter or Space on it) opens its voucher underneath. It holds:

- the refusal reasons;
- the admission report, with pass or fail per rule;
- the receipt per frame;
- the timeline in clock time;
- the facts: transaction, lane, leaf, mode, mempool, to, verify gas, deadline, max cost;
- the explorer link, with the in-memory warning.

**Around the lines:**

- "set aside for pending" sits above the heads, like a balance carried forward.
- The lane-limits paragraph sits under the last line as the page's fine print.
- When a rotation lands, the page is ruled off with a full-width double rule and the line "Epoch 0 closed by the
  rotation in block N. Lanes below this line belong to the old tree."
- At 375 px each line becomes a block, in this order: lane and leaf; the action; amount and gas; the status. The stamp
  sits at the top right.

**Each backend status:**

| Backend status | Words | Amount | Stamp | Register cell |
| --- | --- | --- | --- | --- |
| Submitted | admitted, with the pending tick and the expiry count | plain | none | in flight (an Ink ring) |
| OnChain | included | double rule | burned, in block N | burned (violet) |
| Reverted | included, a frame reverted | struck: the key was used, the value did not move | burned, in block N | burned |
| Included (no receipt yet) | included, no receipt yet | single rule until the receipt says whether the value moved | burned, in block N | burned |
| Expired | expired, leaf burned | struck | burned, by the signer | burned |
| Refused | refused, leaf burned | struck | burned, by the signer | burned |
| Unknown | unknown, still in flight | plain | none | in flight |

## 5. Moments: one per key action

The signature moment is the stamp; the second beat is the tear. Everything else is 260 ms or less and fires only on the
action it answers. Nothing moves on load, on hover or while idle. The one exception is a live lane's expiry count, and
that is only text changing.

| Key action | The one moment | What it shows |
| --- | --- | --- |
| Pay | Immediately: the ticket lifts off along its perforation and fades up and away. The next serial rolls in from below, the count rolls down, and the new lane is written at the top of the ledger with its serials pressed in red. When the chain includes the lane: the stamp lands on its line ("burned, in block N"), the double rule draws under the amount, the stub takes its violet frame and the register cell turns violet | the leaf leaves the phone; the chain burns it exactly once |
| Simulate stuck payment | The same tear, with "expiry in 4 s" counting on the line. At expiry the amount is struck and the stamp lands "burned, by the signer". The phone tears its next ticket by itself, and the retry is written above, linked both ways | expiry burns the leaf; the retry is a fresh leaf on a fresh lane, with no fee bump |
| Send from cold | No tear, because the cold device signs from the seed. The next cold cell in the register fills with an Ink ring and the line is written; the stamp lands at inclusion | cold lanes are leaves too |
| Cut tickets | A dashed perforation runs around the cut range in the register's hot band, which then fills red. The stub strip grows by the same serials and the count rolls up | tickets are leaves leaving the cold device, without the seed |
| Set policy | It gets its own cold lane and stamp. When it is included, the cap line printed on the ticket is reprinted | the caps live in the account, not on the ticket |
| Rotate root | The first press arms the button ("Confirm: rotate root", filled with Ink). When the rotation is included, the ledger is ruled off with a full-width double rule naming the closed epoch, and the register empties into a fresh book for the new epoch | a rotation is a new tree; the old lanes belong to the old one |
| Offline | The cold column drops to 40 % ink, with no motion | the laptop is closed |
| Mempool switch to public | The switch inverts. A payment made while a lane is pending is written and stamped at once: "refused, leaf burned: one pending per sender" | why the alt mempool matters |
| Fire now (agent) | Four stubs are perforated as one block and lift together. Four lines are written at once, and their stamps land in whatever order the chain includes them | parallel lanes, landing out of order |
| Server compromised (agent) | Two lines are written and stamped "burned, by the signer", with "exceeds value cap" and "target not allowed". The max-loss total is ruled again | the account refuses, and the ticket is still burned |
| Grant tickets (session) | The session card prints its stub strip left to right, 35 ms per stub | a session is 20 one-time keys |
| A move (session) | The cell is punched: its centre opens to the page colour and the lane prints under it. At inclusion a violet ring closes around the hole. On the public mempool the hole stays open with "waiting" | each move is its own lane |
| Click a lane | The voucher opens under the line, at once | the admission report |

The mock implements Pay, Simulate stuck payment, Send from cold, Cut tickets, Set policy, Rotate root (refused while a
lane is in flight, which is the case on load), Offline, the mempool switch, Play scene and the voucher.

## 6. Review against the brief and the AI tells

### Pass 1, kept here so the changes are visible

- **Palette:** warm paper (`#F4F1EA`), black ink, and one red accent for both serials and stamps.
- **Type:** a Didone for serials (banknote numerals), and IBM Plex Mono for every number and hash.
- **Layout:** two side-by-side panels with hairline borders, a dense zero-radius table, and the balance as a big hero
  number.
- **Motion:** stamps settling onto every row on load, and panels fading in.

### What the review found, and pass 2

| Pass 1 choice | The tell it hits | Pass 2 |
| --- | --- | --- |
| Cream paper, a Didone and a red accent | warm cream, high-contrast serif and a clay accent (skill tell 1; the brief's "warm cream with terracotta") | Ledger green, from accountant's columnar pads and the pale stock of bank paying-in slips. A Clarendon (Besley) instead of a Didone. Two inks with owners instead of one accent |
| Plex Mono for numbers | monospace for small labels (skill tell 5 and the brief); it is also the Nov 4 prototypes' face | No monospace. Tabular figures and decimal alignment in Archivo. The only machine text is the ticket's machine line, in Archivo's widest width |
| Hairline panels, a dense table, zero radius | the broadsheet layout (skill tell 3) and the SaaS card kit (skill tell 4) | No panels at all: one instrument split by a perforation, paper objects with die-cut 4 px corners, and ledger lines with room, ruled with rules that mean something |
| A big balance hero | the default hero: a big number with a small label | The next ticket is the hero, as the most characteristic object in this product |
| Stamps on load and fade-ins | scattered motion (the skill's one-orchestrated-moment rule) | Nothing moves on load or on hover. The stamp lands only when the chain includes a lane |
| Grey hints | grey text on coloured backgrounds (the brief) | No grey: pre-printed words are Print green at 6.4:1 or better |
| Stamps at random angles, with an ink texture | skeuomorphic kitsch (the brief) | Crisp vector stamps at an angle fixed by the leaf number. No textures and no paper grain |

**The similar-prompt test.** Asked for "a crypto wallet UI", the default is near-black, a neon accent, monospace
hashes and stat cards. Asked for "an editorial fintech page", it is cream paper, a serif, hairlines and a red accent.
Pass 2 lands in neither: its colours, type and structure come from the cheque book and the ledger, and each encodes a
protocol fact.

### Checklist for pass 2

- **Inter for everything:** no. Besley and Archivo.
- **Purple-to-blue gradients:** no gradient anywhere. The violet is a flat stamp ink on cancellation marks only, never
  on chrome.
- **Nested cards:** none. Paper objects sit on the page at a single level.
- **Grey text on coloured backgrounds:** none. The palette has no grey.
- **A rounded icon tile above every heading:** there are no icons at all.
- **Cramped padding:** no. The grid is 8 px with 24 px lines, and ledger cells have 16 px of padding.
- **All-caps labels:** none; sentence case throughout.
- **Monospace for small labels:** none.
- **Middle-dot meta strings:** none; facts are label and value pairs. The current page titles ("Hot and cold ·
  Winterlock") use one, and this direction drops it.
- **Tinted near-black standing in for black:** no. Ink is `#000000`, and the dark theme's ink is a deliberate
  off-white.
- **Warm cream with a terracotta accent:** no. Cool ledger green with crimson and violet.
- **A single word accented in a headline:** none. Red marks a class of data (serials), never one word.
- **Eyebrows, "WORD — fragment" labels, "→" on links:** none.

### What remains a risk

- **Violet could read as the AI purple.** It is a dark aniline stamp ink (`#4B2B80`), flat and multiply-blended, and it
  never appears on buttons, links, focus or backgrounds. If Vicky dislikes it, the fallback is a bank blue, `#1E3F8A`,
  for the stamp only, with everything else unchanged.
- **Green and red together could read as festive.** Red is confined to serials, which are small Clarendon numerals; the
  green is cool and greyed; and dark mode uses rose, not red.
- **The register's node count.** It has 1,024 DOM nodes (4,096 at height 12). That is fine, because it is redrawn only
  when something changes.

## 7. Mapping onto the existing controls

Every control and id on the current pages stays. New elements are marked "new".

**Hot and cold** (`hot-cold.html`):

| Existing | In this direction |
| --- | --- |
| `header.top`: the brand and the three screen links | masthead: the Besley wordmark; links in Print, with the current one in Ink over a 2 px rule |
| `#banner` and `#banner-retry` | a full-width Ink band with Ledger-coloured text and an outlined button |
| `#wallet-head` (the summary `dl`) | the account line: labels in Print at 14 px, values in Ink at 18 px, the balance at 24 px |
| `#notice` | one printed line: clock time in Print, the message in Ink, bold for an error |
| `#scene-fields`: `#play` and its hint | an outlined button, with the hint in Print |
| `#cold-pane`, its `h2` and `#offline` | the left half of the instrument; Offline drops the column's body to 40 % |
| `#tree-summary` | the same facts, under the register (new: drawn from leaf states, see section 8) |
| `#transfer-form` (`#transfer-to`, `#transfer-amount`, `#transfer`, `#transfer-problem`) | the same fields; Send from cold is the column's Ink primary |
| `#policy-form` (`#policy-value`, `#policy-fee`, `#policy-target`, `#policy-start`, `#policy-set`) | the same fields; Set policy in Ink |
| `#cut-form` (`#cut-left`, `#cut-count`, `#cut`) | the same; Cut tickets outlined |
| `#rotate-form` (the warning, `#rotate-height`, and `#rotate` with its two-click arm) | the warning gets a 4 px Ink rule; the armed button fills with Ink |
| `#phone-pane`, its `h2` and its line | the right half of the instrument |
| `#ticket-count`, `#ticket-note`, `#device-issue` | the count in Besley at 36 px, with a rolling number (it needs two spans: the number and " of N"); the note in Print; the device issue as a warning |
| the stub strip (new) | the exported tickets, each with its state |
| `#pay-form` (`#pay-to` read-only, `#pay-amount`, `#pay-cap`, `#pay-problem`, `#pay`, `#stuck`, the hint) | the ticket. It adds the serial and the machine line; the target is printed on a dashed line; the amount box; the cap printed under it; Pay in Ink; Simulate stuck payment outlined |
| `#phone-set-aside` | unchanged text, in Ink |
| `.board`: `#board-title`, the Mempool radios, `#set-aside`, `#lane-limits`, `#lanes` | the ledger (section 4); the radios become a two-part Ink switch; the lane limits become fine print under the last line |
| `footer#status` and the FAKE CHAIN badge | fine print in Print. The badge becomes an Ink band reading "Fake chain": the band carries the warning, not the capitals |

**Agent** (`agent.html`):

| Existing | In this direction |
| --- | --- |
| Market: `#price`, `#change`, `#spark` (focusable, with the hover readout), `#spark-readout`, `#rule-text` | the price in Archivo 600 at 36 px, tabular, with the change beside it. The sparkline is drawn in Ink on a Stock strip, with the last 30 s under a hatched Print band (a pattern, not a gradient). The rule is printed in a 1 px Ink box, like an instruction on a form |
| `#agent-fields`: `#armed`, `#drop`, `#fire`, `#fire-hint`, `#fire-plan` | the toggle and two outlined buttons, with Fire now in Ink; the plan as a Print-ruled note |
| Allowance: `#allowance`, `#device-issue`, `#max-loss`, `#agent-set-aside`, Expires in with its two disabled buttons, the proposed line | the facts as on the ticket, plus a stub strip of the agent's tickets (new). Max loss is a ledger total, with a single rule above the figure. The disabled buttons sit at 40 % with the proposed line beside them |
| `#compromise-fields`: `#compromised` and its hint | an outlined button |
| Event log: `#log` | a day book: clock time in Print, the entry in Ink, lanes in Serial; no motion |
| the board | the same ledger |

**Session** (`session.html`):

| Existing | In this direction |
| --- | --- |
| Dapp: `#grid` (36 buttons, A1 to F6), `#moves`, `#moves-in`, `#moves-out`, the hint | the 6 by 6 grid as punch positions (circles, with 44 px targets at 375), in the states from section 5; the counters as an account line |
| Wallet: `#sheet` (`#request`, `#grant-note`, `#grant-plan`, `#grant`, `#decline`) | the request printed as a form in a 1 px Ink box; Grant in Ink, Decline outlined |
| `#card`: `#left`, `#left-note`, `#device-issue`, `#caps`, `#session-set-aside`, Expires in with End session (disabled), the proposed and comparison lines | the count in Besley, plus a stub strip of the session's tickets (new); the caps as facts; the rest as on hot and cold |
| the board | the same ledger |

## 8. Build notes and open questions

**Data the new parts need.** The register and the stub strip want each leaf's state: unused, exported, in flight or
burned. Today the screens could derive most of it:

- each lane and its leaf, from `GET /wallets/:address/txs`;
- the exported count, from `tickets.exported`, assuming the cuts are contiguous from `hotStart`. The backend cuts "the
  next count unused hot leaves", so they are contiguous as long as no keyed lane uses a hot leaf.

A read-only leaf map from the backend, one field or one endpoint, would be cleaner. The other new parts need nothing
new:

- the stamp's block: the receipt, or the timeline line "chain: key used by block N";
- "by the signer": the Expired and Refused statuses;
- the expiry count: the record's deadline.

The ticket serial assumes the device signs its lowest unused ticket; to be confirmed.

**Code.** `board.js` gains the stamp and the amount classes (final, void) and fills each lane's stamp once.
`hot-cold.js` gains the register, the stub strip, the ticket serial and machine line, and the two spans in the count.
The tear is one Web Animations call on a clone, skipped under reduced motion. No framework, no build step and no new
dependency.

**Fonts.** Self-host the two latin woff2 files (Archivo roman variable, 87 KB; Besley roman variable, 35 KB) with
`@font-face` and `font-display: swap`. No third-party request (CROPS). The mock links Google Fonts.

**The mock's data.** The numbers are the brief's, with one change: leaves used reads 12 of 1,024, not 11. The in-flight
lane is the cold device's leaf 2, and the backend's count is the cold journal: ten exported tickets, leaf 1 and leaf 2.
I put the in-flight lane on the cold device so that the board tells the hot-and-cold story itself, with laptop and phone
lanes pending at once. The cold lane lands about 9 s after load.

**Review aids in the mock's URL:**

- `?theme=dark` or `?theme=light`;
- `?motion=reduce`;
- `?freeze`: the in-flight lane stays pending;
- `?play`: Play scene runs on load.

The footer's Theme switch is mock-only. I checked the mock in headless Chromium at 375, 768, 1024 and 1280 px, in light
and dark, with and without reduced motion. Play scene runs end to end with no script errors and no sideways scroll.

**Open questions for Vicky:**

1. Ledger green for the whole page, or white with green only in the ledger? I recommend green: it is the identity.
2. Violet stamps, or the bank-blue fallback?
3. Keep the machine line on the ticket?
4. The register's data: derive it in the page, or ask the backend for a leaf map?
5. At 375 px the cold column is long before the ticket appears. Should its four forms fold into disclosure sections
   there?
