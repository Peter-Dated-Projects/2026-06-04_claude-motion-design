---
id: file-management-reuse-research
root: research
type: research
status: current
summary: "Research: how to extend remotion-skills.txt and the project model to support shared component libraries and code reuse across animations -- covering file structure, prompt conventions, component library surface, and esbuild-sandbox constraints."
created: 2026-06-05
updated: 2026-06-05
---

# Claude skills for file management and code reuse across Remotion animations

RESEARCH / DESIGN PROPOSAL (T-059). Read alongside the companion technical proposal
in `research/multi-file-architecture.md`, which covers the esbuild-wasm bundle-mode
spike and the Rust/frontend wiring changes required to make relative imports work.
This document focuses on the *prompt and skill* layer: what to teach Claude, how to
structure shared code so Claude reliably reuses it, and what a component library for
vertical-video motion graphics should look like.

---

## TL;DR

- A shared module layer (`theme.ts`, `motion.ts`, `components/`) is the natural
  next step once the multi-file compiler lands (see `multi-file-architecture.md`).
- The single biggest prompt lever is exposing the **public API surface** of shared
  modules directly in the system prompt -- not just a file tree, but a short type
  signature or JSDoc comment per exported symbol. Without that, Claude reinvents
  inline rather than importing.
- The Onda open-source library defines a clean vocabulary for the component
  categories we actually need: entrances, graphics overlays, data visualization,
  scene blocks, and atmosphere. Use their category taxonomy but build our own
  implementations matching the existing `remotion-skills.txt` palette and motion
  tokens.
- Single-file simplicity is a real, ongoing value. Multi-file reuse is most worth
  the complexity for cross-animation design tokens and a handful of scene-block
  components; individual animation logic should stay local.

---

## 1. How LLM-driven code reuse works in AI coding tools

### What Cursor and Copilot do

Both tools face the same problem: a codebase is much larger than a context window,
so they must decide what to include.

- **Cursor** uses explicit `@-mentions` to pull files into context, plus auto-import
  of "open tabs" and an indexed project graph for retrieval. The user opts in by
  mentioning files; the model does not auto-discover them.
- **GitHub Copilot** defaults to the current file only, optionally expanding to
  workspace context on request. Reliable reuse requires the user to mention the
  target file or the completion to be context-adjacent.
- **Devin / Claude Projects** with repo ingestion: the whole repo is loaded, but
  relevance degrades for large codebases. The model's recall of a specific export
  buried in a file it saw once is unreliable.

The common finding: **LLMs import reliably from existing files only when the target
module's API surface is explicitly in the prompt or context window** at call time.
Adjacency (the file is "near" the current file in the editor) helps. A bare file
tree listing does not -- the model sees file names but not what is exported, so it
writes inline rather than guessing what the import provides.

### The CLAUDE.md / skills-prompt convention

The AI-coding community has converged on putting concise API inventories into the
system prompt / CLAUDE.md. Addy Osmani's workflow explicitly recommends bundling
"all information the AI needs" -- relevant code modules, type signatures, known
constraints -- before asking for a new feature. The pattern in `remotion-skills.txt`
(sections 4-8 give a full type-system-level spec of palettes, presets, and
templates) is already practicing this correctly for the single-file case. Extending
it to shared modules means adding a parallel section listing their exports.

---

## 2. Recommended project file structure

Extending the existing `multi-file-architecture.md` recommendation (flat project
root, `animation.tsx` entry point, relative imports only):

```
project-slug/
  animation.tsx          <- entry point; root composition; default export
  theme.ts               <- design tokens (colors, font stacks, spacing scale)
  motion.ts              <- spring/interpolate presets as named constants
  components/
    AnimatedWord.tsx      <- kinetic staggered word (word-by-word entrance)
    StatCounter.tsx       <- big number that counts up + scale with label
    LowerThird.tsx        <- name/title bar; slides in, safe-zone-aware
    GradientBg.tsx        <- ambient background (drifting radial blobs)
    ProgressBar.tsx       <- horizontal bar fills to a value
    QuoteCard.tsx         <- giant glyph + body + attribution
  assets/                <- project images (Tauri add_asset writes here)
  project.json           <- project metadata (not source; excluded from fileMap)
```

Conventions Claude must follow:
- Import only with relative paths (`./theme`, `../components/LowerThird`).
- `animation.tsx` is the only file with a `default export`; component files export
  named components only.
- Never import third-party npm packages; only `react`, `remotion`, `@remotion/player`
  are allowed as bare imports (the compiler enforces this with a hard error).
- The entry point is also the only place `fps` and `durationInFrames` are exported.

Why flat-root vs `src/` subdir: the existing `multi-file-architecture.md` analysis
recommends flat-root as the lower-friction first step. This document follows that.
If sources move to `src/` later, only the import paths change in the prompt, not
the structural principles below.

