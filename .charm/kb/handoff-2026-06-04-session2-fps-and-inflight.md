# Handoff: FPS/duration feature + in-flight work (2026-06-04, session 2)

Written because the work is moving to another computer. This captures the one
PLANNED feature (FPS/duration control) plus the state of work that was in flight
when the session ended, so it can be recreated on the new machine.

## (!) BEFORE YOU MOVE MACHINES: push first

As of this writing the repo has ~19 commits on `main` that exist ONLY locally
(`git log origin/main..HEAD`) -- the entire T-001..T-013 body of work, plus the
KB commits. There are also uncommitted KB files in the working tree (this doc,
the decisions/handoff/research notes, INDEX bumps). If you switch computers
without pushing, all of it is stranded.

Do this before moving:
1. Commit the outstanding KB files (scoped `git add .charm/kb` + this doc).
2. `git push` so origin/main has everything.
3. On the new machine: clone/pull, then start a fresh charm session. The KB
   (this doc + the research note) travels with the repo; recreate the tickets
   below via `create_tickets`.

## Completed and committed this session (no action needed)

All verified by a tester unless noted:
- T-006 `2f268b5` -- system prompt rewritten for direct file editing (no more
  console code-dumps; Write/Edit on animation.tsx).
- T-007 `c0ed413` + `c43c409` -- projects moved to
  `~/Documents/ClaudeMotion/projects/<slug>/` across all four `projects_root()`
  resolvers; Reveal in Finder added.
- T-008 `df2dade` -- react-mosaic rearrangeable panels (dark-themed).
- T-009 `3163ce2` -- replay controls: SVG icons + autoplay-first-render-only.
- T-010 `d510d45` -- display name -> "ClaudeMotion" (internal identifiers left alone).
- T-011 `2c41f66` -- cached skills/MCP config now refreshes on embedded-content
  change (`write_if_changed`), not seed-if-absent. This is why prompt fixes now
  actually reach an existing install.
- T-012 `34c3a96` -- Restart-session control in the terminal panel header.
- T-013 `5d60ee7` -- diagnose-only: confirmed the preview compile fix from
  `b9e5226` holds at HEAD. NOTE: this is a static + build-level conclusion. A
  live `bun run tauri dev` visual confirm (animation actually renders) is still
  an OPEN human gate -- do this on the new machine.

## In flight when the session ended (verify on new machine)

These workers were running; their commits may or may not have landed before the
move. Check `git log` for them; if absent, recreate from the specs noted.

- T-014 (multi-file research) -- COMMITTED `0eb5aa4`. Deliverable lives at
  `.charm/kb/research/multi-file-architecture.md` (design proposal for letting
  Claude use multiple files; the preview compiler currently runs esbuild in
  TRANSFORM mode and cannot resolve cross-file imports). Read it before building
  multi-file support. Recommendation in it: build AFTER preview stability is
  confirmed. Ran on Opus, not Sonnet (charm has no model selection).
- T-015 (mosaic drop-zone indicators) -- was running (worker-018), commit status
  UNKNOWN at move time. If not committed, recreate; spec below.

---

## TICKET (PLANNED) -- Let Claude control composition FPS and duration

**touches:** `src-tauri/resources/remotion-skills.txt`,
`src/workers/sandbox-compiler.worker.ts`,
`src/components/PreviewPanel/PreviewPanel.tsx`,
`src/components/PreviewPanel/ReplayControls.tsx`
(plus wherever the @remotion/player composition config is actually set -- find it)
**depends_on:** none

**Goal.** Today the composition is fixed app-side: fps 30, durationInFrames 150,
1080x1920. `remotion-skills.txt` tells Claude to READ them via `useVideoConfig()`
but "do not hardcode them", so Claude cannot change clip length or frame rate.
We want Claude able to set **FPS and duration** per animation. (Width/height stay
1080x1920 for now -- this is FPS + duration only.)

**Investigate first.** `useVideoConfig()` is consumed at `PreviewPanel.tsx:87`,
but the fps/durationInFrames VALUES are set upstream where the Player/Composition
is configured. Locate that source (the sandbox runtime that mounts the bundle into
@remotion/player, or a constants module) before designing the change.

**Approach (suggested -- confirm against the code).**
- Let `animation.tsx` declare its own fps + durationInFrames as exported constants
  the preview reads (e.g. `export const fps` / `export const durationInFrames`, or
  a single `export const config = { fps, durationInFrames }`). Fall back to the
  current defaults (30 / 150) when unset.
- Extend the sandbox compiler so these exported values reach the Player, and have
  the Player use them for the composition.
- Update `remotion-skills.txt`: tell Claude it MAY set fps and durationInFrames via
  that mechanism (state it explicitly), with the defaults; keep every existing
  Remotion + safe-zone rule intact.
- `ReplayControls.tsx` hardcodes `DEFAULT_FPS = 30` and derives the time readout +
  scrubber from fps/duration -- make sure it consumes the ACTUAL values so the
  scrubber length and `m:ss.ff` readout stay correct when Claude changes them.

**Done when:** an animation that exports a different fps/duration actually plays at
that rate and length in the preview; the replay controls (scrubber + time readout)
reflect it; defaults hold when unset; `tsc` + `vite build` pass.

---

## TICKET (recreate only if T-015 didn't commit) -- Visible mosaic drop-zone indicators

**touches:** `src/App.tsx`, `src/App.css`
**depends_on:** none

When dragging a panel to rearrange, there's no clear preview of where it will dock.
react-mosaic's base CSS IS imported (`App.tsx` ~line 6) and a dark drop-target rule
exists (`App.css` ~line 285) but its fill is very faint
(`rgba(59,130,246,0.2)`), so the indicator goes unnoticed. Fix: confirm dragging a
MosaicWindow by its header initiates a drag and renders the 5 drop zones
(top/bottom/left/right/center); make those overlays high-contrast and obviously
visible against the dark theme so they read as a real "this is the new area"
preview; keep the dark theme intact. App.tsx + App.css only; no new dnd library.
Done when dragging shows clear drop-zone previews, docking works all directions,
`tsc` + `vite build` pass. (Full confirm needs a live drag in `bun run tauri dev`.)
