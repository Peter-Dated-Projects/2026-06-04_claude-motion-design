---
id: design-templates
root: research
type: research
status: current
summary: "Named library of ~10 reusable short-form motion-graphic templates -- each with layout sketch, motion choreography, and a compiling Remotion TSX skeleton using only allowed primitives -- plus two composition recipes for full 3-5s clips."
related:
  - research/design-motion-principles
  - research/design-visual-system
  - domain/platform-safe-zones
created: 2026-06-04
updated: 2026-06-04
---

# Reusable Short-Form Motion-Graphic Templates

A pick-a-template library: the building blocks Claude assembles a clip from. Each entry has a
**name**, a **when-to-use**, an **ASCII layout sketch** (placement inside the 1080x1920 safe
area), a **motion choreography** (what enters/holds/exits, in what order, at what frame), and a
**compiling Remotion TSX skeleton** built only from allowed primitives.

This note is the *templates* layer. It deliberately does NOT redefine motion timing curves or
the type/color system -- those live in the sibling research:
- **`design-motion-principles.md`** -- the easing curves, spring configs, stagger math, and the
  "why" behind enter/exit timing. Skeletons here cite preset names from it; tune values there.
- **`design-visual-system.md`** -- the type scale, color tokens, spacing grid for 1080x1920.
  Skeletons here use placeholder hex/sizes; swap in the system tokens when assembling.
- **`platform-safe-zones.md`** (`domain/`) -- the pixel-accurate safe-zone boundaries every
  layout below respects.

> Sibling note status (2026-06-04): `design-motion-principles.md` and `design-visual-system.md`
> are being written concurrently (tickets T-036 / T-037) and may not exist on disk yet. The
> references are by name and stable; reconcile exact preset/token names once they land.

---

## Hard runtime constraints (every skeleton obeys these)

These are non-negotiable for this project's sandbox preview/export:

- **Imports only** from `react`, `react-dom`, `remotion`, `@remotion/player`. Nothing else --
  no `@remotion/shapes`, no icon packs, no animation libs.
- **No external assets**: no image/video/audio/font files, no network fetches, no `<Img>`/
  `<Video>`/`staticFile`. "Image-like" looks are built from **CSS gradients, SVG shapes, and
  typography** only.
- **System fonts only.** Use a system stack (`-apple-system, "Segoe UI", Roboto, sans-serif`).
  No `@font-face`, no Google Fonts.
- **Canvas is fixed 1080x1920 vertical.** Width/height never change. (Confirmed canonical; see
  `gotchas/canonical-canvas-is-vertical`.)
- **Timing is frame-based at 30fps.** Default composition is `durationInFrames: 150` (5.0s). An
  animation MAY override `fps`/`durationInFrames` by exporting them (the sandbox applies them to
  the composition before render; see `gotchas/animation-can-export-fps-duration`). All frame
  numbers below assume **30fps** -- multiply by `fps/30` if you change it.
- **React is pinned to 18.x** (`gotchas/react-18-pin-not-19`). Standard hooks only.

### Allowed Remotion primitives used below

All from `remotion`: `AbsoluteFill`, `Sequence`, `Series`, `useCurrentFrame`, `useVideoConfig`,
`interpolate`, `spring`, `Easing`, `interpolateColors`, `random`. Always **clamp** `interpolate`
(`extrapolateLeft: "clamp", extrapolateRight: "clamp"`) unless you explicitly want extrapolation.

### Shared safe-zone reference (do not redraw -- use these numbers)

```
Universal safe content area : x 30..920  , y 140..1550   (action-safe; nothing clipped)
Title-safe (text + logos)   : x 80..880  , y 200..1500
Center focus (hero content) : x 150..930 , y 300..1420
Caption band (burned-in)    : bottom edge no lower than y=1480 (avoid platform auto-captions)
```

A tiny constants block most skeletons reuse:

```tsx
// Safe-zone insets at 1080x1920 (see platform-safe-zones.md)
const SAFE = { left: 80, right: 80, top: 200, bottom: 420 } as const; // title-safe
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
```

---

## Template 1 -- Kinetic Staggered Headline

