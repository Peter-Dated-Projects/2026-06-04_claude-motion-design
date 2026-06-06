---
id: mcpmarket-motion-research
root: research
type: research
status: current
summary: "Research on LottieFiles/motion-design-skill (the skill behind mcpmarket.com/tools/skills/motion-design-ui-animation): philosophy, Disney principles, emotion-to-motion mapping, choreography patterns, and what is worth adapting into remotion-skills.txt."
created: 2026-06-05
updated: 2026-06-05
---

# Research: mcpmarket.com motion-design-ui-animation

## Source

The mcpmarket.com page at `https://mcpmarket.com/tools/skills/motion-design-ui-animation`
is behind Vercel bot protection and returned 429 on direct fetch. The underlying
source is the public GitHub repo `LottieFiles/motion-design-skill` (MIT license),
installed via `npx skills add LottieFiles/motion-design-skill`. All analysis below
is from that repo, read via the GitHub API.

## What the skill contains

A philosophy-first, implementation-agnostic motion design knowledge base for AI
agents. Structure:

```
skills/motion-design/
  SKILL.md                    -- 8-step checklist, quick-reference tables
  director/
    core-philosophy.md        -- Three Pillars (Emotional Intent, Visual Narrative, Motion Craft)
    decision-framework.md     -- Full decision pipeline
    disney-principles.md      -- 12 principles, UI-adapted with numeric specs
    motion-personality.md     -- 4 brand archetypes + identity system
    emotion-mapping.md        -- Emotion -> motion translation tables
    choreography.md           -- Multi-element coordination
    narrative-structure.md    -- Micro-story framework
    context-adaptation.md     -- Platform, a11y, performance
  patterns/
    entrance-exit.md
    state-feedback.md
    ambient-continuous.md
    multi-element.md
  reference/
    timing-easing-tables.md
    property-selection.md
    quality-checklist.md
    troubleshooting.md
```

Works with any animation system (CSS, Framer Motion, GSAP, Spring, Lottie). Designed
for UI/web animations — buttons, modals, page transitions, micro-interactions.

---

## Gaps vs remotion-skills.txt

Items below are NOT already covered (or are covered only superficially) in our
current system prompt. Ordered by relevance to Remotion short-form video.

### 1. Three Pillars framework — high value

The skill opens with a philosophy gate before any technical choices:

| Pillar | Question | Drives |
|--------|----------|--------|
| Emotional Intent | What should the viewer FEEL? | Easing, timing, amplitude |
| Visual Narrative | What's the micro-story? | Setup -> Action -> Resolution |
| Motion Craft | How do we make it believable? | Physics, secondary motion, paths |

Our remotion-skills.txt jumps straight to palette/type/motion presets. Adding a
brief "define emotional intent first" gate before the technical sections would give
Claude a meaningful decision tree for ambiguous prompts (e.g. "something energetic"
vs. "something premium").

### 2. Motion Personality archetypes — high value

Four named archetypes with duration and easing defaults:

| Archetype | Duration | Easing | Overshoot | Keywords |
|-----------|----------|--------|-----------|----------|
| Playful | 150-300ms | ease-out-back | 10-20% | fun, bouncy |
| Premium | 350-600ms | cubic-bezier(0.4,0,0.2,1) | 0% | elegant, minimal |
| Corporate | 200-400ms | cubic-bezier(0.2,0,0,1) | 0-3% | clean, professional |
| Energetic | 100-250ms | ease-out-expo | 15-30% | dynamic, bold |

Our skill has named spring presets tied to roles (snappy-entrance, smooth-settle)
but no named personality/brand-intent layer. Adding a "choose ONE personality before
picking presets" rule would help Claude make coherent choices when the user gives
a style direction rather than a technical one.

Also introduced: Brand Motion Identity — define (1) signature easing, (2) duration
palette of three values, (3) consistent entrance pattern. Useful for repeat projects.

### 3. Disney's 12 Principles (UI-adapted with numbers) — medium-high value

Our skill references "snappy" and "smooth" presets but never names the underlying
principles. The most useful ones for Remotion that are NOT explicitly in our prompt:

