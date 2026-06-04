---
id: multi-file-architecture
root: research
type: research
status: current
summary: "Design proposal for letting ClaudeMotion projects span multiple .tsx files (components, shared theme/easing modules) instead of one animation.tsx; recommends switching esbuild-wasm to bundle mode with a virtual-FS resolver plugin, fed by a frontend file map, AFTER preview stability is confirmed."
created: 2026-06-04
updated: 2026-06-04
---

# Multi-file project architecture for ClaudeMotion

RESEARCH / DESIGN PROPOSAL. No code was changed by this ticket (T-014). Every
claim below is grounded in the code at HEAD with file paths; verify those paths
before acting on this.

## TL;DR recommendation

Build multi-file support, but **not yet**. Land it AFTER the preview compile
hang (T-013, formerly T-003) is confirmed stable, because multi-file forces a
rewrite of the exact compile path that is currently being stabilized, and
shipping both at once means you cannot tell which change broke the preview.

When you do build it, the shape is:

1. Switch the sandbox compiler from esbuild-wasm **transform** mode to **bundle**
   mode, driven by a single in-memory virtual-filesystem plugin
   (`onResolve` + `onLoad`).
2. That one plugin does two jobs: resolve **relative** imports (`./theme`,
   `../components/Card`) against a project file map, and resolve **bare**
   imports (`react`, `remotion`, `@remotion/player`) to tiny shim modules that
   re-export the existing `window` globals. This deletes the current regex
   import-rewriting hack and makes it more robust, not just more capable.
3. The frontend passes esbuild a **file map** (path -> source), not disk access.
   The worker stays sandboxed and fs-free. The Rust watcher becomes recursive
   over the project's source files and emits a map instead of a single string.
4. `animation.tsx` stays the entry point / default-export root composition.
   Everything else is a module it imports. Convention: `components/`, and shared
   modules like `theme.ts` / `easing.ts` at the project root.
5. The editor starts as a read-only file tree mirror (smallest change that shows
   value) and only later becomes multi-file editable.

The phased plan is in section 7.

---

## Grounding: how the single-file pipeline works today

The whole app is wired to exactly one file, `animation.tsx`, in four places.
This is the thing multi-file has to unwind.

**1. The compiler cannot resolve imports at all.**
`src/workers/sandbox-compiler.worker.ts` runs esbuild-wasm in **transform** mode
(`esbuild.transform(...)`, ~line 169), not bundle mode. Its own header comment
(lines 8-15) spells this out: transform mode "cannot resolve bare imports, so we
rewrite `import ... from 'react' | 'remotion' | '@remotion/player'` into const
bindings off the window globals". The rewriting is a regex pass
(`bindImportsToGlobals` -> `IMPORT_RE` / `GLOBAL_FOR`, lines 36-102). It only
knows the bare modules in `GLOBAL_FOR` (react, react-dom, remotion,
@remotion/player). A relative import like `import { Card } from './components/Card'`
is left untouched, and because transform mode never resolves it, the emitted IIFE
contains a dangling `import`/require that breaks at runtime in the sandbox. So
cross-file imports do not work today, full stop.

**2. The worker has no file access.**
The worker receives a single `code` string over `postMessage`
(`CompileRequest = { type: "compile"; code: string }`, line 29) and posts back a
compiled IIFE string. It never reads disk. The `code` comes from
`PreviewPanel.tsx`: `workerRef.current?.postMessage({ type: "compile", code: source })`
(line 226), where `source` is one string of TSX.

**3. The frontend tracks one source string.**
`App.tsx` seeds `code` via `invoke<string>("load_animation", { slug })` (line
231) and then mirrors disk changes through a single listener:
`listen<{ code: string }>("animation://changed", ...)` -> `setCode(...)` (lines
254-255). One string flows to both the Monaco editor and the preview.

