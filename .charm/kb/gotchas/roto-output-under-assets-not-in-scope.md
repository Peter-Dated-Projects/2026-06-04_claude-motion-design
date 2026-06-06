---
id: roto-output-under-assets-not-in-scope
root: gotchas
type: gotcha
status: current
summary: "Rotoscope PNG output lands in <project>/assets/rotoscope_<stem>/, which is OUTSIDE the current asset-protocol scope (extractions/** only); webview thumbnails need tauri.conf.json's assetProtocol.scope widened to assets/** -- and that scope lives in tauri.conf.json, NOT capabilities/default.json."
created: 2026-06-06
updated: 2026-06-06
---

The T-002 backend (`commands/rotoscoping.rs`) writes the extracted PNG sequence to
`<project>/assets/rotoscope_<source_stem>/frame_*.png` + `meta.json`. The current
Tauri asset-protocol scope only allows
`$DOCUMENT/ClaudeMotion/projects/**/extractions/**` (tauri.conf.json,
`app.security.assetProtocol.scope`). The rotoscope output path is under
`assets/`, NOT `extractions/`, so the webview will 404 every rotoscope thumbnail
loaded via `convertFileSrc` until the scope is widened (e.g. add
`$DOCUMENT/ClaudeMotion/projects/**/assets/**`).

Two traps for whoever wires up the frontend (T-004/T-005):

1. The scope is in **tauri.conf.json**, not `capabilities/default.json`. There is
   no `core:asset` capability permission to add -- see
   [[asset-protocol-no-permission-csp-null]]. The T-002 ticket listed
   `capabilities/default.json` in its touches expecting the scope there; that was
   a wrong assumption, so T-002 left both that file and tauri.conf.json untouched
   and flagged this. No rotoscoping ticket (T-002..T-005) has tauri.conf.json in
   its touches, so this widening is currently unowned -- the orchestrator needs to
   assign it.

2. On unix the asset scope defaults `require_literal_leading_dot = true`, so a
   `**` glob will not match a leading-dot path segment. The rotoscope output dir
   is `rotoscope_<stem>` (no leading dot), so it's fine -- but don't introduce a
   dot-prefixed variant. (Same constraint the IG `_work` dir was named around --
   see [[ig-work-dir-under-extractions-asset-scope]] if present.)
