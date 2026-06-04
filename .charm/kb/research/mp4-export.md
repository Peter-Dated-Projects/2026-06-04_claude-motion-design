---
id: mp4-export
root: research
type: research
status: current
summary: "Design+spike proposal for real MP4 export: render via a Tauri sidecar embedding @remotion/renderer (Phase 1 spike shells out to system Node first), Chromium downloaded-on-first-use, a render-only registerRoot bundle that shares only source + the fps/duration/config convention with the preview compiler, progress into the render-log store, output via a Rust save dialog."
created: 2026-06-04
updated: 2026-06-04
---

# How to actually render an MP4

## TL;DR recommendation

- **Render engine:** `@remotion/renderer` (`renderMedia`) driven from a **Tauri sidecar**
  -- a single self-contained Node binary that embeds `@remotion/bundler` +
  `@remotion/renderer`. This is the destination architecture. The **Phase 1 spike**
  shells out to a **system Node** instead, to prove the pipeline end-to-end before
  paying the sidecar-packaging cost.
- **Chromium:** **download-on-first-use** via Remotion's `ensureBrowser()` into the
  app-data dir. Do NOT bundle Chromium in the installer.
- **Composition entry:** the render path needs its **own** `registerRoot` composition
  bundle. It does **not** reuse the preview compiler. The two share only the *source*
  (`animation.tsx`) and the *fps/duration/config export convention*.
- **Where it runs:** a new Rust command spawns the sidecar/Node, streams progress as
  Tauri events into the existing `useRenderLogStore` (`render` stage), and writes the
  `.mp4` to a user-chosen path via the same Rust save-dialog pattern as `export_tsx`.

This recommendation is design only. **No app code is changed by this ticket.**

---

## Where the code stands today

- **The button is a hardcoded stub.** `src/components/layout/ExportMenu.tsx:93-101`
  renders the Export MP4 `<button>` with `disabled` and `title="Coming soon"` and **no
  `onClick`**. Export TSX and Export ZIP, by contrast, call `runExport(command, label)`
  (`ExportMenu.tsx:49-64`), which `invoke()`s a Rust command and toasts the returned
  save path. There is no MP4 command to call.
- **There is no render pipeline at all.** The only "rendering" today is the live
  *preview*: `@remotion/player` mounted in a sandboxed iframe
  (`src/components/PreviewPanel/PreviewPanel.tsx`, `src/assets/sandbox-frame.html`).
  The Player plays frames in real time on screen; nothing encodes them to a file.
- **The existing export commands set the shape to mirror.**
  `src-tauri/src/commands/export.rs` (`export_tsx`) and
  `src-tauri/src/commands/zip.rs` (`export_project_zip`) both: resolve the project
  folder under `{documentDir}/ClaudeMotion/projects/{slug}/`, open a **Rust-side**
  `tauri_plugin_dialog` save dialog (`blocking_save_file`), write the output, and
  return the chosen path as a `String` (or the sentinel `"cancelled"` on dismiss).
  Both are already registered in `src-tauri/src/lib.rs:40-64`. MP4 export should look
  exactly like this from the frontend's point of view.
- **Dependencies already present.** `src-tauri/Cargo.toml` already pulls in
  `tauri-plugin-shell` (sidecar/shell-out capability) and `portable-pty` -- the app
  **already spawns a user-installed external CLI** (Claude Code) in a pty. `package.json`
  already depends on `remotion`, `@remotion/player`, **and the full `esbuild`** (not
  just `esbuild-wasm`), at Remotion `^4.0.471`. `@remotion/bundler` and
  `@remotion/renderer` are *not* yet deps.

The single most important consequence: **shelling out to an external binary is already
this app's established model.** Requiring (or bundling) a Node-based renderer is
consistent with how the app already talks to Claude Code, not a new architectural
departure.

---

## Question 1 -- Render engine: how does Remotion produce the file?

`@remotion/renderer`'s `renderMedia()` is the standard path. It needs three things the
WKWebView cannot provide:

1. a **Node runtime**,
2. a **headless Chromium** (Chrome Headless Shell) that Remotion drives frame-by-frame,
3. a **bundled Remotion composition** (see Question 3).

Tauri is Rust + WKWebView with **no bundled Node** and no headless Chromium. WKWebView
is also the wrong engine even if we could script it: Remotion targets Chromium
specifically, and the preview iframe runs on an **opaque origin** under a strict CSP
(`sandbox-frame.html:16-19`, `connect-src 'none'`, `allow-scripts` only) -- it cannot
read back pixels or reach a file system. So the renderer has to live **outside** the
webview, in a Node process.

