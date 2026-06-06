---
id: sharp-under-bun-local-node-modules
root: gotchas
type: gotcha
status: current
summary: "sharp (native libvips) loads and runs fine under Bun ONLY when resolved from the project's local node_modules; a Bun script run from outside the ig-pipeline tree resolves sharp from Bun's global install cache, whose flattened layout breaks the native @rpath lookup for libvips-cpp.dylib (ERR_DLOPEN_FAILED). Keep scoring scripts/tests inside scripts/ig-pipeline/."
created: 2026-06-06
updated: 2026-06-06
---

`sharp` is the load-bearing image dependency for the ig-pipeline scoring stage
(T-005: Laplacian variance, mean pixel delta, RGB histogram entropy over raw
pixel buffers). Verified during the T-001 scaffold that it both installs and
*runs* under Bun 1.3.9 on darwin-arm64 (`bun install` clean; greyscale `.raw()`
buffer extraction and `.jpeg()` encode both work) -- so it was NOT the blocker
the ticket flagged it might be. But there is a sharp footgun:

- The sharp native addon (`sharp-darwin-arm64.node`) is linked against
  `@rpath/libvips-cpp.8.17.3.dylib` and finds it via `@loader_path/../../`-style
  rpaths pointing at the sibling `@img/sharp-libvips-darwin-arm64` package.
- In the project's **local** `node_modules` that sibling is present and the
  rpath resolves, so sharp loads.
- If you `bun run` a `.ts` file located **outside** the project tree (e.g. a
  scratch file in `/tmp`), Bun resolves `sharp` from its **global install
  cache** (`~/.bun/install/cache/@img/...`), whose flattened layout does NOT
  place the libvips package where the addon's rpath expects it. Result:
  `ERR_DLOPEN_FAILED: ... Library not loaded: @rpath/libvips-cpp.8.17.3.dylib`.

This looked at first like a hard "sharp doesn't work under Bun" blocker, but it
was purely a test-harness artifact -- the smoke file was in `/tmp`. Moving it
inside `scripts/ig-pipeline/` made sharp load immediately.

Implication for T-005 and any future sharp use: keep the scoring code and its
tests inside `scripts/ig-pipeline/` (they will be, by ticket scope) so `sharp`
always resolves from local `node_modules`. If you ever see `ERR_DLOPEN_FAILED`
for libvips, the first thing to check is whether the entry file is outside the
project tree, not whether sharp is broken. See also the runtime decision
[[0007-ig-pipeline-bun-runtime]].
