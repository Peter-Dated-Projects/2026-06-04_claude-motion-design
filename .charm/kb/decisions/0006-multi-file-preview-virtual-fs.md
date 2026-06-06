---
id: 0006-multi-file-preview-virtual-fs
root: decisions
type: decision
status: current
summary: "The preview compiler moved from esbuild.transform (single-file) to esbuild.build with an in-memory virtual-FS plugin, so animation.tsx can import relative project files (./theme, ./components/X); allow-listed bare imports are still rewritten to window globals (not bundled), and the file watcher went recursive + .ts/.tsx with a {paths} event."
created: 2026-06-06
updated: 2026-06-06
related: esbuild-wasm-no-concurrent-transform
---

T-067 (re-run of T-062) made the preview compiler multi-file. Before, every
animation was a self-contained monolith: `src/workers/sandbox-compiler.worker.ts`
ran `esbuild.transform`, which cannot resolve imports, so shared `./theme` /
`./motion` / `./components/*` files were inert.

## What changed

**Worker: transform -> build + virtual-FS plugin.** The worker now calls
`esbuild.build({ entryPoints:['animation.tsx'], bundle:true, write:false,
format:'iife', globalName:'AnimationExports', jsx classic, plugins:[virtualFsPlugin(files)] })`
and reads `result.outputFiles[0].text`. There is no real FS in the worker; the
plugin serves every module from the in-memory `files: Record<string,string>` map
the frontend posts (keyed by project-relative forward-slash path).

**Allow-listed bare imports are NOT bundled.** `bindImportsToGlobals` (the
existing regex that rewrites `react` / `react-dom` / `react-dom/client` /
`remotion` / `@remotion/player` into `const`-bindings off `window.React` /
`window.RemotionRuntime`) is now run inside the plugin's `onLoad` on EVERY file's
contents, BEFORE esbuild parses it. So esbuild's resolver only ever sees relative
imports. This is what preserves single-file behavior byte-for-byte (same window
globals, same `AnimationExports.default` contract).

**onResolve is the error surface.** A relative specifier with no map match -> a
clear `Cannot resolve './x' from '...'` error. Any bare specifier that SURVIVED
the rewrite (i.e. not in the allow-list) -> a `Disallowed import 'x'` error
naming it. Both come back as esbuild build failures the preview panel shows.

**Path resolution** (`resolveRelative`) is pure JS, no node `path`: dirname +
normalize (`.`/`..`), then try `exact, +.ts, +.tsx, /index.ts, /index.tsx`.

## Decisions made

- **components/ recursion: YES, supported now.** `file_watch.rs` switched from
  `RecursiveMode::NonRecursive` to `Recursive` and from an exact `animation.tsx`
  name filter to a `.ts`/`.tsx` extension filter, so edits to files in `components/`
  (or any subdir) refresh the preview. Without the recursive switch those edits
  would silently not refresh.

- **Watcher event contract changed: `{ code }` -> `{ paths: string[] }`.** The
  watcher no longer ships animation.tsx's contents; it emits the set of changed
  project-relative paths (coalesced across a multi-file burst into ONE event). The
  frontend (App.tsx) responds: if `animation.tsx` is among them, re-read it via
  `load_animation` -> `setCode`; if any non-entry `.ts`/`.tsx` changed, rebuild the
  whole preview map by re-listing + re-reading from disk.

- **Map rebuild is a full re-list, not a path diff.** On any non-entry change
  App.tsx re-runs `list_project_files` + `read_file` for all `.ts`/`.tsx`. This
  makes add / delete / rename self-correcting (a removed file just drops out) at
  the cost of re-reading a handful of small files -- fine for motion projects.

- **Source of truth stays in App.tsx, not projectStore.** `projectStore.ts` was in
  the ticket's `touches` but the map lives cleanest where `code`/`fileContents`
  already live. `previewFiles` (non-entry map) + `code` (entry) are combined via a
  memoized `previewFileMap = { ...previewFiles, [ENTRY_FILE]: code }` passed to
  PreviewPanel. projectStore was left untouched.

## Validated

A standalone esbuild-wasm 0.25.12 harness confirmed the exact plugin logic:
single-file regression, multi-file (`./theme` + `./motion` + `components/` + `../`
imports), disallowed-import error naming the specifier, relative-miss error, and
`/index.ts` resolution all behave as intended.

## Known gap (out of T-067 scope)

`RenderModal` reuses `PreviewPanel` but passes only the legacy single-file `code`
prop, so its render-preview cannot resolve relative project imports for a
multi-file animation. PreviewPanel keeps accepting `code?` (wrapped into a
one-entry map) for back-compat; wiring RenderModal to pass the full map is a
follow-up (RenderModal.tsx was outside this ticket's touches).