**When to use:** the opening hook. A short punchy line (2-6 words) that snaps in word-by-word.
The single most-used short-form opener -- it earns attention in the first 0.5s.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|                                                            |
|                                                            |
|        +------------------------------------------+        |  y~760
|        |   B I G    B O L D                        |        |
|        |   H E A D L I N E    H E R E              |        |  centered block
|        +------------------------------------------+        |  y~1160
|                                                            |
|                                                            |
|  (bottom safe 420 -- caption/UI zone, keep clear)          |
+------------------------------------------------------------+
```

**Choreography:** words enter on a **stagger** (each word delayed ~4 frames after the previous),
each rising ~40px with a spring + fade. Hold. Optional exit: whole block fades + lifts at the
tail. Order: word[0] @0, word[1] @4, word[2] @8 ... Uses the "punchy entrance" spring preset
(see `design-motion-principles.md`).

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const WORDS = ["MAKE", "MOTION", "THAT", "MOVES"]; // fill: 2-6 short words

export const KineticHeadline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const STAGGER = 4; // frames between words

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", alignItems: "center" }}>
      <div style={{ maxWidth: 920, padding: "0 80px", textAlign: "center", lineHeight: 1.02 }}>
        {WORDS.map((word, i) => {
          const delay = i * STAGGER;
          const enter = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.7 } });
          const y = interpolate(enter, [0, 1], [40, 0]);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                margin: "0 14px",
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: 132,
                color: "#FFFFFF",
                opacity: enter,
                transform: `translateY(${y}px)`,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 2 -- Big-Number / Stat Reveal

**When to use:** a single metric you want to land hard ("$2.4M", "10x", "87%"). The number
counts/springs up; a label sits beneath it. The classic "stat drop."

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|                                                            |
|                  +-------------------+                     |
|                  |     8 7 %         |   <- huge numeral    |  y~820
|                  +-------------------+                     |
|                  |  faster renders   |   <- label          |  y~1010
|                  +-------------------+                     |
|                                                            |
|  (bottom safe 420)                                         |
+------------------------------------------------------------+
```

**Choreography:** number **counts up** from 0 to target over ~24 frames (ease-out), while
scaling 0.8 -> 1.0 with a tiny overshoot. Label fades up ~10 frames after the number starts.
Optional accent underline wipes left-to-right under the number on settle.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const TARGET = 87;            // fill: numeric target
const SUFFIX = "%";           // fill: "%", "x", "+", "" ...
const LABEL = "faster renders";

export const StatReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const count = Math.round(
    interpolate(frame, [0, 24], [0, TARGET], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  const scale = interpolate(pop, [0, 1], [0.8, 1]);
  const labelIn = spring({ frame: frame - 10, fps, config: { damping: 18 } });
  const underline = interpolate(frame, [18, 34], [0, 360], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 280, color: "#FFFFFF", lineHeight: 1 }}>
          {count}
          <span style={{ fontSize: 160, color: "#6EE7F9" }}>{SUFFIX}</span>
        </div>
        <div style={{ height: 8, width: underline, background: "#6EE7F9", borderRadius: 4, margin: "24px auto 0" }} />
        <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 56, color: "#A8A8B8", marginTop: 28, opacity: labelIn }}>
          {LABEL}
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 3 -- Lower-Third / Caption Bar

**When to use:** a name/title/source attribution, or a burned-in caption line. A bar slides in
from the left and parks in the lower portion -- but **above** the platform caption zone.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|                                                            |
|                                                            |
|                                                            |
|                                                            |
|   +----------------------------------------+               |  y~1300
|   | |  PETER ZHANG                          |              |  bar w/ accent edge
|   | |  Founder, ClaudeMotion                |              |  y~1440  (above 1480!)
|   +----------------------------------------+               |
|  (bottom safe -- platform UI below y=1480)                 |
+------------------------------------------------------------+
```

**Choreography:** bar slides in from x=-120% to its anchor (ease-out, ~12 frames), accent edge
draws first. Primary line then secondary line fade-stagger inside. On exit, bar slides back left.
**Bottom edge must stay <= y~1460** so it clears platform auto-captions (`platform-safe-zones.md`).

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const PRIMARY = "PETER ZHANG";
const SECONDARY = "Founder, ClaudeMotion";

export const LowerThird: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const slideIn = spring({ frame, fps, config: { damping: 20 } });
  const exit = spring({ frame: frame - (durationInFrames - 14), fps, config: { damping: 20 } });
  const x = interpolate(slideIn, [0, 1], [-700, 0]) + interpolate(exit, [0, 1], [0, -700]);
  const line2 = interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      {/* anchored bottom-left, bottom edge ~y1440 (clears caption zone) */}
      <div style={{ position: "absolute", left: 60, bottom: 480, transform: `translateX(${x}px)` }}>
        <div style={{ display: "flex", background: "rgba(15,15,22,0.92)", borderRadius: 16, overflow: "hidden" }}>
          <div style={{ width: 12, background: "#6EE7F9" }} />
          <div style={{ padding: "28px 44px" }}>
            <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 64, color: "#FFFFFF" }}>{PRIMARY}</div>
            <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 40, color: "#A8A8B8", marginTop: 8, opacity: line2 }}>
              {SECONDARY}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 4 -- Title Card

**When to use:** the establishing frame of a clip -- a title with an optional kicker (eyebrow)
above and subtitle below, centered. Often layered over Template 10 (gradient background).

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|                                                            |
|                  - - - KICKER - - -            <- eyebrow   |  y~700
|        +------------------------------------------+        |
|        |        T H E   T I T L E                 |        |  y~880
|        +------------------------------------------+        |
|                  one-line subtitle here          <- sub     |  y~1080
|                                                            |
|  (bottom safe 420)                                         |
+------------------------------------------------------------+
```

