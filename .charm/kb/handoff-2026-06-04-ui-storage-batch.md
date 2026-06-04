# Handoff: UI + storage batch (2026-06-04)

Status: **PLANNED, NOT STARTED.** Five tickets were specced and ready to spawn as
charm workers, but charm ticket creation was failing, so the full specs are recorded
here for recreation (recreate via `create_tickets` when charm is healthy, or hand to
a human). No code for this batch has been written yet.

## Brief

A second round of feedback on ClaudeMotion produced five work items. One is a real
bug we introduced in the embedded-terminal pivot; the rest are polish + UX. Two
required user decisions, both now made and recorded as ADRs:

- Project file location -> `~/Documents/ClaudeMotion/projects/`
  (see [decisions/0002](decisions/0002-project-files-in-user-documents.md))
- Panel rearrangement -> `react-mosaic-component`
  (see [decisions/0003](decisions/0003-react-mosaic-panel-layout.md))

## Repo state at handoff

- Branch `main`, clean working tree as of the previous batch (commits `83778d2`,
  `4164f75`, `ec0ff32`, `b9e5226`, `8af07d7`). The prior 6-issue batch is done.
- The interactive-terminal pivot has landed
  (see [decisions/0001](decisions/0001-embedded-interactive-claude-pty.md)).
- Runtime still needs a human `bun run tauri dev` visual confirm (preview render +
  terminal->file->preview loop) — that gate is still open from the last batch.

## Scheduling / parallelism

Four tickets have non-overlapping file scopes and can run in parallel. The RENAME
ticket conflicts with the MOSAIC ticket (both edit `src/App.tsx` and `package.json`),
so it must wait: `RENAME depends_on [MOSAIC]`. Single shared git tree — commit with a
scoped `git add <files>`, never `git add -A`
(see [gotchas/shared-tree-git-add-all-sweeps-other-workers](gotchas/shared-tree-git-add-all-sweeps-other-workers.md)).

---

## Ticket 1 — Rewrite Claude system prompt for direct file editing

**touches:** `src-tauri/resources/remotion-skills.txt`
**depends_on:** none

**Problem.** After the embedded-terminal pivot, the system prompt is wrong and causes
the reported bug: Claude prints the whole animation file into the terminal as text
instead of editing the file. `remotion-skills.txt` still carries the OLD scrape
contract verbatim: *"Wrap the entire file in a single `<code>` XML tag and nothing
else. No markdown fences, no prose, no explanation outside that tag."* That made sense
when we parsed `<code>` blocks; now Claude runs interactively with its own Write/Edit
tools in the project dir, so it must edit `animation.tsx` directly and not emit code.

**Scope (edit that file only).** Rewrite so the behavior is:
- Claude works inside a project dir; the file it owns is `animation.tsx` in the cwd.
- It MUST use Write/Edit to modify `animation.tsx` directly. It MUST NOT print the
  file contents, MUST NOT use `<code>` tags, MUST NOT use markdown code fences to
  deliver the file.
- After editing, reply with at most a 1-2 sentence summary of the change, or stay
  silent. Never paste the animation code into chat.
- KEEP all existing Remotion domain rules: useCurrentFrame / useVideoConfig / spring /
  interpolate (no CSS transitions or setTimeout), fps 30 / 150 frames / 1080x1920 via
  useVideoConfig, spring defaults, PascalCase single default export, the animation
  vocabulary list, the full safe-zone constraints block, and "if ambiguous, make a
  creative choice; do not ask clarifying questions."

**Done when:** the file instructs tool-based editing + brief/no chat reply, zero
references to `<code>` or "wrap the entire file"; all Remotion + safe-zone rules
preserved.

**Test note:** embedded via `include_str!` and copied to
`app_data_dir/claude-config/remotion-skills.txt` by `ensure_claude_config` — an
existing install caches a stale copy, so a manual retest needs that cached file
refreshed (delete it / fresh profile).

