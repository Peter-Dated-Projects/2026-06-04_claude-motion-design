---
id: code-execution-sandbox
root: decisions
type: decision
status: current
summary: "Recommended architecture for executing Claude-generated Remotion animation code in a live preview panel: esbuild-WASM in-browser compile + sandboxed iframe with postMessage hot-reload, with a Docker/gVisor server-side fallback for MP4 export."
created: 2026-06-04
updated: 2026-06-04
---

# Code Execution Sandbox Strategies for AI-Generated Animation

## Context

The system needs to safely execute Claude-generated TypeScript/JSX animation code and render a live
preview. The code will import Remotion APIs (`@remotion/player`, `useCurrentFrame`, etc.) and
possibly third-party libraries. Users iterate in a tight loop with Claude, so hot-reload latency is
a first-class constraint.

---

## Approaches Evaluated

### 1. iframe sandbox (inject compiled JS into sandboxed iframe)

**How it works:** Compile TSX server-side or client-side; inject the result as a `<script>` or
`srcdoc` into an `<iframe sandbox="...">`. Communicate via `postMessage`.

**Attack surface:**
- `sandbox` attribute eliminates same-origin access, form submission, plugin execution, and
  top-level navigation. With `allow-scripts` but without `allow-same-origin`, the iframe runs in a
  unique null origin — script can execute but cannot read parent cookies/localStorage or make
  credentialed requests.
- Main risk: exfiltration via `fetch`/`XMLHttpRequest` to arbitrary third-party URLs from inside
  the iframe. Mitigate with a Content Security Policy on the iframe's `srcdoc` or the served
  sandbox document: `default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'`.
- `postMessage` origin must be validated on both sides.

**Hot-reload:** Full page reload of iframe on each edit = ~50-200 ms for small bundles. Partial
module replacement requires a custom HMR protocol over postMessage — non-trivial but achievable.
Val.town's sandbox does simple full-srcdoc replacement (fast enough at <100 KB).

**Remotion Player compatibility:** Remotion's `<Player>` component is designed to run in a browser
context. It works inside a sandboxed iframe as long as:
- `allow-scripts` is present (required).
- `allow-same-origin` is omitted (safe null-origin sandbox).
- Web Audio/video assets are served from a CDN with permissive CORS and the CSP `connect-src`
  allows that CDN.
- `requestAnimationFrame` is available (it is, even in sandboxed iframes).

**Latency:** With in-browser compilation (see approach 5), round-trip to first frame is 200-800 ms
on a cold compile, ~50-150 ms on a warm cache. Acceptable for an "iterate with Claude" UX where
the bottleneck is usually waiting for Claude's response anyway.

**Verdict:** Best default option when combined with in-browser compilation.

---

### 2. Web Worker + OffscreenCanvas

**How it works:** Execute animation logic in a Worker; render frames via `OffscreenCanvas`
transferred from the main thread; transfer rendered `ImageBitmap` back for display.

**Attack surface:**
- Workers run in the same origin as the host page; they share the origin's cookie jar and can make
  credentialed fetch calls. This is a significant attack surface — malicious generated code can
  exfiltrate auth tokens or hit internal APIs.
- No native DOM isolation; you must restrict the Worker's fetch via a Service Worker intercept
  layer, which adds complexity.

**Hot-reload:** Workers can receive new code strings and `eval()` them (or use `importScripts` with
a blob URL). This avoids iframe teardown. However, `eval()` in a Worker is still `eval()` — any
loaded module state accumulates. Clean teardown requires `terminate()` + new Worker per edit.

**Remotion Player compatibility:** Remotion's `<Player>` is a React component requiring the DOM.
It cannot run inside a Worker. The Worker approach would only work for raw canvas-drawing
animations, not Remotion's composition model. This rules out the approach for this project.

**Verdict:** Not viable for Remotion-based animations.

---

### 3. Server-side sandbox (Docker/gVisor)

