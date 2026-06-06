---
id: asset-protocol-no-permission-csp-null
root: gotchas
type: gotcha
status: current
summary: "Tauri 2 asset protocol needs BOTH app.security.assetProtocol {enable, scope} in tauri.conf.json AND the protocol-asset cargo feature on the tauri crate in Cargo.toml -- the conf flag does NOT flip the feature. There is NO core:asset capability permission (adding one fails capability schema validation), and because this app's CSP is null no CSP edit is needed for asset:// <img> to load."
created: 2026-06-06
updated: 2026-06-06
---

Enabling the asset protocol so the frontend can render local files via
`convertFileSrc(path)` as an `<img src>` (e.g. the IG frame grid showing extraction
JPEGs) needs TWO changes in this app -- a conf flag AND a cargo feature. The conf
flag alone is NOT enough: without the cargo feature the asset-serving handler is not
compiled in and `convertFileSrc(...)` URLs 404. (This is the correction to the
original note, which wrongly claimed the conf flag flips the feature; it does not.)
The other two "changes" intuition suggests -- a capability permission and a CSP edit
-- are genuinely NOT needed (see below). Tauri 2.11 / `@tauri-apps/api` 2.11.

What is actually required (BOTH of these):

- `tauri.conf.json` -> `app.security.assetProtocol = { enable: true, scope: [...] }`
  (committed in 3e7b914 by T-028). `enable: true` turns the protocol on at runtime;
  it does NOT enable the cargo feature. `scope` (an `FsScope`) is a bare array of
  path globs and supports Tauri path variables. We scope to
  `"$DOCUMENT/ClaudeMotion/projects/**/extractions/**"` -- narrow to extraction
  artifacts (frames + source/clip mp4) only, NOT `animation.tsx` / `project.json` /
  `assets/`. `$DOCUMENT` matches how projects.rs resolves the projects root
  (`document_dir()/ClaudeMotion/projects/<slug>`); frames land at
  `<projectRoot>/extractions/<YYYY-MM-DD>_<id>/frames/frame_NNN.jpg`.

- `src-tauri/Cargo.toml` -> the `tauri` dependency must include the `protocol-asset`
  feature: `tauri = { version = "2", features = ["protocol-asset"] }` (added by
  T-033). This is what compiles the asset-protocol handler (it pulls in `http-range`).
  This lives in Cargo.toml, which was outside T-028's touch scope, which is why the
  protocol was still broken after 3e7b914 until T-033 landed.

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

Net: the whole job is the conf flag (`enable` + `scope`) AND the `protocol-asset`
cargo feature -- two files, no capability change, no CSP change.
