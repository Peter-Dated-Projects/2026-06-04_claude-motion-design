---
id: critique-image-skills-gaps
root: research
type: research
status: current
summary: "Critical audit of remotion-image-skills.txt and overall skills coverage gaps"
created: 2026-06-07
updated: 2026-06-07
---

# Critique: Image Skills and Coverage Gaps

Note: the ticket references `mcpmarket-motion-research.md` and
`file-management-reuse-research.md` as `.charm/kb/` files (not
`.charm/kb/research/`). Both exist at that path and have been read for this
analysis.

---

## Image skills: what works (and why)

### The four-step workflow is a sound frame

The workflow (Extract description -> Map to CSS/SVG -> Animate -> Iterate) maps
well to the actual constraint: the sandbox cannot render photographs, so the
model must decompose an image into primitives it CAN produce. Breaking that into
explicit phases reduces the chance the model jumps straight to JSX for a scene it
has not structurally understood. The Step 4 iteration summary ("summarize what
abstractions were used") is particularly good -- it creates a shared vocabulary
between user and model for targeted corrections. "Make the gradient more blue"
maps cleanly to a specific gradient layer in a way that "make it look more like
the original" does not.

### The photograph recipe correctly abandons realism

The photograph recipe -- "extract 3-5 dominant color zones; map each to a CSS
gradient layer; stack radial blobs for color complexity" -- is the right call.
Attempting realism via CSS for photographic content would produce bad output.
Dominant-color gradient fields acknowledge the constraint explicitly and produce
something that is coherently designed rather than a failed approximation.

### The SVG logo recipe covers the common real cases

Geometric logos (circles, arcs, polygons, paths) via inline SVG is exactly what
the sandbox supports and what brand assets most often require for non-photographic
marks. The fallback to system font + exact brand hex for wordmarks is practical.
These two branches together cover most of what users will actually drop in.

---

## Image skills: what does not work (and why)

### 1. The internal JSON schema is CoT scaffolding that may silently not fire

Step 1 says: "produce a structured description before writing any code. Use this
format internally (do not paste it into chat unless the user asks)."

This instructs the model to generate a large JSON object purely as hidden
reasoning -- without extended thinking mode, there is no guaranteed mechanism for
this. A model operating in standard turn-taking mode will either:

- Skip the step entirely (treating "internally" as optional), proceeding to JSX
  without the structured analysis, which defeats the scaffolding purpose.
- Paste the JSON anyway, because the instruction to suppress output is weaker than
  the model's disposition to show its work.

The design-skills-encoding.md note endorses chain-of-thought as a quality lever,
but cites it as a tool for design *intent* (the emotion/personality/narrative
framework in Section 3 of remotion-skills.txt), not for hidden structured data
generation. The intent questions in Section 3 work because they orient the model
before code generation without demanding suppressed output. The JSON schema in
Step 1 is more ambitious and less reliable.

**What to do instead:** either move the analysis to visible output ("Before
writing code, write a brief scene analysis:") so it definitely happens, or
collapse Step 1 into a smaller prompt-internal note ("identify the 2-3 dominant
visual regions and their colors before you start"). Demanding a hidden 50-field
JSON object is wishful.

### 2. Fractional positions add unnecessary arithmetic

The schema uses `{ "cx": 0.5, "cy": 0.5 }` (fraction of canvas) and then
immediately provides the conversion: `cx * 1080 = x center, cy * 1920 = y center`.

The canvas is fixed at 1080x1920. There is no portability benefit to fractional
coordinates -- the code never renders at another resolution. Every position the
model extracts from the image must be converted before it can appear in a style
prop, and that conversion is error-prone arithmetic the model must get right for
every element:

```js
const cardX = layer.position.cx * 1080 - (layer.size.w * 1080) / 2;
```

The conversion shown in the UI Card recipe is correct, but it is still a manual
step that accumulates error across a scene with 5-10 elements. Absolute px
coordinates (position as `{ "x": 540, "y": 960 }` meaning the element's left-top
corner, or center + explicit `"cx_px": 540`) would eliminate the arithmetic
entirely and produce style props directly. The only counterargument -- that
fractional positions are more readable in the JSON -- is outweighed by the
compile-time correctness benefit.

### 3. The UI Card recipe shows arithmetic without a JSX wrapper

The UI Card recipe gives this conversion:

```js
const cardX = layer.position.cx * 1080 - (layer.size.w * 1080) / 2;
const cardY = layer.position.cy * 1920 - (layer.size.h * 1920) / 2;
const cardW = layer.size.w * 1080;
const cardH = layer.size.h * 1920;
```

These are variable declarations, not a component. The recipe shows the math but
not how to use it inside JSX -- no `<div style={{ position: 'absolute', left:
cardX, top: cardY, width: cardW, height: cardH }}>` example. Compare the logo
recipe, which shows actual SVG JSX:

```jsx
<svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
  <path d="M ..." fill="#brandHex" />
```

That is complete and followable. The card recipe is a calculation fragment that
stops before the output a model needs to produce. A model generating UI card
layouts from this recipe must infer the wrapping -- which it will likely do
correctly, but the inconsistency with the other recipes (which show real JSX) is
a quality gap.

### 4. The fallback table is at the end, after the model has committed to the workflow

The fallback table appears after Step 4. But the question it answers -- "can I
even attempt this?" -- should be answered before the model reads the four-step
workflow. As currently structured, the model reads through all of Steps 1-4
before discovering:

```
Photograph (people/scene)   : No -- replace with dominant-color gradient field
Complex texture             : No -- flat fill in dominant tone
Photorealistic 3D render    : No -- abstract geometric composition with extracted palette
```

If the user image is a photograph, the correct first response is "I cannot
recreate this photographically; I will use a dominant-color gradient field" -- not
a four-step decomposition that ends in the same result. Moving the fallback table
to the top (or immediately after the introductory paragraph) would let the model
scope the task immediately and communicate that scope to the user before writing
any code.

The current placement also means models may faithfully execute the full Step 1
JSON schema for an input that falls into the "No" category, which is wasted token
budget on both sides.

### 5. Step 3 re-states safe zones already defined in the main file

Step 3 contains: "Apply safe zones -- all text must stay in x 80-920, y
200-1500." Section 2 of remotion-skills.txt already defines this with more
precision (x 80-920, y 200-1500 is title-safe; there is also universal safe x
30-920, y 140-1550). The re-statement in image skills is not wrong, but it is a
copy of a hard constraint that is supposed to be authoritative in one place. If
the main file's safe zone numbers ever change, the image skills file has a
stale copy.

### 6. "Apply the standard motion system from remotion-skills.txt" is a fragile cross-reference

Step 3 says: "apply the standard motion system from remotion-skills.txt." In
practice the two files are concatenated, so the model is reading one combined
document. "From remotion-skills.txt" names a file artifact, not a content
location. If the concatenation order changes, or the combined file is referenced
differently, the pointer breaks.

The image skills file does give the named preset names (snappy-entrance,
gentle-float, soft-exit) immediately after the cross-reference, but without
their numerical configs. If a model treats image skills as self-contained (which
the "IMAGE REFERENCE MODE" header arguably invites), it has only the names, not
the spring parameters needed to implement them. The cross-reference works when the
two files are always concatenated and the model holds both in context, but that is
an architectural assumption the prompt should not rely on silently.

### 7. "Override the active palette P object" lacks a mapping guide

The BRANDED SLIDE recipe says: "Override the active palette P object with
extracted brand hex codes. Use the design token structure from remotion-skills.txt
Section 5 (Color Palettes)."

Two problems:

First, P's role structure (bg / surface / accent / accent-soft / ink / muted) is
defined in remotion-skills.txt Section 5, not in this file. The image skills file
never shows what P looks like, so "override P" is actionable only if the model
has already read Section 5.

Second, "override with extracted brand hex codes" does not explain the mapping
process. Given a brand image with a dark navy background, white text, and a gold
accent mark, which colors go to which roles? The role names (bg, surface, accent,
ink, muted) carry semantic meaning -- bg is the full frame, ink is primary text,
accent is the one loud color -- but the mapping from observed image regions to
these roles is not guided. A reasonable model will likely make a sensible guess,
but this is the step most likely to produce a P override that mixes up ink and
muted, or assigns accent to a background color.

A two-sentence mapping heuristic would close this gap: "darkest dominant color ->
bg; primary text color -> ink; most visually distinctive brand color -> accent;
intermediate surface tones -> surface and accent-soft; secondary text color ->
muted."

---

## Coverage gaps across the whole system

### Coverage check: the 8 mcpmarket-motion-research.md adaptations

`mcpmarket-motion-research.md` (T-028 output) analyzed the LottieFiles
`motion-design-skill` and identified 8 prioritized adaptations for
`remotion-skills.txt`. Checking each against the current file:

1. **"Define emotional intent" gate** -- present. Section 3 ("INTENT FIRST") is
   exactly this gate, with emotion and personality questions before any technical
   choices.

2. **Motion Personality table** -- present. Section 3 "PERSONALITY" has all four
   archetypes (Playful / Premium / Corporate / Energetic) with duration ranges and
   overshoot levels. The skills file went further than the adaptation asked for --
   it cross-references the named spring presets.

3. **Emotion -> Motion table** -- present. Section 3 "EMOTION" lists six emotions
   (joy / calm / urgency / elegance / surprise / playfulness) with timing and easing
   guidance for each.

4. **Disney Arcs with numbers** -- present. Section 8 "Disney principles" explicitly
   names "Arcs" as a principle, gives "10-20px perpendicular offset at the midpoint
   of major travel", and specifies "Drive x and y with different interpolate ranges."

5. **1/3 Rules** -- present. Section 8 "1/3 Rules" has both: max 1/3 elements in
   motion simultaneously, and no element travels more than 1/3 of canvas without
   an intermediate keyframe.

6. **Counter-motion guidance** -- present. Section 8 "Counter-motion" and Section 9
   T10 description both include it. Section 8: "When the hero enters from one
   direction, move the ambient background blob/gradient in the OPPOSITE direction at
   20-30% of the hero's speed."

7. **Shimmer pattern** -- present. Section 8 "Shimmer / gleam" and Section 9 T11
   both cover it, including the `backgroundPosition` interpolation code.

8. **De-sync note for multi-element float** -- present. Section 8 "gentle-float
   de-sync" gives three example Hz values (0.30, 0.22, 0.38) for independent
   elements. The NEVER list also prohibits same-Hz floating.

**Finding: all 8 adaptations have been implemented.** The current
`remotion-skills.txt` addressed every item the mcpmarket research identified. This
is a significant positive -- the gap analysis that motivated the rewrite has been
fully closed at the skills-content level.

### Gap 1: Section 10 (Component Vocabulary) documents a system that does not exist

Section 10 of remotion-skills.txt says:

```
If the project contains shared modules, ALWAYS import from them instead of
rewriting inline. Check for: theme.ts, motion.ts, components/ directory.
```

It then lists concrete imports:

```
import { P, DISPLAY, BODY } from './theme';
import { SNAPPY, SMOOTH_SETTLE, fadeIn, softExit, gentleFloat } from './motion';
import { AnimatedWord } from './components/AnimatedWord';
```

None of these files exist in a new project. New projects contain only
`animation.tsx`. Two independent KB notes confirm this is a real problem:

`multi-file-architecture.md` is explicit: the sandbox compiler runs in esbuild
**transform** mode, which cannot resolve relative imports at all -- "cross-file
imports do not work today, full stop." A relative import like `import { P } from
'./theme'` left in the output of transform mode "contains a dangling import that
breaks at runtime in the sandbox."

`file-management-reuse-research.md` repeats this in its constraints summary: "The
current compiler is transform-mode. Relative imports DO NOT work today. All
shared-module design is contingent on Phase 1 of multi-file-architecture.md
landing." It explicitly recommends that the SHARED MODULES section only be added
to `remotion-skills.txt` "in lockstep with Phase 3 of the architecture plan" --
which has not landed.

The conditional phrasing ("If the project contains") softens the rule: a model
that finds the files absent would not import from them. But the instruction "Check
for: theme.ts, motion.ts, components/ directory" creates a subtler risk -- a
model may decide to create these files proactively (since the skills file says they
should be there) and then write imports. That combination -- files written but
compiler in transform mode -- produces code that looks correct to the model but
will not compile in the preview sandbox.

Section 10 should be gated behind the multi-file compiler landing. Until then, it
is a forward-documentation hazard.

### Gap 2: Template descriptions are one-liners; composition assembly has no code

Section 9 of remotion-skills.txt describes 11 templates with one-line
when-to-use entries, e.g.:

```
T1  Kinetic Staggered Headline -- opening hook; 2-6 words snap in word-by-word.
T2  Big-Number / Stat Reveal   -- one metric counts up + scales with a label beneath.
```

The design-templates.md note (T-038 output) has full TSX skeletons for all 10
template types -- 30-80 lines each, fully compilable, with real spring configs and
frame counts.

The exemplar in Section 11 of remotion-skills.txt is a complete, compiling
component using Template 1 (Kinetic Staggered Headline). A model can infer the
animation pattern for similar staggered text from that exemplar. But for templates
that have fundamentally different structures -- T7 (Logo Reveal with SVG
strokeDashoffset), T8 (Section Wipe with clip-path), T9 (Progress Motif with SVG
arcs) -- the one-liner gives no implementation guidance. A model generating T7
from scratch will produce a reasonable attempt, but the specific technique (SVG
ring-draw via `strokeDashoffset`) is not suggested anywhere in the skills file and
may not appear without the skeleton.

The larger gap is composition assembly. The design-templates.md file has two
complete recipes (Recipe A: "Stat Drop" with 120f Series, Recipe B: "Hook + Wipe
+ Quote" with Sequence overlap for the wipe). The skills file describes the
assembly pattern in prose:

```
Assemble with Sequence / Series over an Ambient Background base. Default skeleton:
ambient (T10) base -> hook (T1 or T4) -> substance (T2/T5/T6/T9) -> sign-off
(T3 or T7), wipe (T8) only for a hard tonal cut.
```

No code accompanies this. The Sequence/Series API has non-obvious semantics
(Series resets `frame` to 0 for each child; Sequence offsets `from` in global
time; the AmbientBackground goes outside the Series as a persistent base layer).
A model generating a multi-scene clip from the prose description will frequently
make Series/Sequence mistakes that only manifest at runtime, not at a glance.
One complete recipe in code (like Recipe A in design-templates.md) would anchor
the assembly pattern the same way the exemplar anchors single-template generation.

### Gap 3: The "Intent First" section (3) front-loads questions but does not default

Section 3 of remotion-skills.txt has the intent framework:

```
EMOTION -- what should the viewer feel? [joy / calm / urgency / elegance / ...]
PERSONALITY -- which archetype governs? [Playful / Premium / Corporate / Energetic]
NARRATIVE -- what is the micro-story? [Setup -> Action -> Resolution]
```

These are framed as questions to answer before touching code. But they have no
default. Section 4 ("DEFAULT LOOK") provides the palette/font/template/motion
default, but Section 3 does not say "default emotion is elegance" or "default
personality is Premium." A model receiving an ambiguous one-word prompt ("animate
FINKS") reads Section 3 and must independently choose an emotion and personality
before it hits Section 4's actual defaults.

The design-skills-encoding.md blueprint's recommendation was: "spell out a single
default for every axis." Section 3 currently does not do this -- it teaches the
framework without choosing a default within it. A one-line addition like "Default:
emotion = elegance, personality = Premium" would be consistent with the "Midnight
Pop" default palette (Section 4 describes it as "moody, premium, electric") and
eliminate the ambiguity.

---

## Specific recommendations

**1. Move the fallback table to the top of remotion-image-skills.txt.** Scope what
is possible before the workflow. A model handling a photograph should know
immediately to apply the gradient-field approach rather than running the four-step
analysis and discovering the same answer at the end.

**2. Replace the "do not paste into chat" JSON schema with visible, lighter CoT.**
Either make the Step 1 analysis explicitly user-visible (a brief structured
paragraph, not a 50-field JSON) or collapse it into a shorter checklist ("identify
background type, 2-3 dominant colors, major geometric elements, any text"). Hidden
structured generation is unreliable without extended thinking mode.

**3. Switch to absolute px in the scene description.** Replace `{ "cx": 0.5, "cy":
0.5 }` with `{ "cx_px": 540, "cy_px": 960 }`. Eliminate the conversion step; the
canvas never changes size.

**4. Add a P-role mapping heuristic to the BRANDED SLIDE recipe.** Dark dominant
region -> bg; primary text color -> ink; most distinctive brand color -> accent.
Two sentences; enough to guide the mapping without requiring the model to read
Section 5.

**5. Disable or guard Section 10 until multi-file support lands.** Either remove
the section, add a clear "NOT YET: these shared modules do not exist in the
default project setup -- do not attempt these imports" caveat, or change "ALWAYS
import from them" to "IF these files exist in the project, import from them." As
written, Section 10 will cause broken imports in any project that doesn't already
have the files.

**6. Add one composition recipe (code-level) to Section 9.** A 30-line Series
example showing AmbientBackground (T10) + Series of two or three inner templates
would anchor multi-scene assembly the way the exemplar anchors single-template
generation. It does not need to be long -- just enough to show the Series/Sequence
frame-reset semantics and the transparent-background rule for inner templates.

**7. Assign a default to Section 3 intent.** Add "Default: emotion = elegance,
personality = Premium" (or whatever is consistent with the Midnight Pop default)
so that ambiguous prompts produce a coherent, deliberate result without relying on
the model choosing an intent unprompted.
