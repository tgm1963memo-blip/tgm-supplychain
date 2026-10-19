---
name: TSS Supply Chain
description: Sales and planning system for TSS and TGM, where key figures are printed like cold-chain carton labels.
colors:
  seal-navy: "#1B2064"
  seal-navy-900: "#11144A"
  seal-navy-700: "#2A3080"
  seal-navy-500: "#6A70B8"
  seal-navy-300: "#B9BDE0"
  seal-navy-100: "#DDE0F0"
  seal-navy-50: "#EEF0F8"
  seal-red: "#C3161B"
  seal-red-700: "#A01216"
  seal-red-50: "#FCECEC"
  on-red: "#FFFFFF"
  cold-ground: "#F3F4F8"
  label-stock: "#FFFFFF"
  label-stock-2: "#FAFAFD"
  rule-line: "#D9DCE8"
  rule-line-2: "#ECEEF4"
  ink: "#14163A"
  ink-2: "#4B4F6E"
  ink-3: "#646887"
  ok-green: "#1F7A4D"
  ok-green-50: "#E6F4EC"
  warn-amber: "#9A5200"
  warn-amber-50: "#FDF1E1"
  sample-pill-bg: "#FFF4DB"
  sample-pill-fg: "#7A5300"
  chart-mute: "#A3A7C2"
typography:
  display:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1.25
  figure:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: "38px"
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  stat-figure:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "30px"
    fontFeature: "tnum"
  headline:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "24px"
  title:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "tnum"
  table:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "tnum"
  band-label:
    fontFamily: "IBM Plex Sans Thai, Noto Sans Thai, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.08em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    letterSpacing: "0.01em"
  lot-line:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0.02em"
rounded:
  tick: "1px"
  tag: "4px"
  inner: "6px"
  control: "8px"
  card: "10px"
  modal: "12px"
  pill: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.seal-red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.seal-red-700}"
  button-navy:
    backgroundColor: "{colors.seal-navy}"
    textColor: "{colors.label-stock}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.seal-navy}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.seal-navy-50}"
  button-ghost-hover:
    backgroundColor: "{colors.seal-navy-50}"
    textColor: "{colors.seal-navy}"
  segment-active:
    backgroundColor: "{colors.seal-navy}"
    textColor: "{colors.label-stock}"
    rounded: "{rounded.inner}"
    height: "28px"
    padding: "0 12px"
  chip:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "38px"
    padding: "0 12px"
  card:
    backgroundColor: "{colors.label-stock}"
    rounded: "{rounded.card}"
    padding: "16px 20px 20px"
  lot-label-band:
    backgroundColor: "{colors.seal-navy}"
    textColor: "{colors.label-stock}"
    typography: "{typography.band-label}"
    height: "28px"
    padding: "0 16px"
  lot-label-band-red:
    backgroundColor: "{colors.seal-red}"
    textColor: "{colors.on-red}"
    typography: "{typography.band-label}"
    height: "28px"
    padding: "0 16px"
  stat-strip:
    backgroundColor: "{colors.label-stock}"
    textColor: "{colors.seal-navy}"
    rounded: "{rounded.card}"
    padding: "14px 20px"
  tag:
    backgroundColor: "{colors.seal-navy-50}"
    textColor: "{colors.seal-navy}"
    rounded: "{rounded.tag}"
    padding: "0 8px"
    height: "20px"
  nav-sidebar:
    backgroundColor: "{colors.seal-navy}"
    width: "232px"
  nav-badge:
    backgroundColor: "{colors.seal-red}"
    textColor: "{colors.on-red}"
    height: "18px"
    padding: "0 6px"
---

# Design System: TSS Supply Chain

<!-- Recorded from the shipped mockup .scratch/redesign-mockup/ (finish review: ship, 2026-10-17). This system is the target for a later migration into the production index.html, which does not use it yet. -->

## Overview

**Creative North Star: "The Lot Label"**