**Choreography:** kicker fades in first (small), title **clip-reveals** upward (mask wipe from
bottom) or springs in, subtitle fades up last. A thin rule line can wipe between title and
subtitle. Tasteful, slower than the kinetic headline.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const kicker = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleIn = spring({ frame: frame - 6, fps, config: { damping: 16 } });
  const titleY = interpolate(titleIn, [0, 1], [60, 0]);
  const rule = interpolate(frame, [18, 30], [0, 320], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sub = interpolate(frame, [24, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 880, padding: "0 80px" }}>
        <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 40, letterSpacing: 8, color: "#6EE7F9", opacity: kicker }}>
          KICKER
        </div>
        <div style={{ overflow: "hidden", marginTop: 24 }}>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 120, color: "#FFFFFF", lineHeight: 1.05, opacity: titleIn, transform: `translateY(${titleY}px)` }}>
            The Title
          </div>
        </div>
        <div style={{ height: 4, width: rule, background: "#3A3A4A", borderRadius: 2, margin: "32px auto" }} />
        <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 52, color: "#A8A8B8", opacity: sub }}>
          One-line subtitle that frames the idea
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 5 -- Animated Bullet / List Build

**When to use:** 3-5 short points that build one at a time ("3 reasons", "what you get"). Each
row animates in with a marker; earlier rows stay on screen.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|       HEADER                                  <- optional    |  y~360
|                                                            |
|   [*]  First point of the list               <- row 0      |  y~620
|                                                            |
|   [*]  Second point comes next               <- row 1      |  y~820
|                                                            |
|   [*]  Third point lands last                <- row 2      |  y~1020
|                                                            |
|  (bottom safe 420)                                         |
+------------------------------------------------------------+
```

**Choreography:** rows enter on a **stagger** (~12 frames apart), each sliding in from x-40px
with a fade; the marker pops (spring scale) just before its text. Keep <=5 rows; total build
should finish well before the clip's hold.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const ITEMS = ["First point of the list", "Second point comes next", "Third point lands last"];

export const ListBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ROW_STAGGER = 12;

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", padding: "0 90px" }}>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 56, color: "#6EE7F9", marginBottom: 56 }}>
        Why it works
      </div>
      {ITEMS.map((text, i) => {
        const delay = i * ROW_STAGGER;
        const rowIn = spring({ frame: frame - delay, fps, config: { damping: 18 } });
        const marker = spring({ frame: frame - delay, fps, config: { damping: 10, mass: 0.5 } });
        const x = interpolate(rowIn, [0, 1], [-40, 0]);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", marginBottom: 44, opacity: rowIn, transform: `translateX(${x}px)` }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "#6EE7F9", marginRight: 32, transform: `scale(${marker})` }} />
            <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 64, color: "#FFFFFF" }}>{text}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
```

---

## Template 6 -- Quote Card

