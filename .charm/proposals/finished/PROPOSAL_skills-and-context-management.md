# Proposal: Skills & Context Management System for ClaudeMotion

**Status: DONE** — implemented and shipped (see commit `14c9038` "ft. skills + gifs export").

---

## Context

ClaudeMotion is a Tauri desktop app built for Finks marketers. Users describe an animation in plain language and Claude generates a Remotion TSX file that renders as a live 1080x1920 vertical video — TikTok/Reels/Shorts format. The app runs entirely locally: Claude runs via the `claude` CLI in an interactive PTY session, edits `animation.tsx` directly on disk, and a file watcher pushes changes to a sandboxed preview iframe.

The core loop is: user types → Claude writes code → preview updates. There is no intermediate parsing, no code block extraction, no structured API. Claude owns the file and the user watches it update in real time.

The system prompt (injected via `--append-system-prompt-file`) is what shapes every animation Claude produces. It is the only lever between a generic coding assistant and a specialized motion design tool.

---

## The Problem

### 1. Claude generates mediocre animations without deep motion design knowledge

Out of the box, Claude will produce animations that technically compile but look amateur: elements enter simultaneously with no stagger, motion paths are straight lines, typography has default tracking, palettes are arbitrary, there is no hold phase for reading, exits are abrupt. These are learnable rules — but Claude does not apply them without being explicitly taught.

The current `remotion-skills.txt` covers the basics (safe zones, named spring presets, 6 palettes, type scale, 10 templates). It is functional but incomplete. Key gaps:

- No emotional intent gate — Claude picks motion style arbitrarily for ambiguous prompts
- No named personality archetypes — "make it feel premium" has no mapping to spring configs
- No Disney animation principles — arcs, anticipation, follow-through, squash/stretch are absent
- No clip-path reveals — only opacity fades, which read as soft where editorial is appropriate
- No counter-motion — backgrounds never react to hero entrances
- No choreography discipline — 10 elements can all start on frame 0

The result: animations that are correct but not designed.

### 2. Claude cannot accept a visual reference

Marketers work from brand assets, screenshots, and design mockups. They want to say "make it look like this" and hand Claude an image. Claude has vision capability but no structured workflow for translating a visual reference into the CSS/SVG primitives the Remotion sandbox allows. Without guidance, Claude will either refuse ("I can't load external images") or hallucinate an implementation that tries to use `<img>` tags or `staticFile` — both blocked by the sandbox.

### 3. Claude reinvents the same code every animation

Every animation today is a self-contained `animation.tsx` with hardcoded palette tokens, hardcoded font stack strings, and inline implementations of the same three utility patterns (fade-in, soft-exit, gentle-float). As a user builds multiple animations, the design drifts: one animation uses `#4F8CFF` for accent, another uses `#5090FF`. The same spring config is written slightly differently in each file. There is no design consistency and no accumulation of reusable work.

### 4. The context Claude receives is static and one-size-fits-all

The same skills file is appended to every session regardless of what the user is doing or what files exist in the project. A session working on a list animation gets the same context as one working on a logo reveal. There is no awareness of what has already been built in the project.

---

## What We Are Solving

1. **Lift the quality floor** of every animation Claude produces, from "it compiles" to "it looks designed."
2. **Enable image-reference mode** so marketers can hand Claude a visual and get a faithful abstract recreation.
3. **Establish shared design tokens and reusable components** so animations within a project are consistent and Claude doesn't rewrite the same utilities from scratch.
4. **Make the skills context dynamic** — what Claude knows about a project should reflect what actually exists in it.

---

## Proposed Solution

### Component 1: Enhanced skills prompt

Update `remotion-skills.txt` to include the missing motion design knowledge as structured, Claude-readable reference material. This is a content change only — no code change required, ships with the next binary.

