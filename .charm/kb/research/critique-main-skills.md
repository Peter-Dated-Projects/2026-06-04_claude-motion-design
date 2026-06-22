---
id: critique-main-skills
root: research
type: research
status: current
summary: "Critical audit of remotion-skills.txt: what works, what does not, and why"
created: 2026-06-07
updated: 2026-06-07
---

# Critique: remotion-skills.txt

## What works (and why)

**1. The prescriptive default look (Section 4)**

> "Palette 'Midnight Pop' (P1). Font stack 'Bold Impact' (#2) for the hook, 'Neutral Modern' (#1) for body. Template 'Kinetic Staggered Headline' over an 'Ambient Background' base. Motion: 'snappy-entrance' in, 'gentle-float' on hold, 'soft-exit' out. A bare prompt ('animate FINKS') must still land on this coherent look."

This single directive is the most impactful line in the file. It closes the model's largest failure mode -- inventing arbitrary design from scratch -- with a one-sentence mandate. The closing sentence ("animate FINKS") is especially good: it names the exact degenerate case and forces a non-trivial default onto it.

**2. The zeta/overshoot primer in Section 8**

> "Spring overshoot is set by the damping ratio zeta = damping / (2*sqrt(stiffness*mass)): zeta<1 bounces, zeta=1 arrives with no overshoot."

This lets the model reason about spring configs rather than copying them blindly. When the user asks for "less bounce," the model can reason about damping and stiffness rather than guessing. It also makes the preset table entries internally consistent: the "feel" column follows derivably from the numbers. Non-obvious, high-value.

**3. The gentle-float de-sync rule (Section 8)**

> "NEVER float 2+ elements at the same Hz -> de-sync frequencies (0.22, 0.30, 0.38) so they never phase-lock."

This is precisely the kind of non-obvious instruction that separates this file from a generic prompt. Even experienced developers forget this. The three concrete Hz values are ready to paste, which removes the failure mode entirely rather than just warning about it.

**4. The accent-as-spice constraint (Section 5)**

> "accent is a spice, not a base: color ONE word, ONE shape, or ONE bar -- never a paragraph."

Tight, imperative, binary. Names the failure ("a paragraph") and the fix ("ONE element"). This is the correct register for a style constraint -- you cannot squint at it and decide it probably doesn't apply to your situation.

**5. The PREFER-EXISTING RULE in Section 10 (Component Vocabulary)**

> "PREFER-EXISTING RULE: check this list before writing any animation element inline. If a component fits, import it. Only write inline if no existing component applies."

A real workflow guardrail, not a design taste. It directly prevents code duplication across generations. The section wouldn't exist in a naive prompt; its presence suggests someone ran into inline-vs-import divergence in practice.

**6. Clip-path reveals (Section 8)**

The clip-path reveal section gives working code for both text line reveals and panel wipes, including exact variable names and the CSS `inset()` call. This is a concrete alternative to opacity fades that produces an editorial look -- it requires knowledge of how `clipPath` interacts with `overflow:hidden`, which the model can't be expected to derive reliably. Providing it as a ready-to-paste block is the right call.

---

## What does not work (and why)

### 1. The Easing API references in Section 3 don't exist in Remotion

Section 3 lists these easing curves:

```
joy        : curved upward arcs, ease-out-back, ...
surprise   : radial outward, ease-out-expo, ...
calm       : gentle curves, ease-in-out sine, ...
```

None of `ease-out-back`, `ease-out-expo`, or `ease-in-out sine` are in Remotion's Easing API. The Section 1 vocabulary listing says: `Easing.bezier, Easing.linear, Easing.out(Easing.ease), Easing.in/out/inOut(Easing.cubic)`. There is no `Easing.back`, no `Easing.expo`, no `Easing.sine`. A model reading Section 3 will attempt one of:

- `Easing.out(Easing.back)` -- runtime error, `Easing.back` is undefined in Remotion
- `Easing.bezier(...)` with a guessed back-curve bezier -- inconsistent across generations
- Ignoring the emotion guidance and using whatever easing it defaults to

This is the most concrete bug in the file. The emotion table promises a capability (ease-out-back for joy/playfulness) that the import allowlist does not provide. The fix is either to remove the unsupported easing names and replace them with Remotion-native equivalents (e.g., `Easing.out(Easing.cubic)` for decelerate, a specific `Easing.bezier(0.34, 1.56, 0.64, 1)` approximation for back-ease), or to add the `from-bezier` values inline.

