---
id: toolchain-version-key-and-replace-me-gate
root: gotchas
type: gotcha
status: current
summary: "render-toolchain installs are keyed on TOOLCHAIN.version (the install dir), and install_render_toolchain early-returns when is_installed() is true -- so a contents-only archive rebuild that keeps the same version is NEVER re-fetched by existing installs. Bump version (now carries a -r<N> revision suffix, set by TOOLCHAIN_REVISION in build-render-toolchain.mjs) to invalidate. Separately, sha256=\"REPLACE_ME\" is a real gate, not a stub: install errors out with a configure message instead of downloading."
created: 2026-06-06
updated: 2026-06-06
---

Two coupled traps in `src-tauri/src/commands/render_toolchain.rs` +
`scripts/build-render-toolchain.mjs`, both load-bearing for shipping a new archive.

**1. The version key gates re-fetch, and install early-returns.**
`toolchain_dir(app)` is `{appData}/render-toolchain/{TOOLCHAIN.version}`, and
`install_toolchain_blocking` opens with `if is_installed(&app) { return Ok(()); }`.
`is_installed` is just `.ok` marker + node + render-mp4.mjs present in that dir. So
if you rebuild the archive with NEW CONTENTS but the SAME `version`, every machine
that already installed the old archive has a matching dir + `.ok` and will never
download the new one -- silently running stale contents forever.

Historically `version` was exactly the Remotion version. That breaks the moment you
change archive contents WITHOUT bumping Remotion (e.g. re-pinning the bundled
`bun`/`yt-dlp`/`ffmpeg`/`ffprobe` CLIs). Fix in place: `version` now carries a
`-r<N>` revision suffix (e.g. `4.0.473-r2`), driven by `TOOLCHAIN_REVISION` in
`build-render-toolchain.mjs`. Bump `TOOLCHAIN_REVISION` on any contents-only
rebuild; the Rust `TOOLCHAIN.version` must match the build script's printed
`version` exactly.

Belt-and-suspenders: presence predicates that check ACTUAL FILES (not just `.ok`)
don't get fooled by a stale dir. `ig_tools_installed(app)` checks the four CLI
files directly, so a pre-CLI install reads as "IG tools missing" rather than
falsely present. But note this alone does NOT trigger a re-fetch -- the install
path keys off `is_installed`, so the version bump is still required to actually
re-download.

**2. `sha256 = "REPLACE_ME"` is an active gate.**
`install_toolchain_blocking` returns a "not configured yet" error if `url` or
`sha256` equals `"REPLACE_ME"`. This is the intended state when the archive's
contents changed but it hasn't been rebuilt + re-uploaded yet (hosting is an
out-of-band maintainer step). It is strictly better than leaving a now-wrong real
sha256 (-> opaque checksum-mismatch download failure) or a stale-but-valid one
(-> installs an outdated archive). After you actually run the build script and
upload, paste the printed url + sha256 + size_mb + version back into `TOOLCHAIN`.
