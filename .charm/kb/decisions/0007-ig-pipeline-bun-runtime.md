---
id: 0007-ig-pipeline-bun-runtime
root: decisions
type: decision
status: current
summary: "The Instagram reel->brief pipeline is built as Bun + TypeScript scripts under scripts/ig-pipeline/, runnable/testable from the CLI with no UI or Tauri wiring in v1. Chosen over Node (slower cold start, the existing scripts/*.mjs island) and Python (would add a second runtime to bundle alongside the Node render-toolchain)."
created: 2026-06-06
updated: 2026-06-06
---

Decision: the reel-ingestion-and-motion-brief pipeline is a standalone Bun + TS
island under `scripts/ig-pipeline/`. Each stage (download, clip, frames, score,
analyze, store) is its own module with a thin `import.meta.main` CLI; `run.ts`
chains them. Tested with `bun test` — deterministic scoring tests against
committed fixture frames, plus an opt-in env-gated e2e smoke run against a real URL.

Why Bun over the alternatives:
- vs Python (what the spike prototyped in): shipping the app would then need a
  Python runtime bundled on top of the existing Node render-toolchain — two
  runtimes. Bun keeps it to TypeScript.
- vs Node: Bun runs `.ts` directly with fast cold start and a built-in test
  runner; cleaner than adding to the `scripts/*.mjs` Node island.

External binaries (`yt-dlp`, `ffmpeg`/`ffprobe`, `claude`) are spawned as
subprocesses and assumed present on the dev machine for v1; vendoring them into
the shipped render-toolchain is a later UI/integration concern.

Explicitly deferred (non-goals this session): all UI (no IG workspace/panels),
all Tauri/Rust wiring (no commands/events/terminal_input delivery), toolchain
bundling, the rotoscoping pipeline, and the stream-json single-turn image
optimization. See `.charm/PROJECT.md` and `.charm/proposals/SPIKE-instagram-pipeline.md`.