---

## Ticket 2 — Move project files to ~/Documents/ClaudeMotion/projects + Reveal in Finder

**touches:** `src-tauri/src/commands/projects.rs`, `src-tauri/src/claude_bridge.rs`,
`src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`,
`src/components/layout/ProjectMenu.tsx`
**depends_on:** none
Decision: [decisions/0002](decisions/0002-project-files-in-user-documents.md)

**Scope.**
1. Change the storage root to `app.path().document_dir()` + `ClaudeMotion/projects`,
   CONSISTENTLY in BOTH resolvers or the terminal/watcher look in the wrong folder:
   - `projects.rs::projects_root()` (currently `app_data_dir().join("projects")`)
   - `claude_bridge.rs::project_dir()` (currently
     `app_data_dir().join("projects").join(slug)`; feeds PTY cwd + file watcher) —
     must point at the SAME path.
   `create_dir_all` the tree. No migration of old app_data projects. KEEP
   `claude_config_dir()` in app_data_dir/claude-config — only PROJECTS move.
2. Reveal in Finder: add `reveal_project(slug: String) -> Result<(), String>` (and/or
   a projects-root variant) that opens the folder via
   `std::process::Command::new("open").arg(dir)` on macOS (no new crate). Register in
   `lib.rs` `generate_handler!`. Add a "Reveal in Finder" item in `ProjectMenu.tsx`
   that invokes it for the active project (fall back to projects root if none open).

**Done when:** new projects are created under `~/Documents/ClaudeMotion/projects/<slug>/`
with the four files + `assets/`; the PTY cwd and the `animation.tsx` watcher both use
that path; the Project menu's Reveal in Finder works; `cargo check` + `tsc` clean.

**Discipline:** do NOT touch App.tsx / App.css / package.json.

---

## Ticket 3 — Rearrangeable panels via react-mosaic

**touches:** `src/App.tsx`, `src/App.css`, `package.json`
**depends_on:** none
Decision: [decisions/0003](decisions/0003-react-mosaic-panel-layout.md)

**Scope.**
- Add `react-mosaic-component` (+ `react-dnd` / `react-dnd-html5-backend` peers if the
  version needs them) to `package.json`; install so the lock updates; import its CSS.
- Rewrite the panel region of `App.tsx`: a `<Mosaic>` whose three tiles are the
  existing `<TerminalPanel/>`, `<CodePanel .../>`, `<PreviewPanel .../>` with ALL
  current props/wiring unchanged (code state, onCodeChange, etc.). Default layout
  terminal | editor | preview. Each tile is a `<MosaicWindow>` with a draggable header.
- Remove the obsolete hand-rolled resize logic (`startDrag`, `.resize-handle`,
  `panelsRef`, `panelWidths`) once mosaic replaces it.
- `App.css`: drop the old `.panels` / `.panel-slot` / `.resize-handle` rules; theme the
  mosaic tiles to the dark palette (tile bg, header bar, splitter). Inner `.panel--*`
  styles keep working inside tiles.
- Apply a DARK theme (mosaic ships light by default — `mosaic-blueprint-theme` or a
  custom override) so there's no white chrome.
- Layout persistence to localStorage is optional (nice-to-have).

**Done when:** all three panels render in draggable tiles; dragging a header
rearranges; dividers resize; dark-themed; panels keep full functionality; `tsc` +
`vite build` pass.

**Discipline:** own App.tsx / App.css / package.json only. Do NOT touch the panel
components or ReplayControls. Commit with scoped `git add` — the RENAME ticket edits
App.tsx/package.json right after.

---

## Ticket 4 — Redesign / fix the replay controls

**touches:** `src/components/PreviewPanel/ReplayControls.tsx` (+ a co-located
`ReplayControls.css` — do NOT use App.css, the mosaic ticket owns it)
**depends_on:** none