**4. The Rust watcher is single-file by design.**
`src-tauri/src/file_watch.rs` watches the project **directory** non-recursively
(`RecursiveMode::NonRecursive`, line 69) but then **filters events down to
`animation.tsx` by name** (`ANIMATION_FILE`, lines 28 / 56-60) and emits
`ChangedPayload { code }` with just that one file's contents (lines 105-108).
`load_animation` / `save_animation` in
`src-tauri/src/commands/projects.rs` (lines 259-277) likewise read/write only
`animation.tsx`.

**5. The prompt tells Claude it owns one file.**
`src-tauri/resources/remotion-skills.txt` (29 lines) opens with "The file you own
is animation.tsx ... a single TypeScript/React file" and "export a single default
component". Claude *can* already create other files in
`~/Documents/ClaudeMotion/projects/<slug>/` (per decision 0002 the project dir is
a normal user-writable folder and the embedded CLI has a normal cwd there) -- the
bottleneck is the compiler and the editor, not Claude's ability to write files.

**6. Export is single-file too.**
`src-tauri/src/commands/export.rs` copies `animation.tsx` plus `assets/` (header
comment lines 1-7). Multi-file export must copy the whole `src/` tree, not one
file. Noting it here so it is not forgotten; it is a small change but it is a
fourth place coupled to the single-file assumption.

---

## 1. Compiler strategy

### The core question: does esbuild-wasm bundle mode work in the browser worker?

Yes -- with the important caveat that this should be confirmed with a small spike
before committing, because it is the load-bearing assumption of the whole design.

What is certain from the code: esbuild-wasm is already initialized and running in
the worker (`initEsbuild` / `ensureInit`, lines 135-160), compiling from a wasm
binary shipped as a local Tauri resource (`esbuild.wasm?url`, line 20) -- nothing
is fetched from a CDN, and it works fully offline. Bundle mode uses the same wasm
module; it is the same engine with a different entry call (`esbuild.build` instead
of `esbuild.transform`).

What is well-established but should be spiked in *this* setup: esbuild's browser
build supports `build({ bundle: true, plugins: [...] })` with **async**
`onResolve` / `onLoad` callbacks. In-browser code playgrounds rely on exactly this
pattern (a virtual-FS plugin that serves files esbuild asks for). Two details
worth stating because they are easy to get wrong:

- **The `worker: false` flag is not a blocker.** It is currently set in
  `initEsbuild` (line 144). That flag controls whether *esbuild* spawns its own
  Web Worker; we set it false because we are already inside one
  (`sandbox-compiler.worker.ts`). Plugins work regardless of that flag.
- **`transformSync` / `buildSync` do NOT support plugins** -- but we use the
  async `build`, so that restriction does not apply.

The honest risk: I have not executed bundle-mode + plugins inside this specific
Tauri-asset-protocol + Vite-worker stack. The first task of the implementation
phase is a 1-file spike that bundles two trivial files importing each other and
renders the result. If that spike fails, the fallbacks in "Alternatives" apply.

### The design: one virtual-FS resolver plugin doing two jobs

Replace `bindImportsToGlobals` + `esbuild.transform` with `esbuild.build` and a
single plugin. The plugin handles both kinds of imports:

```
esbuild.build({
  stdin: { contents: entrySource, loader: 'tsx', resolveDir: '/', sourcefile: 'animation.tsx' },
  bundle: true,
  format: 'iife',
  globalName: 'AnimationExports',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  write: false,
  plugins: [virtualFs(fileMap)],
});
```

The plugin:

- **Bare imports (react / remotion / @remotion/player):** `onResolve` tags them
  with a custom namespace; `onLoad` returns a tiny shim
  `module.exports = window.RemotionRuntime` (or `window.React`). Because esbuild
  compiles a named import of a CommonJS module into a property access, `import { interpolate } from 'remotion'`
  becomes `RemotionRuntime.interpolate` -- exactly the binding the regex hack
  produces today, but generated by the bundler instead of hand-rolled regex. This
  preserves the existing window-globals contract (`GLOBAL_FOR`, lines 36-42) and
  keeps the bundle from inlining React/Remotion (it stays externalized to the
  globals the sandbox iframe already loads -- see the preview-sandbox KB note).
