---
id: roto-output-under-assets-not-in-scope
root: gotchas
type: gotcha
status: current
summary: "RESOLVED (dd3d775): asset-protocol scope now includes projects/**/assets/** alongside extractions/**, so rotoscope PNG thumbnails/playback under <project>/assets/rotoscope_<stem>/ resolve via convertFileSrc. Historical trap: the scope lives in tauri.conf.json, NOT capabilities/default.json, and was unowned by any roto ticket."
created: 2026-06-06
updated: 2026-06-06
---

RESOLVED as of commit dd3d775 ("Widen asset-protocol scope to project assets/ for
rotoscope output PNGs"): `app.security.assetProtocol.scope` in tauri.conf.json now
lists BOTH `$DOCUMENT/ClaudeMotion/projects/**/extractions/**` and
`$DOCUMENT/ClaudeMotion/projects/**/assets/**`. Rotoscope thumbnails + PNG-sequence
playback (T-006, via `convertFileSrc`) now load correctly. The rest of this note is
the history of how the gap was found and closed -- keep it for the casing/ownership
lessons.

The T-002 backend (`commands/rotoscoping.rs`) writes the extracted PNG sequence to
`<project>/assets/rotoscope_<source_stem>/frame_*.png` + `meta.json`. Before
dd3d775 the asset-protocol scope only allowed
`$DOCUMENT/ClaudeMotion/projects/**/extractions/**`. The rotoscope output path is
under `assets/`, NOT `extractions/`, so the webview 404'd every rotoscope thumbnail
loaded via `convertFileSrc`. This bit T-006: its first pass (worker-010, commit
7e669f2) shipped the media wiring but relied on an UNCOMMITTED, out-of-scope edit to
tauri.conf.json; tester-011 correctly failed it because at the committed state the
scope was still `extractions/**` only. The widening then landed separately in
dd3d775 (a ticket that owns tauri.conf.json), and T-006 re-validated clean against
HEAD.

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