**Problem.** The replay bar is buggy and looks cheap. Two concrete issues:
1. Buttons use ASCII text glyphs (`|<`, `<`, `>`/`||`, `>`, `>|`) rendered as text,
   not real icons — looks janky (see the user's screenshot).
2. It force-plays on EVERY successful recompile: the `renderOk` handler posts
   `{type:"play"}` (ReplayControls.tsx ~line 175), so playback restarts every time
   Claude/the editor changes the code — disruptive while iterating.

**Scope.**
- Replace the ASCII glyphs with proper inline SVG icons (skip-to-start, step-back,
  play/pause, step-forward, skip-to-end) following the existing `EyeIcon` pattern in
  PreviewPanel (currentColor, no icon-font/emoji dep).
- Fix the auto-play behavior: don't restart playback on every recompile. Reasonable
  behavior: autoplay only the first successful render of a project, or preserve the
  prior play/pause state across recompiles, or make it a setting. Pick the least
  surprising default (preserve prior state; only autoplay the very first render).
- Polish styling into a co-located CSS file: nicer buttons (hover/active states),
  a themed scrubber track + thumb (not the default browser range), aligned spacing,
  consistent dark palette. Keep the time readout `m:ss.ff / m:ss.ff`.
- Keep all functionality: step, seek/scrub, play/pause, Space shortcut, speed
  (0.5x/1x/2x), Loop, and the `scrubbingRef` anti-fight behavior.

**Done when:** controls use crisp SVG icons, look polished and on-theme, no longer
hijack playback on every recompile, and all existing controls still work; `tsc` clean.

**Discipline:** ReplayControls.tsx + its own CSS only. Do NOT edit App.css or
PreviewPanel.tsx.

---

## Ticket 5 — Rename the app display name to "ClaudeMotion"

**touches:** `index.html`, `src-tauri/tauri.conf.json`, `src/App.tsx`,
`src/components/Onboarding.tsx`, `src-tauri/Cargo.toml`
**depends_on:** [Ticket 3 — react-mosaic] (both edit App.tsx; sequence to avoid the
shared-tree race)

**Scope — USER-FACING display name only -> "ClaudeMotion":**
- `index.html` `<title>Claude Motion</title>` -> `ClaudeMotion`
- `tauri.conf.json` `productName: "claude-motion"` -> `"ClaudeMotion"`; window
  `title: "Claude Motion"` -> `"ClaudeMotion"`
- `App.tsx` window title (the two `"Claude Motion"` strings, ~lines 238-239) ->
  `"ClaudeMotion"`
- `Onboarding.tsx` ~line 127 copy "Claude Motion drives the claude CLI..." ->
  "ClaudeMotion ..."
- `Cargo.toml` `description` text (cosmetic) may be updated to match.

**Explicitly DO NOT change (invasive, low value):**
- `Cargo.toml` `[package] name = "claude-motion"` and `[lib] name = "claude_motion_lib"`
  (would force a `main.rs` edit + change build artifacts).
- `tauri.conf.json` `identifier = "ai.finks.claude-motion"` (changing it moves
  app_data_dir and orphans claude-config).
- `package.json` `"name": "claude-motion"` (npm names are lowercase; no user value).
- localStorage keys `claude-motion:lastProject` / `claude-motion:panelWidths` in
  App.tsx / uiStore.ts (renaming loses persisted state).

**Done when:** the window title, product name, HTML title, and onboarding copy all
read "ClaudeMotion"; internal identifiers untouched; `tsc` + build pass.

---

## Logo note (informational, no ticket)

The app icon is the **default Tauri placeholder** (yellow/blue circular mark) from the
`create-tauri-app` scaffold (commit `118b01f`), regenerated by `tauri icon` — the
`Square*Logo.png` files are its Windows Store tiles. Not custom. Replace
`src-tauri/icons/*` (re-run `tauri icon <source.png>`) whenever real branding exists.
