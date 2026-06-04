---
id: design-visual-system
root: research
type: research
status: current
summary: "Prescriptive pick-from token system (type scale, font stacks, color palettes, spacing/layout, hierarchy, anti-patterns) tuned for 1080x1920 short-form vertical video, expressible with inline CSS/SVG + Remotion + system fonts only."
created: 2026-06-04
updated: 2026-06-04
---

# Visual Design System for 1080x1920 Vertical Video

This is a **menu of concrete tokens to pick from**, not design theory. Every value
here is meant to be dropped directly into inline CSS / SVG inside a Remotion
composition. A model should be able to apply these mechanically: pick a font stack,
pick a palette, pull type sizes from the scale, anchor layout to the safe zone, done.

## Hard constraints these tokens respect

- **Resolution:** 1080x1920 (9:16), top-left origin, y increases downward (Remotion / CSS convention).
- **Fonts:** system / web-safe stacks ONLY. No custom font files, no Google Fonts, no `@font-face`, no network/asset loads. Imports limited to react / react-dom / remotion / @remotion/player.
- **Styling:** inline CSS and SVG only. No external CSS frameworks, no images.
- **Safe zones:** all critical content stays inside the universal safe zone from
  `platform-safe-zones.md`: `x 30-920, y 140-1550`. Text and logos stay inside the
  **title-safe** box `x 80-920, y 200-1500`. Captions keep their bottom edge above
  `y 1480` to avoid platform auto-caption clash. These are not negotiable.

Because the video is watched on a phone, often muted, in feed, while scrolling,
**legibility wins over subtlety every time**. Type runs larger, contrast runs higher,
and the layout runs simpler than you would design for desktop or print.

---

## 1. Type scale (px at 1080x1920)

Sized for a 1080px-wide canvas viewed on a phone (~390-430 device px wide), so the
on-screen size is roughly 1/2.7 of the canvas px. Sizes account for video compression
softening small text and for muted/scroll viewing.

| Role | Size (px) | Range | Weight | Letter-spacing | Line-height | Use for |
|---|---|---|---|---|---|---|
| Display | 150 | 130-180 | 800 (heavy) | -2% (-3px) | 0.95 | One- or two-word hero statement, big number, hook |
| Headline | 96 | 80-110 | 700 (bold) | -1% (-1px) | 1.0 | Primary title, the line that carries the scene |
| Subhead | 60 | 52-72 | 600 (semibold) | 0 | 1.1 | Secondary line, section label, supporting claim |
| Body | 42 | 38-48 | 400-500 | 0 | 1.3 | Sentences, explanation, list items |
| Caption | 32 | 28-36 | 500-600 | +1% (+0.3px) | 1.25 | Subtitles, attributions, fine print, timestamps |

### Hard rules
- **Minimum legible size: 28px.** Below ~28px at 1080 wide, video compression and
  small phone screens make text unreliable. Never go below it for anything that must be read.
- **Display / Headline use negative tracking.** Large type looks loose at default
  spacing; tightening -1% to -2% makes it read as one solid shape. Body and caption
  use 0 or slightly positive tracking for clarity at small size.
- **Line-height shrinks as size grows.** Display sits at 0.95 (lines can almost touch);
  body opens to 1.3 for readability. Never use 1.5+ — it wastes vertical space in a tall frame.
- **Measure (line length): 14-26 characters for Display/Headline, max ~40 for Body.**
  Long lines force the eye to travel across the wide-but-not-that-wide frame. Break
  hero lines manually into 2-3 short lines stacked.
- **Weight is the cheapest hierarchy tool.** A heavy Display over a regular Body reads
  as hierarchy even in one color. Lean on weight before reaching for color.

### CSS shape (drop-in)
```css
/* Display */
fontSize: 150, fontWeight: 800, letterSpacing: '-3px', lineHeight: 0.95
/* Body */
fontSize: 42, fontWeight: 400, letterSpacing: '0', lineHeight: 1.3
```

---

## 2. Font stacks (system / web-safe only)

Five curated stacks. Each is an exact CSS `font-family` string that resolves on macOS,
iOS, Windows, and Android without loading anything. Pick ONE primary per video; at most
two total (one display + one body) — see anti-patterns.

