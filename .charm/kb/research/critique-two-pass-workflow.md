---
id: critique-two-pass-workflow
root: research
type: research
status: current
summary: "Critical audit of the two-pass layout/motion workflow: design tradeoffs, prompt consistency, enforcement gaps"
created: 2026-06-07
updated: 2026-06-07
---

# Critique: Two-Pass Layout/Motion Workflow

## How the system actually works

`pty_bridge.rs::open` receives a `mode: Option<String>` argument. When mode is
`"layout"` or `"motion"`, it appends the matching phase skills file as a second
`--append-system-prompt-file` after the main skills file. The full context stack
for each pass:

- Layout pass: `remotion-skills.txt` (main + image) + `remotion-skills-layout.txt` + `project-context.txt`
- Motion pass: `remotion-skills.txt` (main + image) + `remotion-skills-motion.txt` + `project-context.txt`
- Single pass (mode absent): `remotion-skills.txt` (main + image) + `project-context.txt`

The phase skills file is always appended AFTER the main file, so it has recency
advantage in the context window.

---

## What works (and why)

**1. "Final resting position" framing in the layout prompt.**
The layout prompt says: "Decide the final resting position of each element NOW;
the motion pass will animate INTO these positions, so they must be correct here."
This is the strongest design idea in the two-pass system. It forces the model to
build a statically coherent composition before motion is considered. Without this
constraint, models frequently place elements in positions that only look correct
mid-animation (e.g., off-canvas start positions mixed into layout decisions).

**2. The motion self-constraint instruction arrives last in context.**
Because the phase file is appended after the main skills file, the model reads
"The layout in animation.tsx is locked" as the most recent instruction before
executing. In transformer models, recency has a moderate advantage in instruction
following. The delivery order is correct for this reason.

**3. The layout self-check prevents the most obvious violation.**
The self-check ("Does animation.tsx contain zero animation imports or calls?")
catches the case where a model adds motion code during a layout pass. It is
minimal—it only checks one thing—but that one thing is the primary failure mode
for the layout constraint.

---

## What does not work (and why)

### Spring preset inconsistency between the two files

This is the most concrete bug. The motion phase prompt (Section 2) defines:

```
SNAPPY : { mass: 0.6, damping: 14, stiffness: 180 }
SMOOTH : { mass: 1,   damping: 26, stiffness: 120 }
BOUNCY : { mass: 1,   damping: 9,  stiffness: 140 }
GENTLE : { mass: 1.2, damping: 20, stiffness: 80  }
```

The main skills file (Section 8) defines:

```
snappy-entrance : { mass:1,   damping:18, stiffness:200 }
smooth-settle   : { mass:1,   damping:22, stiffness:120 }
emphasis-pop    : { mass:1,   damping:14, stiffness:260 }
heavy-drop      : { mass:1.8, damping:25, stiffness:180 }
quick-tick      : { mass:0.6, damping:12, stiffness:240 }
```

The motion pass model sees BOTH tables simultaneously. `SNAPPY` (mass:0.6,
damping:14) and `snappy-entrance` (mass:1, damping:18) have the same semantic
label but meaningfully different physics: SNAPPY has a lower damping ratio
(zeta = 14 / (2*sqrt(180*0.6)) = ~0.67 — some overshoot) versus snappy-entrance
(zeta = 18 / (2*sqrt(200)) = ~0.64 — slightly more overshoot but heavier mass).
Neither is wrong, but the model now has two competing definitions for "snappy."
`SMOOTH` (damping:26) and `smooth-settle` (damping:22) differ by 4 on a
parameter where 4 units changes the feel perceptibly.

The motion prompt names only 4 presets; the main file names 5 (emphasis-pop,
heavy-drop, quick-tick have no counterparts in the motion prompt). A model
reading both files may randomly pick either naming convention.

### The layout constraint is instructional, not mechanical

The layout prompt says "the starter file you are given intentionally omits the
motion imports." This is an assertion about a state the user set up — not a
constraint the system enforces. `pty_bridge.rs` does not preprocess `animation.tsx`
before a layout pass. `claude_bridge.rs` does not strip imports. If the current
`animation.tsx` already contains `useCurrentFrame` or the user opens a layout
session on a project mid-way through its motion pass, nothing removes the imports.

The self-check instructs the model to verify absence of motion imports before
finishing. But self-checks are model-compliance features, not system guarantees.
A model under instruction pressure (e.g., a user pushing for faster output) may
skip the check.

### The "layout is locked" constraint is instructional, not mechanical

The motion prompt says "Do not change element positions, sizes, copy, or palette."
There is no diff-check between the pre-motion and post-motion versions of
`animation.tsx`. No file is snapshotted before the motion pass to enable
enforcement. The model can silently restructure the layout while animating, and
the system has no way to detect or reject that.

