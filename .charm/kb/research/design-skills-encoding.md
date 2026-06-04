# Encoding Design Quality into the Skills File / System Prompt

Research for T-039. This is the **technique** layer: how to STRUCTURE the
model-facing skills file so a code-generating Claude reliably produces
good-looking motion graphics. It does not produce the design content itself --
that lives in the three sibling research notes, which this blueprint consumes by
reference:

- `design-motion-principles.md` (T-036) -- named motion presets (spring configs, timings, choreography)
- `design-visual-system.md` (T-037) -- type scale, font stacks, color palettes, spacing tokens
- `design-templates.md` (T-038) -- named reusable templates with TSX skeletons

It builds on `prompt-engineering.md` (T-009), which already settled
output format (single `<code>`/on-disk file), context-passing (rolling current
file), selection annotation, and the retry loop. **This note does not re-derive
those.** It only addresses the open question that note left untouched: *"Make it
look good" fails -- how do we make the prompt make it look good?*

Current state of the file being redesigned:
`src-tauri/resources/remotion-skills.txt` is ~30 lines. It nails the runtime
contract (Remotion primitives, fps/duration exports, safe zones, import
allowlist) but says nothing prescriptive about aesthetics. There is no palette,
no motion preset, no template, no anti-pattern list, no self-check. The model is
left to invent design from scratch on every generation, which means it regresses
to the bland average of its training data.

---

## 1. Thesis: prescriptive beats descriptive for aesthetic code-gen

The single most important finding: **an LLM asked to "make it look good"
produces the statistical average of its training data, which is mediocre.** The
fix is not a better adjective ("make it look *premium*") -- it is removing the
choice. You raise the floor by narrowing the output space to a curated set of
good options and forcing a pick.

Three mechanisms explain why this works, each with grounding:

