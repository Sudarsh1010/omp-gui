---
name: omp-gui (working title)
description: Quiet mission control for many concurrent agent sessions — warm utilitarian, sharp-cornered, emerald-signaled.
colors:
  working-emerald: "oklch(0.508 0.118 165.612)"
  emerald-wash: "oklch(0.979 0.021 166.113)"
  paper: "oklch(1 0 0)"
  stone-ink: "oklch(0.147 0.004 49.25)"
  stone-mist: "oklch(0.97 0.001 106.424)"
  stone-voice: "oklch(0.553 0.013 58.071)"
  stone-hairline: "oklch(0.923 0.003 48.717)"
  signal-red: "oklch(0.577 0.245 27.325)"
typography:
  display:
    fontFamily: "Merriweather Variable, serif"
    fontWeight: 600
  title:
    fontFamily: "Merriweather Variable, serif"
    fontSize: "0.875rem"
    fontWeight: 500
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  none: "0px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
components:
  button-primary:
    backgroundColor: "{colors.working-emerald}"
    textColor: "{colors.emerald-wash}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "32px"
    padding: "0 10px"
  button-primary-hover:
    backgroundColor: "color-mix(in oklab, oklch(0.508 0.118 165.612) 80%, transparent)"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stone-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "32px"
    padding: "0 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.stone-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "32px"
    padding: "0 10px"
  button-destructive:
    backgroundColor: "color-mix(in oklab, oklch(0.577 0.245 27.325) 10%, transparent)"
    textColor: "{colors.signal-red}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "32px"
    padding: "0 10px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.stone-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    height: "32px"
    padding: "4px 10px"
  badge:
    backgroundColor: "{colors.working-emerald}"
    textColor: "{colors.emerald-wash}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "20px"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stone-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "16px"
  tooltip:
    backgroundColor: "{colors.stone-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "6px 12px"
---

# Design System: omp-gui (working title)

## Overview

**Creative North Star: "Mission Control, Quiet"**

A flight deck for N concurrent agents where everything is scannable at a glance and nothing performs. The system is warm utilitarian: a strictly functional, terminal-dense core softened by warm stone neutrals and serif headings. Color is state, not decoration — one green means the agent is working or succeeded, one red means something failed or destroys, and everything else stays near-monochrome so a wall of live sessions reads calmly. Alarms only when real, no theatrics.

The material character is flat and precise: sharp-cornered rectangles separated by hairline rings, compact 32px controls, 12px type. Depth appears only when something genuinely floats. Controls are quiet until pressed — a 1px downward nudge and a focus ring are the only theatrics the system allows.

**Key Characteristics:**

- OKLCH-native palette: muted emerald signal on warm stone neutrals, light and dark
- Sharp rectangles everywhere; the full circle is the only permitted curve
- Flat at rest (hairline rings), shadow only on floating overlays
- Dense, instrument-grade scale: 12px body, 32px controls, 4px spacing unit
- Serif (Merriweather) headings as editorial calm inside a Geist/Geist Mono tool
- Phosphor icons, 16px default, 12–14px in compact controls

## Colors

A near-monochrome warm-stone field where chroma is reserved for meaning: emerald for the agent's work and success, red for failure and destruction. Both themes are OKLCH throughout; the `.dark` class flips the same token names.

### Primary

- **Working Emerald** (`oklch(0.508 0.118 165.612)`): the product's one voice — primary actions, active/selected agent state, checked controls, links. Doubles literally as `--success`; success is not a separate hue.
- **Emerald Wash** (`oklch(0.979 0.021 166.113)`): text and icons on Working Emerald surfaces.
- The chart ramp is five emeralds (`oklch(0.845…)` → `oklch(0.432…)`), so even data visualization stays in the one-hue world. Dark mode dims primary to `oklch(0.432 0.095 166.913)`.

### Neutral

- **Stone Ink** (`oklch(0.147 0.004 49.25)`): foreground text; also the tooltip surface (inverted). Dark mode's background.
- **Paper** (`oklch(1 0 0)`): background and card surface in light mode.
- **Stone Mist** (`oklch(0.97 0.001 106.424)`): muted/accent fills — hover washes, inline code, skeletons.
- **Stone Voice** (`oklch(0.553 0.013 58.071)`): secondary text (`--muted-foreground`).
- **Stone Hairline** (`oklch(0.923 0.003 48.717)`): borders and input strokes. In dark mode hairlines become white alphas (`oklch(1 0 0 / 10%)` borders, `/ 15%` inputs).