Every key figure is printed like the cold-chain carton label that leaves the TSS plant: a fact with a code, a lot and a date. White label stock sits on a cool navy-tinted ground. The navy of the TSS seal owns the sidebar, headings and figures. The seal's red is an ink used sparingly, so when it appears it means "this is the headline" or "this is the decision". The world turns down the generic SaaS card grid with coloured side borders and emoji.

The system is dense and numeric, built for people who read sales, stock and approval state all day. Columns stay fixed and values change in place. On a period switch the label figures and month ticks reprint where they stand instead of re-laying out. Status is printed in one mark vocabulary (hollow, filled, hatched, struck) shared by every table, chain and Gantt, so it never depends on colour alone. Retired items print grey rather than disappearing.

Two themes ship from the same tokens: light (the label on cold ground) and dark (a deep navy room with lightened seal inks). Desktop is the working surface. Every page still works at 390px, where tables turn into stacked label/value rows.

**Key Characteristics:**
- Palette sampled from the TSS seal: indigo-navy, red, white. The old gold accent is retired.
- Lot-label KPI cards with die-cut notched corners, a header band, a dashed perforation and a 12-tick month ruler.
- IBM Plex Sans Thai for the UI, IBM Plex Mono for codes, document numbers and lot lines only, tabular numerals everywhere.
- One printed state-mark vocabulary across tables, approval chains and the Gantt.
- Flat label stock: 1px rules, no resting shadows on content.

## Colors

The palette is three seal inks (navy, red, white) spread over a cool navy-tinted neutral ramp, plus green and amber kept for outcomes and warnings.

### Primary
- **Seal Navy** (`seal-navy`): the system's voice. Sidebar ground, page and card titles, every figure, active segments, checked chips, filled state marks, hit ticks on the month ruler, chart series 1, focus rings, and the default lot-label band. Its ramp (`seal-navy-900` to `seal-navy-50`) supplies toast ground, chart series 2 and 3, hover tints, selected rows and tag fills.

### Secondary
- **Seal Red** (`seal-red`): the rare ink. Used only where the Rare Red Rule allows. `seal-red-700` is its hover; `seal-red-50` is the tint behind error alerts, red tags and the halo on the current approval step.

### Tertiary
- **Outcome Green** (`ok-green`, tint `ok-green-50`): positive deltas (▲), success alerts and toasts, the live-sync dot, "ok" tags.
- **Warning Amber** (`warn-amber`, tint `warn-amber-50`): late or at-risk items (warn mark, late Gantt bar), changed-but-unsaved cells, warning alerts.
- **Sample Pill** (`sample-pill-bg` / `sample-pill-fg`): only for the "ข้อมูลตัวอย่าง" sample-data pill in the top bar.

### Neutral
- **Cold Ground** (`cold-ground`): page background behind all label stock.
- **Label Stock** (`label-stock`, `label-stock-2`): card, table, input and modal surfaces; `label-stock-2` is table headers, footers, row hover and read-only fields.
- **Rule Lines** (`rule-line`, `rule-line-2`): card and control borders, then the lighter row dividers, ruler future ticks and progress tracks.
- **Ink** (`ink`, `ink-2`, `ink-3`): body text, secondary text, then labels, captions, axis text and retired rows.
- **Chart Mute** (`chart-mute`): unchecked checkbox strokes, hatched draft marks, muted chart text.

Dark theme reassigns the same token names (navy lightens to `#AEB3F0`, red to `#F0545A`, ground to `#0E1030`). The full dark map is in `.impeccable/design.json`. Pages only reference tokens, never theme-specific hex.

### Named Rules
**The Seal Ink Rule.** Every hue comes from the TSS seal (red, indigo-navy, white) or is a functional outcome colour (green, amber). Gold `#D4AF37` is retired and must not come back.