- **Relative imports (`./x`, `../x`):** `onResolve` resolves them against the
  file map keys (handling `.tsx` / `.ts` / index resolution); `onLoad` returns
  `fileMap[resolvedPath]` with the right loader. No disk access.
- **Anything else** (an unknown bare import): `onResolve` returns an error so the
  preview shows a clear "cannot import 'lodash' -- only react/remotion are
  available" message instead of a cryptic runtime failure. This is strictly
  better than today, where an unknown bare import silently survives transform and
  explodes in the sandbox.

Net effect: bundle mode is not just "more capable", it **deletes** the regex
import rewriter (`IMPORT_RE`, `rewriteClause`, `bindImportsToGlobals`, lines
36-102) -- roughly 70 lines of fragile string surgery -- and replaces it with a
resolver the bundler drives. That is a maintainability win independent of
multi-file.

### Perf / wasm constraints

- Bundle mode does more work (resolve graph, multiple `onLoad` round-trips) than a
  single transform. For a handful of small TSX files this is milliseconds; the
  dominant cost remains the one-time ~12 MB wasm init (`INIT_TIMEOUT_MS = 10_000`,
  line 108), which is unchanged.
- Each `onLoad` for a relative file is an async hop into JS and back. Keep the
  file map in memory in the worker (passed in the compile message) so there is no
  per-hop IPC to the main thread mid-bundle. **Do not** make `onLoad` call back
  to Rust/disk -- that would serialize a disk read into every module resolution
  and could reintroduce a hang class similar to T-013.
- Watch the IIFE output: `globalName: 'AnimationExports'` and the
  `window.AnimationExports.default` contract (worker header lines 14-15) must be
  preserved so `PreviewPanel` / the sandbox keep reading the default export the
  same way.

### Alternatives considered

