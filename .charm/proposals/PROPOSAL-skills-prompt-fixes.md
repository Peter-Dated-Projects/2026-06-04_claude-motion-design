# Proposal: Skills Prompt Fixes

**Status: DRAFT**

---

## Context

Four investigative agents (T-006 through T-009) audited the full skills prompt
system -- remotion-skills.txt, remotion-skills-layout.txt,
remotion-skills-motion.txt, remotion-image-skills.txt, and the delivery layer
in claude_bridge.rs / pty_bridge.rs. This proposal consolidates their findings
into 20 concrete fixes across three tiers. Each fix names the exact file and
location, the problem, and the change required.

---

## Tier 1 -- Bugs (cause errors or silently broken output)

### F1: Replace non-Remotion easing names in Section 3
**File:** `src-tauri/resources/remotion-skills.txt`, Section 3 EMOTION table

**Problem:** `ease-out-back`, `ease-out-expo`, and `ease-in-out sine` do not exist
in Remotion's Easing API. The import allowlist only permits `Easing.bezier`,
`Easing.linear`, and `Easing.in/out/inOut(Easing.cubic/ease)`. A model following
this table for a "joy" or "playful" clip will produce a runtime error or silently
fall back.

**Fix:** Replace each with a Remotion-native equivalent inline:

```
joy        : curved upward arcs, Easing.bezier(0.34,1.56,0.64,1) (back approx), 200-400ms, 10-20% overshoot
calm       : gentle curves,      Easing.inOut(Easing.cubic),                     500-800ms, 0%
urgency    : straight direct,    Easing.out(Easing.cubic),                       100-200ms, 0%
elegance   : long smooth arcs,   Easing.bezier(0.4,0.0,0.2,1.0),               400-700ms, 0%
surprise   : radial outward,     Easing.bezier(0.0,0.0,0.2,1.0) fast out,      150-300ms, 15-25%
playfulness: arcs + bounce,      Easing.bezier(0.34,1.56,0.64,1),              200-350ms, 10-20%
```

---

### F2: Reconcile spring preset tables between motion phase prompt and main file
**File:** `src-tauri/resources/remotion-skills-motion.txt`, Section 2

**Problem:** The motion phase prompt defines four presets (SNAPPY, SMOOTH, BOUNCY,
GENTLE) with different names and different numbers from the main file's five presets
(snappy-entrance, smooth-settle, emphasis-pop, heavy-drop, quick-tick). A motion-pass
model sees both simultaneously and has two competing tables for the same concept.
Example: SNAPPY is `{ mass:0.6, damping:14, stiffness:180 }` vs snappy-entrance's
`{ mass:1, damping:18, stiffness:200 }` -- same label, different feel.

**Fix:** Remove the preset table from `remotion-skills-motion.txt` entirely. Replace
Section 2 with a one-line reference: "Use the named presets from the main skills file:
snappy-entrance, smooth-settle, emphasis-pop, heavy-drop, quick-tick. Do not define new
spring configs." Update the intent-to-preset mapping in Section 1 to use the canonical
names: Playful -> emphasis-pop + quick-tick; Premium -> smooth-settle; Corporate ->
snappy-entrance; Energetic -> snappy-entrance + heavy-drop.

---

### F3: Guard Section 10 (Component Vocabulary) until multi-file compiler lands
**File:** `src-tauri/resources/remotion-skills.txt`, Section 10

**Problem:** Section 10 instructs the model to import from `theme.ts`, `motion.ts`,
and `components/`. These files don't exist in new projects. Worse, the sandbox
compiler runs in esbuild transform mode -- relative imports don't resolve at all.
A model following Section 10 writes broken imports that fail silently in the preview.

**Fix:** Prepend a hard gate to Section 10:

```
IMPORTANT: This section only applies if the project already contains theme.ts,
motion.ts, and a components/ directory (visible in CURRENT PROJECT FILES above).
If those files are absent, skip this section entirely -- do not create them and
do not write relative imports. The compiler does not support them yet.
```

Change "ALWAYS import from them" to "if they exist, import from them."

---

## Tier 2 -- Prompt quality (meaningful output degradation)

### F4: Remove the conflicting Section 1 spring default
**File:** `src-tauri/resources/remotion-skills.txt`, Section 1