**How it works:** Send generated code to a backend endpoint; spin up an ephemeral container
(gVisor-sandboxed) that runs Node + headless Chromium (or Remotion's CLI render); stream frames or
a video back.

**Attack surface:**
- Very strong isolation — gVisor intercepts system calls; container has no direct hardware access.
- Network egress must be blocked at the container level (iptables, or Firecracker VM).
- The main risk is container escape, which gVisor substantially mitigates.

**Hot-reload:** Cold container spin-up is 500 ms-3 s. Even with a warm container pool, the
roundtrip for each code change is 200-500 ms + render time (Remotion CLI renders at ~4-10 fps for
complex compositions). Not suitable for real-time preview; only practical for final export.

**Remotion Player compatibility:** Full — Remotion CLI runs in Node + headless Chromium. This is
the path for MP4/GIF export.

**Latency:** 2-10 s per render pass. Far outside the "instant preview" budget.

**Verdict:** Use exclusively for final MP4/GIF export (invoked deliberately by the user), not for
live preview. Pair with the iframe approach for preview.

---

### 4. Cloudflare Workers / Edge sandbox (V8 isolate)

**How it works:** Deploy a Cloudflare Worker that accepts generated code, evals it in a V8 isolate,
and returns rendered output.

**Attack surface:**
- V8 isolates provide strong CPU/memory isolation. No process-level syscall access.
- But Cloudflare Workers do not expose a DOM or `window` — they run a Service Worker-like
  environment.
- No `requestAnimationFrame`, no `HTMLCanvasElement`, no React DOM — Remotion cannot run.

**Hot-reload:** API call per keystroke debounce (200-300 ms network) + isolate cold start (first
request ~50 ms, subsequent ~5 ms). Latency is acceptable but the roundtrip adds jitter.

**Remotion Player compatibility:** None. Remotion requires browser APIs unavailable in V8 isolates.
You could run a custom lightweight animation interpreter here, but that would mean abandoning
Remotion's composition model entirely.

**Verdict:** Not viable for Remotion. Could be used for validation/type-checking the generated code
before sending it to the browser, but not for preview rendering.

---

### 5. esbuild-WASM in-browser + sandboxed iframe (recommended)

**How it works:**
1. Load `esbuild-wasm` (~7 MB, cached in a Service Worker) in the main page.
2. On each Claude response (or user edit), compile the TSX bundle entirely in the browser via
   esbuild-WASM. Remotion and React are pre-bundled as externals and loaded from a CDN via
   importmap or a stub in the iframe's HTML template.
3. Inject the compiled output into a sandboxed iframe via `postMessage` or `srcdoc` replacement.
4. The iframe's host document pre-loads Remotion's `<Player>` and React from a locked CDN URL
   (with SRI hash). The injected code only exports a composition function; the host doc mounts it
   into `<Player>`.

**Attack surface:**
- Compilation happens in the browser; no server round-trip required for preview.
- The iframe runs at null origin (`sandbox="allow-scripts"` without `allow-same-origin`).
- CSP on the iframe document: `default-src 'none'; script-src cdn.example.com 'sha256-...';
  connect-src 'none'` — blocks arbitrary fetch.
- esbuild-WASM itself runs in a Worker, isolating the compilation CPU spike from the main thread.

**Hot-reload:** The esbuild compile step takes 50-300 ms for a typical animation file (single
entry, Remotion/React as externals). The iframe srcdoc swap adds ~30-100 ms. Total round-trip to
updated frame: ~100-400 ms. With a debounce on the Claude stream (fire on the last token of a
complete code block), this is effectively instant from the user's perspective.

**Remotion Player compatibility:** Full. The iframe template pre-loads Remotion's `<Player>` from
CDN; the injected code only needs to export a `composition` object (`fps`, `durationInFrames`,
`component`). Hot-reloads preserve the Player's playhead position if the postMessage protocol
sends the current frame alongside the new bundle.

**Latency profile:**
- Cold (first compile, WASM not yet loaded): 1-3 s (mostly WASM init).
- Warm (WASM loaded, Remotion cached): 100-400 ms.
- Streaming partial update: can show a "compiling..." overlay while esbuild runs, then swap.

**Verdict:** Recommended for live preview.

---

## What Similar Tools Use

### StackBlitz (WebContainers)
StackBlitz runs a full Node.js environment inside a browser tab using WebAssembly (WebContainers).
This enables `npm install`, a dev server, and HMR — the full Node ecosystem in-browser. It uses
Service Workers to intercept HTTP requests made by the in-browser dev server, routing them to the
WASM runtime.

This is the highest-fidelity approach but has significant overhead: WebContainers take 5-15 s to
boot, and the bundle is large (~15 MB WASM + runtime). For a motion design tool where the user
just wants to see their Remotion composition render, this is over-engineered. StackBlitz uses it
because their users need to run arbitrary npm packages and dev servers.

**Key takeaway:** WebContainers are the right call when you need full npm compatibility. For
Remotion animations with a known dependency set, they are unnecessary.

### CodeSandbox (Sandpack)
CodeSandbox's open-source `Sandpack` library uses a bundler (based on their legacy
`codesandbox-bundler`, now migrated toward a custom in-browser bundler) that runs in an iframe.
Modules are fetched on-demand from a CDN. The iframe communicates with the host via postMessage.

