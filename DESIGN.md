# Design System

The visual language of **jsonl-tools** — a dark, monospace, developer-tool
aesthetic where JSON itself is the brand. This document is the reference for
color, type, components, interaction, and the logo system.

> Companion docs: [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
> [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md)
>
> The current theme was derived from a Claude Design handoff
> (`jsonl-tools.dev Themed.html`) that sampled the live site and dropped the
> `{ ⚙ }` logo into the header.

## Overview

The product looks like the thing it operates on: a terminal-adjacent surface
rendered entirely in a monospace face, on a deep navy background. The identity
is literally JSON — a gear (the "tool") wrapped in curly braces: `{ ⚙ }`.

The palette is **two-accent**:

- **Cyan `#1ba6c9`** drives *interaction* — buttons, focus rings, active tabs,
  the user menu, JSON keys.
- **Violet `#9b86f5`** is the *brand* — the logo, saved-session links, and JSON
  string values.

This replaced the earlier single-purple (`#7c3aed`) direction: the logo settled
on the lavender `#9b86f5` of the saved-session links, while cyan stayed the
interactive accent exactly as on the live site.

## Color

Eight CSS custom properties defined once in `:root` (`src/index.css`, mirrored
in `src/bulk-analyzer.css`) carry the whole palette. Everything else is derived
from them.

| Token              | Value                      | Role                                                        |
| ------------------ | -------------------------- | ----------------------------------------------------------- |
| `--color-primary`   | `#0d1421`                  | Page background (deep navy)                                  |
| `--color-secondary` | `#e8edf6`                  | Primary text (ink)                                          |
| `--color-accent`    | `#1ba6c9`                  | **Cyan** — interactive: buttons, focus, active tab, JSON keys |
| `--color-brand`     | `#9b86f5`                  | **Violet** — brand, links, JSON string values               |
| `--color-neutral`   | `#8b95ad`                  | Cool slate — secondary highlight (tool names, medium deltas) |
| `--color-muted`     | `#6b7892`                  | Muted text — meta, secondary nav                            |
| `--color-faint`     | `#566076`                  | Faintest — `|` separators                                   |
| `--color-border`    | `rgba(110, 135, 170, 0.28)` | Soft panel/table/input borders                              |

### Semantic colors

A small set of fixed hexes carry meaning regardless of the palette:

| Purpose            | Value     | Seen on                                         |
| ------------------ | --------- | ----------------------------------------------- |
| Danger / error / `null` | `#ff6b6b` | Errors, destructive controls, revoke tags, null values |
| Success            | `#98c379` | Copy-success                                     |
| Assistant accent   | `#7ee787` | `assistant` row type in the analyzer table       |
| Numbers            | `#d19a66` | JSON int/float/bigint                            |
| Boolean            | `#c678dd` | JSON booleans                                    |

> Two accent-filled controls — `.send-button` and the analyzer's active `.tab` —
> use a literal `white` label instead of `--color-primary`. That `white` is the
> only hardcoded color outside the token and semantic sets above.

### Surface elevation

There is no separate set of "surface" tokens. Elevated and recessed surfaces
are mixed from `--color-primary` toward black at call sites:

```css
background: color-mix(in srgb, var(--color-primary) 80%, black); /* inputs, tables   */
background: color-mix(in srgb, var(--color-primary) 90%, black); /* cards, panels    */
background: color-mix(in srgb, var(--color-primary) 70%, black); /* deepest insets   */
```

The lower the percentage of `primary`, the deeper the surface reads. Structural
borders use the soft `--color-border`; smaller controls sometimes soften
`--color-muted` further with `color-mix(... var(--color-muted) 40%, transparent)`.

## Typography

A single monospace stack, everywhere:

```css
font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

- **Base:** `14px`, `line-height: 1.5`
- **Buttons / inputs:** `16px`
- **Meta / hints / table summaries:** `12–13px`
- **`h1` / header lockup:** large (the logo lockup is `40px`)
- Numeric/meta runs use `font-variant-numeric: tabular-nums` so timestamps and
  counts align.

> The source design used **JetBrains Mono**; the app deliberately keeps the
> system monospace stack (no external/Google-Fonts request — this is an
> encrypted-sharing tool). Swap the `font-family` above to adopt JetBrains Mono.

## Theme & surfaces

- **Dark only.** `:root` declares `color-scheme: dark` with
  `background-color: var(--color-primary)` and `color: var(--color-secondary)`.
- Depth is conveyed by the `color-mix` surface convention above plus thin
  `--color-border` borders and the occasional `box-shadow: 0 6px 20px rgba(0,0,0,0.35)`
  on popovers and menus.
- **Reduced motion** is respected globally — all animation is disabled under
  `@media (prefers-reduced-motion)`.

## Layout

- The body is centered and constrained: `max-width: 70vw; margin: 0 auto`.
- A fixed footer sits at the bottom on the primary background.
- Content sections stack vertically with generous gaps; rows use flexbox with
  consistent `8–16px` gaps.

## Components

The component catalog, all built from the tokens above.

**Header lockup (`.site-title` / `.site-logo`)** — the `{ ⚙ } jsonl-tools`
brand mark replaces a plain text title. Rendered inline (see Brand & logo
system) so it always reads on the forced-dark background.

**Buttons**
- **Filled (default `button`)** — **cyan** accent background, `--color-primary`
  text, `600`+ weight. The primary call to action.
- **Ghost (`.button-ghost`, `.upload-button`)** — transparent fill, soft border
  and ink/muted text; brightens on hover.
- **Icon (`.icon-button`)** — square `44px`, transparent until hover, accent
  glyph; for copy/regenerate affordances.

**Inputs** — `textarea`, `.share-title`, and account/secret inputs sit on a
recessed surface with a soft border. Secret and link inputs render their value
in the cyan accent, monospace.

**Share card & toggle** — `.share-card` groups title + action + result into one
bordered panel. `.share-toggle` is a custom switch (track + knob) that turns
cyan when on and pulses while busy.

**Tabs (`.panel-tabs`)** — text buttons with a transparent bottom border; the
active tab is **cyan** with a cyan underline.

**Tables** — full-width, collapsed borders, header row on `--color-primary`,
body on a recessed surface. `.viewer-table` is fixed-layout with a narrow muted
line-number column. The analyzer table adds delta (fast/medium/slow) and
row-type (user/assistant/queue/other) color coding.

**Links** — saved-session titles (`.history-entry a`) read as **violet**,
underlined — the brand link treatment. The logged-in `@user ▾` menu trigger is
cyan.

**Modal (`.modal-overlay` / `.modal-content`)** — centered card over an 85%
black scrim, with a cyan `h3` scale inside.

**Popover menus (`.user-menu`, `.menu-list`)** — small bordered panels with a
drop shadow; items highlight with a translucent-accent background on hover.

**CLI token manager (`.cli-tokens`)** — a copyable terminal-style command
callout (muted `$` prompt + accent command), an "+ Add" ghost button, and a
spaced token list with a pinned Revoke control.

**API tester (`.endpoint-row`)** — a bordered row whose border turns cyan on
`:focus-within`, with a method pill and an inline URL input.

**Secret row (`.secret-row`)** — `[ value ] (actions) (copy)`: a copyable
secret box (accent text, `user-select: all`) trailed by ghost icon buttons.
Reused by the generated passphrase, recovery code, and the CLI command block.

## Interaction language

- **Hover on filled controls** darkens the cyan fill:
  `color-mix(in srgb, var(--color-accent) 80%, black)`.
- **Hover on quiet controls/links** brightens muted → secondary, or muted →
  accent.
- **Focus** moves cyan onto the border (`:focus`, `:focus-within`).
- **Active selection** (tabs) is signalled with cyan text + a cyan underline.
- **Brand links** (saved-session titles) are violet + underline.
- **Transitions** are short and eased — typically `0.15s`–`0.18s ease` on
  `background`, `border-color`, and `transform`.

## JSON viewer theme

The `@uiw/react-json-view` instances (main app, data view, analyzer expanded
rows) share one token map from `src/json-view-style.ts`, parameterized only by
font size so JSON renders identically everywhere. The headline split mirrors the
design: **keys in cyan, string values in violet.**

| Element                     | Color     |
| --------------------------- | --------- |
| Keys (string + number) / edit / update / copied / URLs | `#1ba6c9` (cyan) |
| Strings / quotes-string     | `#9b86f5` (violet) |
| Numbers (int/float/bigint)  | `#d19a66` |
| Boolean                     | `#c678dd` |
| `null` / `undefined`        | `#ff6b6b` |
| Braces / brackets / base    | `#aaaaaa` |
| Colons / quotes / arrows / lines / info | `#6b7892` (muted, varying alpha) |
| Dates / NaN / ellipsis      | `#8b95ad` (neutral) |
| Copied-success              | `#98c379` |

## Brand & logo system

The identity is **`{ ⚙ }`** — a gear (the "tool") inside JSON curly braces —
extending to the wordmark **`{ ⚙ } jsonl-tools`**, where `jsonl` is ink and
`-tools` is **violet** (`.dev` dropped). The gear, braces, and `-tools` are all
brand violet; the gear has **rounded teeth** (concept R1).

### Two renderings

| Where | What | Why |
| ----- | ---- | --- |
| **In-app header** | An inline JSX lockup (`SiteLogo` in `src/App.tsx`, styled by `.site-logo`) | The app is permanently dark; an inline lockup follows the theme tokens and never mis-renders the way a `prefers-color-scheme`-adaptive `<img>` would on a forced-dark page |
| **Distributable assets** | Generated SVGs in `src/` (below) | Self-contained, background-adaptive files for the favicon and any external use |

### Assets

All three are generated SVGs in `src/`:

| File          | Lockup                | Use                                    |
| ------------- | --------------------- | -------------------------------------- |
| `favicon.svg` | gear only             | Browser favicon (clean down to 16px); referenced by every HTML entry point |
| `mark.svg`    | `{ ⚙ }`               | Compact app mark                       |
| `logo.svg`    | `{ ⚙ } jsonl-tools`   | Full wordmark lockup                   |

### Principles

- **One hue, one adaptive neutral.** A single brand violet plus one neutral
  that flips per background via an inline `prefers-color-scheme` rule, so a
  single self-contained file works on any background — light or dark.
- **Computed geometry, not a traced bitmap.** The gear is generated math
  (rounded tooth tips via quadratic curves + a real round hub-hole via
  `fill-rule="evenodd"`) and the braces are stroked bézier paths, so the marks
  stay crisp at any size.

### Brand constants

Defined in `scripts/gen-brand.ts`:

| Constant            | Value     | Meaning                                       |
| ------------------- | --------- | --------------------------------------------- |
| `BRAND`             | `#9b86f5` | Gear + braces + `-tools` (matches `--color-brand`) |
| `NEUTRAL_LIGHT_BG`  | `#0d1421` | `jsonl` on a light background                  |
| `NEUTRAL_DARK_BG`   | `#e8edf6` | `jsonl` on a dark background                   |

### Regenerating

The three SVGs are build artifacts — edit the generator, never the SVGs by hand:

```sh
bun scripts/gen-brand.ts
```

This rewrites `src/favicon.svg`, `src/mark.svg`, and `src/logo.svg`. To restyle
the brand (hue, neutrals, gear proportions, brace shape), change the constants
and geometry parameters in `scripts/gen-brand.ts` and rerun. The in-app header
lockup (`SiteLogo`) carries its own copy of the rounded-gear geometry — keep the
two in sync if you change tooth count or proportions.

### Social card (Open Graph)

`src/og.png` is the single 1200×630 link-preview card used as `og:image` /
`twitter:image` for every indexable page (the docs head model in
`src/server/docs-page.ts`; served at `/og.png`). It is the `{ ⚙ } jsonl-tools`
lockup on the dark `#0d1421` background with the tagline *“Browser tools for
Agentic JSONL traces.”*

Unfurlers (Slack, X, LinkedIn, iMessage) want a **raster** image at that size —
SVG `og:image`s are widely rejected — so the card is composed as an SVG from the
shared brand primitives (`cogPath` / `bracePath`) and rasterized to PNG with the
`puppeteer` already used for mermaid. Like the SVGs it is a committed build
artifact — edit the generator, never the PNG:

```sh
bun run gen:og   # rewrites src/og.png
```

The card is referenced only from indexable docs, never the key-bearing `/s/`
viewer, so no share metadata can leak into a link preview.

## Docs pages

The in-app documentation at `/docs` is **generated from Markdown at build time**.
`docs/public/*.md` is the single source of truth; each file becomes a themed page
at `/docs/<basename>` (e.g. `docs/public/cli.md` → `/docs/cli`), shown on the
`/docs` index and reachable from the header **Docs** link. Pages reuse the shared
`SiteLogo` lockup and a standalone `src/docs.css` that re-declares the `:root`
tokens (like `src/bulk-analyzer.css`) — keep those token values in sync with
`src/index.css`.

Conversion happens ahead of serving, never per request: `scripts/gen-docs.ts`
runs `marked` over each file and writes the committed `src/docs.generated.ts`
that the docs bundle imports. Because conversion is build-time, `marked` (and the
mermaid toolchain below) stay **devDependencies** — they never enter a browser
bundle (enforced by `src/boundary.test.ts`) nor the pruned production image. The
generator's renderer drops raw HTML and neutralizes dangerous link/image schemes
(`javascript:`/`data:`), so the shipped HTML is sanitized at generation time (the
content is first-party).

**Mermaid diagrams** in fenced ` ```mermaid ` blocks are rendered to **inline
SVG at build time** via `@mermaid-js/mermaid-cli` (headless Chromium), themed to
the `:root` tokens, and baked into the committed artifact — so no diagram/runtime
library ships to the browser. Each SVG is given a unique root id (mermaid-cli
hardcodes `my-svg`, which would collide on a page with multiple diagrams) and is
stripped of any `<script>`/event handlers defensively. Note the SVG output is not
byte-deterministic (generated ids, font metrics), so regenerating produces diff
churn in those blocks; the drift guard (below) compares everything *except* the
diagram SVGs, so it stays stable. Non-mermaid fences render as escaped
`<pre><code>`.

### Regenerating docs

`src/docs.generated.ts` is a build artifact — edit the source docs, never the
generated file by hand:

```sh
bun run gen:docs
```

This rewrites `src/docs.generated.ts` from `docs/public/*.md`. After editing any
public doc, rerun it and commit the regenerated module; a `bun test` drift guard
(`scripts/gen-docs.test.ts`) fails if the committed artifact and the source ever
diverge.