**When to use:** a testimonial, a punchy line, or a citation. Large quotation mark, the quote
body, and an attribution. Reads as "credibility/payoff."

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|        "                                       <- glyph     |  y~520
|        +------------------------------------------+        |
|        |  This tool changed how we               |        |
|        |  ship motion graphics.                  |        |  y~860
|        +------------------------------------------+        |
|                                                            |
|        -- Jane Doe, Head of Brand              <- attrib    |  y~1180
|  (bottom safe 420)                                         |
+------------------------------------------------------------+
```

**Choreography:** giant quote glyph fades + scales in first. Quote body reveals (fade-up, or
line-by-line if multi-line). Attribution slides in from the left last, after a small beat.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const QUOTE = "This tool changed how we ship motion graphics.";
const ATTRIB = "Jane Doe, Head of Brand";

export const QuoteCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const glyph = spring({ frame, fps, config: { damping: 14 } });
  const body = interpolate(frame, [10, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bodyY = interpolate(frame, [10, 24], [30, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const attribIn = spring({ frame: frame - 28, fps, config: { damping: 20 } });
  const attribX = interpolate(attribIn, [0, 1], [-40, 0]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", padding: "0 90px" }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 220, color: "#3A3A4A", lineHeight: 0.6, opacity: glyph, transform: `scale(${glyph})`, transformOrigin: "left" }}>
        &ldquo;
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 84, color: "#FFFFFF", lineHeight: 1.15, marginTop: 24, opacity: body, transform: `translateY(${bodyY}px)` }}>
        {QUOTE}
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 48, color: "#6EE7F9", marginTop: 48, opacity: attribIn, transform: `translateX(${attribX}px)` }}>
        &mdash; {ATTRIB}
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 7 -- Logo / Wordmark Reveal

**When to use:** the sign-off / brand stamp, usually the last 1-1.5s. Built from **text + a
shape** (no image asset): a mark (SVG circle/ring or a styled glyph) plus the wordmark.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|                                                            |
|                                                            |
|                   ( O )                        <- SVG mark  |  y~820
|                                                            |
|              C L A U D E M O T I O N            <- wordmark |  y~1040
|                                                            |
|                                                            |
+------------------------------------------------------------+
```

**Choreography:** mark draws (SVG `strokeDashoffset` ring draw, ~16 frames) then springs to
scale 1; wordmark reveals via a left-to-right mask (clip) or letter-spacing settling from wide to
normal. Hold to end. Keep it centered in the center-focus zone.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const R = 90;
const CIRC = 2 * Math.PI * R;

