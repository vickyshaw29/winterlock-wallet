# Winterlock design system

One system for the React app (`web/`) and the Snap's page (`snap/site/`). Winterlock is a wallet console: people come
to send a payment, watch it land, and see which one-time keys it used. It must read as a working wallet first.

## Scene and theme

Shown on a laptop at a bright hackathon booth and recorded for a short video, so **light is the default**. Dark is a
real second theme with its own values (below), never an inversion. Respect `prefers-reduced-motion`.

## Type

- UI: **IBM Plex Sans** 400, 500, 600, self-hosted (`@fontsource/ibm-plex-sans`). No third-party font requests.
- Data: **IBM Plex Mono** 400, 500, only for addresses, hashes, leaf numbers, nonce keys, gas and wei. Never as
  decoration.
- Numbers in tables, balances and gas use `font-variant-numeric: tabular-nums`.

| Role | Size / line | Weight | Notes |
| --- | --- | --- | --- |
| Page title | 28 / 34 | 600 | tracking -0.02em |
| Balance | 40 / 44 | 500 | tabular, tracking -0.02em |
| Section title | 18 / 24 | 600 | |
| Body | 14 / 20 | 400 | measure ≤ 70ch |
| Label | 12 / 16 | 500 | sentence case, `--ink-3`; never uppercase eyebrows |
| Input | 15 / 20 | 400 | |
| Mono data | 13 / 18 | 400 | |

## Colour

Light (default):

| Token | Value | Job |
| --- | --- | --- |
| `--bg` | `#F4F3EF` | page ground |
| `--surface` | `#FFFFFF` | panels, inputs |
| `--sunk` | `#ECEBE6` | wells, table header, hover rows |
| `--ink` | `#111316` | text, primary button |
| `--ink-2` | `#474B52` | secondary text |
| `--ink-3` | `#676B73` | labels, help text (≥ 4.5:1 on `--surface` and `--bg`) |
| `--rule` | `#DDDBD4` | hairlines, borders |
| `--cold` | `#2747A8` | cold device, cold keys, links, focus ring |
| `--cold-tint` | `#E7EBF7` | cold backgrounds |
| `--hot` | `#B8420F` | hot tickets, the phone |
| `--hot-tint` | `#FAECE3` | hot backgrounds |
| `--ok` | `#1D7A46` | OnChain, admitted |
| `--ok-tint` | `#E3F1E8` | |
| `--wait` | `#8F6200` | reserved, signed, submitted, pending |
| `--wait-tint` | `#F6EED8` | |
| `--bad` | `#B42318` | refused, expired, burned, errors |
| `--bad-tint` | `#FAE7E5` | |

Dark: `--bg #0F1012`, `--surface #17191C`, `--sunk #1F2226`, `--ink #ECEDEE`, `--ink-2 #B6BAC1`, `--ink-3 #9196A0`,
`--rule #2C2F35`, `--cold #93AAFF`, `--cold-tint #1B2440`, `--hot #FF9361`, `--hot-tint #3A2216`, `--ok #5BC98F`,
`--ok-tint #15291E`, `--wait #E6B84F`, `--wait-tint #33290F`, `--bad #FF7B6E`, `--bad-tint #3A1A17`. The primary button
in dark is `--ink` on `--bg`.

Colour only carries meaning: cold vs hot, and the state of a key or a lane. Everything else is ink on paper. No purple
or lavender, no gradients, no glow.

## Shape, depth, spacing

- Radius: 10px for panels, 8px for buttons and inputs, 999px only for small status pills and the network chip.
- Depth: 1px `--rule` borders. No shadows, except one soft shadow on dialogs and popovers
  (`0 8px 24px rgb(0 0 0 / 0.12)`). Never a border and a wide shadow together.
- Panels sit on the page ground only. **No card inside a card**: inside a panel, separate groups with spacing and a
  hairline, or a `--sunk` well for read-only data.
- 4px grid. Panel padding 20px (24px on wide screens). 32px between panels, 48px above a page section. More space
  above a heading than below it.
- Layout max width 1200px, centred, 24px gutters (16px on phones). Works at 390px wide.

## Components

- **Top bar**: product mark plus "Winterlock" wordmark; tabs (underline on the active one, not pills); right side:
  network chip (dot in `--ok`, "Devnet 1337 · block 6,073" in mono digits), mempool switch (segmented control
  `alt / public`), theme button. When the backend runs the local fake chain, a full-width `--wait-tint` bar under the
  top bar says "Local simulation · no EVM", because that warning must never be missed.
- **Buttons**: primary is solid `--ink` with `--surface` text; secondary is 1px `--rule` border on `--surface`;
  destructive text in `--bad`. Height 40px (36px compact). Label names the action ("Send 0.001 ETH", not "Submit").
  Loading keeps the width and shows a spinner plus the verb in progress.
- **Inputs**: 40px, 1px `--rule`, `--surface`; focus ring 2px `--cold` with 2px offset. Amounts have the token symbol
  inside the field on the right. Errors sit under the field in `--bad`, naming the problem and the fix.
- **Address and hash chips**: mono, `0x1234…abcd`, a copy button, and for hashes an explorer link with an external
  icon.
- **Status pills**: tint background, solid text in the state colour, 12px 500, a 6px dot. States: Reserved, Signed,
  Submitted, Admitted (`--wait`); OnChain (`--ok`); Refused, Expired, Burned (`--bad`); Hot (`--hot`).
- **Tables** (lane board, transactions): 44px rows, `--sunk` header with 12px labels, hairline row dividers, mono for
  lane, leaf, gas and hash columns, right-aligned numbers.
- **Empty states**: one plain sentence saying what will appear and the one action that makes it appear.
- **Explanations**: keep every piece of text, but long help goes into small `--ink-3` text under its control, or a
  native `<details>` with a short summary when it is more than two lines.
- Icons: lucide only, 16px, 1.5 stroke. No emoji, no unicode glyphs as icons.

## Signature move: the key sheet

Every account has 1,024 one-time keys (height 10). Draw them as a **32 × 32 grid of 7px squares with 2px gaps**,
leaf 0 top-left, row by row:

- unused cold leaf: 1px `--rule` outline, empty;
- used cold leaf (OnChain): filled `--cold`;
- hot band (from hotStart to 1023): 1px `--hot` outline; a used hot leaf is filled `--hot`;
- reserved / signed / submitted: filled `--wait`;
- burned / expired: filled `--bad`;
- hover or focus shows the leaf number and state; a legend under the grid with counts per state.

The key sheet is the hero of the wallet panel and the cold-device area. The lane board echoes it: each lane row
carries a thin three-step track (Signed → Admitted → OnChain) in the state colours. That is the only decoration.

## Never

Same-size icon cards as page structure, a hero metric with sparkline, eyebrow labels above headings, section
numbers, gradient text, glass or blur, coloured left borders on callouts, hard offset shadows, monospace as costume,
emoji, a modal for something that needs no interruption, and grey-on-grey text below 4.5:1.