What is being added:
- **Intent gate** (Section 3): before picking any preset, Claude answers three questions — what emotion, what personality archetype (Playful/Premium/Corporate/Energetic), what narrative arc. Each archetype maps to specific spring presets and duration ranges, so a vague prompt like "make it feel premium" produces a smooth-settle, 0-overshoot, long-hold composition rather than an arbitrary one.
- **Disney principles with Remotion-specific numbers**: arcs (10-20px perpendicular offset, drive x and y with different `interpolate` ranges), anticipation (4-6f opposite displacement before entrance), squash-and-stretch (scale volume-preserving on impact), follow-through (trailing elements delay 2-3f, use calmer spring), secondary action (30-50% amplitude, starts after primary).
- **Choreography rules**: max 1/3 of elements in active motion simultaneously; no travel over 360px without an intermediate keyframe.
- **Clip-path reveals**: editorial alternative to opacity fade for Display/Headline text; directional panel wipes for Template T8.
- **Counter-motion**: ambient background moves opposite to hero entrance at 20-30% speed.
- **Shimmer/gleam**: gradient sweep across one accent element during the hold phase.
- **De-synced floating**: when 2+ elements float, use different Hz values to prevent phase-lock.
- **Surface depth/elevation**: named shadow scale for layering panels.
- **Component vocabulary** (Section 10): documents the expected API surface of `theme.ts`, `motion.ts`, and `components/` — teaching Claude the naming convention it will use once shared files exist.

Why this method: the skills file is embedded at compile time via `include_str!` and written to disk on every launch, replacing stale copies. Any update to the file ships automatically on the next app launch with no user action. Structured, scannable reference material (tables, named presets, code snippets) outperforms prose instructions for LLM behavior: Claude pattern-matches against named presets ("snappy-entrance") more reliably than against descriptive sentences.

### Component 2: Image reference skill

Create `remotion-image-skills.txt` — a standalone skill appended alongside the main prompt. Kept separate from the main file for authoring clarity; delivered by concatenating both at materialize time in `claude_bridge.rs`.

What it provides:
- A 4-step workflow: extract a structured JSON scene description from the image → review it → pass it to Claude with the sandbox constraint reminder → iterate with targeted corrections.
- A JSON schema with fractional canvas positions, hex colors, z-ordering, and per-element shape vocabulary — precise enough for code generation, forgiving enough for Claude's vision extraction accuracy.
- Five CSS/SVG recreation recipes matched to the most common image types: photograph (dominant-color gradient field), logo/wordmark (inline SVG paths + system font), UI screenshot (absolutely-positioned div rectangles), gradient/abstract background (CSS multi-stop gradients), branded slide (palette override from extracted hex codes).
- A fallback table distinguishing what can be faithfully recreated (flat geometry, wordmarks, gradients, UI cards) from what cannot (photographs, textures, custom fonts) and what abstraction to use in each fallback case.

Why this method: Claude's vision capability reliably extracts color, layout, text content, and shape vocabulary from images, but produces unreliable pixel coordinates and font names. A structured JSON intermediate separates extraction (where Claude uses vision) from code generation (where Claude uses its Remotion knowledge) and makes both steps independently correctable. The fallback table sets explicit expectations so Claude never tries to use `<img>` or `staticFile`.

Why a separate file: image reference mode is a distinct input modality, not a generation rule. Keeping it separate makes the main skills file easier to maintain and leaves room for conditional loading later (append only when the message contains an image attachment, once Tauri message inspection is in place).

### Component 3: Multi-file project support

Switch the esbuild-WASM compiler from transform mode to bundle mode with a virtual filesystem plugin, enabling relative imports (`./theme`, `./components/AnimatedWord`) to resolve at preview time.

Why this is needed: the component vocabulary documented in Section 10 of the skills file is inert until imports actually work. Without this, every animation is still a self-contained monolith and design tokens drift between projects.

What changes:
- `sandbox-compiler.worker.ts`: replace `esbuild.transform()` with `esbuild.build()` + a virtual-FS plugin that resolves bare imports to the existing React/Remotion shims and relative imports from an in-memory file map passed from the frontend.
- Frontend → worker message protocol: extend `{ code: string }` to `{ files: Record<string, string> }`.
- `file_watch.rs`: extend to watch all `.ts`/`.tsx` files, not just `animation.tsx`.
- `projectStore.ts`: on any file change, re-read the changed files and push an updated file map to the worker.
- `projects.rs create_project()`: scaffold `theme.ts` (Midnight Pop tokens, font stacks) and `motion.ts` (five named `SpringConfig` constants, `fadeIn`, `softExit`, `gentleFloat`) alongside `animation.tsx`.