### Tertiary

- **Signal Red** (`oklch(0.577 0.245 27.325)`): destructive actions and error state only — always as a 10–20% wash behind red text, never a solid red button. Brightens to `oklch(0.704 0.191 22.216)` in dark mode.

### Named Rules

**The Two-Signals Rule.** Emerald means the agent is working or succeeded; red means it failed or would destroy something. No third accent may be introduced; everything else earns at most a stone-gray wash. On a screen of N live sessions, chroma is the alarm channel — keep it silent by default.

**The Wash-Not-Block Rule.** Destructive affordances are red text on a red-tinted wash (`destructive/10`, hover `/20`), never solid red fills. Solid color blocks are reserved for the primary action.

## Typography

Three faces, three jobs: Geist Variable carries the interface, Merriweather Variable slows the eye at section starts, Geist Mono speaks for the machine.

- **Body Font:** Geist Variable (sans). Interface default at 12px (`text-xs`); relaxed 1.625 line-height inside cards and transcripts; 14px (`text-sm`) for spinner/status copy.
- **Display Font:** Merriweather Variable (serif), 600 weight in long-form/docs contexts (`.typeset`: h1 1.75em, h2 1.25em, h3 1.125em).
- **Title:** Merriweather Variable at 14px/500 for card titles via `font-heading`.
- **Label/Mono Font:** Geist Mono Variable for machine truth — paths, session ids, frames, code. Inline code sits on a Stone Mist wash at 0.85em.
- **Character:** the serif inside a dense tool is deliberate editorial calm — it de-machines the chrome and marks where a section begins; the sans does all the work in between.

**The Editorial Calm Rule.** Merriweather appears only where a section or document begins (titles, headings); it never labels controls, tabs, or table cells. If text is interactive or tabular, it is Geist; if it is machine output, it is Geist Mono.

## Layout

The shell is a collapsible session sidebar beside a `SidebarInset` work area: a 40px (`h-10`) chrome bar with hairline bottom border, then the active session view at 16px padding (`px-4 py-4`) with a 12px (`gap-3`) vertical rhythm. Session content splits into a Chat/Browser tab pair; a subagent panel docks below.

- Spacing unit is 4px; the working steps are 4 / 6 / 8 / 10 / 12 / 16px. Card interior spacing is 16px (12px in `size="sm"`).
- Controls: 32px default height (`h-8`), 28px `sm`, 24px `xs`, 36px `lg`; sidebar rows are 32px, menu items pad 8px.
- Density is the point: 12px type and compact rows keep many sessions visible at once. Empty states center a `Empty` block with icon, title, description, and one primary action.
- Docs/long-form contexts step up: `.typeset` renders at 1.125× below 48rem and 1× above, 1.75 leading.

**The Density-Is-Kindness Rule.** On a mission-control surface, whitespace inflation hides sessions the operator needs to see. Add air only inside reading surfaces (transcripts, docs), never to chrome, lists, or controls.

## Elevation & Depth

Flat at rest, shadow on float. Resting surfaces — cards, panels, the sidebar, inputs — are flat and separate by hairline: `ring-1 ring-foreground/10` on cards, `border-border` strokes elsewhere, tonal Stone Mist washes for hover. True overlays earn a shadow because they genuinely float: popovers and dropdown menus ship `shadow-md` + ring, submenus `shadow-lg` + ring. Dialogs currently rest on ring + backdrop alone; a soft shadow is permitted there under this rule. Tooltips are solid Stone Ink and need no shadow at all.

### Shadow Vocabulary

- **ambient-float** (`shadow-md`: `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): popovers, dropdown menus.
- **deep-float** (`shadow-lg`: `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): nested submenus, drag layers.

**The Flat-at-Rest Rule.** If it doesn't float above the page, it doesn't cast a shadow. Cards, panes, and inputs separate by hairline ring and tonal layering only; a shadow on a resting surface is a defect.

## Shapes

The form language is the sharp rectangle. Every rectangular surface — buttons, inputs, badges, cards, tabs, popovers, dialogs, tooltips, even the tooltip's arrow diamond — is `rounded-none` (0px). The only permitted curvature is the full circle (9999px): avatars, radio indicators, switch tracks and thumbs, message avatars.