### The layout pass model receives extensive motion guidance it must ignore

Because the main skills file is ALWAYS active, the layout pass model sees:
- Section 3 (INTENT FIRST): emotion-to-motion-timing mappings (e.g., "joy: curved
  upward arcs, ease-out-back, 200-400ms, 10-20% overshoot") that are meaningless
  during a layout pass.
- Section 8 (MOTION PRESETS): all spring presets, Disney principles, clip-path
  reveals, shimmer, counter-motion.
- Section 12 (ANTI-PATTERNS): several anti-patterns are motion-specific.

The layout prompt does not acknowledge this. It says nothing like "the motion
guidance in your context applies to the next pass, not this one." A model reading
the full context might reason about motion placement while nominally doing layout,
producing element positions optimized for animation rather than static composition.

### The motion prompt adds very little unique content

The motion prompt's unique contributions are:
1. "The layout in animation.tsx is locked." (the constraint — genuinely unique)
2. The intent-to-personality-to-spring mapping table (Playful/Premium/Corporate/Energetic)
3. The structure-of-a-clip narrative (Entrance -> Hold -> Exit)

The main skills file covers (2) partially in Section 3 and Section 8, and (3)
in the timing budget at the end of Section 8. The motion prompt's Disney
principles (Section 3), choreography rules (Section 4), and spring presets
(Section 2) are all duplicated from the main file but with different names and
numbers.

The net result: a motion pass model sees the main file's comprehensive motion
guidance PLUS a shorter, partially-conflicting summary of the same concepts. The
motion prompt is approximately 65 lines; the main file's motion sections are
~120 lines covering the same ground with more detail and correct-by-construction
consistency.

### Layout self-check scope is too narrow

The self-check verifies only that motion imports/calls are absent. It does not
verify:
- Safe-zone compliance (all content within x 80-920, y 200-1500)
- Palette correctness (exactly one of P1-P6 used, no out-of-role accent colors)
- Type scale hierarchy (one clear hero element, at most two font sizes)
- Absolute positioning of all elements (required for motion pass to animate INTO
  these positions)

A layout that passes the self-check may still produce poor motion output if
element positions are ambiguous or palette choices violate the constraints the
motion pass assumes.

---

## Specific recommendations

**Fix 1 (blocking): Reconcile spring preset names and values.**
The motion prompt and the main skills file must agree on names and numbers. The
simplest fix: remove the named preset table from the motion prompt entirely and
reference the main file's names (`snappy-entrance`, `smooth-settle`, etc.)
directly. The motion prompt's intent-to-preset mapping (Section 1) should use the
main file's canonical names: "Playful -> emphasis-pop; Premium -> smooth-settle;
Corporate -> snappy-entrance; Energetic -> snappy-entrance + heavy-drop."

**Fix 2 (high value): Expand the layout self-check.**
Add checks for: (a) all positioned elements have explicit `left`/`top` or
`transform: translate` values in their style (so the motion pass knows where they
start); (b) background color is a named palette hex, not a gradient that changes
frame-to-frame; (c) no element is positioned outside x 80-920 or y 200-1500. Even
listing these as explicit questions the model asks itself (not automated checks)
raises compliance.

**Fix 3 (medium): Add a context-acknowledgment line to the layout prompt.**
After the HARD CONSTRAINT block, add: "Your context includes motion guidance
(spring presets, Disney principles). That guidance is for the next pass. Do not
let it influence element placement in this pass." This one line explicitly
addresses the confusing context.

**Fix 4 (medium): Specify exactly what "layout is locked" means in the motion prompt.**
Replace the current vague statement with an enumerated list:
"Do not change: (a) element positions or sizes; (b) text copy or font sizes;
(c) background or surface colors; (d) the number of elements or their z-order.
You MAY add: new style properties for transform and opacity; useCurrentFrame and
spring/interpolate calls; the motion imports at the top of the file."

**Fix 5 (lower priority): Surface the UI for triggering passes.**
The `mode` argument to `terminal_open` exists in the Rust command but there is no
visible UI affordance (button, menu item, or workspace indicator) for choosing
layout vs. motion mode. Without UI, the two-pass workflow is effectively only
accessible to developers who know to call `terminal_open` with the mode argument
directly. The workflow exists at the infrastructure layer without a user-facing
entry point.

**Fix 6 (optional, higher effort): Mechanical enforcement of layout constraint.**
Before a layout pass session opens, read `animation.tsx` and strip any existing
`useCurrentFrame`, `spring`, `interpolate`, and `Easing` imports from the import
line (not from business logic — just the Remotion import list). Write the stripped
version back before spawning the PTY. This makes the "starter file omits motion
imports" claim true by construction, not by trust.
