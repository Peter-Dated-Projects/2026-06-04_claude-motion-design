---
id: client-side-rendering
root: architecture
type: architecture
status: current
summary: "WebCodecs + mp4-muxer makes client-side 1080x1920 MP4 feasible for canvas-rendered compositions, but DOM/CSS Remotion compositions remain blocked on frame capture, not encoding."
created: 2026-06-04
updated: 2026-06-04
---

# Client-Side Video Rendering: WebCodecs Revisit

Research findings for T-012. Re-evaluates the client-side MP4 path that RES-04 ruled out (ffmpeg.wasm + MediaRecorder). Four approaches assessed: WebCodecs + OffscreenCanvas, WebCodecs + Remotion frame stepping, multi-threaded ffmpeg.wasm with COOP/COEP, and mp4-muxer + WebCodecs. See [[export-rendering-pipeline]] for the prior ruling and the full server-side comparison.

---

## Approach 1: WebCodecs API + OffscreenCanvas

### Browser support (as of mid-2026)

| Browser | Version | Notes |
|---|---|---|
| Chrome / Edge | 94+ | Full support, hardware H.264/VP9/AV1 |
| Safari | 16.4+ | H.264 and HEVC; VP9/AV1 software-only |
| Firefox | 130+ | Landed in stable; H.264 requires OS media codec (Windows/macOS OK, Linux fragile) |
| Chrome for Android | 94+ | Software encode; hardware path device-dependent |

Coverage for a web app targeting desktop: approximately 95%+ of modern desktop browsers. Firefox 130 shipped September 2024, so by mid-2026 the vast majority of Firefox installs have it.

### Encode speed at 1080x1920 H.264

WebCodecs does not run a WASM encode loop -- it calls the platform's native hardware encoder via the browser. This is the fundamental difference from ffmpeg.wasm.

**M1 Mac (Apple Silicon):**
- VideoToolbox hardware H.264 encoder (same path Final Cut uses).
- Encode speed: approximately 300-800 fps at 1080x1920 in practice -- meaning a 15s / 450-frame sequence at 30fps encodes in roughly 0.5-1.5 seconds of wall-clock time.
- This is effectively instantaneous from the user's perspective.

**Mid-tier Windows laptop (Intel 12th gen, integrated GPU):**
- Intel Quick Sync H.264 hardware encoder available in Chrome via MediaFoundation.
- Encode speed: approximately 100-300 fps at 1080x1920 -- a 450-frame sequence in roughly 1.5-4.5 seconds.
- On laptops without Quick Sync (older AMD APUs, some Chromebooks): software path via OpenH264 or libvpx, roughly 10-30 fps at 1080x1920 -- meaning a 450-frame sequence takes 15-45 seconds. Acceptable but noticeable.

**Codec support summary:**
- H.264 (avc1): Widely supported, hardware path on most platforms. Recommended default.
- VP9 (vp09): Hardware on Chrome/Android, software on Safari. Avoid as primary.
- AV1 (av01): Hardware on newer devices (Apple M3+, Intel Arc, NVIDIA RTX 40-series). Good quality but patchy hardware path in 2026 mid-tier devices.

**Bottom line: on hardware that the target demographic (content creators, marketers) realistically owns, WebCodecs H.264 encodes a 15s 1080x1920 video in under 5 seconds. This reverses the RES-04 ruling on encoding speed.**

WebCodecs does NOT require SharedArrayBuffer, COOP, or COEP headers. It runs on the platform's native codec infrastructure via the browser's GPU process.

---

## Approach 2: WebCodecs + Remotion Frame Stepping

The encoding half is solved. The capture half -- getting each frame as a VideoFrame -- is where the complexity lives.

### The frame capture problem

`VideoFrame` can be constructed from: `HTMLCanvasElement`, `OffscreenCanvas`, `HTMLVideoElement`, `ImageBitmap`, `VideoFrame`, or raw `BufferSource`. To go frame-by-frame:

1. Render the Remotion composition to a canvas at a specific frame number.
2. Create a `VideoFrame` from that canvas.
3. Encode it via `VideoEncoder`.
4. Advance to the next frame.

Step 1 is the hard part. Remotion compositions fall into two categories:

**Canvas-rendered compositions (Three.js, PixiJS, Lottie on canvas, Canvas2D):**
- The rendered output is already a canvas at every frame.
- You can drive the animation loop manually: set the frame counter, call the render function, read back the canvas.
- `VideoFrame` from canvas works directly.
- CORS taint: if images are loaded with `crossOrigin="anonymous"` and the CDN serves correct CORS headers, the canvas is not tainted and VideoFrame creation succeeds. This is controllable if the app proxies or controls asset loading.
- **This path is fully viable.**

**DOM/CSS-rendered compositions (most Remotion animations using standard JSX, CSS transitions, SVG):**
- There is no canvas to capture. Remotion renders to a real DOM subtree.
- `html2canvas` can rasterize a DOM node to a canvas, but it is slow (~50-500ms per frame depending on complexity), does not support all CSS features, and has its own CORS limitations.
- Screen Capture API (`captureStream()`) has the real-time constraint and requires user permission.
- Puppeteer-style headless capture is server-side by definition.
- **There is no reliable, fast, client-side path for DOM-rendered Remotion compositions as of mid-2026. WebCodecs solves encoding but not DOM frame capture.**

### Remotion-specific APIs for frame stepping

Remotion's `@remotion/player` exposes:
- `PlayerRef.seekTo(frame: number)` -- moves the playhead to a specific frame
- `PlayerRef.getCurrentFrame()` -- returns current frame
- The Player emits a `seeked` event after repositioning

The Player renders to a hidden `<div>` via React. Capturing what's inside requires either:
- The composition rendering to a `<canvas>` that you can read (canvas compositions only)
- A future Remotion API that exposes a frame-capture callback (not available as of mid-2026)

**Practical implementation for canvas compositions:**

```typescript
// Pseudo-code sketch -- canvas-rendered composition only
async function renderToMP4(
  renderFrame: (canvas: OffscreenCanvas, frame: number) => Promise<void>,
  fps: number,
  totalFrames: number,
  width: number,
  height: number
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);

  // mp4-muxer setup
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory'
  });

  // VideoEncoder setup
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; }
  });
  encoder.configure({
    codec: 'avc1.42001f', // H.264 Baseline Profile Level 3.1
    width,
    height,
    bitrate: 10_000_000,
    framerate: fps
  });

  for (let i = 0; i < totalFrames; i++) {
    await renderFrame(canvas, i);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i / fps) * 1_000_000) // microseconds
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); // keyframe every 2s
    frame.close();
    // Yield to event loop every N frames to avoid blocking UI
    if (i % 30 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await encoder.flush();
  muxer.finalize();

  return new Blob([target.buffer], { type: 'video/mp4' });
}
```

**Memory note:** `frame.close()` is mandatory. A `VideoFrame` holds a reference to GPU memory; without explicit close, you will exhaust GPU memory within tens of frames.

---

## Approach 3: ffmpeg.wasm with SharedArrayBuffer + COOP/COEP

The multi-threaded ffmpeg.wasm build requires `SharedArrayBuffer`, which in turn requires these response headers on every page that loads the worker:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### COOP/COEP compatibility assessment

**Google OAuth popup flow:**
- COOP: same-origin prevents `window.opener` communication between the OAuth popup and the parent window.
- Google's OAuth popup (`accounts.google.com`) uses `window.opener.postMessage` to deliver the token back.
- **Result: Google OAuth popup is broken by COOP: same-origin. This is a hard incompatibility.**
- Workaround A: use OAuth redirect flow (`prompt: 'select_account'` with a redirect URI instead of popup). Fully compatible -- no `window.opener` needed. Requires a round-trip page reload.
- Workaround B: serve the render page on a separate subdomain (e.g., `render.app.com`) that has COOP/COEP, while auth lives on `app.com`. The render page is never used for login.

**COEP: require-corp and third-party assets:**
- Every subresource (images, fonts, scripts) loaded on a COEP: require-corp page must either serve `Cross-Origin-Resource-Policy: cross-origin` headers or be same-origin.
- Google Fonts CSS does NOT serve CORP headers. Loading them directly on a COEP page fails.
- User-uploaded images on S3 without explicit CORP headers fail.
- **Result: COEP: require-corp breaks virtually any page that loads third-party CDN assets without explicit CORP configuration.**
- Workaround: `COEP: credentialless` (a newer variant, Chrome 96+, no Safari support as of mid-2026) is less strict -- it loads cross-origin resources without credentials but does not require CORP headers. This resolves the font/CDN issue but still has no Safari support.