This is architecturally similar to approach 5 above. Sandpack explicitly chose iframe isolation
over WebContainers for the embedded-preview use case. Sandpack supports React, Remotion (there is
an official `@codesandbox/sandpack-themes` template for Remotion), and hot-reload with state
preservation.

**Key takeaway:** The iframe + in-browser bundler model is validated by CodeSandbox for exactly
this use case. Their Remotion template proves that `<Player>` works inside a Sandpack iframe.

### Val.town
Val.town executes user code (TypeScript) in a Deno-based sandbox server-side for backend vals, and
uses a sandboxed iframe with `srcdoc` injection for frontend/React vals. For the preview panel,
they compile with esbuild on their servers and push the bundle into the iframe via postMessage.

**Key takeaway:** Server-side esbuild + client-side iframe is their split. For this project,
shifting the compile step to the browser (esbuild-WASM) eliminates the server round-trip and
reduces latency.

---

## Recommended Architecture: Live Preview Panel

### System diagram

```
Claude stream
     |
     v (on complete code block)
+------------------+
| Main thread      |
|  debounce(200ms) |
+------------------+
     |
     v postMessage(sourceCode)
+------------------+
| esbuild Worker   |  <-- esbuild-WASM loaded once, cached via Service Worker
|  compile TSX     |
|  externals:      |
|    react         |
|    react-dom     |
|    remotion      |
|    @remotion/*   |
+------------------+
     |
     v postMessage({ bundle, currentFrame })
+------------------------------------------+
| Sandbox iframe (null origin)             |
|  sandbox="allow-scripts"                 |
|  CSP: script-src CDN_URL; connect-src   |
|       'none'                             |
|                                          |
|  Pre-loaded (from locked CDN):           |
|    React, ReactDOM, Remotion Player      |
|                                          |
|  On message:                             |
|    1. eval() bundle -> get composition   |
|    2. ReactDOM.render(<Player            |
|         component={composition.component}|
|         fps={composition.fps}            |
|         durationInFrames={...}           |
|         initialFrame={currentFrame}      |
|       />, root)                          |
+------------------------------------------+
```

### Implementation sketch

**esbuild Worker (`sandbox-compiler.worker.ts`):**
```typescript
import * as esbuild from 'esbuild-wasm'

let initialized = false

async function ensureInit() {
  if (initialized) return
  await esbuild.initialize({ wasmURL: '/esbuild.wasm', worker: false })
  initialized = true
}

self.onmessage = async (e: MessageEvent<{ id: string; source: string; filename: string }>) => {
  await ensureInit()
  try {
    const result = await esbuild.transform(e.data.source, {
      loader: 'tsx',
      format: 'iife',
      globalName: '__userComposition__',
      // Remotion, React, ReactDOM are pre-loaded in the iframe via importmap
      // Mark them as externals that map to globals already on window
      define: {
        'require("react")': 'window.__React__',
        'require("remotion")': 'window.__Remotion__',
      },
      minify: false,
      sourcemap: 'inline',
    })
    self.postMessage({ id: e.data.id, ok: true, code: result.code })
  } catch (err) {
    self.postMessage({ id: e.data.id, ok: false, error: String(err) })
  }
}
```