### Options evaluated

**(a) Tauri sidecar -- a self-contained Node binary embedding `@remotion/renderer`.**
Compile a Node script + its `node_modules` (`@remotion/bundler`, `@remotion/renderer`,
`react`, `remotion`) into one binary via Node SEA, `bun build --compile`, or `pkg`,
declared as `externalBin` in `tauri.conf.json` and launched through the already-present
`tauri-plugin-shell`.
- (+) No "user must install Node" requirement -- works on a clean machine.
- (+) Matches Tauri's recommended pattern; shell plugin is already wired.
- (+) Deterministic toolchain version (we pin Remotion + Node).
- (-) Binary size: a Node + Remotion sidecar is on the order of **80--150 MB per
  platform** before Chromium. Inflates the installer.
- (-) Cross-platform packaging is real work: one sidecar per `target_triple`
  (`darwin-arm64`, `darwin-x64`, `win`, `linux`), each built in CI.
- (-) macOS notarization: the embedded binary must be signed + hardened-runtime'd as
  part of the app bundle.

**(b) A small Rust-invoked CLI (render logic in Rust).**
Rejected. Remotion's renderer **is** JavaScript and drives Chromium via its own Node
protocol; there is no Rust reimplementation. A Rust CLI would still have to embed/launch
Node, i.e. it collapses back into (a) with extra glue.

**(c) Require a system Node and shell out.**
Ship a plain `.mjs` render script as a Tauri resource and run it with the user's
`node`, via `tauri-plugin-shell`.
- (+) **Smallest footprint** -- no embedded runtime, tiny installer delta.
- (+) **Consistent with the existing Claude-CLI dependency** (the app already refuses to
  work without an external CLI present).
- (+) Fastest to a working spike.
- (-) Fragile UX on a clean machine: detect Node, surface a clear "install Node 18+"
  error, version-skew risk.
- (-) Still needs `node_modules` for Remotion: either ship them as a resource (heavy,
  but no install step) or run an install on first use (network + slow + fragile). Shipping
  a pre-resolved `node_modules` resource is the lesser evil.

**(d) Frame-capture from the existing sandbox + ffmpeg encode.**
Seek the preview Player frame-by-frame, capture each frame, pipe to ffmpeg.
- (+) Reuses the existing compiler/preview; no second render engine.
- (-) **Fidelity is the killer.** The Player renders **DOM/CSS**, not a canvas. Capturing
  arbitrary DOM means DOM-to-image rasterization (html-to-canvas-style), which is exactly
  the hard problem headless Chromium already solves correctly and naive rasterizers get
  wrong (fonts, filters, transforms, blend modes). Remotion itself uses Chromium
  screenshots for this reason.
- (-) The sandbox is on an **opaque origin** with `connect-src 'none'` and no
  same-origin access (`sandbox-frame.html`, `PreviewPanel.tsx:491` `sandbox="allow-scripts"`),
  so reading pixels out of it is blocked by design; we'd have to dismantle the security
  model.
- (-) Real-time playback is wall-clock; deterministic offline render is not. Frame timing
  would drift.
- Verdict: tempting for reuse, but it trades correctness for it. Not recommended.

### Recommendation

**Destination = (a) sidecar. Spike = (c) system Node first.** Build the render script
and prove `bundle()` + `renderMedia()` produce a real `.mp4` using a system Node in
Phase 1 (cheap, fast feedback). Once the pipeline is proven, package that same script as
a self-contained sidecar in Phase 2 so end users need no Node. Option (b) is out; (d) is
a fallback only if sidecar size proves unacceptable.

---

## Question 2 -- Chromium sourcing

`@remotion/renderer` exposes `ensureBrowser()`, which downloads a pinned **Chrome
Headless Shell** (a slimmed headless build, ~150 MB extracted) on first use and caches
it. Two options:

- **Download-on-first-use (recommended).** Call `ensureBrowser()` (configured to cache
  under `{appDataDir}/ClaudeMotion/chromium/`) the first time the user exports an MP4.
  - (+) Keeps the **installer small** -- Chromium is not in the bundle.
  - (+) Sidesteps **macOS notarization** of a second large embedded binary -- a
    downloaded, user-cached browser is not part of the signed app bundle.
  - (-) First export needs **network** and a one-time ~150 MB download; must show
    progress ("Downloading renderer (first run)...") in the render log and handle
    offline gracefully.