**Sandboxed iframes:**
- `<iframe>` embeds from third parties (Stripe, Intercom, analytics scripts) require their own COEP headers to work on a COEP page. Most third-party iframes do not serve these. Embeds break.

**Summary for ffmpeg.wasm multi-threaded:**
COOP + COEP is architecturally incompatible with a general-purpose web app that uses Google OAuth popups and third-party CDN assets. The workarounds (redirect OAuth, separate subdomain for the render page, COEP: credentialless) are non-trivial and reduce the approach to a niche deployment pattern. Given that WebCodecs now solves the encoding speed problem without requiring these headers, multi-threaded ffmpeg.wasm is no longer worth the architectural cost.

---

## Approach 4: mp4-muxer + WebCodecs

`mp4-muxer` (maintained by Vanilagy, used in browser-based video editors) is a pure-JS MP4 muxer designed specifically to wrap WebCodecs `VideoEncoder` output.

- Bundle size: ~50-80 KB gzipped (vs. ffmpeg.wasm core: ~7-22 MB depending on build).
- Produces ISO base media file format (MP4) with proper `moov` atom placement.
- Supports both in-memory (`ArrayBufferTarget`) and streaming (`StreamTarget`) modes.
- `fastStart: 'in-memory'` mode writes the `moov` atom at the beginning of the file (required for web playback and social media upload); it buffers the entire output in memory during encoding and rewrites it on finalize.
- Output is browser-compatible: plays in Chrome, Safari, Firefox, VLC, social media upload APIs.
- Does not support audio muxing from a separate source in the same trivial API (requires separate AudioEncoder pipeline), but for silent animation exports this is irrelevant.

**This is the correct pairing with WebCodecs.** There is no reason to bring ffmpeg.wasm in for muxing when mp4-muxer handles it at 1% of the bundle size.

---

## Memory Profile: 450-Frame Encode via WebCodecs

A 15s @ 30fps, 1080x1920 encode (450 frames):

| Buffer | Size estimate | Notes |
|---|---|---|
| One `VideoFrame` (GPU-backed) | ~8 MB | Closed immediately after encode(); GPU memory |
| Encoder internal queue | ~50-200 MB | GPU memory; drains as encoding proceeds |
| Encoded chunk buffer (mp4-muxer) | ~15-40 MB | The final MP4 data accumulating in `ArrayBufferTarget` |
| Peak heap | ~100-300 MB | Dominated by the encoder queue and muxer buffer |

Key points:
- You do NOT need to buffer all 450 raw frames simultaneously. One frame at a time is the correct pattern.
- `frame.close()` after each `encode()` call is the critical discipline -- omitting it causes GPU memory to accumulate.
- The `encoder.encode()` call is non-blocking and returns immediately. The encoder processes chunks asynchronously. If you submit frames faster than the encoder drains, the internal queue grows. Yielding to the event loop every 30 frames (as shown in the sketch above) prevents queue buildup.
- If `encoder.encodeQueueSize` exceeds a threshold (~10), you should await a flush or back-pressure with a promise on the next chunk output.
- **Verdict: 450-frame 1080x1920 encode is safe on any machine with >1 GB available RAM (which is all target hardware). No OOM risk when frames are processed one at a time.**

---

## CORS / Canvas Taint

WebCodecs does not change the canvas taint rules. `new VideoFrame(canvas, ...)` throws a `SecurityError` if the canvas is tainted.

