---
id: ig-work-dir-under-extractions-asset-scope
root: gotchas
type: gotcha
status: current
summary: "IG Phase A's scratch frames must live at extractions/_work/<id>/ (NOT a project-root sibling like .ig-work, and NOT a dot-prefixed name) so the live review grid's convertFileSrc thumbnails fall inside the asset-protocol scope projects/**/extractions/** -- on macOS that scope defaults require_literal_leading_dot=true, so a `**` wildcard will not match a leading-dot segment."
created: 2026-06-06
updated: 2026-06-06
---

The IG frame grid renders LIVE Phase-A candidate frames (during `awaiting-review`,
before the user picks a keep set) via `convertFileSrc(frame.path)` against the Tauri
asset protocol. The asset scope (tauri.conf.json `app.security.assetProtocol.scope`)
is `$DOCUMENT/ClaudeMotion/projects/**/extractions/**` -- it covers the FINAL
extraction folder but nothing else under a project.

Two non-obvious constraints fall out of this:

1. **Phase A's scratch dir must be UNDER `extractions/`.** The original design put
   it at `<project>/.ig-work/<id>/` (a sibling of `extractions/`). That path contains
   no `/extractions/` segment, so it is OUTSIDE the scope and every review thumbnail
   404s. Fixed by relocating to `<project>/extractions/_work/<id>/` (see
   `ig_pipeline.rs::ig_work_dir`). The Bun stages don't care where they write (the
   Rust passes the dir explicitly), and store reads media by ABSOLUTE path from the
   results blob, so it reconciles correctly regardless of where work lived.

2. **The scratch dir name must NOT start with a dot.** On unix, the asset scope
   defaults `require_literal_leading_dot = true` (tauri-2.x `src/scope/fs.rs`: the
   `Some(require)` arm falls through to `true` on `#[cfg(unix)]`). With that set, a
   `**` wildcard will NOT match a path component beginning with `.`, so a
   `extractions/.work/...` frame would STILL be blocked even though it is "under
   extractions". Hence `_work`, not `.work`. (`require_literal_separator` is also
   true, but that only affects single `*`/`?`; the recursive `**` token still
   descends subdirectories.)

Consequences for other code:
- `ig_list_extractions` must skip the `_work` dir. It does so naturally because
  `_work` has no `extraction.md` (the completeness check), and it also skips any
  dotfile dir defensively.
- `_work` is not dot-hidden, so it DOES appear in the editor file tree
  (`projects.rs::collect_files` only skips dotfiles + NON_SOURCE) while a run is in
  flight. It is transient (deleted after Phase B's store) and the IG workspace has no
  editor panel, so this is cosmetic only. If it becomes annoying, the real fix is to
  add `requireLiteralLeadingDot: false` to the asset scope and rename back to `.work`,
  OR add `_work` to NON_SOURCE -- both are out of scope for the integration ticket.

Related: [[asset-protocol-no-permission-csp-null]],
[[ig-backend-two-phase-state-and-frame-paths]], [[ig-frames-4digit-vs-store-3digit]].
