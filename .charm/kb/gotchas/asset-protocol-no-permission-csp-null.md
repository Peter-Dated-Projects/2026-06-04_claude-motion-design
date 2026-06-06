---
id: asset-protocol-no-permission-csp-null
root: gotchas
type: gotcha
status: current
summary: "Tauri 2 asset protocol is gated ONLY by app.security.assetProtocol {enable, scope} in tauri.conf.json -- there is NO core:asset capability permission (adding one fails capability schema validation). And because this app's CSP is null, no CSP edit is needed for asset:// <img> to load; introducing a CSP would be a regression risk, not an additive change."
created: 2026-06-06
updated: 2026-06-06
---

Enabling the asset protocol so the frontend can render local files via
`convertFileSrc(path)` as an `<img src>` (e.g. the IG frame grid showing extraction
JPEGs) needs exactly ONE change in this app, despite intuition (and the T-028
ticket text) suggesting three. Tauri 2.11 / `@tauri-apps/api` 2.11.

What is actually required:

- `tauri.conf.json` -> `app.security.assetProtocol = { enable: true, scope: [...] }`.
  `enable: true` flips on the `protocol-asset` cargo feature; `scope` (an `FsScope`)
  is a bare array of path globs and supports Tauri path variables. We scope to
  `"$DOCUMENT/ClaudeMotion/projects/**/extractions/**"` -- narrow to extraction
  artifacts (frames + source/clip mp4) only, NOT `animation.tsx` / `project.json` /
  `assets/`. `$DOCUMENT` matches how projects.rs resolves the projects root
  (`document_dir()/ClaudeMotion/projects/<slug>`); frames land at
  `<projectRoot>/extractions/<YYYY-MM-DD>_<id>/frames/frame_NNN.jpg`.

What is NOT required (and is actively wrong here):

- There is NO `core:asset` permission in this app's generated capability schema
  (`src-tauri/gen/schemas/desktop-schema.json` has `core:app|event|image|menu|...`
  but no `core:asset:*`). The asset protocol is gated by the conf `scope`, not by a
  window capability. Adding `core:asset:default` to `capabilities/default.json` would
  FAIL capability schema validation at build time and break the crate. Leave
  capabilities untouched.

- No CSP edit is needed. `app.security.csp` is `null` (CSP disabled), so nothing
  restricts `<img>` and `asset://...` loads once the protocol is enabled. Tauri only
  rewrites a CSP that EXISTS. Introducing a CSP now would NOT be additive -- it would
  turn on enforcement that could regress the preview sandbox (iframe + compiler worker
  + bundled Remotion runtime). If a CSP is ever added later, it MUST include the asset
  origin in `img-src` (`asset:` and `http://asset.localhost` on Windows), or these
  images break.

Net: for a config-only, no-regression change, enable + scope is the whole job.