| # | Personality | When to use | `font-family` string |
|---|---|---|---|
| 1 | **Neutral Modern** (system default) | Safe default, tech, lifestyle, anything | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| 2 | **Bold Impact / Grotesk** | Ads, hooks, punchy statements, sports | `"Helvetica Neue", Helvetica, Arial, sans-serif` (pair with weight 800-900) |
| 3 | **Friendly Humanist** | Casual, community, education, kids | `"Segoe UI", "Trebuchet MS", Verdana, Tahoma, sans-serif` |
| 4 | **Editorial Serif** | Premium, story, quotes, fashion, finance | `Georgia, "Iowan Old Style", "Times New Roman", serif` |
| 5 | **Technical Mono** | Code, data, crypto, retro-terminal, stats | `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace` |

**Optional rounded (soft/friendly):** `ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
falls back gracefully to system-ui on Windows/Android; use only when a soft tone matters
and a hard fallback is acceptable.

### Rules
- **`-apple-system` / `BlinkMacSystemFont` always lead a sans stack** so Apple devices get
  the polished SF system font; the rest are real fallbacks, not decoration.
- **Pair at most one display font with one body font.** A classic combo: serif Display
  (#4) over sans Body (#1). Or stay single-family and vary only weight/size.
- **Numbers:** for stat-heavy scenes, mono (#5) keeps digits aligned (tabular). For prose
  with the occasional number, the sans stacks are fine.

---

## 3. Color palettes

Six palettes, each as hex with explicit ROLES. Contrast ratios below are computed (WCAG
2.1 relative-luminance formula) for the key text-on-background pairs. For video, aim
**higher** than the WCAG minimums: treat **7:1 as the floor for body text** and **4.5:1 as
the floor for large headline text**, because compression, motion, and bright-room viewing
all erode effective contrast.

Roles in every palette:
- `bg` — full-frame background
- `surface` — raised card / panel behind a text block
- `accent` — the one loud color (one highlight word, a shape, a progress bar)
- `accent-soft` — muted tint of the accent for fills/backgrounds behind text
- `ink` — primary text color (always the highest-contrast pair vs bg)
- `muted` — secondary/de-emphasized text and hairlines

### DARK palettes

**P1 - Midnight Pop** (moody, premium, electric) — default dark choice
```
bg          #0B0E14
surface     #161B26
accent      #4F8CFF   (electric blue)
accent-soft #1E2A44
ink         #F5F7FA
muted       #8A94A6
```
Contrast: ink on bg ~18:1 (excellent body). accent #4F8CFF on bg ~6.0:1 (large text / shapes only). muted on bg ~5.5:1 (secondary text, large only).

**P2 - Warm Charcoal** (cozy, organic, food/lifestyle)
```
bg          #15120E
surface     #241E16
accent      #FFB347   (amber)
accent-soft #3A2E1C
ink         #FBF6EE
muted       #A8997F
```
Contrast: ink on bg ~17:1. amber accent on bg ~10.5:1 (safe even for medium text). A high-legibility warm scheme.

**P3 - Deep Forest** (calm, natural, wellness, finance-green)
```
bg          #0A1410
surface     #14241C
accent      #43E0A0   (mint)
accent-soft #14342A
ink         #EEF7F1
muted       #7FA08F
```
Contrast: ink on bg ~17:1. mint accent on bg ~11:1 (very strong). muted on bg ~4.6:1 (large secondary text only).

### LIGHT palettes

**P4 - Paper & Ink** (editorial, clean, premium print feel) — default light choice
```
bg          #FAF7F2   (warm paper)
surface     #FFFFFF
accent      #C42B30   (deep red)
accent-soft #FBE6E6
ink         #1A1714   (near-black)
muted       #6B6256
```
Contrast: ink on bg ~16:1 (excellent body). deep-red accent on bg ~5.2:1 — **headline-size only**, use `ink` for body, accent for a highlighted word or shape.

**P5 - Soft Sky** (fresh, friendly, SaaS/tech-light)
```
bg          #EEF3FA   (cool light)
surface     #FFFFFF
accent      #2563EB   (strong blue)
accent-soft #DBE7FF
ink         #0F1B2D   (deep navy-black)
muted       #5A6B82
```
Contrast: ink on bg ~15:1. blue accent on bg ~4.4:1 — **large text / shapes only**; body stays `ink`.

### NEUTRAL high-contrast

**P6 - Mono Bold** (maximum punch, ads, hooks, sports) — dark variant
```
bg          #000000
surface     #141414
accent      #FFD400   (signal yellow)
accent-soft #2E2A00
ink         #FFFFFF
muted       #999999
```
Contrast: ink on bg 21:1 (max possible). yellow accent on bg ~17:1 (safe at any size). The most aggressive, attention-grabbing scheme; one accent only or it gets garish.

### Palette rules
- **`accent` is a spice, not a base.** Color one word, one shape, one bar — not a paragraph.
  Most text is `ink`; secondary text is `muted`.
- **Behind any text laid over busy/video footage, use a `surface` panel or a scrim**
  (e.g. `rgba(0,0,0,0.45)` over a light image) so the contrast ratio actually holds. The
  ratios above assume text sits on the flat `bg`/`surface`, not on uncontrolled imagery.
- **Add a subtle text-shadow on text over any non-flat background:**
  `textShadow: '0 2px 12px rgba(0,0,0,0.5)'` (dark scrim) lifts legibility cheaply.
- **Where an accent fails body contrast (P4, P5, P3-muted), it is flagged "large only."**
  Respect that — do not set 42px body text in an accent that only clears 4.5:1.

---

## 4. Spacing scale + layout

### Spacing scale (8px base)
```
2xs  4
xs   8
sm  16
md  24
lg  32
xl  48
2xl 64
3xl 96
4xl 128
```
Use these for gaps, padding, and vertical rhythm. Snapping to one scale is what makes a
layout read as "designed" instead of arbitrary.

### Layout frame (anchored to safe zones)
```
Frame:            1080 x 1920
Universal safe:   x 30-920,  y 140-1550   (nothing critical outside)
Title-safe (text):x 80-920,  y 200-1500   (all text + logos live here)
Content column:   x 80-920   -> 840px wide single column, left-aligned or centered
Center focus:     y 400-1400 -> hero content, faces, the line that matters
```

- **Outer padding:** keep `>= 80px` from the left edge and `>= 160px` from the right edge
  (platform action buttons live in the right column). The simplest safe rule: **lay text
  out in the 840px-wide column from x=80 to x=920 and never cross x=920.**
- **Top:** start content no higher than `y=200` (below the platform nav bar).
- **Bottom:** end content by `y=1500`; keep captions' bottom edge above `y=1480`.
- **Grid:** a single centered column is correct for almost all vertical video. If you need
  structure, use a 4-column grid across the 840px content width (column ~ 198px, gutter 24px),
  but resist multi-column text — vertical video is a one-column medium.
- **Optical center sits slightly above true center.** Place the hero headline block centered
  around `y ~ 820-900` (the safe-area center is `(475, 845)`), not at `y=960`. Content that
  sits at the mathematical middle looks low.
- **Vertical rhythm:** stack blocks with `2xl` (64) or `3xl` (96) gaps between distinct
  groups, `md` (24) between tightly related lines. Generous whitespace reads as premium;
  cramped reads as amateur.

---

## 5. Hierarchy rules

Create a clear focal order so the eye lands in the right place within the first second.

1. **One hero per scene.** Exactly one element is the biggest/boldest/brightest. If two
   things compete for "most important," the scene reads as noisy and the hook is lost.
2. **Step the scale, don't crowd it.** Use non-adjacent steps for clear contrast: Display
   over Body (150 vs 42) reads instantly; Headline over Subhead (96 vs 60) is a softer step.
   Avoid two sizes that are close (e.g. 60 and 64) — looks like a mistake, not a hierarchy.
3. **Three levers, in order of cheapness:** size -> weight -> color. Exhaust size and weight
   before adding a second color. A heavy 150px ink Display over a 42px muted Body needs no
   color at all to establish rank.
4. **Color directs, it doesn't decorate.** Use `accent` to point at the single most important
   word or number. Everything else is `ink` (primary) or `muted` (secondary).
5. **Alignment is a hierarchy signal.** Keep one alignment per block (all centered OR all
   left). A centered hero with left-aligned body is fine; mixing alignments inside one block
   is not.
6. **Group with proximity.** Related lines sit `md` (24px) apart; the next idea is `2xl`
   (64px+) away. Whitespace, not lines or boxes, is the primary grouping tool.

---

## 6. Anti-patterns (and the fix)

| Anti-pattern | Why it looks amateur | Fix |
|---|---|---|
| **Low contrast** (gray text on gray, accent-on-bg for body) | Video compression + bright rooms kill marginal contrast; text vanishes | Body text >= 7:1; large text >= 4.5:1. Use `ink` on `bg`. Add a scrim/`surface` panel over footage. |
| **More than 2 font families** | Reads as ransom-note, no voice | One family, vary weight/size; or exactly one display + one body pairing. |
| **Tiny text** (< 28px, long paragraphs) | Unreadable while scrolling; nobody reads paragraphs in feed | Min 28px. Cut copy to a few short lines. Promote the key phrase to Headline. |
| **Text in unsafe zones** (bottom 370px, right 160px, top 140px) | Clipped by platform UI / captions / action buttons | Keep all text in title-safe `x 80-920, y 200-1500`; captions bottom-edge above y=1480. |
| **Muddy / clashing palette** (many saturated colors, no clear bg) | No focal point, looks like a template gone wrong | One `bg`, one `accent`, `ink` + `muted` for text. Spice with accent only. |
| **Loose giant type** (default tracking on Display) | Big text looks unset and floaty | Apply -1% to -2% letter-spacing on Display/Headline; tighten line-height to ~0.95. |
| **Everything centered AND huge** | No hierarchy; the eye has nowhere to land | One hero element; step the type scale; demote the rest to Body/muted. |
| **Walls of equal-weight text** | No entry point, ignored in 0.5s | Establish one Display/Headline hook; rest is supporting Body. |
| **Cramped edges** (text touching frame sides) | Looks unfinished, fights platform UI | Respect the 80px left / 160px right padding; lay out in the 840px column. |
| **Off-center hero** (content at true y=960 or lower) | Sits visually low, especially under captions | Center hero around y~820-900 (optical center of the safe area). |
| **Pure-saturated text on pure-saturated bg** (e.g. red on blue) | Vibrates, illegible, painful | Text is `ink`/`muted`; saturated color only as accent shapes, never as text-on-saturated. |

---

## Quick recipe (mechanical apply)

1. Pick a **palette** (P1 Midnight Pop or P4 Paper & Ink are safe defaults).
2. Pick a **font stack** (#1 Neutral Modern is the safe default; #2 Bold Impact for hooks).
3. Hero line = **Display** (150px, weight 800, -2% tracking), in `ink`, one accent word in `accent`.
4. Supporting line = **Body** (42px) in `muted`, `md`/`2xl` gap below the hero.
5. Lay everything in the **840px content column (x 80-920)**, hero centered around **y~850**.
6. Check it against the **anti-pattern table** before shipping.

---

## Sources

- **Internal:** `platform-safe-zones.md` (this KB) — pixel-accurate safe zones, title-safe
  and center-focus boxes, caption placement, and the universal safe zone used throughout.
- **Contrast:** WCAG 2.1 contrast-ratio definition and relative-luminance formula (W3C).
  Ratios above were computed with that formula; the 7:1 body / 4.5:1 large-text floors are
  raised above WCAG AA minimums to account for video compression and feed viewing.
- **Type scale & weight-as-hierarchy:** Material Design type scale; Apple Human Interface
  Guidelines (typography, the system font stack with `-apple-system`/`BlinkMacSystemFont`).
- **Measure / line length / tracking:** Butterick, *Practical Typography* (line length and
  large-type tracking guidance).
- **Social-video legibility:** TikTok and Meta (Reels) creative best-practice guidance on
  large text, high contrast, captions, and keeping critical content out of the UI overlap
  zones; the empirical safe-zone measurements captured in `platform-safe-zones.md`.