---

## 3. Prompt conventions for reliable import-based reuse

The three things that reliably make Claude import from an existing file rather than
rewrite inline:

### 3a. Expose type signatures in the system prompt

Do not just list filenames. For every export in `theme.ts` and `motion.ts`, include
its name and type in the skills prompt:

```
Shared modules in this project (import with relative paths):

theme.ts exports:
  const P: { bg, surface, accent, accentSoft, ink, muted }  // Midnight Pop tokens
  const DISPLAY: string   // Bold Impact font stack
  const BODY: string      // Neutral Modern font stack
  const SP: number        // spacing base (8px)

motion.ts exports:
  const SNAPPY: SpringConfig    // { mass:1, damping:18, stiffness:200 }
  const SMOOTH_SETTLE: SpringConfig
  const EMPHASIS_POP: SpringConfig
  const HEAVY_DROP: SpringConfig
  const QUICK_TICK: SpringConfig
  function fadeIn(frame: number, start: number, dur: number): number
  function softExit(frame: number, durationInFrames: number): { opacity, y }
  function gentleFloat(frame: number, fps: number): number

components/ exports (import from e.g. './components/AnimatedWord'):
  AnimatedWord  -- props: { word, frame, fps, delay?, color?, fontSize? }
  StatCounter   -- props: { value, label, frame, fps, delay? }
  LowerThird    -- props: { name, title, frame, fps }
  GradientBg    -- props: { frame, color? }
  ProgressBar   -- props: { value, frame, fps, delay? }  // value 0..1
  QuoteCard     -- props: { quote, attribution, frame, fps }
```

This section belongs in the system prompt (between the runtime contract and safe
zones), not just as a comment in a file Claude might not read before writing.

### 3b. Prefer-existing rule

Add an explicit instruction: "Before writing an animation or helper inline, check
the components/ inventory above. If an existing component fits, import it; do not
reimplement the same shape with different variable names." This is the most
effective single sentence for import-over-inline behavior. LLMs default to inline
when they are uncertain; the explicit rule shifts the prior.

### 3c. Convention-first for shared files

Tell Claude it is the author of shared modules too -- when it creates a reusable
piece it should use `Edit` to add it to the right shared file and import it from
there in the animation. Without this, it will write the helper locally and never
add it to the library. The prompt phrasing: "If you create a new reusable
component, add it to components/ as a named export; if you create a new spring
config, add it to motion.ts. Then import it from animation.tsx."

### 3d. File-inventory context injection (Phase 3+ feature)

Once Phase 2 of `multi-file-architecture.md` lands (the Rust watcher emits a file
map), the frontend can inject a live file tree listing into every terminal session
via the MCP skills prompt materialized by `claude_bridge.rs`. The base system
prompt gives the fixed API surface; the dynamic listing confirms which files
actually exist in this project. This is the same pattern Cursor uses (auto-include
open files) but scoped to what the compiler can actually resolve.

---

## 4. Proposed component library surface

Derived from studying Onda (70 components across 8 categories), Remotion Kit, and
the existing `remotion-skills.txt` templates. The principle is to match the
template vocabulary already in section 8 of the skills file -- components are
pre-baked template instances with sensible defaults and overridable props.

### Atomic units

Each component is self-contained: it reads `useCurrentFrame` / `useVideoConfig`
internally and takes a `frame`/`fps` prop for stagger-offset control. The caller
wraps it in a `<Sequence from={offset}>` to control scene timing; the component
handles its own entrance/hold/exit relative to its local frame 0.

| Component | What it renders | Key props | Template it implements |
|---|---|---|---|
| `AnimatedWord` | One word with snappy-entrance spring + soft-exit | `word`, `delay`, `color`, `fontSize`, `preset` | T1 kinetic staggered headline (one word slot) |
| `StatCounter` | Big number that counts up (interpolate 0->value) + scale spring, label beneath | `value`, `label`, `prefix`, `suffix` | T2 big-number reveal |
| `LowerThird` | Name + title bar; bar slides left, text fades | `name`, `title`, `barColor` | T3 lower-third caption bar |
| `TitleCard` | Kicker + title + subtitle, staggered soft entrance | `kicker`, `title`, `subtitle` | T4 title card |
| `ListBuild` | 3-5 items appearing one at a time, stagger 6f | `items: string[]` | T5 animated list build |
| `QuoteCard` | Giant glyph + body + attribution, serif-optional | `quote`, `attribution` | T6 quote card |
| `ProgressBar` | Horizontal bar from 0 to value, spring fill | `value` (0..1), `label`, `color` | T9 progress motif |
| `GradientBg` | Ambient drifting radial blobs, parameterized by palette | `color` (accent hex), `speed` | T10 ambient background |