- **Manual concatenation (poor-man's bundler):** topologically sort files, strip
  imports, concatenate. Rejected -- it cannot handle name collisions, re-exports,
  or `import * as`, and it reinvents a bundler badly. The regex hack already shows
  how brittle string-level import surgery is.
- **A second in-browser bundler (`@rollup/browser`, etc.):** rejected -- esbuild
  is already loaded and offline-shipped; adding Rollup-wasm doubles the bundle
  weight and the maintenance surface for no gain.
- **Bundle on the Rust side (esbuild/swc native, or Remotion's own bundler):**
  viable long-term and probably required for high-fidelity MP4 export anyway, but
  a much bigger lift and it moves compile off the worker. Out of scope for the
  first increment; revisit when export goes high-fidelity.

---

## 2. File source of truth

**Recommendation: the frontend passes esbuild a file map; the worker stays
fs-free.** This preserves the current clean separation (the worker is a pure
string-in / string-out compiler, lines 29-32) and keeps it sandboxable.

Data flow, generalizing what exists:

```
Rust watcher (recursive over src/)
   -> emits ProjectFilesPayload { files: { "animation.tsx": "...", "components/Card.tsx": "..." } }
      (today: ChangedPayload { code }, file_watch.rs:30-33)
   -> App.tsx listener setFiles(map)
      (today: setCode(string), App.tsx:254-255)
   -> PreviewPanel posts { type: "compile", files: map, entry: "animation.tsx" }
      (today: { type: "compile", code }, PreviewPanel.tsx:226)
   -> worker builds with virtualFs(map), entry = files[entry]
```

Recompile trigger: today the watcher fires on `animation.tsx` writes
(`file_watch.rs:56-60`). For multi-file it must fire on **any** `.tsx`/`.ts`
under the project's source tree. Two concrete changes in `file_watch.rs`:

- Switch `RecursiveMode::NonRecursive` (line 69) to `Recursive` so nested
  `components/` changes are seen.
- Replace the `== animation.tsx` name filter (lines 56-60) with an
  extension/path filter (`.tsx`/`.ts` under `src/`), then on debounce read the
  whole set and emit the map. The existing ~150ms debounce (`DEBOUNCE`, line 26)
  already coalesces multi-file save bursts -- keep it.

Where source files live: see section 4. If sources move under a `src/`
subdirectory, watch `src/`; if they stay flat in the project root, exclude
non-source files (`project.json`, `conversation.json`, `assets/`) from the map.

One caveat to call out: `projects_root` is hand-duplicated in **four** places
(decision 0002 notes `projects.rs`, `claude_bridge.rs`; export.rs's header notes
itself and `zip.rs` -- "the four are hand-duplicated"). The watcher already uses
`claude_bridge::project_dir`. Multi-file does not add a fifth copy, but the
recursive-read logic should live in one helper, not be re-implemented per command.

---

## 3. Editor UX

Today the Monaco editor is effectively a **read-only mirror**: disk is the source
of truth, `animation://changed` pushes content in (App.tsx:254), and both Claude
(terminal) and the user write the file. The panel shell is now react-mosaic
(decision 0003): panels are draggable tiles, each with a header.

**Recommendation: phase the editor.**

- **First increment -- file tree + read-only mirror.** Add a thin file-tree
  column to the Code panel listing the project's source files; clicking one shows
  that file (still mirroring disk, still read-only-ish). This is the smallest
  change that makes multi-file *visible* and *navigable*. It does not touch the
  save path, so it cannot regress editing. The editor already swaps content on
  project change; swapping on file selection is the same mechanism keyed by file
  path instead of slug.
- **Later -- multi-file editable.** Let the user edit any file; on save, write
  that specific path via a generalized `save_animation(slug, path, code)`. This
  is more work (dirty-state per file, conflict with the watcher when Claude writes
  the same file) and should wait until the read-only tree has shipped.

Tabs vs tree: prefer a **tree** (left rail) over tabs as the primary navigator --
projects can have many files and tabs do not scale; a tree mirrors the on-disk
layout the user sees in Finder (decision 0002 made the folder user-visible on
purpose). Tabs can be added later as a convenience for open files, on top of the
tree. Both live *inside* the existing Code mosaic tile -- no new top-level panel,
so react-mosaic layout (decision 0003) is untouched.

Rough ASCII layout (ASCII only, no box-drawing):

```
+----------------------------------------------------------------------+
|  ClaudeMotion -- my-project                          [export] [...]  |
+------------------+---------------------------+-----------------------+
|  CODE            |  CODE (editor)            |  PREVIEW              |
|  (file tree)     |                           |  (phone bezel)       |
|                  |  1  import {Card} from     |                      |
|  > src/          |     './components/Card'   |    +-------------+    |
|    animation.tsx*|  2  import {theme} from    |    |           |    |
|    theme.ts      |     './theme'             |    |  1080x1920  |    |
|    easing.ts     |  3                        |    |   preview   |    |
|    v components/ |  4  export default ...    |    |           |    |
|       Card.tsx   |                           |    +-------------+    |
|       Logo.tsx   |                           |   [replay] [safe]    |
+------------------+---------------------------+-----------------------+
|  TERMINAL  (embedded Claude CLI -- writes any file in the project)   |
+----------------------------------------------------------------------+
   * = entry point / default-export root composition
```

The tree column and editor column can be one mosaic tile internally split, or the
tree can be a collapsible rail within the Code tile. Either keeps the three
top-level mosaic regions (Code / Preview / Terminal) intact.

---

## 4. Entry-point model

- **`animation.tsx` stays the entry point** -- the root composition and the
  default export the sandbox renders (`window.AnimationExports.default`, worker
  lines 14-15). Nothing downstream of the bundle changes: the IIFE still exposes
  one default export. This keeps the preview, replay, and (eventually) export
  contracts stable.
- **Other files are modules it imports.** Recommended conventions:
  - `components/` -- reusable presentational components (`components/Card.tsx`).
  - `theme.ts` -- shared design tokens (colors, fonts, spacing).
  - `easing.ts` -- shared spring configs / easing helpers (the prompt already
    teaches a spring-defaults vocabulary; a shared module is the natural home).
  - Files import each other with **relative** paths only (`./`, `../`). Bare
    imports remain restricted to react / remotion / @remotion/player.
- **Source location:** two options.
  - (a) Keep files flat in the project root alongside `animation.tsx`; watch the
    root and exclude `project.json` / `conversation.json` / `assets/`.
  - (b) Move sources under `src/` (`src/animation.tsx`, `src/components/...`).
    Cleaner separation from project metadata and assets, and makes the recursive
    watch trivially "watch `src/`".
  Recommend (b) `src/` for new projects to keep the watch scope unambiguous, but
  it is a larger change (touches `load_animation`/`save_animation` paths, export,
  and the prompt). (a) is the lower-friction first step. Decide based on how much
  of the path you want to disturb in increment 1; the doc's phased plan assumes
  (a)-then-(b) is acceptable but does not require the move up front.

---

## 5. Prompt changes (`remotion-skills.txt`)

The prompt (29 lines) currently asserts single-file ownership in several spots.
The minimum edits to teach the multi-file model:

- Change "The file you own is animation.tsx ... a single TypeScript/React file"
  to: you own a **project** whose entry point is `animation.tsx`; you may create
  additional `.tsx`/`.ts` modules and import them with **relative** paths.
- Keep "export a single default component" **but scope it to `animation.tsx`**:
  the entry file exports the default root composition; other modules export named
  components/helpers.
- Add the conventions from section 4 (`components/`, `theme.ts`, `easing.ts`) so
  Claude organizes consistently rather than inventing a layout per project.
- Restate the import constraint explicitly: only `react`, `remotion`,
  `@remotion/player` may be imported as bare modules; everything else must be a
  relative import to a file in the project; no third-party npm packages (this
  matches the new compiler's "unknown bare import -> error" behavior from
  section 1, so the prompt and the compiler agree).
- Keep the "edit files on disk, never paste code into chat" rule unchanged -- it
  already generalizes to multiple files.

Sequencing note: do **not** flip the prompt to multi-file until the compiler
supports it. If the prompt invites cross-file imports before bundle mode lands,
Claude will write imports that silently break the preview -- the worst failure
mode (a confident-looking project that will not render). Prompt change ships in
the same increment as the compiler change, not before.

---

## 6. Phased plan

Each phase is independently shippable and leaves the app working.

**Phase 0 -- prerequisite gate (do this first, no multi-file code).**
Confirm the preview compile path is stable (T-013 / former T-003 closed and
verified). Rationale in section 7. If the preview is still flaky, stop here.

**Phase 1 -- compiler bundle-mode spike + cutover (highest value, highest risk).**
- Spike: bundle two trivial inter-importing files via `esbuild.build` + a virtual
  plugin in the worker; confirm the IIFE renders in the sandbox.
- Replace `transform` + `bindImportsToGlobals` with `build` + the virtual-FS
  plugin (section 1). Single-file projects must compile **identically** -- a
  one-file `fileMap` through bundle mode produces the same default export. Ship
  this even before the editor/tree exists: it is a strict superset, deletes the
  regex hack, and improves error messages. This is the smallest first step that
  delivers value.

**Phase 2 -- file source of truth (recursive watch + file map).**
- Generalize the worker compile message and `PreviewPanel` to pass a file map
  (section 2). Generalize `file_watch.rs` to recursive + extension filter,
  emitting a map. `App.tsx` tracks `files` instead of one `code` string.
- After this, Claude can create `components/Card.tsx`, import it, and the preview
  recompiles correctly -- multi-file works end to end with the existing read-only
  editor still showing only `animation.tsx`.

**Phase 3 -- prompt + conventions.**
- Update `remotion-skills.txt` (section 5) so Claude actually uses multi-file, and
  establish `components/` / `theme.ts` / `easing.ts`. Ship in lockstep with the
  compiler being ready (it now is, after Phase 1/2).

**Phase 4 -- editor file tree (read-only mirror).**
- Add the file-tree navigator to the Code mosaic tile (section 3, first
  increment). Read-only; no save-path changes.

**Phase 5 -- export + multi-file editing (later).**
- Export: copy the whole source tree, not just `animation.tsx`
  (`export.rs`, `zip.rs`).
- Editor: make non-entry files editable with per-file save. Lowest priority --
  Claude is the primary author; the user editing arbitrary files is a power-user
  nicety.

Phases 1-2 are the real unlock. 3 makes Claude use it. 4-5 are polish.

---

## 7. Tradeoffs and risks (called out honestly)

- **Build it AFTER preview stability, not now.** This is the main
  recommendation. Phase 1 rewrites the *exact* compile call
  (`transform` -> `build`) that T-013 is stabilizing. Doing both at once means a
  preview regression is unattributable -- you will not know whether the hang came
  back because of the wasm init path or because of the new bundle/plugin path.
  Stabilize the single-file preview first, lock it with the diagnosis from T-013,
  *then* cut over to bundle mode as a clean, separately-bisectable change.
- **Bundle-mode-in-wasm is high-confidence but not yet verified here.** It is a
  well-trodden pattern, but it has not been run in this Tauri-asset-protocol +
  Vite-worker setup. The Phase 1 spike is the cheap insurance; treat a green
  spike as the real go/no-go, not this document.
- **New hang surface.** The current code fought a compile *hang*
  (`INIT_TIMEOUT_MS`, the explicit-fetch rationale at lines 129-145). Bundle mode
  adds async `onLoad`/`onResolve` round-trips -- a plugin that never resolves a
  promise would hang the build the same way. Mitigation: keep the file map fully
  in memory in the worker (no disk/IPC inside resolution), and wrap `build` in
  the existing `withTimeout` (line 110) like init already is.
- **Unknown-import behavior is a feature, not just a risk.** Today an unknown
  bare import slips through transform and dies in the sandbox; bundle mode lets us
  fail it at compile with a clear message. Make sure the message is friendly
  ("only react/remotion available") so Claude/users self-correct.
- **Four-place storage-root duplication (decision 0002) is a latent footgun.**
  Multi-file touches the watcher and export, both of which independently resolve
  the projects root. Do not add a fifth copy; consolidate the recursive-read
  helper.
- **Watcher/editor write conflicts (Phase 5).** Once the user can edit non-entry
  files while Claude also writes them, the `animation://changed` mirror can clobber
  unsaved edits. The single-file app already has this tension for `animation.tsx`;
  multi-file multiplies it. Defer real conflict handling to Phase 5 and keep the
  editor read-only until then.
- **Export fidelity is a separate, bigger problem.** Per the export-rendering and
  client-side-rendering KB notes, high-fidelity MP4 export is its own unsolved
  axis. Multi-file does not solve or worsen it, but a future native/Rust bundler
  for export would also be the natural place to share resolution logic with the
  preview. Keep the virtual-FS resolver design portable so it can be reused if
  export moves to a real bundler.

---

## Open questions for Peter

- Source layout: flat project root vs `src/` subdir (section 4)? Affects how
  invasive Phase 2's watcher change is.
- Should the editor ever become multi-file *editable*, or is read-only-mirror
  forever acceptable given Claude is the author? (Decides whether Phase 5's editor
  half is worth building.)
- Is any third-party npm ever in scope (e.g. a easing/util lib), or is the
  "react + remotion only" constraint permanent? Permanent makes the compiler
  simpler (no node_modules resolution, ever).