Why this method: the virtual-FS approach keeps the compiler sandboxed — no filesystem access from the worker, no Tauri invoke inside esbuild resolution. The frontend owns file I/O and passes a complete snapshot to the worker on each compile. This is both simpler (no async inside the plugin) and safer (the compiler cannot read outside the project dir).

Import constraint enforcement: bare imports other than `react`, `react-dom`, `remotion`, `@remotion/player` produce a hard compile error rather than a silent failure. This surfaces the problem immediately in the preview panel rather than producing a broken animation.

### Component 4: Dynamic project context injection

At PTY session open, generate a per-session `project-context.txt` in `claude-config/` listing the source files that actually exist in the current project. Pass it as an additional `--append-system-prompt-file` argument.

Why: the component vocabulary in Section 10 tells Claude what components *could* exist. The dynamic injection tells Claude what *does* exist right now. Without it, Claude may try to import `./components/AnimatedWord` in a project where that file hasn't been created yet, producing a compile error instead of an inline implementation.

What the injected context looks like:
```
================================================================
CURRENT PROJECT FILES
================================================================
  animation.tsx      <- entry point
  theme.ts           <- P, DISPLAY, BODY
  motion.ts          <- SNAPPY, fadeIn, softExit, gentleFloat
  components/
    AnimatedWord.tsx
    GradientBg.tsx
```

This is cheap to generate (a directory read at session open) and eliminates the gap between what the static skills prompt documents and what's actually available to import.

---

### Component 5: Phased generation — layout pass then motion pass

Break animation generation into two explicit passes within the same PTY session, each constrained to a specific design concern.

**Why not 5 sequential agents**

The instinct to phase the design process is correct — real motion designers work in phases. But 5 separate autonomous agents breaks down for this use case: latency compounds (5+ full Claude sessions for a 4-second clip), context is lost between agents (each only sees the file, not the reasoning behind it), and later agents can silently undo earlier ones. Layout decisions affect motion; color decisions affect contrast on moving elements. They are not cleanly separable across independent sessions.

Two passes within the same session preserves shared context while still separating concerns.

**Pass 1 — Layout pass**

Claude establishes structure: element placement, copy, hierarchy, palette selection, typography. No animation logic. The user sees a static frame in the preview and can redirect before any motion work begins.

**Pass 2 — Motion pass**

Claude adds all animation on top of the existing structure: spring configs, stagger, Disney principles, hold behavior, exit. The layout is treated as fixed. Claude does not move elements or change copy — it only adds `transform` and `opacity` animation around what is already placed.

**The enforcement problem**

Instructions alone don't hold. Claude optimizes for "produce a good animation" and will rationalize skipping phase constraints if the user's prompt implies both — "make it snappy" suggests layout and motion simultaneously, and Claude will do both unless mechanically prevented.

Two mechanisms that actually enforce the phases:

**Structural scaffolding — constrain by what is imported, not what is instructed**

The layout-pass starter file omits all motion imports. Claude almost never reaches outside the established import pattern; if `spring`, `interpolate`, `useCurrentFrame`, and `Easing` are not in the import list, it will not call them. This is structural prevention, not an instruction to follow.

Layout-phase starter seeded into `animation.tsx` at pass start:

```tsx
import React from "react";
import { AbsoluteFill } from "remotion";
// useCurrentFrame, spring, interpolate intentionally absent — layout phase only

export const fps = 30;
export const durationInFrames = 120;

const Animation: React.FC = () => {
  // Place elements, set copy, establish hierarchy.
  // No animation code in this pass.
  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0E14" }}>
      {/* structure here */}
    </AbsoluteFill>
  );
};
export default Animation;
```

The motion-pass starter adds the motion imports back and injects a comment marking the layout as locked, signaling to Claude that the structural work is done.

**Post-compile validation — fail loudly with a specific error**