### Utility modules

`theme.ts` -- design token exports that mirror the 6 palettes in section 4 of
`remotion-skills.txt`. The Midnight Pop tokens are the default export; others are
named (P2, P3, ... P6). Font stacks are also named strings so components do not
hardcode them.

`motion.ts` -- named spring configs (the 5 presets from section 7 of the skills
file as typed constants), plus three utility functions:
- `fadeIn(frame, startFrame, dur)` -- the standard eased opacity ramp
- `softExit({ frame, durationInFrames })` -- returns `{ opacity, translateY }` for
  the standard 14-frame accelerating exit
- `gentleFloat(frame, fps)` -- the sine-based hold animation

These three functions appear in every animation; factoring them eliminates copy/paste
of the same 3-line interpolate call in every file.

### What NOT to put in shared components

- Animation-specific layout (the exact `x`, `y`, and surrounding elements that make
  an animation unique) -- this stays in `animation.tsx`.
- One-off spring configs tuned to a specific moment -- keep inline unless reused
  across 3+ animations.
- Any logic that references `durationInFrames` directly (that belongs in the entry
  point via `useVideoConfig`).

---

## 5. Exposing shared utilities in the system prompt

The practical structure is a new section in `remotion-skills.txt` (or a separate
`remotion-components.txt` materialized alongside it by `claude_bridge.rs`):

```
================================================================
X. SHARED MODULES (import with relative paths only)
================================================================
These files exist in every project. ALWAYS import from them instead of
rewriting inline. Use Edit to ADD new exports when you create reusable pieces.

Import: import { P, DISPLAY, BODY } from './theme';
  P.bg, P.accent, P.ink, P.muted, P.surface, P.accentSoft  (Midnight Pop defaults)
  DISPLAY = '"Helvetica Neue", Helvetica, Arial, sans-serif'
  BODY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

Import: import { SNAPPY, SMOOTH_SETTLE, fadeIn, softExit, gentleFloat } from './motion';
  SNAPPY = { mass:1, damping:18, stiffness:200 }
  SMOOTH_SETTLE = { mass:1, damping:22, stiffness:120 }
  EMPHASIS_POP = { mass:1, damping:14, stiffness:260 }
  fadeIn(frame, start, dur) -> opacity 0..1 with ease-out-cubic
  softExit({ frame, durationInFrames }) -> { opacity, translateY } for 14f exit
  gentleFloat(frame, fps) -> translateY offset for hold-phase float

Import components: import { AnimatedWord } from './components/AnimatedWord';
  AnimatedWord -- props: word, frame, fps, delay?, color?, fontSize?
  StatCounter  -- props: value, label, frame, fps, prefix?, suffix?, delay?
  LowerThird   -- props: name, title, frame, fps, barColor?
  GradientBg   -- props: frame, fps, color?
  ProgressBar  -- props: value (0..1), frame, fps, label?, color?, delay?
  QuoteCard    -- props: quote, attribution, frame, fps
  ListBuild    -- props: items: string[], frame, fps
  TitleCard    -- props: kicker, title, subtitle?, frame, fps

PREFER-EXISTING RULE: check this list before writing any animation primitive inline.
If a component matches, import it. Only write inline if no component fits.
```

This section lives between the runtime contract (section 1) and safe zones (section
2), so it is in context before Claude touches any code.

### Dynamic injection of the actual file tree

The above is the static API surface. The `claude_bridge.rs` skills materialization
can also inject a dynamic section listing which component files actually exist in
the current project -- formatted as a short `ls`-style listing. This handles the
case where Claude has added a new component during a session: the next prompt turn
sees the new file. Implementation: read the `components/` directory at session
start and append the file list to the materialized skills prompt.

---

## 6. Open-source Remotion component libraries -- what to study

### Onda (github.com/degueba/onda)

The most comprehensive reference. 70 components across 8 categories (Entrances,
Interface, Graphics, Data, Scenes, Atmosphere, Cinematic, Media) plus 18 transitions.
The design principle is a "shared motion vocabulary" across all components: one
spring config (SPRING_SMOOTH), one STAGGER constant (4f), one opacity easing curve
(HOUSE_EASE). This is exactly the pattern `remotion-skills.txt` already encodes in
sections 7-8 -- Onda confirms the approach is right.

Key takeaway: Onda ships components as **source you own** (copy-paste via CLI), not
as runtime npm dependencies. This matches the esbuild-sandbox constraint perfectly:
since we cannot install npm packages at runtime, any component library must be
inlined source. The Onda copy-paste model is the right one.

Component categories most relevant to ClaudeMotion vertical video:
- Scenes (title cards, lower thirds, stat cards, quote cards): these are our T1-T7
  templates as reusable React components.
