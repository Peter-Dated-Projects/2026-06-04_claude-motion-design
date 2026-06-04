# Gotchas

Traps, flaky behavior, and non-obvious constraints -- the things that bite you twice.

| Note | Summary | Status |
|---|---|---|
| [react-18-pin-not-19](react-18-pin-not-19.md) | React is deliberately pinned to 18.3.x, not 19 — the preview runtime bundles React 18 UMD, so bumping React breaks the sandbox preview. | current |
| [tauri-plugin-three-place-wiring](tauri-plugin-three-place-wiring.md) | Enabling a Tauri 2 plugin needs three edits (Cargo.toml, lib.rs, capabilities); a missing capability fails silently at runtime, not build time. | current |
| [storage-std-only-no-uuid-chrono](storage-std-only-no-uuid-chrono.md) | Local project storage hand-rolls UUIDv4 and RFC3339 from std (ticket scope excluded Cargo.toml); don't swap in uuid/chrono without adding the deps first. | current |
| [claude-cli-stream-json-flags](claude-cli-stream-json-flags.md) | `claude -p --output-format stream-json` requires `--verbose`, and incremental text_delta tokens need `--include-partial-messages`; neither was in the ticket arg list but both are mandatory. | current |
| [canonical-canvas-is-vertical](canonical-canvas-is-vertical.md) | The shipped system prompt (remotion-skills.txt) is canonical: vertical 1080x1920, durationInFrames 150. The prompt-engineering.md research note still says 1920x1080 — do not "fix" the prompt to match it. | current |
| [monaco-cdn-offline-loader](monaco-cdn-offline-loader.md) | @monaco-editor/react fetches Monaco from a CDN by default; the offline desktop app must loader.config({ monaco }) against the bundled monaco-editor and wire workers via Vite ?worker imports. | current |
