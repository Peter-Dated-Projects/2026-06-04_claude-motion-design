---
id: react-18-pin-not-19
root: gotchas
type: gotcha
status: current
summary: "React is deliberately pinned to 18.3.x, not 19 — the preview runtime bundles React 18 UMD, so bumping React (or re-running create-tauri-app) breaks the sandbox preview."
related:
  - architecture/preview-sandbox
created: 2026-06-04
updated: 2026-06-04
---

`package.json` pins `react` / `react-dom` (and their `@types`) to `^18.3.x`, even
though `create-tauri-app`'s `react-ts` template scaffolds React 19 by default.

Why this matters: the esbuild-WASM preview sandbox (T-IMPL-007) does NOT bundle React
into the compiled animation. Instead `sandbox-frame.html` loads `react.production.min.js`
+ `react-dom.production.min.js` as window globals, and the prebuild script copies those
UMD files out of `node_modules`. React 19 changed the client entry/UMD story, and the
plan's preview design is written against React 18 UMD globals (`window.React` /
`window.ReactDOM.createRoot`). The bundled `@remotion/player` (pinned 4.0.471) is also
built against the React 18 it was installed beside.

Footgun: if a future agent runs `npm create tauri-app` fresh, blindly accepts a
`react@^19` bump, or lets Dependabot push React 19, the frontend will still build but the
preview iframe can break in subtle ways (mismatched React copies, UMD global shape). Keep
`react`, `react-dom`, `@remotion/player`, and `remotion` versions in lockstep — they all
have to agree with whatever the preview runtime bundles.
