---
id: phase-prompts-defer-to-main-for-canonical-defs
root: conventions
type: convention
status: current
summary: "Phase-specific skill prompts (remotion-skills-motion.txt etc.) must NOT redefine concepts the main remotion-skills.txt owns (e.g. the five named spring presets); they reference the canonical names and defer all definitions to the main file -- duplicating a table there reintroduces conflicting values."
created: 2026-06-07
updated: 2026-06-07
---

The skills prompt system is layered: `remotion-skills.txt` is the canonical
source for shared design vocabulary, and the phase prompts
(`remotion-skills-motion.txt`, `remotion-skills-layout.txt`,
`remotion-image-skills.txt`) add phase-specific guidance on top. These are all
concatenated into the single system prompt the model reads (see
[[cli-system-prompt-single-file]]), so the model sees every layer at once.

Convention: a phase prompt must NOT redefine a concept the main file already
owns. It references the canonical name and defers the definition. Concrete
instance (T-011 / F2): the motion prompt used to define its own four spring
presets (SNAPPY/SMOOTH/BOUNCY/GENTLE) with mass/damping/stiffness numbers that
collided with the main file's five canonical presets (snappy-entrance,
smooth-settle, emphasis-pop, heavy-drop, quick-tick) -- same label "SNAPPY", a
different feel. Because both tables land in the same prompt, the model saw two
competing definitions for one concept. The fix removed the table and replaced
it with a one-line "use the presets from the main skills file; do not define
new configs," and made the intent->preset mapping use the canonical names,
mirroring the main file's mapping verbatim.

Why it matters: if you later "helpfully" re-add a local preset/palette/easing
table to a phase prompt for convenience, you reintroduce the conflict. Keep
canonical definitions in exactly one place (the main file) and reference them
by name everywhere else. When the main file's preset names change, the phase
prompts only need their name references updated, not numbers.