A canvas is tainted if any image, video, or SVG loaded from a cross-origin URL was drawn into it without both:
1. The resource serving `Access-Control-Allow-Origin: *` (or the app's origin)
2. The element setting `crossOrigin="anonymous"` before the `src` is set

**Controllable mitigations for the app:**
- User-uploaded images: configure the S3 bucket to serve `Access-Control-Allow-Origin: *` on GET, and load via `<img crossOrigin="anonymous">`. This is standard and low-effort.
- Google Fonts: fonts loaded via CSS `@font-face` do NOT taint the canvas (CSS-loaded fonts are opaque to the canvas; they only affect text rendering, which is not considered a cross-origin data leak). Safe.
- Icon CDNs (e.g., icons8, svgrepo): SVG loaded as an `<img crossOrigin="anonymous">` is safe if the CDN serves CORS headers. Most public CDNs do.
- User-pasted arbitrary URLs: these are the uncontrolled case. If a user pastes a Dropbox or Instagram URL as a background image, CORS headers are unlikely. Fall back to proxying.

**Asset proxy as the safety valve:** a lightweight image proxy endpoint (`/api/proxy?url=<encoded-url>`) fetches the resource server-side and re-serves it with `Access-Control-Allow-Origin: *`. This covers the arbitrary-URL case and is a 20-line endpoint. Add it for v1.

---

## Revised Recommendation vs Server-Side Rendering

### When client-side WebCodecs is viable (changed from RES-04)

Client-side MP4 export via WebCodecs + mp4-muxer is now the recommended path for compositions that render to canvas. Specifically:
- Canvas-based Remotion compositions (Three.js, PixiJS, Canvas2D, Lottie on canvas)
- Any custom animation engine that renders to a canvas element
- AI-generated animations built on a canvas-first renderer (if the app controls the renderer)

Benefits over server-side:
- Zero cost per render
- Instantaneous: 450 frames encode in under 5s on typical creator hardware
- No server infra required for the export path
- No round-trip latency

### When server-side remains necessary

Server-side Remotion Lambda is still required for:
- DOM/CSS/SVG-rendered Remotion compositions (the standard Remotion JSX model)
- Any composition that references external assets that cannot be proxied
- Guaranteed consistency across machines (hardware encoder output can vary slightly by platform)
- Compositions longer than ~2 minutes where in-browser memory could become a concern

### Practical implication for the AI motion design tool

The viability of client-side rendering depends entirely on what rendering model the AI code generation targets:

| AI generates... | Export path |
|---|---|
| Canvas2D / Three.js / PixiJS animations | WebCodecs + mp4-muxer, fully viable |
| Standard Remotion JSX (DOM rendering) | Remotion Lambda remains the only reliable path |
| Hybrid (CSS for layout, canvas for visuals) | WebCodecs viable only for the canvas layers |

**Recommendation:** if the project has flexibility in the code generation target, design AI output to render to `OffscreenCanvas` (not DOM). This unlocks zero-cost client-side MP4 export and eliminates the Remotion Lambda dependency entirely for the export path. The trade-off is that `OffscreenCanvas`-first animations are less intuitive to hand-edit than Remotion JSX.

If the project commits to standard Remotion JSX, implement Remotion Lambda for MP4 (as RES-04 recommended) and treat the WebCodecs findings as a future path contingent on switching renderers.

---

## Key Gotchas

1. `VideoFrame` must be explicitly `.close()`d after `encoder.encode()`. Leaking VideoFrames exhausts GPU memory silently -- no JS OOM error, just visual glitches or a crashed GPU process.

2. `encoder.flush()` is async and MUST be awaited before `muxer.finalize()`. Calling `finalize()` without flushing produces a truncated or corrupt file.

3. Safari's WebCodecs implementation does not support `VideoEncoder` with `AV1` or `VP9` codec strings as of mid-2026. Use `avc1.42001f` (H.264 Baseline) for maximum compatibility. To check: `await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', ... })` returns `{ supported: true }` on all three engines.

4. `mp4-muxer`'s `fastStart: 'in-memory'` mode buffers the entire encoded output in `ArrayBufferTarget.buffer`. The buffer is an `ArrayBuffer` with a fixed initial allocation that grows via `resizable ArrayBuffer` (Chrome 111+, Firefox 128+, Safari 16.4+). On browsers without resizable ArrayBuffer, mp4-muxer falls back to copying; still works but slower.

5. COOP: same-origin breaks `window.opener`-based Google OAuth popup. If you ever need COOP/COEP for any reason (multi-threaded ffmpeg.wasm, SharedArrayBuffer for anything), switch to OAuth redirect flow first.