- **Bundle Chromium in the installer.** Rejected as the default: +150 MB per platform,
  and the embedded browser becomes a notarization + signing surface on macOS. Keep as a
  future "offline installer" variant only.

A system-Chrome fallback (`browserExecutable` pointing at an installed Chrome) is a nice
escape hatch for the spike but not the primary path -- version skew makes renders
non-deterministic.

---

## Question 3 -- Composition entry: shared with the preview compiler, or separate?

**Separate. The render path needs its own entry and its own bundler.** This is the
subtlest part of the design, so spelling it out:

The preview compiler (`src/workers/sandbox-compiler.worker.ts`) runs esbuild in
**TRANSFORM mode**, not bundle mode (`esbuild.transform(...)`, `format: "iife"`,
`globalName: "AnimationExports"`, lines 175-183). It **cannot resolve bare imports**, so
it textually rewrites `import ... from 'react' | 'remotion' | '@remotion/player'` into
`const` bindings off `window.React` / `window.RemotionRuntime`
(`GLOBAL_FOR`, `bindImportsToGlobals`, lines 36-102). The output is a self-contained
IIFE that, when run in the sandbox, mounts an `@remotion/player` `<Player>`
(`sandbox-frame.html:151-171`). That is a *player*, not a Remotion *project*.

`renderMedia()` needs the opposite shape: a **real bundle** (built by
`@remotion/bundler`'s `bundle()`, which resolves actual npm `react` / `remotion` from
`node_modules`) whose entry calls **`registerRoot`** and declares a **`<Composition>`**
with `id`, `component`, `durationInFrames`, `fps`, `width`, `height`. There is no
window-global rewrite and no Player.

So the render path gets a **render-only entry module** (a Tauri resource, generated/
templated at render time) that:

1. imports the user's `animation.tsx` default export (and reads its optional
   `fps` / `durationInFrames` / `config` exports),
2. wraps it in a `<Composition>` fixed at **1080x1920** (the app's only format --
   `sandbox-frame.html:54-61`),
3. resolves fps/duration with the **same precedence the preview already uses** so a clip
   renders identically to its preview. That logic lives in `resolveConfig` /
   `resolvePositive` in `sandbox-frame.html:66-90`: top-level `export const fps` /
   `durationInFrames` win over a `config` object; defaults are **30 fps / 150 frames**;
   fps may be fractional, duration is floored to a whole frame count. **This convention
   must be duplicated (or, better, extracted into a shared module) so preview and render
   never diverge** -- a clip that previews at 24fps/120 frames must render at
   24fps/120 frames.

**What's shared vs. what diverges:**

- Shared: the **source file** (`animation.tsx`) and the **fps/duration/config export
  convention**.
- Diverges: the **compiler** (esbuild-wasm transform + window-global rewrite for preview;
  `@remotion/bundler` real bundle for render), the **module resolution** (globals vs.
  `node_modules`), and the **mount target** (`<Player>` vs. `<Composition>`/`registerRoot`).

**Assets.** The preview's CSP allows only `data:` / `blob:` media. The render bundle runs
in real Chromium with file access, so project `assets/` (copied alongside exports today,
`export.rs:92-100`) can be served via Remotion's `staticFile()` / `--public-dir`. The
render entry must point Remotion's public dir at the project's `assets/` folder. Flag:
animations that reference assets by a preview-only `blob:`/`data:` scheme will need a
path convention that resolves in both worlds -- worth nailing down before Phase 3.

---

## Question 4 -- Where the work runs, progress, and output

- **Where:** a new Rust command (e.g. `export_mp4`) in `src-tauri/src/commands/`,
  registered in `lib.rs` alongside `export_tsx` / `export_project_zip`. It resolves the
  project dir (the same `projects_root` helper that is **hand-duplicated** across
  `projects.rs`, `zip.rs`, `export.rs`, `claude_bridge.rs` -- noted in those files'
  headers; a fifth copy here inherits that maintenance hazard, so consider extracting it),
  opens a Rust save dialog defaulting to `{slug}.mp4`, then spawns the sidecar/Node via
  `tauri-plugin-shell`, passing the project source path, resolved fps/duration, asset
  dir, and output path.