**Problem:** Section 1 establishes `{ mass: 1, damping: 12, stiffness: 100 }` as the
session default. Section 8 says use `snappy-entrance` as the workhorse. The Section 1
default (zeta ~0.60, ~9% overshoot, ~20+ frame settle) produces noticeably springier,
slower entrances than `snappy-entrance`. Since Section 1 comes first in a linear read,
it wins for any prompt where the model doesn't explicitly reach the preset table.

**Fix:** Replace the line with: "Spring default: use `snappy-entrance` for primary
entrances. See Section 8 for all named presets -- reference them by name, do not
invent configs."

---

### F5: Fix the exemplar's counter-motion
**File:** `src-tauri/resources/remotion-skills.txt`, Section 11

**Problem:** Section 8 defines counter-motion as "move the ambient background in the
OPPOSITE direction from the hero at 20-30% of the hero's speed." The exemplar's blob
oscillates freely on `Math.sin(frame/45)` with no directional relationship to the hero
entrance. The exemplar is the highest-signal teaching tool in the file and fails to
demonstrate the rule it's supposed to anchor.

**Fix:** Replace the blob's `by` definition with a version that drifts downward during
the hero's entrance (frames 0-18), then settles into idle oscillation:

```tsx
const enterProgress = interpolate(frame, [0, 18], [0, 1], { extrapolateLeft:'clamp', extrapolateRight:'clamp' });
// counter-motion: blob drifts DOWN (opposite of hero rising) during entrance
const bx = 540 + Math.sin(frame / 45) * 200;
const by = 760 + interpolate(enterProgress, [0, 1], [0, 40]) + Math.cos(frame / 55) * 80;
```

---

### F6: Add default emotion + personality to Section 3
**File:** `src-tauri/resources/remotion-skills.txt`, Section 3

**Problem:** Section 3 asks the model to choose emotion and personality before writing
code but specifies no default. An ambiguous prompt like "animate FINKS" leaves the model
choosing freely -- contradicting the opinionated-defaults principle that Section 4 applies
to everything else. The Midnight Pop default palette is described as "moody, premium,
electric"; there should be a matching Section 3 default.

**Fix:** Add one line after the NARRATIVE block:

```
DEFAULT (use when the prompt doesn't imply otherwise): emotion = elegance, personality = Premium.
```

---

### F7: Expand the layout self-check
**File:** `src-tauri/resources/remotion-skills-layout.txt`

**Problem:** The layout self-check only verifies absence of motion imports. It misses
safe-zone compliance, palette correctness, type hierarchy, and whether elements have
explicit final positions for the motion pass to animate into.

**Fix:** Replace the current single-item self-check with:

```
[ ] animation.tsx contains zero animation imports or calls (useCurrentFrame, spring, interpolate, Easing)?
[ ] All text and key visuals inside the safe zone (x 80-920, y 200-1500)?
[ ] Exactly one palette (P1-P6) used; no colors invented outside its named roles?
[ ] One clear hero element (the largest/boldest); at most two font sizes doing the hierarchy work?
[ ] Every element has an explicit absolute position (left/top or transform: translate) so the
    motion pass can animate INTO these positions?
[ ] No background that changes per-frame (no frame-dependent gradient); the base is static?
```

---

### F8: Add composition recipe code to Section 9
**File:** `src-tauri/resources/remotion-skills.txt`, Section 9

**Problem:** Section 9 describes multi-template composition in prose but gives no code.
The Sequence/Series API has non-obvious semantics (Series resets `frame` to 0 per child;
AmbientBackground must sit outside the Series; inner templates need `transparent`
backgrounds). Models generating multi-scene clips from the prose description frequently
misuse Series/Sequence, producing runtime bugs.

**Fix:** After the template list and the assembly prose, add a minimal 25-line Series
recipe showing the three key patterns -- AmbientBackground outside the Series, Series
children with `durationInFrames`, transparent inner backgrounds:

