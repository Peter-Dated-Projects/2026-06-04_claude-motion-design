---
id: preview-sandbox
root: architecture
type: architecture
status: current
summary: "Live preview pipeline: a worker esbuild-transforms TSX to an IIFE, injected via blob-URL <script> into a sandboxed iframe that mounts @remotion/player off locally-bundled, fully-offline React + Remotion window globals."
related:
  - gotchas/react-18-pin-not-19
  - gotchas/preview-sandbox-csp
  - gotchas/player-ref-no-speed-loop
created: 2026-06-04
updated: 2026-06-04
---

How the live preview actually works (implemented in T-026 / charm T-IMPL-007).

## Data flow

1. `src/components/PreviewPanel/PreviewPanel.tsx` holds the current animation TSX (a sample
   for now; Monaco T-025 / Claude T-024 feed it during integration T-032). On change it posts
   `{type:'compile', code}` to a Web Worker.
2. `src/workers/sandbox-compiler.worker.ts` lazily `esbuild.initialize()`s esbuild-wasm
   (wasm shipped locally, imported with Vite `?url`), then `esbuild.transform`s the TSX:
   `loader:'tsx'`, `format:'iife'`, `globalName:'AnimationExports'`, **classic** JSX
   (`React.createElement`). Before transform it rewrites bare `react|react-dom|remotion|
   @remotion/player` imports into `const` bindings off the iframe's window globals (transform
   mode cannot resolve imports). Posts back `{type:'compiled', bundle}`.
3. PreviewPanel forwards the bundle to a sandboxed iframe via `postMessage`.
4. `src/assets/sandbox-frame.html` runs the bundle by injecting it as a **blob-URL `<script>`**
   (never eval / new Function), reads `window.AnimationExports.default`, and mounts
   `window.RemotionRuntime.Player` (1080x1920, fps 30, 150 frames). It streams `frameUpdate`
   and posts `renderOk` / `renderError` back to the parent.

## Offline runtime delivery (no CDN, no Tauri asset protocol)

`scripts/build-preview-runtime.mjs` (an npm `predev`/`prebuild` step) bundles
`@remotion/player` + `remotion` into one IIFE (`globalName: RemotionRuntime`, react/react-dom
external -> window globals via an esbuild resolve plugin) and copies React + ReactDOM 18 UMD
prod builds and `esbuild.wasm` into `src-tauri/resources/`. PreviewPanel imports those four
files with Vite `?raw` / `?url` and **inlines** the three runtime scripts into the iframe via
`srcDoc`. So the whole preview is self-contained in the frontend bundle — it works in `vite
dev` and in the built `dist/` that Tauri serves, with **zero** `tauri.conf.json` / capability /
`vite.config` wiring. This was a deliberate departure from the plan's `tauri://localhost` +
`script-src 'self'` design, both because that wiring was out of T-026's file scope and because
that design is unworkable anyway — see [preview-sandbox-csp](../gotchas/preview-sandbox-csp.md).

## Security posture

The iframe is `sandbox="allow-scripts"` only (no `allow-same-origin`), so it runs on an opaque
origin isolated from the app. CSP is `default-src 'none'; connect-src 'none'` — the sandbox has
no network access, so a malicious generated animation cannot exfiltrate. Compiled user code
runs via blob URL, not eval. The runtime React/Remotion are inlined (CSP `script-src
'unsafe-inline' blob:`), which is required given the opaque origin.

## Not yet verified

The headless checks (bundle exposes Player under React 18 UMD in a VM; worker transform yields
a valid IIFE; `tsc` + `vite build` green with wasm/worker/runtime assets emitted) all pass.
What remains is visual confirmation that a frame actually renders inside the live Tauri
WKWebView iframe — that needs the running app.