export const LogoReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const draw = interpolate(frame, [0, 16], [CIRC, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pop = spring({ frame: frame - 14, fps, config: { damping: 12 } });
  const wordIn = spring({ frame: frame - 18, fps, config: { damping: 18 } });
  const spacing = interpolate(wordIn, [0, 1], [40, 10]); // letter-spacing settles
  const wordY = interpolate(wordIn, [0, 1], [24, 0]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", alignItems: "center" }}>
      <svg width={240} height={240} viewBox="0 0 240 240" style={{ transform: `scale(${0.9 + 0.1 * pop})` }}>
        <circle cx={120} cy={120} r={R} fill="none" stroke="#6EE7F9" strokeWidth={10}
          strokeDasharray={CIRC} strokeDashoffset={draw} strokeLinecap="round"
          transform="rotate(-90 120 120)" />
        <circle cx={120} cy={120} r={26} fill="#6EE7F9" opacity={pop} />
      </svg>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 84, color: "#FFFFFF", letterSpacing: spacing, marginTop: 40, opacity: wordIn, transform: `translateY(${wordY}px)` }}>
        CLAUDEMOTION
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 8 -- Section Transition / Wipe

**When to use:** the connective tissue between two scenes -- a full-frame colored panel that
wipes across the screen, optionally carrying a section label. Hides the cut and resets attention.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
| ####                                                       |  panel sweeping
| ##########                                                 |  left -> right
| ###############        NEXT UP            <- optional label|  y~960
| ##########                                                 |
| ####                                                       |
+------------------------------------------------------------+
```

**Choreography:** panel translates from x=-100% to 0 (cover, ease-in-out ~12 frames), holds a few
frames with the label centered, then continues 0 -> +100% (reveal) exposing the next scene.
Drop this as a short `Sequence` straddling the boundary between two scenes (see Recipe B).

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const LABEL = "NEXT UP";

// Designed for a ~30-frame Sequence: cover 0-12, hold 12-18, reveal 18-30.
export const SectionWipe: React.FC = () => {
  const frame = useCurrentFrame();

  // -100% .. 0% .. +100% of width across the window
  const x = interpolate(frame, [0, 12, 18, 30], [-1080, 0, 0, 1080], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelOpacity = interpolate(frame, [8, 13, 17, 22], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ transform: `translateX(${x}px)`, background: "#6EE7F9", justifyContent: "center", alignItems: "center" }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 96, letterSpacing: 6, color: "#0B0B12", opacity: labelOpacity }}>
        {LABEL}
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 9 -- Progress Motif

**When to use:** to imply a process, a "step N of M", or a loading/score motif. A bar or ring
that fills. Pairs well under a header or as an accent on a stat.

**Layout:**
```
+--------------------------- 1080 ---------------------------+
|  (top safe 200)                                            |
|        STEP 2 OF 3                            <- label      |  y~700
|                                                            |
|        [##############------------------]     <- bar fill   |  y~880
|                                                            |
|                  ( ring variant )            <- alt          |
|  (bottom safe 420)                                         |
+------------------------------------------------------------+
```

**Choreography:** track draws instantly (or fades), fill animates 0 -> target width (ease-out,
~24 frames). Ring variant: animate `strokeDashoffset` of an SVG arc. A numeric percent can ride
along (reuse the count-up from Template 2).

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const TARGET = 0.66; // 0..1 fill

export const ProgressMotif: React.FC = () => {
  const frame = useCurrentFrame();
  const TRACK_W = 760;

  const fill = interpolate(frame, [6, 30], [0, TARGET], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelIn = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0B12", justifyContent: "center", alignItems: "center" }}>
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 48, letterSpacing: 6, color: "#A8A8B8", opacity: labelIn, marginBottom: 40 }}>
        STEP 2 OF 3
      </div>
      <div style={{ width: TRACK_W, height: 28, borderRadius: 999, background: "#1C1C28", overflow: "hidden" }}>
        <div style={{ width: TRACK_W * fill, height: "100%", borderRadius: 999, background: "linear-gradient(90deg,#6EE7F9,#A78BFA)" }} />
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 10 -- Gradient Ambient Background

**When to use:** the **base layer** under almost everything. A slowly drifting gradient with
soft "blobs" (radial gradients) gives depth without any image asset. Render it first, then layer
a content template on top.

**Layout:** full-frame; content templates sit above it.
```
+--------------------------- 1080 ---------------------------+
| (.)            soft radial blob drifts slowly              |
|        gradient sweeps hue over the clip                   |
|                         (.)                                |
|     (.)                              soft blob              |
+------------------------------------------------------------+
```

**Choreography:** the base gradient angle/hue eases slowly across the whole duration; 2-3 radial
"blobs" drift on gentle sine paths (use `Math.sin(frame/period)`), low opacity, large blur via
big radii. Keep motion **subtle** -- it should never compete with foreground text.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const AmbientBackground: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const hue = interpolate(frame, [0, durationInFrames], [220, 280]); // slow hue drift
  const bx = 540 + Math.sin(frame / 40) * 220;
  const by = 700 + Math.cos(frame / 55) * 260;
  const cx = 700 + Math.cos(frame / 48) * 200;
  const cy = 1300 + Math.sin(frame / 60) * 240;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 60% 12%), hsl(${hue + 40} 55% 8%))`,
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(620px circle at ${bx}px ${by}px, hsla(190,90%,60%,0.25), transparent 60%)` }} />
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(560px circle at ${cx}px ${cy}px, hsla(265,90%,65%,0.22), transparent 60%)` }} />
    </AbsoluteFill>
  );
};
```

---

## Composition recipes (templates assembled into a full clip)

Recipes show how to **sequence templates into a finished 3-5s clip** using `Series` (or stacked
`Sequence`s). The ambient background (Template 10) renders as a persistent base layer behind a
`Series` of content scenes. Frame counts assume 30fps.

### Recipe A -- "Stat Drop" (4.0s / 120 frames)

A punchy proof clip: hook -> the number -> who said it. Good for ads, launch posts, results.

```
[ AmbientBackground .......................... full 0-120 ]
[ Series ]
  scene 1  TitleCard      0-45   (1.5s)  "the hook / setup"
  scene 2  StatReveal     45-95  (1.67s) "the payoff number"
  scene 3  LowerThird     95-120 (0.83s) "attribution / CTA"
```

```tsx
import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { AmbientBackground } from "./AmbientBackground";
import { TitleCard } from "./TitleCard";
import { StatReveal } from "./StatReveal";
import { LowerThird } from "./LowerThird";

// Export to make the clip 4s; sandbox applies fps/durationInFrames to the composition.
export const fps = 30;
export const durationInFrames = 120;