A latent `--radius: 0.625rem` scale (`sm` 0.375rem → `4xl` 1.625rem) exists in the theme because shadcn derives from it, but the shipped language overrides it everywhere rectangular. Butted control groups drop inner borders (`border-l-0`) so adjacent squares read as one instrument strip.

**The Sharp Rectangle Rule.** Rectangles are square-cornered, period — no `rounded-sm` creep on new components, including overlays. If a shape is round, it is a perfect circle with a distinct job (identity, toggle state); there is nothing in between.

## Components

### Buttons

- **Shape:** sharp rectangle, 32px tall, 10px horizontal padding, 12px/500 Geist label, 6px icon gap; icon-only squares at 32/28/24px.
- **Primary:** solid Working Emerald with Emerald Wash text; hover dims to 80% opacity.
- **Outline / Secondary / Ghost:** hairline-bordered paper, Stone Mist fills, or transparent; all hover to a muted wash.
- **Destructive:** Signal Red text on a 10% red wash, hover 20%.
- **Hover / Focus / Press:** color-wash transitions (`transition-all`); focus is `border-ring` + 1px ring at 50% alpha; press nudges down 1px (`active:translate-y-px`) — the system's one tactile flourish.

### Inputs / Fields

- **Style:** transparent field, Stone Hairline stroke, 32px tall, 12px text, Stone Voice placeholder; dark mode fills `input/30`.
- **Focus:** ring-colored border + 1px halo at 50% alpha.
- **Error / Disabled:** `aria-invalid` swaps border and halo to Signal Red; disabled drops to 50% opacity with a filled wash.

### Badges / Chips

- **Style:** 20px tall sharp rectangles, 12px/500 text, 8px padding; same variant family as buttons (solid emerald, secondary wash, red-wash destructive, hairline outline).

### Cards / Containers

- **Corner Style:** 0px.
- **Background:** paper (`--card`), 12px/1.625 body text, 16px internal spacing, serif 14px/500 title.
- **Shadow Strategy:** none — `ring-1 ring-foreground/10` hairline only (see Elevation).

### Navigation

- Sidebar: Stone-tinted surface (`--sidebar` family), 32px rows, 12px labels, wash-on-hover, emerald only for the active/primary affordance. Tabs: 32px list, `line` variant underlines the active trigger with a 2px foreground bar.

### Tooltips

- Inverted: solid Stone Ink surface, Paper text, 12px, sharp corners, square 45°-rotated arrow, inline `kbd` slots.

### Signature Component

- **The press-nudge:** `active:translate-y-px` on every button-like control — a single physical detail that makes the flat, quiet system feel operable rather than inert.

## Do's and Don'ts

### Do's

- **Do** use `@omp-gui/ui` primitives for every surface; compose app-specific pieces from them (mandated by `docs/agents/ui.md`).
- **Do** keep emerald exclusively for agent-working/success/primary-action meaning, exactly as `--primary`/`--success` share one value.
- **Do** separate resting surfaces with `ring-1 ring-foreground/10` or `border-border` hairlines; reserve `shadow-md`/`shadow-lg` for floating overlays.
- **Do** hold the density floor: 12px control type, 32px control height, 4px spacing unit.
- **Do** use Phosphor icons only, 16px default (`size-4`), stepping to `size-3`/`size-3.5` in compact controls.
- **Do** write machine truth — paths, ids, frames — in Geist Mono.
- **Do** ship both themes: every new color must be defined in `:root` and `.dark` in OKLCH.

### Don'ts

- **Don't** round a rectangle. `rounded-none` is the law for buttons, inputs, badges, cards, tabs, and overlays; only true circles use `rounded-full`.
- **Don't** introduce a third accent hue or use emerald decoratively; chroma is the alarm channel.
- **Don't** paint solid red surfaces; destructive is red text on a 10–20% wash.
- **Don't** put Merriweather on controls, tabs, or table cells; the serif marks beginnings only.
- **Don't** add shadows to cards, panels, or inputs at rest.
- **Don't** hand-roll primitives or import icon sets other than Phosphor.
- **Don't** bake the working name "omp-gui" into user-facing chrome as if final; the shipping name is undecided (PRODUCT.md).
