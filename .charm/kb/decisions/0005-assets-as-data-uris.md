---
id: 0005-assets-as-data-uris
root: decisions
type: decision
status: current
summary: "Project image assets are surfaced to the frontend as inline base64 data: URIs (not the Tauri asset:// protocol), and the Assets view is display-only until multi-file compilation lands."
created: 2026-06-04
updated: 2026-06-04
---

# Image assets as inline data: URIs

The Code panel's Assets view (T-048) lists and adds image files under a project's
`assets/` folder. Two calls worth remembering:

## How thumbnails reach the WebView

`list_assets` / `add_asset` in `src-tauri/src/commands/projects.rs` return each
image as an `AssetFile { name, dataUri }` where `dataUri` is a base64
`data:<mime>;base64,...` string. We chose this over the Tauri asset protocol
(`asset://` / `convertFileSrc`) because data URIs render in the WKWebView with
zero asset-scope/CSP configuration -- the simplest thing that works for a small,
local set of files. The encoder is hand-rolled (std-only) to avoid adding the
`base64` crate, matching this module's existing no-extra-crates philosophy (same
reason it hand-rolls uuid/rfc3339).

Trade-off to revisit if asset folders ever get large: data URIs re-read and
re-encode every file on each `list_assets` call and bloat the IPC payload by ~33%.
At that point switch to the asset protocol.

## Assets are display-only (for now)

The Assets view intentionally does NOT wire images into the rendered animation.
Images are not editable text and never open as Monaco tabs. Feeding assets into
the preview is gated on the multi-file compiler + sandbox data-URI plumbing and is
a deliberate follow-up -- see [[remotion-player-no-umd]] context around how the
sandbox loads code today.

## Adding new Tauri commands

Reminder that bit this ticket: a new `#[tauri::command]` is invisible to the
frontend until it is added to `generate_handler!` in `src-tauri/src/lib.rs`. A
ticket that scopes only `commands/*.rs` cannot ship a working command on its own;
include `src-tauri/src/lib.rs` in `touches`, or split registration into a
dependent ticket.