export const StatDropClip: React.FC = () => (
  <AbsoluteFill>
    <AmbientBackground />
    <Series>
      <Series.Sequence durationInFrames={45}>
        <TitleCard />
      </Series.Sequence>
      <Series.Sequence durationInFrames={50}>
        <StatReveal />
      </Series.Sequence>
      <Series.Sequence durationInFrames={25}>
        <LowerThird />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
```

> Note: the inner templates here paint their own opaque `#0B0B12` background, which would hide
> the ambient layer. When composing over `AmbientBackground`, fill the template's background as
> `transparent` (delete the `backgroundColor`) so the base shows through. Keep one source of
> truth for the background per clip.

### Recipe B -- "Hook + Wipe + Quote" (5.0s / 150 frames)

A narrative beat: grab attention, transition, deliver credibility. Uses the wipe to mask the cut.

```
[ Series ]
  scene 1  KineticHeadline   0-70    (2.33s) "the hook line"
  overlap  SectionWipe        62-92   (1.0s)  straddles the cut, label "PROOF"
  scene 2  QuoteCard          92-150  (1.93s) "the testimonial payoff"
```

```tsx
import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { KineticHeadline } from "./KineticHeadline";
import { SectionWipe } from "./SectionWipe";
import { QuoteCard } from "./QuoteCard";

export const fps = 30;
export const durationInFrames = 150;

export const HookQuoteClip: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#0B0B12" }}>
    <Sequence durationInFrames={70}>
      <KineticHeadline />
    </Sequence>
    <Sequence from={92}>
      <QuoteCard />
    </Sequence>
    {/* wipe straddles the boundary, hiding the cut */}
    <Sequence from={62} durationInFrames={30}>
      <SectionWipe />
    </Sequence>
  </AbsoluteFill>
);
```

---

## How to pick (decision guide for the assembling model)

| Goal in the clip | Reach for |
|---|---|
| Grab attention in the first 0.5s | Kinetic Staggered Headline (1) |
| Land one metric hard | Big-Number / Stat Reveal (2) |
| Name a speaker / cite a source / caption a line | Lower-Third / Caption Bar (3) |
| Establish the topic calmly | Title Card (4) |
| Enumerate 3-5 points | Animated List Build (5) |
| Provide social proof / a memorable line | Quote Card (6) |
| Sign off with the brand | Logo / Wordmark Reveal (7) |
| Cut between two scenes cleanly | Section Transition / Wipe (8) |
| Imply a process or score | Progress Motif (9) |
| Add depth behind everything | Gradient Ambient Background (10) |

**Default clip skeleton:** ambient background (10) as base -> a hook (1 or 4) -> the substance
(2, 5, 6, or 9) -> a sign-off (3 or 7), with a wipe (8) only if there's a hard tonal cut. A
finished short usually composes **3-4 templates** over 3-5s; more than that feels frantic.

---

## Sources / conventions these derive from

The templates encode widely-observed short-form motion conventions; verify exact timing against
`design-motion-principles.md`:

- **Stagger-in headlines & word-by-word kinetic type** -- the dominant TikTok/Reels opener
  pattern; popularized by tools like CapCut "Typing"/"Word by word" presets and the
  text-animation libraries built on Framer Motion / GSAP SplitText.
- **Stat-drop / count-up** -- standard in data-story and ad creative; count-up + scale-overshoot
  is the After Effects "Number" + "Overshoot" expression idiom.
- **Lower-thirds** -- broadcast convention adapted for vertical: slide-in bar with an accent
  edge, two-line name/title, kept above the platform caption band.
- **Quote cards & testimonial reveals** -- ubiquitous in brand/SaaS shorts; oversized quotation
  glyph + attribution slide.
- **Logo sting / wordmark reveal** -- the end-card sign-off; ring-draw + wordmark settle is a
  staple motion-branding move.
- **Section wipes** -- solid-color cover/reveal transitions (the "swipe transition" family) used
  to mask cuts and reset attention.
- **Progress motifs** -- step indicators / fill bars from explainer and UI-promo shorts.
- **Ambient gradient backgrounds** -- "aurora/mesh gradient" backdrops (Stripe-style) recreated
  with CSS radial gradients on sine drift, since no image assets are allowed.

When a teardown or named reference is needed, prefer the principles note's citations as the
canonical source so timing/easing stays in one place.
