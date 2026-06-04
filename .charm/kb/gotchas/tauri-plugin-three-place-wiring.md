---
id: tauri-plugin-three-place-wiring
root: gotchas
type: gotcha
status: current
summary: "Enabling a Tauri 2 plugin (dialog/shell/fs) requires edits in THREE places — Cargo.toml dep, .plugin(...) in lib.rs, and a permission in capabilities/default.json — and missing the capability fails silently at runtime, not at build time."
created: 2026-06-04
updated: 2026-06-04
---

Tauri 2 split the old v1 "allowlist" into a three-part model. To use a plugin you must
wire it in all three of these, or it won't work:

1. `src-tauri/Cargo.toml` — add the crate (e.g. `tauri-plugin-dialog = "2"`).
2. `src-tauri/src/lib.rs` — register it on the builder: `.plugin(tauri_plugin_dialog::init())`.
3. `src-tauri/capabilities/default.json` — grant a permission set in `"permissions"`
   (e.g. `"dialog:default"`, `"shell:default"`, `"fs:default"`).

The dangerous part: if you do (1) and (2) but forget (3), the app still COMPILES and runs.
The plugin only fails when JS actually invokes a command — the capability check rejects it
at runtime with a permission error. So a missing capability is invisible until the feature
is exercised. The scaffold (T-020) wired all three for dialog/shell/fs with the `:default`
permission sets.

Downstream note: `shell:default` does NOT allow spawning arbitrary binaries. The Claude CLI
bridge (T-IMPL-003 / T-022) will need an explicit `shell:allow-execute` or a scoped
sidecar/command permission added to the capability file — `:default` won't cover it.

Also: capabilities reference windows by label. `tauri.conf.json` must give the window
`"label": "main"` to match `"windows": ["main"]` in the capability file (the scaffold sets
this explicitly rather than relying on the implicit default).
