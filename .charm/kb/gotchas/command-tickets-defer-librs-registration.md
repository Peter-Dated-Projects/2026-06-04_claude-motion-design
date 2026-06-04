---
id: command-tickets-defer-librs-registration
root: gotchas
type: gotcha
status: current
summary: "Command-adding tickets ship the command file but do NOT register it in lib.rs (out of their touches); new Tauri commands and new toolbar components sit unwired until the integration pass mounts them."
created: 2026-06-04
updated: 2026-06-04
---

Tickets that add backend commands declare only their own new files in `touches`
(e.g. T-028 touches `commands/zip.rs`, `Cargo.toml`, `ProjectMenu.tsx`), but
`src-tauri/src/lib.rs` -- where the module tree and `generate_handler!` live --
is **not** in their scope. Same story on the frontend: `Toolbar.tsx`/`App.tsx`
are owned by the scaffold/integration tickets, so a new component like
`ProjectMenu.tsx` ships unmounted.

Consequence: a freshly shipped command file is **dead code** until lib.rs is
wired -- it is not even compiled, because without `pub mod <name>;` in the
`mod commands { ... }` block it is not part of the crate, so `cargo check` skips
it and silently passes. T-022 (claude.rs) and T-028 (zip.rs) both shipped this
way.

Known-pending wiring as of T-028 (the integration pass, T-032, must do this):
- `lib.rs` -> add `pub mod claude;` / `pub mod zip;` under `mod commands`, and
  add the handlers to `generate_handler!`:
  `commands::zip::export_project_zip`, `commands::zip::import_project_zip`
  (plus the claude.rs commands from T-022).
- `Toolbar.tsx` -> render `<ProjectMenu />` (it is self-contained; just import
  and mount it).

To VERIFY a command file compiles without leaving an out-of-scope edit: add the
`pub mod` + handler lines to lib.rs temporarily, run `cargo check`, then
`git checkout -- src-tauri/src/lib.rs`. That is how T-028's zip.rs was confirmed
to build against zip 0.6.6 and the Tauri 2 `DialogExt` API.

Note: Rust-side file dialogs (`app.dialog().file()...blocking_save_file()`)
bypass the webview capability system, so they need no `dialog:allow-*`
capability entry -- only `dialog:default` (already present) to load the plugin.
See [[tauri-plugin-three-place-wiring]] for the contrasting plugin-enable case.