**Iframe host document (`sandbox-frame.html`, served from the same origin but with restrictive CSP):**
```html
<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'self' https://esm.sh; style-src 'unsafe-inline';">
  <!-- React and Remotion loaded as ESM from a pinned CDN version -->
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1",
      "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
      "remotion": "https://esm.sh/remotion@4.0.290",
      "@remotion/player": "https://esm.sh/@remotion/player@4.0.290"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { Player } from '@remotion/player'

    // Expose globals for the injected IIFE bundle
    window.__React__ = React
    window.__ReactDOM__ = { createRoot }
    window.__RemotionPlayer__ = Player

    let root = null
    let currentFrame = 0

    window.addEventListener('message', (e) => {
      if (e.data?.type !== 'RENDER') return
      currentFrame = e.data.currentFrame ?? currentFrame

      try {
        // Evaluate the compiled bundle — it sets window.__userComposition__
        // eslint-disable-next-line no-new-func
        new Function(e.data.code)()
        const composition = window.__userComposition__?.default ?? window.__userComposition__

        if (!root) {
          root = createRoot(document.getElementById('root'))
        }
        root.render(
          React.createElement(Player, {
            component: composition.component,
            fps: composition.fps ?? 30,
            durationInFrames: composition.durationInFrames ?? 90,
            compositionWidth: composition.width ?? 1920,
            compositionHeight: composition.height ?? 1080,
            style: { width: '100%', height: '100%' },
            initialFrame: currentFrame,
          })
        )
        window.parent.postMessage({ type: 'RENDER_OK' }, '*')
      } catch (err) {
        window.parent.postMessage({ type: 'RENDER_ERROR', error: String(err) }, '*')
      }
    })
  </script>
</body>
</html>
```

**Preview panel component (sketch):**
```typescript
// In the main Next.js app
const compiler = new Worker('/sandbox-compiler.worker.js')
const iframeRef = useRef<HTMLIFrameElement>(null)

useEffect(() => {
  compiler.onmessage = (e) => {
    if (!e.data.ok) { showError(e.data.error); return }
    iframeRef.current?.contentWindow?.postMessage({
      type: 'RENDER',
      code: e.data.code,
      currentFrame: playerState.currentFrame,
    }, '*')
  }
}, [])

// Called on each debounced Claude code block completion
function onCodeUpdate(tsxSource: string) {
  compiler.postMessage({ id: nanoid(), source: tsxSource, filename: 'composition.tsx' })
}
```

---

## Security Hardening Checklist

- [ ] Serve `sandbox-frame.html` from the same origin but with `X-Frame-Options: SAMEORIGIN` so
      only the app's own page can embed it.
- [ ] Pin CDN URLs to exact semver and add SRI hashes to the importmap once stable.
- [ ] Set `connect-src 'none'` in the iframe's CSP to prevent the injected code from making
      network requests.
- [ ] Validate `e.origin` in the iframe's message listener (guard: only accept from `window.parent`
      matching the app's own origin).
- [ ] Rate-limit compilation in the Worker (drop messages if a compile is already in flight with a
      debounce of 200 ms).
- [ ] On export, send the source to the server-side Docker/gVisor pipeline — never trust the
      client-rendered preview as the canonical render.

---

## Export Pipeline (separate from live preview)

For MP4/GIF export: POST the TSX source and composition metadata to a backend endpoint. The
backend runs `@remotion/renderer` inside a gVisor-sandboxed container with network egress blocked.
This is the only place where Remotion's headless render (puppeteer-core) runs. The iframe preview
is display-only; the server render is the source of truth for exported files.

---

## Open Questions / Risks

1. **esbuild-WASM bundle size (~7 MB):** Cache aggressively via Service Worker. Consider lazy-
   loading it only when the user opens the preview panel.
2. **Remotion CDN version pinning:** The ESM CDN importmap must be kept in sync with the version
   used in the server-side render. A mismatch produces subtly different animation output. Pin both
   to the same version in a single constants file.
3. **`eval()` in iframe:** Using `new Function(code)()` is equivalent to `eval`. The CSP
   `script-src 'unsafe-eval'` must be set on the iframe document, or the execution will fail in
   strict CSP environments. Alternatively, inject as a `<script>` tag with a blob URL (avoids the
   `unsafe-eval` requirement but requires `script-src blob:`).
4. **Safari iframe sandbox + importmap:** Safari has had bugs with importmaps inside sandboxed
   iframes. Test on Safari 17+; fallback: serve Remotion and React as UMD globals from the CDN
   and skip importmap.
5. **Remotion `<Player>` and `requestAnimationFrame` in hidden iframes:** If the preview iframe
   is not visible (tab in background), `rAF` throttles. Use `Player`'s `renderPlaybackRateControlled`
   prop or a manual frame-stepping approach for thumbnail generation.