### 2. Two competing spring defaults

Section 1 establishes a session default:

> "Spring physics default unless a preset or the user specifies otherwise: { mass: 1, damping: 12, stiffness: 100 }."

Section 8 establishes a different one:

> "snappy-entrance | { mass:1, damping:18, stiffness:200 } | fast, ~7% overshoot | primary element arriving (workhorse)"

These are different configs. `{ mass:1, damping:12, stiffness:100 }` has zeta = 0.60, settling at ~9% overshoot and roughly 20+ frames. `snappy-entrance` has zeta = 0.64, settling at ~7% overshoot and ~13 frames. A model that uses the Section 1 default when Section 8 says "use the workhorse" will produce noticeably springier, slower entrances than intended.

The Section 8 instruction says "reference by name; don't hand-tune springs unless asked." But the model has already been given a named default in Section 1 that bypasses the naming convention. The two defaults conflict, and Section 1 comes first so it wins in a linear read.

Fix: remove the Section 1 spring default entirely, or replace it with an explicit pointer to `snappy-entrance` as the default for primary entrances.

### 3. The Intent-First gate (Section 3) doesn't bind its outputs

Section 3 asks the model to answer three questions (emotion, personality, narrative) before touching code. It provides tables for both emotion and personality that map to specific motion behaviors. But nothing after Section 3 references the outcome of this exercise. The sections that follow (palettes, type, motion presets) give the model full freedom to pick regardless of what emotion/personality analysis concluded.

A model that picks `calm` and `Premium` in Section 3 is not prevented from then choosing `emphasis-pop` and 30% overshoot in Section 8. The gate has no downstream enforcement. The self-check (Section 13) has one item addressing this: "Emotional intent (Section 3) is coherent with palette, personality, and motion choices." But "coherent" is not a binary test -- see the self-check critique below.

Additionally, the personality archetypes in Section 3 reference preset names that haven't been defined yet:

> "Playful: bouncy, 150-300ms -> emphasis-pop + quick-tick"
> "Premium: elegant, 350-600ms -> smooth-settle only"

A model reading top-to-bottom encounters `emphasis-pop` as a forward reference to Section 8. At the point of encounter, the term has no concrete meaning. A model that doesn't fully internalize the whole file before generating (which is every model) won't form the right association until it reaches Section 8, by which point the Section 3 analysis may be out of active context.

### 4. The exemplar's counter-motion is incorrect

Section 8 says:

> "When the hero enters from one direction, move the ambient background blob/gradient in the OPPOSITE direction at 20-30% of the hero's speed."

The exemplar in Section 11 has:

```tsx
const bx = 540 + Math.sin(frame / 45) * 200;
const by = 760 + Math.cos(frame / 55) * 220;
```

The hero enters from BELOW (translateY goes from 40 to 0, i.e., the element rises). For counter-motion the blob should drift DOWNWARD during the entrance. But the exemplar's blob oscillates along a sine/cosine of frame, with no directional relationship to the hero entrance direction. During the entrance phase (frames 0-20 approx), the blob can move in any direction depending on the sine value.

This is the exemplar's job: to demonstrate the rules. It fails to demonstrate counter-motion correctly. A model learning from it will produce blob drift without regard to hero direction, defeating the counter-motion principle. The fix is to add an `enterProgress` variable clamped to the entrance phase and drive `by` in the OPPOSITE direction (downward) during that window, then let it settle into idle oscillation.

### 5. The self-check has too many items and one vague item

Blueprint target: 6-8 binary items. The actual self-check has 14 items. At 14, a model pattern-matching against its own output will auto-pass most items without actually checking -- the list becomes a ritual rather than a gate. Every item past ~8 adds diminishing return on compliance and dilutes the items that matter most.

Item 9 is not binary:

> "[ ] Emotional intent (Section 3) is coherent with palette, personality, and motion choices."

"Coherent" is a subjective judgment the model will almost always grant to its own output. Compare to item 4: "Entrances staggered 3-5f, not simultaneous; no linear easing on entrances or exits." That one is checkable against the code. Item 9 is a vibe-check.

**NEVER list failures without a corresponding self-check item:**

