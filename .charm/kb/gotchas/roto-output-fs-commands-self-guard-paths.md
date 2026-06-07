---
id: roto-output-fs-commands-self-guard-paths
root: gotchas
type: gotcha
status: current
summary: "roto_media.rs filesystem commands take a bare absolute `dir` from the frontend, so they MUST self-guard against traversal -- delete_rotoscope_output is PROJECT-scoped (takes app+slug, requires the canonical parent == project_dir(app,slug)/assets canonicalized AND leaf starts-with rotoscope_) before remove_dir_all; rename_rotoscope_output validates the leaf name. Never trust the frontend-supplied path."
created: 2026-06-06
updated: 2026-06-06
---

The output-folder mutation commands in `src-tauri/src/commands/roto_media.rs`
(`rename_rotoscope_output`, `delete_rotoscope_output`) take an absolute
`dir`/`old_dir` string straight from the Outputs panel -- the backend cannot
assume that path is inside a project, so it must self-guard.

`delete_rotoscope_output` is project-scoped (PR #5 review fix, T-016). It takes
`(app, slug, dir)` and re-derives the project root the same way the read command
`list_rotoscope_outputs` does (`project_dir(app, slug)`). The guard:
1. `path.canonicalize()` first, so any `.`/`..` segments are resolved before any check.
2. Canonicalize `project_dir(app, slug)/assets` (so both sides are symlink/`..`-stable).
3. Require the canonical target's parent to EQUAL that canonical project assets dir.
4. Require the canonical leaf name to start with `rotoscope_` (defense in depth).
5. Only then `std::fs::remove_dir_all`.

The earlier guard only checked that the parent was *named* `assets` (any
`/anywhere/assets/rotoscope_*` passed); step 3 ties it to the active project's
actual assets dir, so a hostile/malformed `dir` can't escape to another project's
(or a system) `assets/rotoscope_*`. The frontend caller (RotoOutputsPanel
`deleteOutput`) passes the active `slug` and bails with "no active project" when
it is null. Adding the `slug` param did NOT require a `lib.rs` edit: Tauri
resolves command params by name from the invoke args object.

`rename_rotoscope_output` still takes a dir-only signature with a lighter guard
(reject empty, `.`, `..`, and any `/`, `\`, null byte in the new leaf name) since
it only renames in place; tightening it to project-scoped the same way is a
reasonable future follow-up.

Takeaway: any future filesystem-mutating command added here should self-guard,
and prefer the project-scoped pattern (re-derive the root from `slug`) over
trusting a path-shape heuristic. Don't "simplify" by dropping the
parent-equals-project-assets / leaf-prefix checks.
