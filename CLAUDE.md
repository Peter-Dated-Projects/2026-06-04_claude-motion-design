# Claude Motion — project map

A Tauri desktop app (macOS/Windows/Linux) for generating and iteratively editing
[Remotion](https://www.remotion.dev/) animations by chatting with the real Claude
CLI. The CLI runs interactively in an embedded terminal, edits `animation.tsx`
with its own tools, and a file watcher pushes those edits into a live preview.

This file is the orientation map — read it first, then open only the files a task
actually needs. Keep it current: when you move a subsystem or change a contract,
update the relevant row here in the same change.

## Stack

- **Frontend:** React 18 + Vite + TypeScript, in a Tauri webview (`src/`)
- **Backend:** Rust / Tauri 2 (`src-tauri/src/`)
- **State:** Zustand stores (`src/store/`)
- **Terminal:** xterm.js rendering a real `claude` CLI over a PTY
- **Preview:** bundled Remotion runtime, 1080x1920 phone frame, offline-capable

Frontend ↔ backend: `invoke("command", args)` from `@tauri-apps/api/core` calls a
Rust `#[tauri::command]`; the backend pushes streams via `emit` → frontend
`listen("event://name")`. All commands are registered in `src-tauri/src/lib.rs`'s
`generate_handler!` — that list is the canonical index of the backend surface.

## Where things live

### Frontend (`src/`)
- `App.tsx` — root; layout tree state, default layout, panel show/hide, persistence
- `main.tsx` — entry point
- `types/index.ts` — shared TS types
- `store/projectStore.ts` — active project + project list
- `store/uiStore.ts` — active editor file, selected text, render logs
- `store/renderLogStore.ts` — preview compile output
- `store/workspaceStore.ts` — workspaces = stages of the design flow within a
  project. A workspace is just a saved panel *layout* over the SAME three
  singleton panels; switching workspaces swaps the tree `SplitLayout` renders
  while the Claude PTY / preview / editor hosts stay mounted, so those sessions
  are shared across workspaces. The stages themselves are hard-coded config in
  `WORKSPACE_DEFS` (id/name/icon/availablePanels/defaultLayout — never persisted,
  users can't create or configure them); only the mutable bits persist — each
  workspace's rearranged `layout` and the `activeWorkspaceId`. `availablePanels`
  scopes a stage's show/hide menu (a panel not listed can't be added there).
  Editor tabs are still global (uiStore) → effectively all-synced; scope
  `openFiles`/`activeFile` per workspace here to make tab sync selectable.

**Panels** (`components/`)
- `PanelLayout/SplitLayout.tsx` — custom recursive split-pane engine. Pointer-driven
  (not HTML5 DnD) panel rearrange + gutter resize, with a full-viewport shield so the
  preview iframe / Monaco don't swallow the pointer mid-drag.
- `TerminalPanel/TerminalPanel.tsx` — the "Claude" panel. xterm.js wired to the PTY
  bridge; also handles native OS file drag-drop (drop a file → its path is typed at
  the prompt). See "Drag-and-drop" below.
- `CodePanel/CodePanel.tsx` — tabs, file tree, Monaco editor
- `CodePanel/AssetsView.tsx` — image-asset thumbnail grid + add-by-drop
- `CodePanel/MonacoEditor.tsx`, `hooks/useMonaco.ts` — editor mount/config
- `PreviewPanel/PreviewPanel.tsx` — Remotion player, phone bezel, replay controls,
  render logs (`PhoneBezel`, `ReplayControls`, `SafeZoneOverlay`, `RenderLogPanel`)
- `layout/` — `Toolbar`, `StatusBar`, `ProjectMenu`, `ExportMenu`,
  `WorkspaceBar` (bottom bar of design-flow stage tabs; backed by workspaceStore)
- `Onboarding.tsx`, `Settings.tsx` — first-run + settings
- `RenderModal.tsx` — video-export modal: live preview (reuses `PreviewPanel`) +
  format/quality settings + save-location picker + Render button, then phased
  progress (install toolchain → render → done/error). Opened via the `videoExportOpen`
  flag in uiStore (set by ExportMenu's MP4 item).
- `workers/sandbox-compiler.worker.ts` + `assets/sandbox-frame.html` — preview compile sandbox

### Backend (`src-tauri/src/`)
- `lib.rs` — crate root: plugin setup, managed state, **the full command registry**
- `claude_bridge.rs` — CLI path resolution + materializes bundled MCP config / skills
  prompt into the app config dir at startup
- `pty_bridge.rs` — single interactive `claude` PTY session (`portable-pty`).
  Commands: `terminal_open`, `terminal_input`, `terminal_resize`, `terminal_close`.
  Events: `terminal://data` (stdout), `terminal://exit`.
- `file_watch.rs` — watches `animation.tsx`; emits `animation://changed`
- `commands/projects.rs` — project CRUD, file I/O, assets (`add_asset` takes bytes),
  conversation persistence, reveal-in-finder
- `commands/claude.rs` — `check_claude_installed`, `get/set_claude_cli`
- `commands/export.rs` — `export_tsx` (writes animation.tsx + assets) and `export_mp4`
  (renders to video — see "MP4 export" below). `commands/zip.rs` — ZIP export + import
- `commands/render_toolchain.rs` — on-demand MP4-render toolchain: `render_toolchain_status`
  + `install_render_toolchain` (download → sha256-verify → unpack into app-data,
  streaming `toolchain://progress`). The `TOOLCHAIN` const holds the hosted archive's
  url/sha256/size — produced + reported by `scripts/build-render-toolchain.mjs`.

### Render / scripts
- `scripts/render-mp4.mjs` — Node script driving Remotion's bundler + renderer
  (headless Chrome + ffmpeg) to turn a project's `animation.tsx` into an H.264 MP4.
  Writes a throwaway entry that wraps the animation's default export in a
  `<Composition>` (1080x1920, fps/duration resolved exactly like the preview).
  Streams `PROGRESS <0..1>` lines on stdout.
- `scripts/build-preview-runtime.mjs` — builds the bundled browser Remotion runtime
  resource used by the preview sandbox.

### Config
- `src-tauri/tauri.conf.json` — window, bundle, CSP. Note: `dragDropEnabled` is
  unset → defaults to **true** (native OS drag-drop; HTML5 `dataTransfer` does NOT
  expose file paths under this mode).
- `src-tauri/capabilities/default.json` — permission set for the main window

## Key flows

- **Edit loop:** user types in TerminalPanel → keystrokes → `terminal_input` → PTY
  stdin. Claude edits `animation.tsx` directly. `file_watch.rs` sees the change →
  `animation://changed` → editor + preview re-read the file. The terminal is pure
  I/O; it never parses Claude's output.
- **Drag-and-drop:** the window uses native OS drag-drop, so file paths arrive via
  `getCurrentWebview().onDragDropEvent()` (window-global; hit-test the drop position
  against the target panel's rect). TerminalPanel uses this to type a dropped file's
  path at the prompt. NOTE: `AssetsView` still uses HTML5 `dataTransfer.files`, which
  under `dragDropEnabled: true` does not receive files — its drop-to-add is likely
  non-functional and should migrate to the same native event (reading bytes from the
  path via the backend).

## Other docs
- `SETUP.md` — onboarding + smoke tests
- `PLAN.md` — roadmap / task tracking
- `PANELS-REDESIGN-HANDOFF.md` — why SplitLayout replaced react-mosaic, and its model