- "NEVER use more than two font families" -- item 3 checks sizes/weights, not families. A model that uses three families passes item 3 anyway.
- "NEVER set text below 28px or run long paragraphs" -- minimum text size is not in the self-check.
- "NEVER leave Display type at default tracking" -- tight tracking on Display is not checked.
- "NEVER use accent color for body text where it fails contrast" -- item 2 checks general contrast legibility but doesn't call out the specific accent-on-body failure mode.
- "NEVER travel a hero element more than 360px in a straight line" -- the arc/travel limit is in item 11 ("Major travel paths arc") but the 360px limit is absent.

### 6. Redundancy: stagger rule appears four times

The stagger rule (3-5 frames per element) appears in:
1. Section 8 motion presets: "Stagger N elements with `delay: index * 4` inside the spring config call (4 frames @30fps)."
2. Section 8 timing budget: "Stagger step 3-5 frames per item -- the single biggest 'looks designed vs amateur' lever."
3. Section 12 anti-patterns: "NEVER animate every element on the same frame -> stagger entrances 3-5 frames per element, hero first."
4. Section 13 self-check: "Entrances staggered 3-5f, not simultaneous."

Four appearances. The rule appears once in the code example (good), once in the prose timing section (good), and then again in anti-patterns and self-check. The anti-patterns and self-check repetitions are fine because they're structural (NEVER list and gate). The redundancy in Section 8's prose is the one that could be cut.

Similarly, templates T10 and T11 in Section 9 repeat the counter-motion and shimmer rules that are already fully specified in Section 8. Template T10: "Drive blob centers in the OPPOSITE direction from the hero entrance for the first 20f (counter-motion)." This is the Section 8 counter-motion rule reprinted as a one-liner in the template. Not harmful, but adds tokens without adding signal.

### 7. Section 3 uses milliseconds; Section 8 uses frames

Section 3 describes motion timing in milliseconds ("200-400ms", "500-800ms"). Section 8 describes timing in frames ("first 12-20%", "8-14 frames"). A model working with frame math from the Section 8 presets must mentally convert Section 3's millisecond guidance. At fps=30, "200-400ms" is 6-12 frames; "500-800ms" is 15-24 frames. The units are not hard to convert, but the file picks a mixed unit system that forces the model to do conversion work rather than mechanical lookup.

---

## Specific recommendations

**Immediate (will cause errors):**
1. Replace `ease-out-back`, `ease-out-expo`, and `ease-in-out sine` in Section 3 with either: Remotion-native equivalents expressed as `Easing.bezier(...)` calls with concrete values, or pointer text like "see Section 8 snappy-entrance preset" that links back to a real API call.

**High leverage (quality lift):**
2. Remove the Section 1 spring default `{ mass: 1, damping: 12, stiffness: 100 }` or replace it with "use `snappy-entrance` for primary entrances; see Section 8 for named presets." The Section 1 default creates a competing baseline that undermines the Section 8 preset system.
3. Add directional counter-motion to the exemplar: during the entrance phase, explicitly move the blob in the OPPOSITE direction from the hero, then transition to idle oscillation. The exemplar is the highest-signal teaching tool in the file and should demonstrate the rules correctly.
4. Fix the self-check to cover the NEVER list gaps: minimum text size (28px), font family count (at most two), tight tracking on Display type, and the 360px travel limit. Replace item 9 ("coherent emotional intent") with a concrete, binary alternative -- e.g., "Palette, motion preset, and overshoot setting are consistent with the personality archetype chosen in Section 3 (no smooth-settle-only Premium personality paired with >10% overshoot)."

**Trim:**
5. Reduce the self-check from 14 to 8-10 items by merging compound items and cutting those already covered by the NEVER list (which the model runs before the self-check anyway during the anti-patterns pass). Priority items: safe zone, contrast, stagger, transform-only, hold duration, imports, fps exports, counter-motion.
6. Convert Section 3 timing references from milliseconds to frames-at-30fps, or add parenthetical conversions, to maintain unit consistency with Section 8.

**Structural (lower urgency):**
7. Move the personality archetype table in Section 3 to after Section 8, or add inline anchor text ("see Section 8") next to each preset name reference. The forward references to `emphasis-pop` and `quick-tick` in Section 3 are weak because the model hasn't seen those definitions yet.
8. Add one line to the soft-exit code block in Section 8 that shows per-element staggered exits -- this is documented in the prose but the only code example for exits is the single-element version. Multi-element exit stagger is a common gap in generated code.