**Squash and Stretch** — scale [1.2, 0.8] on impact (2-4 frames), recover to
[0.85, 1.15], then settle. Volume preservation: +20% width = -20% height.
Skip for premium brands. Currently absent from remotion-skills.txt.

**Anticipation** — small opposite motion before main action, 100-200ms,
10-20% of main magnitude. Example: element shifts 5-10px away before entering.
Our prompt has no anticipation guidance.

**Arcs** — add 10-20px perpendicular offset at midpoint of a travel path.
5px for corporate/premium, 20px+ for playful. Our prompt never mentions arc paths.
In Remotion this maps to driving x and y with different interpolate ranges — we
mention this only in passing ("drive x and y with different ranges so the path arcs")
without naming the principle or giving numbers.

**Follow Through and Overlapping Action** — child/trailing elements delay 50-150ms
behind parent; stop times offset by 100-200ms; lower spring stiffness = more trailing.
We have stagger for entrances but no follow-through framing for compound elements.

**Secondary Action** — support element moves at 30-50% of primary amplitude,
starts 50-100ms after primary, uses different easing. We call this the "ambient"
layer but don't give amplitude ratios.

**Exaggeration by personality**:
- Playful: 15-25% scale overshoot, rotation ±5-15deg
- Energetic: 20-30%
- Corporate: 0-5%
- Premium: 0%
Our spring presets encode some of this implicitly, but naming the personality-
overshoot mapping makes Claude's choices more deliberate.

### 4. Emotion-to-Motion mapping — medium value

A table mapping emotional target to path type, easing, and duration:

| Emotion | Path | Easing | Duration |
|---------|------|--------|----------|
| Joy | Curved, upward arcs | ease-out-back | 200-400ms |
| Calm | Gentle curves | sine ease-in-out | 500-1000ms |
| Urgency | Straight lines, direct | ease-out | 100-200ms |
| Elegance | Long smooth arcs | (0.4,0,0.2,1) | 400-700ms |
| Surprise | Radial outward | ease-out-expo | 150-300ms |
| Playfulness | Arcs, squiggly | ease-out-back | 200-350ms |

Also: path shape as language (angular = tense, curved = friendly, spiral = whimsical,
diagonal = purposeful, vertical up = growth/achievement).

Our prompt has no emotional vocabulary. Useful to add as a short table, especially
for prompts like "make this feel celebratory" or "make it feel premium and slow."

### 5. The 1/3 Rules — medium value (translates directly)

**Distance**: No motion travels more than 1/3 of screen/frame without an
intermediate keyframe (direction change, speed variation, or arc adjustment).

**Elements**: With 3+ animated elements, max 1/3 should be in active motion
simultaneously. Element 1 should settle as element 3 starts.

Our prompt has "stagger 3-5 frames per element" but no explicit cap on simultaneous
motion or distance without keyframe. These rules formalize what "designed" choreography
means. Easy to add as two bullet points.

### 6. Choreography sequence structure — medium value

Setup (20-30%) -> Action (30-40%) -> Resolution (30-40%). Leave 100-200ms still
after resolution before next motion.

Our timing budget (enter 12-20%, hold 55-70%, exit 10-15%) covers similar ground
for single-template clips but doesn't describe internal sequencing when multiple
events happen inside a clip. Useful for multi-template compositions (T1 + T5 + T7).

### 7. Counter-motion — medium value

When the hero enters in one direction, the ambient/background layer moves the
opposite direction at 20-30% of the hero's speed. Adds depth and polish.

| Hero motion | Counter-motion | Speed ratio |
|-------------|---------------|-------------|
| Enters left | Background shifts right | 20-30% |
| Scales up | Shadow scales down | 10-20% |
| Lifts (Y up) | Shadow spreads + softens | 20-30% |

Currently absent from remotion-skills.txt. In Remotion it's easy to implement
by animating the gradient blob center in the opposite direction from the hero.

### 8. Stagger pattern vocabulary — low-medium value

Named stagger patterns beyond sequential:

- **Center-out**: radiating from center element outward
- **Wave**: sine-based delay across a row/column
- **Reverse**: bottom-to-top (useful for exits or backward navigation)

Our prompt only describes sequential stagger. Center-out is useful for word-reveal
where the middle word is the hero. Easy to add as a brief named list.

### 9. Layered floating (de-sync rule) — low value, specific

When multiple elements float simultaneously, use different cycle durations to
prevent synchronization:
- Element 1: 4000ms, ±10px
- Element 2: 5500ms, ±8px (offset 30%)
- Element 3: 3500ms, ±12px (offset 60%)

Our gentle-float is specified as one sinusoidal. Good to add a note that
`Math.sin((frame/fps) * 2*PI * Hz)` where different elements use different Hz
values prevents lockstep floating.

### 10. Shimmer/Gleam pattern — contextually useful

A gradient sweep left-to-right at 30% peak opacity, 1500-2500ms per sweep,
2000-5000ms pause between. In Remotion this would be an interpolated gradient
position on an element. Useful for highlighting a stat or a CTA word.

Currently absent from remotion-skills.txt. Easy to implement with CSS background
gradient animated via interpolate.

---

## What to skip

These sections exist in the skill but are irrelevant or inapplicable to our context:

**Platform/a11y/performance adaptation** (`context-adaptation.md`) — reduced-motion
prefers, mobile vs desktop, 60fps budgets. Remotion renders to video offline; there
is no OS preferences or runtime frame budget concern.

**State feedback patterns** (success/error/loading/hover) — `state-feedback.md`
covers button press, form error shake, loading spinners. These are web UI
micro-interactions. Remotion output is a short-form video, not an interactive UI.

**CSS/Framer/GSAP code** — all implementation examples use web animation APIs.
Our constraint is Remotion's spring/interpolate/Easing primitives only.

**Long-cycle ambient patterns** — 8-20s gradient cycles, 2000-5000ms breathing
periods. Our clips are 3-5s total; a 4000ms breathing cycle completes once per clip
and would read as a single slow pulse, not ambient life. Scale down Hz values
significantly (we already use 0.25-0.35Hz, which is ~2.9-4s, right at the edge).

**Dashboard/modal/list-update recipes** — `choreography.md` has web-UI recipes
(modal open, list item add). These don't translate directly to video compositions.

**Particle systems with 10-20 elements** — performance concern in Remotion's
synchronous render, and visually too busy for 3-5s vertical video.

**Material-based easing** (rigid/elastic/fluid/gas/glass) — the concept is
interesting but the practical output maps to our existing spring presets. The
taxonomy is more useful for interactive UI where materials have physical feedback.

---

## Specific adaptations worth making to remotion-skills.txt

Priority order:

1. **Add a "define emotional intent" gate** (1-2 lines) before the technical sections.
   "Before picking a palette or motion preset, identify: what emotion should this
   evoke? joy / calm / urgency / elegance / surprise / playfulness."

2. **Add Motion Personality table** mapping intent keywords to overshoot level and
   duration bias. Cross-reference to our named spring presets.

3. **Add Emotion -> Motion short table** (6-7 rows: emotion, path character, easing
   family, clip duration bias). No code needed — just the mapping.

4. **Expand arc guidance**: name "Arcs" as a Disney principle, give the
   10-20px perpendicular offset number, explicitly say "use different interpolate
   ranges for x and y to create a curved path."

5. **Add the two 1/3 rules** as bullet points under Section 7 (Motion Presets)
   or Section 8 (Templates).

6. **Add counter-motion guidance** under the ambient background (T10) or gentle-float
   sections: "ambient blob/gradient moves opposite to hero at 20-30% of hero speed."

7. **Add Shimmer** as a new micro-template or pattern (within Section 8 or a note
   in Section 7) for highlighting a single accent word or stat during the hold phase.

8. **Add de-sync note for multi-element float**: when 2+ elements float, vary their
   Hz values (e.g. 0.30, 0.22, 0.38) so they never reach the same phase.

Items 4-8 are small additions (1-3 lines each). Items 1-3 are the most conceptually
new and highest-leverage.