1. **Constraint as quality lever.** Reynolds & McDonell ("Prompt Programming for
   Large Language Models," 2021) show that prompt *framing* -- the structure of
   the task and the space of allowed completions -- dominates outcome quality far
   more than instruction verbosity. A model choosing from five named palettes
   cannot pick mud-brown-on-grey; a model told "choose good colors" frequently
   does. Constraint eliminates the bad tail.

2. **Examples carry more signal than rules.** Few-shot prompting (Brown et al.,
   "Language Models are Few-Shot Learners," 2020; Anthropic's "Use examples /
   multishot prompting" guidance) consistently beats equivalent prose
   instructions. One concrete, polished TSX exemplar teaches spacing rhythm,
   color usage, and motion timing simultaneously and implicitly -- things that
   are tedious and lossy to spell out as rules. Show, then tell.

3. **Self-critique before commit catches the obvious misses.** Self-Refine
   (Madaan et al., 2023) and chain-of-thought (Wei et al., 2022) show models can
   meaningfully improve their own output when given an explicit rubric to check
   against before finalizing. A short pre-finish design checklist converts
   "looks fine to the model" into "passes these N concrete gates."

**Corollary -- opinionated defaults.** Every degree of freedom you do not pin
down is a coin flip the model loses more often than it wins. The skills file
should ship a *default* palette, a *default* font stack, a *default* motion
preset, and a *default* template, so that even a one-word prompt ("animate
FINKS") lands on a coherent, deliberate-looking result. Deviation should be
opt-in by the user's request, not the model's whim.

---

## 2. The techniques, with how each applies here

### 2.1 Constrain to a menu (the core move)

Do not describe a good palette -- enumerate five and tell the model to pick one.
Same for fonts, motion presets, templates. The sibling research outputs ARE these
menus; the skills file's job is to present them as closed sets with a forcing
instruction:

> Pick exactly one palette from the list below. Do not invent colors outside the
> chosen palette's roles.

Why closed sets: an open instruction ("use a cohesive palette") leaves the model
to generate hex values, and it will reach for `#333`/`#666`/`#0066cc` defaults.
A closed set of pre-balanced, contrast-checked palettes removes that failure mode
entirely. The same logic covers motion (pick a named preset, don't hand-tune
spring numbers) and structure (start from a named template, don't lay out from
zero).

### 2.2 Few-shot exemplars (1-2, complete and polished)

Include at least one COMPLETE, compiling, genuinely good `animation.tsx` in the
skills file as a worked exemplar -- not a fragment. It anchors:
- file shape and the fps/duration export idiom
- how a palette's roles map onto actual styles
- staggered-entrance timing that reads professional
- safe-zone-respecting layout

Keep exemplars to 1-2. More than that burns token budget for diminishing return
and risks the model pattern-matching too hard onto one example's specific look
(mode collapse onto the exemplar). The exemplar should use the *default* palette
and the *default* template so it doubles as the "what good looks like" anchor for
the defaults in 2.1.

Source: multishot prompting is Anthropic's single highest-leverage documented
technique for steering output quality and consistency; the GPT-3 paper
established the few-shot scaling result generally.

### 2.3 Explicit anti-patterns / "never do" list

Negative constraints are disproportionately effective because they target the
*specific* bad behaviors the base model gravitates toward. Each sibling note
already produces an anti-pattern list (muddy palettes, >2 fonts, linear easing,
everything-animates-at-once, text in unsafe zones). The skills file should carry
a consolidated, deduplicated "NEVER" block. Phrase each as an imperative
prohibition paired with the correction, because a bare "don't" leaves the model
guessing the alternative:

> NEVER animate every element on the same frame. Stagger entrances by 3-5 frames
> per element (see motion presets).

> NEVER use pure linear `interpolate` for entrances -- it looks robotic. Use a
> spring or an eased curve.

A "never" list is cheap in tokens and high in yield: it patches the exact
failure modes observed, rather than re-teaching all of good design.

### 2.4 Pre-finish self-check rubric

Add a short checklist the model runs against its own output before declaring
done. Keep it to ~6-8 binary, concrete gates -- not vague quality questions.
Example shape:

> Before finishing, verify ALL of the following. If any fails, fix it before you
> stop:
> - [ ] All text and key visuals inside the safe zone (x 30-920, y 140-1550)?
> - [ ] Exactly one palette used; text/background contrast clearly legible?
> - [ ] At most two font sizes/weights doing the hierarchy work?
> - [ ] Entrances staggered, not simultaneous?
> - [ ] No linear easing on entrances/exits?
> - [ ] A clear focal element that enters first / largest?
> - [ ] fps/durationInFrames exports present and sane for the clip's pacing?

This is the cheapest large quality win available: it costs a few dozen tokens and
converts implicit standards into an explicit gate the model is good at applying
to concrete artifacts. Ground: Self-Refine (Madaan et al., 2023).

### 2.5 Opinionated defaults

Spell out a single default for every axis so a bare prompt still looks
deliberate:

> Default look (use unless the request implies otherwise): palette "Midnight",
> font stack "Grotesk", template "Kinetic Headline", motion preset
> "snappy-entrance" + "smooth-settle".

Defaults also reduce decision latency and variance across regenerations -- the
same prompt yields a consistent house style instead of a different random look
each time.

### 2.6 Dosage -- how much detail helps vs hurts

More prescription is not monotonically better. Past a point, a bloated skills
file (a) crowds the context the model uses for the actual request, (b) dilutes
the high-signal rules among low-signal ones, and (c) inflates per-call token cost
(though caching mitigates the cost axis -- see section 4).

Calibration guidance:
- **Menus: as long as needed but flat.** Five palettes is fine; the model reads
  them as a lookup table, not prose to internalize.
- **Rules: ruthless.** Every rule should patch an observed failure mode. If you
  cannot name the bad output a rule prevents, cut it.
- **Exemplars: 1-2, no more.**
- **Prefer one strong default over a long decision tree.** "Use X unless the user
  asks otherwise" beats three paragraphs on when to use X vs Y vs Z.

Rule of thumb: the skills file should read like an opinionated style guide a
senior designer hands a junior, not like a design textbook.

---

## 3. Recommended section-by-section structure for the rewritten `remotion-skills.txt`

Ordering principle: **contract first (must-obey), then defaults, then menus, then
the self-check last** (so it is the freshest thing in context right before the
model finalizes). Approximate token budgets are rough targets to keep the whole
file in a sane range (~2,000-3,000 tokens of skills content, excluding the
exemplar).

| # | Section | Prescriptiveness | ~Tokens | Notes |
|---|---|---|---|---|
| 1 | **Role + runtime contract** | Absolute (MUST) | ~250 | Keep the current file's substance: you own animation.tsx, edit on disk, no code in chat, Remotion primitives only, fps/duration exports, import allowlist, 1080x1920 fixed. This is non-negotiable plumbing -- already correct, don't dilute it. |
| 2 | **Safe zones** | Absolute (MUST) | ~150 | Keep current safe-zone block. It is a hard constraint, not a taste call -- belongs with the contract. |
| 3 | **Default look** | Directive default | ~80 | The one-line "use these unless the request implies otherwise" defaults (palette/font/template/motion preset). Placed early so it frames everything below. |
| 4 | **Color palettes** (from `design-visual-system.md`) | Menu, pick one | ~400 | 5-6 named palettes with role->hex. "Pick exactly one. Do not introduce colors outside its roles." |
| 5 | **Type + font stacks** (from `design-visual-system.md`) | Menu + scale | ~300 | Named font stacks + the px type scale (display/headline/body/caption) + hierarchy rule (<=2 weights doing the work). |
| 6 | **Spacing + layout** (from `design-visual-system.md`) | Tokens + rule | ~200 | Spacing scale, focus-zone placement, the simple grid. |
| 7 | **Motion presets** (from `design-motion-principles.md`) | Menu, pick by name | ~450 | Named presets as exact spring/interpolate configs + the stagger/enter-hold-exit timing budget for a 3-5s clip. "Reference presets by name; don't hand-tune unless asked." |
| 8 | **Templates** (from `design-templates.md`) | Menu, start from one | ~350 | Names + one-line "when to use" each + a pointer to the skeleton idiom. Full skeletons may live on-demand rather than always-on (see section 4). |
| 9 | **The exemplar** | Show-don't-tell | ~600 (separate) | 1 complete, polished animation.tsx using the defaults. Budgeted separately because it's large; consider gating behind first-generation only. |
| 10 | **Anti-patterns (NEVER list)** | Prohibitive | ~250 | Consolidated, deduped from the three sibling lists. Each as "NEVER X -- do Y instead." |
| 11 | **Pre-finish self-check** | Gate | ~150 | The ~6-8 binary checklist from 2.4. LAST, so it's freshest before the model stops. |

The three content sections (4-8) are filled directly from the sibling research
outputs; this ticket only fixes their *shape, order, and framing*. Sections 1-2
are preserved from today's file. Sections 3, 9, 10, 11 are net-new structural
additions and are where most of the quality lift comes from.

---

## 4. Token budget and placement: system prompt vs skills file vs on-demand

There are three tiers, distinguished by how often the content changes and how
universally it applies:

**Tier 1 -- System prompt (constant, cached, always-on).** The role, runtime
contract, safe zones, default look, the NEVER list, and the self-check. These
apply to *every* generation and *every* edit, never change within a session, and
are exactly what prompt caching is for. `prompt-engineering.md` section 8 already
recommends `cache_control` on the system block; that makes always-on prescription
nearly free after the first call. This tier is where the skills file content
predominantly belongs.

**Tier 2 -- Skills file body (the menus).** Palettes, type/spacing, motion
presets, template index. Stable across the session, so also cacheable. Whether
this is literally a separate file or concatenated into the system prompt is an
implementation detail; what matters is it shares the cached prefix and sits
*before* the per-turn `<current_code>`/`<user_request>`.

**Tier 3 -- On-demand (fetched only when relevant).** Full template TSX
skeletons (8-12 of them at ~600 tokens each = too heavy to keep always-on). Two
viable strategies:
- **Index always-on, bodies on-demand.** Keep the template *names + when-to-use*
  in Tier 2; inject the full skeleton for a specific template only when the
  request maps to it. Needs light routing logic in the app.
- **Always-on, accept the cost.** If caching makes the prefix cheap enough,
  inline a trimmed subset (3-4 most common templates). Simpler; start here, move
  to on-demand only if budget bites.

Recommendation: start with everything inlined and cached (simplest, and caching
likely makes it cheap), instrument token cost, and only split templates to
on-demand if the cached prefix grows past a few thousand tokens. Premature
splitting adds routing complexity for a cost the cache may already absorb.

### Phrasing rules (so the rules are actually followed)

These apply to every line of prescriptive content:

- **Imperative, not descriptive.** "Stagger entrances by 3-5 frames" not "good
  animations often stagger their entrances."
- **Concrete numbers, not adjectives.** "damping: 12, stiffness: 100" not "a
  gentle spring." "fontSize 96, weight 800" not "large bold text."
- **Defaults, not menus, when one good answer exists.** "Use the Midnight
  palette" beats "consider one of these palettes" when you want a reliable
  baseline. Reserve open menus for axes where variety genuinely matters.
- **Pair every prohibition with the fix.** "NEVER use linear easing -- use a
  spring or eased curve."
- **Name things so they're referenceable.** Named presets/palettes/templates let
  the user and the model speak the same language ("make it use snappy-entrance")
  and let edits be precise.
- **Put hard constraints in the imperative MUST/NEVER register; put taste in the
  default/menu register.** Don't blur the two -- the model should know which
  lines are inviolable (safe zones, imports) and which are defaults it may
  override on request.

---

## 5. Worked before/after

**Before (representative of today's file -- there is no aesthetic guidance at
all, so this is the implicit instruction):**

> Make the animation look good. Use nice colors and smooth motion.

Result: model picks `#000` background, `#fff` text, a single `spring()` with
default config on one element that fades in, system sans-serif at some arbitrary
size. Technically correct, compiles, looks like a developer's placeholder.

**After (prescriptive, menu + default + concrete numbers):**

> Use the **Midnight** palette unless the request implies another mood:
> background `#0B0E14`, surface `#161B26`, ink `#F2F4F8`, accent `#5B8CFF`,
> accent-soft `#2D3A5C`, muted `#8A93A6`.
>
> Headline: font stack "Grotesk"
> (`'Inter Tight', 'Helvetica Neue', Arial, sans-serif`), fontSize 96, weight
> 800, letterSpacing -0.02em. Body: fontSize 40, weight 500, color muted.
>
> Entrance: apply the **snappy-entrance** preset --
> `spring({ frame, fps, config: { mass: 0.6, damping: 14, stiffness: 220 } })` on
> scale and a 0->1 opacity over frames 0-8. Stagger multiple elements by 4 frames
> each. Settle, hold, then **soft-exit** (opacity 1->0 over the last 10 frames).
>
> Layout: headline centered in the focus zone (x 150-930, y 300-1420), baseline
> ~y 700; supporting text 60px below it.

Result: a deliberate dark editorial look with a blue accent, real type
hierarchy, staggered physics-based motion with a considered exit -- recognizably
"designed" rather than defaulted. The lift comes entirely from removing choices
and supplying concrete numbers; the model's raw capability is identical in both
cases.

(Exact tokens above are illustrative -- the real values come from the sibling
research outputs once those land.)

---

## 6. Handoff to the implementation ticket

This note is a blueprint, not the rewrite. The later implementation ticket
should:

1. Wait for / consume the three sibling outputs (`design-motion-principles.md`,
   `design-visual-system.md`, `design-templates.md`). This structure assumes
   those menus exist; it does not invent their content.
2. Rewrite `src-tauri/resources/remotion-skills.txt` to the section order in
   section 3, preserving sections 1-2 (contract + safe zones) verbatim in
   substance.
3. Decide the Tier-3 split (section 4): start inlined + cached, measure, split
   templates to on-demand only if the cached prefix gets heavy.
4. Confirm prompt caching is applied to the now-larger system/skills prefix
   (`prompt-engineering.md` section 8) -- otherwise the always-on prescription
   gets expensive per call.
5. Validate empirically: run the same handful of prompts against old vs new
   skills file and eyeball the quality delta. The self-check (section 2.4) and
   the NEVER list (section 2.3) are the two additions most worth A/B-confirming,
   since they are the cheapest and claimed-highest-yield.

### Open questions

- **Self-check enforcement.** The model runs the checklist in its own reasoning,
  but nothing *forces* a fix. Worth considering whether the app's existing
  render-probe/retry loop (`prompt-engineering.md` section 5) could mechanically
  check a subset (safe-zone bounds, presence of fps export) and bounce failures,
  rather than trusting self-report alone.
- **Exemplar count vs mode collapse.** One exemplar anchors the default look but
  risks the model over-imitating its specific composition. Two diverse exemplars
  hedge that but cost tokens and may muddy the default. Decide during
  implementation by testing for over-imitation.
- **Edit-time vs generate-time prescription.** This blueprint is framed for
  first-generation. During an edit (`<current_code>` present), the heavy menus
  may be redundant -- the look is already established. Possible optimization: a
  lighter skills payload on edit turns. Out of scope here; flagged for the
  implementation ticket.

---

## Sources

- Anthropic, Prompt Engineering documentation (docs.anthropic.com): "Use examples
  (multishot prompting)", "Be clear and direct", "Let Claude think (chain of
  thought)", "Giving Claude a role / system prompts", "Prompt caching".
- Brown et al., 2020, "Language Models are Few-Shot Learners" (GPT-3) -- few-shot
  beats zero-shot for steering output.
- Reynolds & McDonell, 2021, "Prompt Programming for Large Language Models:
  Beyond the Few-Shot Paradigm" -- framing/constraint dominates instruction
  verbosity.
- Wei et al., 2022, "Chain-of-Thought Prompting Elicits Reasoning in Large
  Language Models."
- Madaan et al., 2023, "Self-Refine: Iterative Refinement with Self-Feedback" --
  basis for the pre-finish self-check.
- W3C Design Tokens Community Group -- the design-token-as-named-value pattern
  underlying the "pick from a menu" framing.
- Sibling research in this directory: `design-motion-principles.md`,
  `design-visual-system.md`, `design-templates.md`; and `prompt-engineering.md`
  (output format, context-passing, retry loop, caching) which this note extends.