```tsx
// Composition recipe: ambient base + Series of 3 scenes (4s / 120f)
export const fps = 30;
export const durationInFrames = 120;

export default function Clip() {
  return (
    <AbsoluteFill style={{ backgroundColor: P.bg }}>
      <AmbientBg />  {/* persistent; outside Series so it never remounts */}
      <Series>
        <Series.Sequence durationInFrames={40}>
          {/* frame resets to 0 here; set inner bg to transparent */}
          <Hook />
        </Series.Sequence>
        <Series.Sequence durationInFrames={50}>
          <Substance />
        </Series.Sequence>
        <Series.Sequence durationInFrames={30}>
          <SignOff />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}
```

---

### F9: Trim the self-check and fix the vague item
**File:** `src-tauri/resources/remotion-skills.txt`, Section 13

**Problem:** 14 checklist items (target was 6-8). Item 9 -- "Emotional intent (Section 3)
is coherent with palette, personality, and motion choices" -- is not binary; a model
will auto-pass it. Five NEVER rules have no corresponding gate: minimum text size (28px),
font family count (<=2), Display tracking (negative), accent-on-body contrast, 360px
travel limit.

**Fix:** Reduce to 10 items. Replace item 9 with a concrete binary: "Personality archetype
from Section 3 is consistent with the motion choices: Premium uses smooth-settle only and
<=3% overshoot; Playful/Energetic may use emphasis-pop; Corporate uses snappy-entrance."
Add gates for: "No text below 28px; no more than two font families; Display type has
negative letter-spacing (at least -1px)."

---

### F10: Add unit consistency to Section 3
**File:** `src-tauri/resources/remotion-skills.txt`, Section 3

**Problem:** Section 3 specifies timing in milliseconds ("200-400ms", "500-800ms").
Section 8 uses frames. A model doing frame math must convert mid-generation.

**Fix:** Add parenthetical frame conversions inline:

```
joy : 200-400ms (6-12f @30fps)
calm: 500-800ms (15-24f @30fps)
...
```

---

### F11: Redirect Section 3 forward references
**File:** `src-tauri/resources/remotion-skills.txt`, Section 3

**Problem:** Section 3 PERSONALITY references `emphasis-pop` and `quick-tick` before
those names are defined in Section 8. A model reading linearly encounters unknown terms.

**Fix:** Add "(defined in Section 8)" next to each first reference. This is a one-word
change per occurrence; it costs nothing and anchors the forward reference explicitly.

---

## Tier 3 -- Delivery layer (session quality improvements)

### F12: Inject `animation.tsx` contents at session start
**File:** `src-tauri/src/claude_bridge.rs`, `write_project_context`

**Problem:** Every session starts with the model having no idea what is in `animation.tsx`.
Its first action is often a Read tool call to orient itself, costing a round trip before
any user-visible work happens. On fresh sessions continuing a project, this cold-start
repeats every time.

**Fix:** In `write_project_context`, after generating the file listing, append a
`CURRENT STATE` block reading the contents of `animation.tsx`:

```rust
if let Ok(contents) = std::fs::read_to_string(project.join("animation.tsx")) {
    body.push_str("\n================================================================\n");
    body.push_str("CURRENT animation.tsx\n");
    body.push_str("================================================================\n");
    body.push_str(&contents);
}
```

Token cost: ~150-400 tokens per session for a typical animation file. Benefit: zero
cold-start round trips, model is immediately oriented.

---

### F13: Refresh project context on new source files
**File:** `src-tauri/src/file_watch.rs` or a new Tauri command

**Problem:** `project-context.txt` is written once at PTY open. If the model creates
`components/AnimatedWord.tsx` mid-session, that file is absent from the listing. The
PREFER-EXISTING rule then tells the model the file doesn't exist, causing it to
reimplement the component inline on the next request.

**Fix:** Add a directory watcher on `{projectDir}/components/` and `{projectDir}/` that
calls `write_project_context` when any `.ts` or `.tsx` file is created or deleted.
The updated file is written to the same path the CLI already has appended; the model
reads it fresh on its next tool invocation. No PTY restart required.

---

### F14: Apply `write_if_changed` to `project-context.txt`
**File:** `src-tauri/src/claude_bridge.rs`, `write_project_context`

**Problem:** `project-context.txt` is rewritten unconditionally on every PTY open with
`std::fs::write`. If files haven't changed since the last session, the file is written
with identical content, potentially invalidating the CLI's prompt cache entry for it.

