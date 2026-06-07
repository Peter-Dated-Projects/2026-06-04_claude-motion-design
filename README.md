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
- **Rotoscoping (optional)** — cut a subject out of a video into a transparent PNG sequence via a local SAM2 GPU microservice, for use as a sprite asset. Auto-hidden when the service isn't running. See below.

## Rotoscoping (optional)

A separate, optional workspace turns a video clip into a transparent PNG sequence —
the subject isolated from its background — that Claude can drop into a composition
as a sprite. It's backed by a local [SAM2](https://github.com/facebookresearch/sam2)
microservice in `microservices/rotoscoping/` that runs on an NVIDIA CUDA GPU
(Windows or Linux — **not** macOS). The app probes the service at startup; if it
isn't reachable, the rotoscoping workspace is hidden and the rest of the app works
normally.

In the workspace you load a source video (persisted in the project's assets), trim
a clip range, place foreground/background prompt points on a reference frame, and
run the job. Multiple jobs can be queued. Outputs play back as looping stop-motion
with playback controls, can be compared side-by-side against the source clip, and
can be renamed, deleted, copied by name, or exported to GIF / MP4 / MOV. The
service auto-configures for the detected GPU generation (30/40/50-series and
similar) and defaults to the SAM2 `base_plus` model — smaller and faster than
`large`, overridable via the `ROTO_SAM2_*` environment variables.

See [microservices/rotoscoping/README.md](microservices/rotoscoping/README.md) for
how to run it.

## Stack

- **Frontend** — React 18 + Vite + TypeScript in a Tauri webview (`src/`)
- **Backend** — Rust / Tauri 2 (`src-tauri/src/`)
- **State** — Zustand (`src/store/`)
- **Terminal** — xterm.js over a `portable-pty` bridge to the `claude` CLI
- **Preview** — bundled browser Remotion runtime in a sandboxed iframe
- **Rotoscoping service (optional)** — Python + SAM2 over FastAPI, reached by the app over HTTP (`microservices/rotoscoping/`)

## Prerequisites

- [Bun](https://bun.sh/)
- Rust toolchain (for Tauri) — see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- The [Claude CLI](https://docs.claude.com/en/docs/claude-code) installed and on your PATH

Optional — only for the rotoscoping workspace:

- An NVIDIA CUDA GPU and the rotoscoping microservice (Windows or Linux, not macOS). Setup in [microservices/rotoscoping/README.md](microservices/rotoscoping/README.md).

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
- `microservices/rotoscoping/` — optional SAM2 rotoscoping microservice (Python)

## More docs

- [CLAUDE.md](CLAUDE.md) — architecture map and key flows
- [SETUP.md](SETUP.md) — onboarding and smoke tests
- [PLAN.md](PLAN.md) — roadmap and task tracking
- [microservices/rotoscoping/README.md](microservices/rotoscoping/README.md) — the optional rotoscoping microservice