- Data (counters, bars, progress): T2 and T9.
- Atmosphere (mesh gradients, grain overlays): T10 ambient background.
- Entrances (fade, slide, scale, word-stagger): the word-by-word entrance is the
  workhorse we already have in the exemplar.

Categories less relevant for now: Interface (code/terminal/browser mockups), Media
(audio visualizer, video clips -- both blocked by our no-external-assets constraint).

### Remotion Kit (github.com/seblavoie/remotion-kit)

Lighter: AnimatedElement (wrapper that applies entrance/exit presets), AnimatedText
(word-level and letter-level stagger), and a preset object (fadeIn, fadeOut,
scaleIn, etc.). The `combine` utility merges multiple animation configs. Useful
reference for the `motion.ts` utility design.

### RemoCN / remocn

A shadcn/ui-style copy-paste model for Remotion components with a focus on
cinematic effects and smooth animations. Less vertical-video specific but confirms
the copy-paste-owned-source pattern.

---

## 7. Tradeoffs: single-file simplicity vs. multi-file reuse

| Axis | Single-file | Multi-file with shared modules |
|---|---|---|
| Compiler complexity | esbuild transform (current, works) | esbuild bundle + virtual-FS plugin (see `multi-file-architecture.md` Phase 1) |
| Claude's reliability | High -- no import ambiguity, one file context | Requires explicit API surface in prompt (see section 3); risk of Claude writing inline instead of importing |
| Cross-animation consistency | Zero -- each animation reinvents palette and presets | High -- `theme.ts` and `motion.ts` are the single source of truth for tokens |
| Prompt size | Smaller -- no shared-module section needed | Larger -- API surface adds ~40-60 tokens; manageable |
| Editor UX | Simple -- one tab, one file | Requires file tree navigator (Phase 4 of `multi-file-architecture.md`) |
| First-run / onboarding | Works immediately | Requires shared files to be scaffolded at project creation; empty `components/` dir is fine |
| Copy/paste portability | `animation.tsx` is self-contained | Exported `.tsx` must include `theme.ts`, `motion.ts`, `components/` -- export.rs change |

Recommendation: ship `theme.ts` and `motion.ts` first (they are pure utility, zero
UI change, and the compiler already handles the multi-file wiring once Phase 1-2 of
`multi-file-architecture.md` land). Components/ follows once the file-tree navigator
(Phase 4) makes them visible to the user. The big value from shared modules is
design-token consistency across animations -- `theme.ts` and `motion.ts` alone
deliver 80% of that value with the smallest surface area.

The "prefer-existing" prompt rule (section 3b) is the highest-leverage, lowest-cost
win: it changes only the skills text and can be added the moment the multi-file
compiler is live.

---

## 8. esbuild-WASM sandbox: import constraints (summary)

This section summarizes the constraints from `multi-file-architecture.md` as they
apply to component library design.

- The current compiler is **transform-mode** (`esbuild.transform`). Relative imports
  DO NOT work today. All shared-module design is contingent on Phase 1 of
  `multi-file-architecture.md` landing (switch to `esbuild.build` + virtual-FS plugin).
- Once bundle mode lands, the constraint is: **bare imports are limited to `react`,
  `react-dom`, `remotion`, `@remotion/player`**. Everything else must be a relative
  import to a file in the project's source tree.
- This means: no lodash, no date-fns, no external animation libraries. Shared
  utilities must be authored as `.ts`/`.tsx` in the project and imported relatively.
  This is why the component library must be copy-paste-source (Onda model) rather
  than an npm package.
- Dynamic imports (`import()`) and `require()` are not available in the sandbox.
  All imports are static and resolved at bundle time.
- Circular imports will cause the virtual-FS resolver to hang or produce an empty
  output. Convention: `animation.tsx` imports from components; components import
  from `theme.ts` / `motion.ts` only; `theme.ts` and `motion.ts` have no internal
  cross-imports. This creates a clean DAG with no cycles.

---

## Next steps (not committed decisions)

1. Land `multi-file-architecture.md` Phases 1-3 (compiler, watcher, prompt). This
   is the blocker for everything else.
2. Add `theme.ts` and `motion.ts` to the project scaffold in `create_project` (or
   materialized by `claude_bridge.rs` alongside `animation.tsx` on first load).
3. Add the SHARED MODULES section to `remotion-skills.txt` (section 5 above) in
   lockstep with Phase 3 of the architecture plan.
4. Build `GradientBg` and `AnimatedWord` first (they appear in every animation and
   directly match existing exemplar code -- lowest risk to verify the pattern).
5. Only after step 4 is validated: add `StatCounter`, `LowerThird`, `ProgressBar`.
6. File tree navigator (Phase 4 architecture) to make components visible to the
   user.