**Fix:** Before writing, compute a lightweight hash of the directory snapshot (sorted
`filename:size` tuples). Store the hash as a sidecar file. Skip the write when the hash
matches. This mirrors the `write_if_changed` pattern already used for skills files.

---

### F15: Remove or simplify the `SKILLS_SECTION_DIVIDER`
**File:** `src-tauri/src/claude_bridge.rs`, `ensure_claude_config`

**Problem:** The divider banner `===== APPENDED SKILL MODULE: IMAGE REFERENCE =====`
appears immediately before the image skills section's own `================================================================ IMAGE REFERENCE MODE ================================================================` header. The model sees two consecutive headers for the same section. The divider adds no information the section header doesn't already provide.

**Fix:** Remove `SKILLS_SECTION_DIVIDER` from the format string. The `trim_end_matches('\n')`
and the surrounding `\n\n` separators already prevent line fusion. The image section's
own header is sufficient.

---

### F16: Add a test that `CONTEXT_NON_SOURCE` matches `NON_SOURCE` in `collect_files`
**File:** `src-tauri/src/claude_bridge.rs` tests, `src-tauri/src/commands/projects.rs`

**Problem:** `CONTEXT_NON_SOURCE` in `claude_bridge.rs` and `NON_SOURCE` in
`collect_files` (projects.rs) are kept in sync by hand comment with no test. If a
new metadata category is added to one without updating the other, the model will see
metadata files it wasn't supposed to.

**Fix:** Add a Rust test that imports both constants and asserts they contain the same
set of strings. Or consolidate them into one shared constant in a shared module.

---

## Image skills specific

### F17: Move fallback table to the top of `remotion-image-skills.txt`
**Problem:** The model reads the full four-step workflow before discovering that
photographs, textures, and 3D renders can't be faithfully recreated. This wastes
token budget on both sides for inputs that fall into "No" categories.

**Fix:** Move the fallback table immediately after the opening paragraph, before
Step 1. Add one sentence: "Check this table first; if your input type is 'No', skip
directly to the gradient-field approach in Step 2."

---

### F18: Replace hidden JSON schema with visible lightweight analysis
**File:** `src-tauri/resources/remotion-image-skills.txt`, Step 1

**Problem:** "Produce this format internally (do not paste into chat)" requires
suppressed structured generation, which is unreliable without extended thinking mode.
The model will either skip it (defeating the scaffolding) or paste it anyway.

**Fix:** Replace with a brief visible analysis before code:

```
Before writing code, describe in 2-3 sentences: (1) background type and dominant
colors, (2) the main visual elements and their approximate canvas positions, (3) any
text content and its hierarchy. This analysis is shown in chat.
```

Visible output guarantees it happens. Two to three sentences is enough to anchor the
recreation without the 50-field JSON overhead.

---

### F19: Switch scene description to absolute px coordinates
**File:** `src-tauri/resources/remotion-image-skills.txt`, Step 1 schema

**Problem:** Fractional positions (`{ "cx": 0.5, "cy": 0.5 }`) require a conversion
step (`cx * 1080`) before they can appear in a style prop. The canvas is fixed; there
is no portability benefit to fractional coordinates. Each element requires arithmetic
that accumulates error.

**Fix:** Replace fractional fields with `cx_px` and `cy_px` in the schema definition
and remove the conversion formula. The UI Card recipe then becomes:

```js
style={{ position:'absolute', left: layer.cx_px - layer.w_px/2, top: layer.cy_px - layer.h_px/2,
         width: layer.w_px, height: layer.h_px }}
```

---

### F20: Add P-role mapping heuristic to the BRANDED SLIDE recipe
**File:** `src-tauri/resources/remotion-image-skills.txt`, Step 2 BRANDED SLIDE

**Problem:** "Override the active palette P object with extracted brand hex codes"
doesn't explain which image colors map to which roles (bg / surface / accent / ink /
muted). A reasonable model guesses, but ink/muted confusion and accent-as-background
errors are common.

**Fix:** Add two sentences: "Map brand colors to roles: darkest dominant region -> bg;
lightest region (if used as a ground) -> surface; primary text color -> ink; secondary
text -> muted; most visually distinctive brand color -> accent. If the brand is
light-on-dark, pick P1/P2/P3 as the base; if dark-on-light, pick P4/P5."
