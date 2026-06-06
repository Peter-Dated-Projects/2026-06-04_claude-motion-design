# Claude Motion

A desktop app for generating and iteratively editing [Remotion](https://www.remotion.dev/)
animations by chatting with the real Claude CLI.

Claude Motion embeds an interactive `claude` session in a terminal panel. You
describe the animation you want; Claude edits `animation.tsx` with its own tools,
a file watcher picks up the change, and a live preview re-renders instantly — all
inside one window. When you're happy, export to a standalone `.tsx`, a ZIP, or a
rendered MP4.

## How it works

```
You type in the terminal  →  claude CLI edits animation.tsx  →  file watcher
fires  →  preview + editor re-read the file  →  you see the result live
```

The terminal is pure I/O — a real PTY running the actual CLI, not a wrapper. The
app never parses Claude's output; it just watches the file Claude writes.

## Features

- **Chat-driven editing** — an embedded `claude` CLI session edits your animation directly.
- **Live preview** — bundled Remotion runtime in a 1080×1920 phone frame, offline-capable, with replay controls and a safe-zone overlay.
- **Code panel** — Monaco editor with tabs and a file tree; see and hand-edit what Claude wrote.
- **Workspaces** — saved panel layouts for the stages of a design flow, over shared terminal/preview/editor sessions.
- **Drag-and-drop assets** — drop a file onto the terminal to type its path at the prompt.
- **Export** — standalone `.tsx`, ZIP (import/export), or an H.264 MP4 rendered via headless Chrome + ffmpeg (toolchain downloaded on demand).

## Stack

- **Frontend** — React 18 + Vite + TypeScript in a Tauri webview (`src/`)
- **Backend** — Rust / Tauri 2 (`src-tauri/src/`)
- **State** — Zustand (`src/store/`)
- **Terminal** — xterm.js over a `portable-pty` bridge to the `claude` CLI
- **Preview** — bundled browser Remotion runtime in a sandboxed iframe

## Prerequisites

- [Bun](https://bun.sh/)
- Rust toolchain (for Tauri) — see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- The [Claude CLI](https://docs.claude.com/en/docs/claude-code) installed and on your PATH

## Getting started

```bash
bun install
bun run tauri dev      # run the desktop app in dev mode
```

Other scripts:

```bash
bun run dev            # frontend only (Vite) — no Tauri shell
bun run build          # typecheck + build frontend
bun run tauri build    # produce a distributable app bundle
```

The preview runtime is rebuilt automatically before `dev` and `build` via
`scripts/build-preview-runtime.mjs`.

## Project layout

See [CLAUDE.md](CLAUDE.md) for the full orientation map. The short version:

- `src/` — React frontend (panels, stores, preview sandbox)
- `src-tauri/src/` — Rust backend (PTY bridge, file watcher, commands)
- `scripts/` — Remotion render + preview-runtime build scripts

## More docs

- [CLAUDE.md](CLAUDE.md) — architecture map and key flows
- [SETUP.md](SETUP.md) — onboarding and smoke tests
- [PLAN.md](PLAN.md) — roadmap and task tracking