**The Rare Red Rule.** Red appears in exactly six roles: the single headline label band per page, the current-month ruler tick, target lines on charts, the one decisive commit action per page (approve, submit, create, log in), notification badges and dots, and negative deltas (▼). Outside those six, red only reports state: errors and validation (error borders, error alerts, reject buttons, the required asterisk) and "waiting on you" (the hollow red mark and the current approval step). Anything else that needs emphasis uses navy. A filled navy button is for progression ("ถัดไป") or an emphasised action that doesn't commit anything.

## Typography

**Display / UI Font:** IBM Plex Sans Thai (with Noto Sans Thai, system-ui), weights 400 to 700
**Mono Font:** IBM Plex Mono (with ui-monospace, Cascadia Mono), weights 400 to 600

**Character:** A humanist Thai sans that holds dense Latin and Thai tables at 13 to 14px, paired with a typewriter-precise mono for the printed facts on a label. Both are embedded as base64 woff2 (`src/fonts.css`), so they render offline and in print.

### Hierarchy
- **Display** (600, 34px, 1.25): the login art panel headline only.
- **Figure** (700, 30px / 38px, -0.01em): the lot-label figure; drops to 28px at ≤520px. The unit sits beside it as a 15px/600 `small`.
- **Stat Figure** (700, 22px / 30px): values in the compact stat strip.
- **Headline** (600, 18px / 24px, navy): page title in the top bar.
- **Title** (600, 15px / 22px, navy): card and section headings; modal titles use 16px.
- **Body** (400, 14px / 1.6): base text. 14px is the floor for Thai reading text.
- **Table** (400, 13px): table cells; headers are 12px/500 in `ink-3`.
- **Band Label** (600, 11px, 0.08em): the lot-label band names its figure in English capitals ("NET SALES"), followed by the Thai name at 500 weight.
- **Lot Line / Mono** (400, 11px for lot lines, 12.5px for codes): customer codes, SKU codes, document numbers, lot lines and ruler month numbers.

### Named Rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` is set on the body and applies everywhere. Digits line up in columns, and figures that reprint don't jitter.

