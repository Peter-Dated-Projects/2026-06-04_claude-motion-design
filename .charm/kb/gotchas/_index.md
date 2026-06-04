# Gotchas

Traps, flaky behavior, and non-obvious constraints -- the things that bite you twice.

| Note | Summary | Status |
|---|---|---|
| [react-18-pin-not-19](react-18-pin-not-19.md) | React is deliberately pinned to 18.3.x, not 19 — the preview runtime bundles React 18 UMD, so bumping React breaks the sandbox preview. | current |
| [tauri-plugin-three-place-wiring](tauri-plugin-three-place-wiring.md) | Enabling a Tauri 2 plugin needs three edits (Cargo.toml, lib.rs, capabilities); a missing capability fails silently at runtime, not build time. | current |
| [storage-std-only-no-uuid-chrono](storage-std-only-no-uuid-chrono.md) | Local project storage hand-rolls UUIDv4 and RFC3339 from std (ticket scope excluded Cargo.toml); don't swap in uuid/chrono without adding the deps first. | current |