After the layout pass saves, the app scans `animation.tsx` for forbidden patterns (`useCurrentFrame`, `spring(`, `interpolate(`, `Easing`). If found, it injects an error into the terminal stream:

```
[LAYOUT PHASE] animation.tsx contains animation code.
This pass produces static JSX only.
Remove all uses of: useCurrentFrame, spring(), interpolate(), Easing
Fix this before the motion pass begins.
```

Claude treats terminal output as feedback — this is the same loop it already uses for compile errors. The error is concrete and unfakeable; Claude will fix it rather than rationalize past it.

Together: scaffolding prevents the violation in ~90% of cases; validation catches the rest and provides a clear correction signal. Neither mechanism relies on Claude following an instruction.

**What changes to build this**

- `pty_bridge.rs::open()`: extend to accept `mode: Option<String>` (`"layout"` | `"motion"` | `None`). Append a phase-specific skills file in addition to the main one when a mode is set.
- `claude_bridge.rs`: add `remotion-skills-layout.txt` and `remotion-skills-motion.txt` as embedded resources alongside the main skills file.
- `projects.rs` or frontend: when a pass is triggered, seed `animation.tsx` with the appropriate starter scaffold before opening the PTY session.
- Post-save validator: a lightweight scan of `animation.tsx` content after each file-change event. Runs in the file watcher callback (`file_watch.rs`) or in the frontend on `file-changed` events. On violation, emit the error string into the terminal stream via `terminal_input`.
- Optional review pass: a headless `claude -p` call (not interactive PTY) that reads the finished `animation.tsx`, checks it against the Section 13 self-check list, and streams results into a review panel. Bounded, read-only, can run without interrupting the user's session.

**Phase-specific skills files**

`remotion-skills-layout.txt` — appended during layout pass:
- Explicitly forbids importing or using `useCurrentFrame`, `spring`, `interpolate`, `Easing`
- Focuses Claude on palette selection, type hierarchy, safe zone compliance, element placement
- Ends with a one-item self-check: "Does animation.tsx contain zero animation imports or calls? If not, remove them."

`remotion-skills-motion.txt` — appended during motion pass:
- Opens with: "The layout in animation.tsx is locked. Do not change element positions, sizes, copy, or palette. Only add animation logic."
- Provides the full motion preset reference, Disney principles, choreography rules
- Reinforces: any structural change (moving a div, changing text, changing a color) is out of scope for this pass

---

## Delivery order

The components above are sequenced by dependency and effort:

| Phase | Component | Effort | Depends on |
|---|---|---|---|
| 1 | Enhanced skills prompt + image skill file | Done — files written | Nothing |
| 2 | Wire image skills into delivery (`claude_bridge.rs`) | Small — 1 Rust change | Phase 1 |
| 3 | Multi-file esbuild compiler | Large — compiler rewrite + watcher + store | Nothing (parallel to 2) |
| 4 | Scaffold theme.ts / motion.ts on project creation | Small — `create_project` change | Phase 3 |
| 5 | Dynamic project context injection | Medium — Rust + file listing at session open | Phase 3 + 4 |
| 6 | Two-pass phased generation (layout + motion) | Medium — mode flag, phase skills files, validator | Phase 1 |

Phases 1 and 2 are independently shippable and immediately improve every animation. Phase 6 is independently shippable after Phase 1 — it only needs the skills infrastructure. Phases 3-5 form a dependent sequence that unlocks design consistency and code reuse.

---

## What success looks like

- A bare prompt ("animate FINKS") produces a clip that feels intentional: coherent palette, staggered entrances, arced motion paths, a readable hold, a fast exit. The intent gate ensures this even for the most ambiguous requests.
- A user drops a brand screenshot into the chat and Claude produces an animation that captures the palette, typography weight, and layout geometry of the original — without trying to load the image as a file.
- Two animations built in the same project share the same palette tokens and spring configs. Updating `theme.ts` ripples consistently rather than requiring manual edits across files.
- Claude never tries to import `./components/StatCounter` in a project where that file doesn't exist yet, because the per-session context tells it what's available.