**The Mono Means Code Rule.** IBM Plex Mono is only for codes, document numbers and lot lines (and the ruler's month digits). Amounts, percentages and labels stay in Plex Sans Thai.

## Layout

The shell has three parts: a 232px sticky navy sidebar (it collapses to a 68px icon rail), a 60px sticky white top bar (breadcrumb, title, sync state, theme, inbox, sample pill), and a content column padded 20px 24px 48px with a 16px vertical gap. Pages follow one order: filter bar (company and period segments, chips, Export on the right), then the figure row, then trend and mix (a 2fr/1fr grid), then detail tables. Grids use 16px gaps. Forms use a 12-column grid with 14px by 16px gaps.

Spacing steps are 4, 8, 12, 16, 20 and 24px. Controls are 36px tall (inputs 38px, small buttons 30px).

Responsive behavior:
- **≤1180px:** the four-up label row becomes 2×2; 2fr/1fr and 1fr/2fr grids stack.
- **≤860px:** the sidebar becomes an off-canvas drawer with a scrim, opened from a burger. The breadcrumb, sync text and sample pill are hidden. Forms go single-column. Stat-strip cells take half width. The login drops its label strip.
- **≤640px (phone):** see the Phone Stack Rule.
- **≤520px:** label rows go one-up and search takes the full width.

### Named Rules
**The Phone Stack Rule.** At ≤640px every table becomes stacked label/value rows: the primary cell spans the row and the others pair two-up with their header as a caption. This covers `ui.table` and hand-built tables (through `autoStack()`), footers included. Tables with a two-row header keep horizontal scroll with the first column (and optionally the second) pinned. Scrollable charts open scrolled to the current month.

**The One Label Row Rule.** Lot-label KPIs appear only on overview and analysis pages (Dashboard, Sales Overview, Stock & Planning, เปรียบเทียบผลิต, Login), with at most one row per page. Work and document pages use the compact stat strip.

## Elevation & Depth

Content is flat label stock on cold ground. Depth comes from the ground/stock contrast and 1px rules, not from shadows. Shadows are kept for things that float above the page: modals, side panels, the mobile drawer, toasts, and the A4 sheet sitting on its grey tray.

### Shadow Vocabulary
- **Sheet** (`box-shadow: 0 1px 2px rgba(17,20,74,.06), 0 4px 12px rgba(17,20,74,.05)`): the A4 document preview only.
- **Float** (`box-shadow: 0 12px 32px rgba(17,20,74,.18), 0 2px 6px rgba(17,20,74,.08)`): modals, side panels, the off-canvas sidebar, toasts.

### Named Rules
**The Flat Stock Rule.** Cards, labels, tables and stat strips have no resting shadow. The lot label draws its edge as a 1px inset rule so the die-cut notches stay crisp.

## Shapes

Gentle, consistent corners: 10px on cards, stat strips and fieldsets; 8px on controls and nav items; 6px on segment thumbs and table cell inputs; 4px on tags; 12px on modals; 1px on ruler ticks. State marks and avatars are circles. The lot label is the one distinctive silhouette: 7px concave notches die-cut from all four corners (a radial-gradient mask), a 1.5px dashed perforation rule across its full width, and a 12-tick ruler of 8px bars. Dashed 1.5px rules also mark drop zones.

## Components

### Buttons
Quiet and outlined by default, with colour reserved for meaning.
- **Shape:** 8px corners, 36px tall, 16px side padding, 13.5px/500 text, optional 16px stroke icon.
- **Primary (red):** `seal-red` fill, white text; hover `seal-red-700`. One per page, for the decisive commit only (see the Rare Red Rule).
- **Navy:** `seal-navy` fill, for progression (stepper "ถัดไป") or an emphasised action that doesn't commit anything.
- **Secondary:** white stock, 1px `rule-line` border, navy text; hover gets a `seal-navy-300` border and `seal-navy-50` fill.
- **Ghost:** no border at rest, `seal-navy-50` on hover. Used for cancel, recall and reset.
- **Danger:** secondary shape with red text; hover adds a red border and a `seal-red-50` fill. Used for reject.
- **Focus:** 2px navy outline, 2px offset. **Disabled:** 45% opacity.

### Segments and Chips
- **Segment:** a white track with a 1px rule and 3px inset. The active thumb is filled navy. Used for company and period switches.
- **Chip:** a 36px toggle with a 16px checkbox square. When pressed, the box fills navy with a white check and the label turns navy.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** `label-stock` on `cold-ground`.
- **Shadow Strategy:** none (Flat Stock Rule).
- **Border:** 1px `rule-line`.
- **Internal Padding:** header 16px 20px 8px with a 15px navy title and a 12.5px `ink-3` sub line; body 8px 20px 20px, or flush for tables.

### Inputs / Fields
- **Style:** 38px, 1px `rule-line`, 8px corners, white. Labels are 12.5px/500 `ink-2`, and the required asterisk is red.
- **Focus:** navy border plus a 3px `seal-navy-50` ring.
- **Error / Read-only:** red border with a 12px red message and icon; read-only fields sit on `label-stock-2` in `ink-2`.

### Navigation
- **Sidebar:** `seal-navy` ground, grouped menu with 11.5px muted group heads, 34px items with 16px stroke icons. Hover is a 7% white wash; the current page is a 13% white wash with white 500 text. Notification counts are red pills. A role switch (Sales / Planning / Admin) sits under the brand, with the active option on white.
- **Top bar:** white, 60px, a 1px bottom rule, an 18px navy title, and 36px outlined icon buttons; the inbox carries a red dot.
- **Tabs:** text tabs with a 2px navy underline when active and navy-tint count pills. Pill tabs use a `seal-navy-50` fill when active.

### Lot Label (signature)
The headline figure as a printed carton label. From top to bottom: a 28px band (navy, or red for the page's single headline), the figure with its unit, a delta line (▲ green / ▼ red, or a navy progress bar against target), a mono lot line (`LOT NS-YTD-2569 · ALL · 17/10`), a dashed perforation, and the month ruler with its digits. Labels sit four-up, or three-up with `k3`.
- **Month ruler:** each tick is that KPI's own month. Filled navy = hit target, hollow navy = missed, red = current month (open), grey = future. The current month's digit is navy and bold. A legend row spans the label grid under the row.
- **Reprint:** on a period switch the band wipes in left to right (0.42s), the figure and lot line re-ink from a slight blur (0.5s), and the ticks grow from 20% height (0.4s), all on `cubic-bezier(.2,.8,.2,1)`. All motion is disabled under `prefers-reduced-motion`.

### Compact Stat Strip
One 10px-cornered white strip divided into cells by 1px rules. Each cell has a 12.5px `ink-3` key, a 22px/700 navy value with a small unit, and an optional 12px sub line. It holds a work or document page's summary figures.

### State Marks
A 12px circle followed by a label. Used in tables, lists and documents:
- **Pending:** hollow navy ring.
- **Waiting on you:** hollow red ring, red 600 label.
- **Done / OK:** filled navy, navy label.
- **Draft:** hatched grey ring.
- **Cancelled:** struck grey ring with a struck-through grey label; the whole row prints grey (`ink-3`).
- **Warn / Late:** filled amber, amber label.

Tags (4px, 20px tall, tinted fill) carry categories such as channel. Tones are navy (default), ok, warn, red, grey and outline.

### Approval Chain
A horizontal row of 24px step dots joined by a 2px rail. Done steps are filled navy with a white check and a navy rail. The current step is a red ring with a `seal-red-50` halo and a red name. Upcoming steps are a `seal-navy-300` ring. Cancelled steps are a grey ring.

### Tables
13px cells with 11px by 16px padding (7px by 12px when dense). Headers are 12px/500 `ink-3` on `label-stock-2` between 1px rules, sticky. Row dividers are `rule-line-2`; hover and footers use `label-stock-2`; selected rows are `seal-navy-50`. Amounts are right-aligned. Editable cells are 30px inputs that turn amber when changed.

### Production Gantt
Bars use the same mark vocabulary: running = filled navy with a progress underline, planned = hollow navy, late = amber, finished = pale `seal-navy-100` with navy text so finished work recedes. Weekend columns sit on `label-stock-2`.

### Charts
Hand-drawn SVG: monthly bars in navy, last year as a `seal-navy-500` line, the target as a red dashed line, the current open month as a `seal-navy-300` bar, and future months as dashed empty slots. Horizontal mix bars use the navy ramp (series 1 for the top two, 2 for the next three, 3 for the rest).

## Do's and Don'ts

### Do:
- **Do** take every hue from the seal tokens (`seal-navy`, `seal-red`, white) or the functional green and amber, and reference tokens so both themes follow.
- **Do** keep red to its six roles (one headline band, the current-month tick, target lines, the one commit action, notification badges, negative deltas), plus error and waiting-on-you states.
- **Do** put lot labels only on overview and analysis pages, at most one row per page, and use the compact stat strip everywhere else.
- **Do** show status with the shared mark vocabulary (hollow, filled, hatched, struck, amber) in tables, chains and the Gantt alike, and print cancelled rows grey.
- **Do** make every table stack into label/value rows at ≤640px (through `ui.table` or `autoStack()`, footers included), and open scrolled charts at the current month.
- **Do** keep tabular numerals on and use IBM Plex Mono only for codes, document numbers and lot lines.
- **Do** reprint figures in place on a period switch rather than re-laying out the page.

### Don't:
- **Don't** bring back the retired gold `#D4AF37` or add any hue that isn't from the seal.
- **Don't** use a red filled button for a non-committing action, or put more than one red band or red commit button on a page.
- **Don't** build card grids with coloured side borders or emoji icons; icons are 16px stroke SVGs.
- **Don't** put resting shadows on cards, labels or tables.
- **Don't** signal status with colour alone; every state has a distinct mark shape.
- **Don't** set amounts or percentages in mono.