- **Progress reporting:** the render script writes structured progress to stdout (Remotion's
  `renderMedia` has an `onProgress` callback -- frames rendered / encoded). The Rust
  command parses those lines and **emits Tauri events** to the frontend. A small frontend
  listener pushes them into the **existing `useRenderLogStore`** -- which already models
  exactly this: stages `compile | render | runtime | watchdog` and levels
  `info | warn | error` (`src/store/renderLogStore.ts:4-14`). MP4 progress fits the
  **`render` stage** cleanly; no new store is needed (optionally add a `"export"` stage
  if we want to visually separate it). The render-log drawer
  (`PreviewPanel.tsx`, `RenderLogPanel.tsx`) then shows export progress for free.
  A determinate progress bar (frames done / total) is a nice-to-have on top.
- **Output:** the chosen `.mp4` path, returned as a `String` from the command, surfaced
  by the same `runExport`/toast machinery in `ExportMenu.tsx:49-64` ("Saved to ..."),
  with `"cancelled"` swallowed exactly like the TSX/ZIP paths.
- **Cancellation:** rendering is long; the spawned process handle must be killable so a
  Cancel button can abort. Design the command to track the child and expose a
  `cancel_mp4_export`.

---

## Question 5 -- Phased plan (smallest real .mp4 first)

**Phase 1 -- Prove the pipeline (spike, system Node).**
- Add `@remotion/bundler` + `@remotion/renderer` as dev/tooling deps; write a standalone
  `render.mjs` (Tauri resource) that `bundle()`s a render entry and `renderMedia()`s to a
  hardcoded path. Run it by hand with system Node against a real project's `animation.tsx`.
- Hardcode 1080x1920, 30fps/150 frames; no UI wiring yet.
- Use `ensureBrowser()` to fetch Chromium into appdata on first run.
- **Done when:** a real, playable `.mp4` of an existing project exists on disk, rendered
  outside the webview. This de-risks every later decision.

**Phase 2 -- Wire it into the app + package the renderer.**
- Add the `export_mp4` Rust command (save dialog + spawn + path return), register in
  `lib.rs`, give the `ExportMenu` button an `onClick` via `runExport('export_mp4', ...)`,
  drop the `disabled`.
- Read fps/duration from the project source using the **shared** resolve-config logic
  (extracted from `sandbox-frame.html`) so render == preview.
- Replace system-Node with a **self-contained sidecar** (`externalBin`), built per
  platform in CI; sort macOS signing/notarization of the embedded binary.
- **Done when:** clicking Export MP4 on a clean machine (no system Node) produces the file
  via the native save dialog.

**Phase 3 -- Progress, quality, perf, robustness.**
- Stream `onProgress` -> Tauri events -> `useRenderLogStore` (`render` stage); add a
  determinate progress bar + Cancel.
- Quality knobs: codec/CRF, resolution presets, fps override; concurrency tuning.
- Asset path convention that resolves in both preview (`blob:`/`data:`) and render
  (`staticFile`) worlds.
- First-run Chromium-download UX (progress, offline handling, retry).

---

## Honest risks

- **Binary size.** A Node+Remotion sidecar is ~80--150 MB/platform *before* Chromium's
  ~150 MB. Even with Chromium downloaded-on-first-use (keeping it out of the installer),
  the sidecar alone roughly doubles a lean Tauri installer. This is the biggest cost of
  the recommended path; option (c) system-Node trades it for a hard external dependency.
- **Chromium first-run download.** ~150 MB over the network on first export. Needs clear
  progress + graceful offline failure, or it reads as a hang.
- **Cross-platform + notarization.** A sidecar per `target_triple`, each signed; macOS
  hardened-runtime + notarization of the embedded binary is non-trivial CI work.
- **Preview/render divergence.** If the fps/duration/config resolution isn't *shared*
  with the preview (`sandbox-frame.html:66-90`), clips will render differently from how
  they preview. Extract the logic; don't re-implement it.
- **No second compiler for free.** The preview's esbuild-wasm transform path
  (`sandbox-compiler.worker.ts`) does **not** carry over -- the render path is a genuinely
  new `@remotion/bundler` pipeline. Budget for it as new code, not a refactor.
- **Asset references.** Preview-only `blob:`/`data:` asset URLs won't resolve in the
  render bundle; needs a path convention (`staticFile` + project `assets/`) settled
  before assets-heavy animations export correctly.
- **`projects_root` duplication.** A fifth hand-copy of the projects-root path (already
  duplicated across four files, per their headers) is a latent drift bug; extract a
  shared helper when adding `export_mp4`.
