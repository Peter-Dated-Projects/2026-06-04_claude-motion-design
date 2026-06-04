---
id: export-rendering-pipeline
root: architecture
type: architecture
status: current
summary: "Cost/complexity matrix and recommended v0 export strategy for MP4, GIF, and code export from a Remotion-based motion design tool."
created: 2026-06-04
updated: 2026-06-04
---

# Export and Rendering Pipeline

Research findings for T-004. Covers every viable export path for a completed Remotion-based motion graphic: MP4 video, GIF, and raw code download. Includes a cost/complexity matrix and a recommended default strategy for v0.

---

## MP4 Export Options

### 1. Remotion Lambda (AWS Lambda render farm)

Remotion Lambda distributes rendering across many Lambda functions in parallel, with each function rendering a chunk of frames, then stitching via ffmpeg in S3.

**Cost model (2026 pricing):**
- Lambda compute: ~$0.0000166667 per GB-second. A 15-second 1080x1920 render uses roughly 2-4 minutes of Lambda time across ~20 concurrent functions. Typical total Lambda cost: $0.05-$0.15 per render.
- S3 storage for the output video: negligible (<$0.001 per render for a ~30 MB file, immediate deletion after delivery).
- Total per-render cost estimate: **$0.05 to $0.20** for a 15s 1080x1920 video at typical complexity. Dense animation (many composited layers) can push toward $0.40.
- At 1000 renders/month: $50-$200/month in AWS costs.

**Latency:**
- Cold start: 8-20 seconds for Lambda container init on first request (can be mitigated with provisioned concurrency at ~$10/month per function).
- Warm render of 15s at 1080x1920 @30fps (450 frames): 45-90 seconds wall clock time with parallelism across 20 Lambda functions.
- Total user-facing latency (warm): **60-120 seconds** from submit to download link.

**Setup complexity:** High. Requires: AWS account, IAM roles, S3 bucket, Remotion Lambda deployment via CLI (`npx remotion lambda sites create`), and a server endpoint to trigger renders. Documented well but non-trivial to configure correctly, especially IAM permissions. Infrastructure is managed by Remotion's CLI but still requires AWS expertise to debug.

**Operational complexity:** Medium ongoing. Lambda functions auto-scale. Main ops concern is Lambda concurrency limits (default 1000/region) and occasional S3 permission issues. Remotion provides a status dashboard endpoint.

**When it makes sense:** When you need production-quality, server-authoritative renders at scale. The render is deterministic and identical on every machine. This is the only approach that reliably handles complex compositions with external asset fetches.

---

### 2. Self-Hosted Remotion Render (Docker + ffmpeg on Fly.io or Railway)

Run `npx remotion render` inside a Docker container on a persistent server. Fly.io and Railway both support Docker deploys.

**Cost model:**
- Fly.io: a 4-CPU, 8 GB RAM machine (~$0.14/hour) can render a 15s 1080x1920 video in roughly 3-8 minutes. At 1000 renders/month (assuming renders are queued, not concurrent), a single machine handles ~150/day = 4500/month. Cost: ~$100/month flat for the server.
- Railway: similar pricing, ~$100-150/month for equivalent specs.
- Does NOT scale horizontally without significant queue infrastructure.

**Latency:** 3-8 minutes per 15s render on a 4-CPU machine, no parallelism. This is the primary limitation — Remotion Lambda's parallelism is fundamentally faster for high-resolution output.

**Setup complexity:** Medium. Docker image is straightforward (Remotion publishes a base image). Main complexity: render queue (BullMQ or similar), result delivery (S3 or signed URL), timeout handling. More moving parts than Lambda but all visible.

**When it makes sense:** Budget-sensitive projects where $100/month flat is cheaper than Lambda at low volume. Not ideal for v0 because of the latency cliff — 3-8 minutes is poor UX for a demo/MVP.

---

### 3. Browser-Based MediaRecorder API

Capture frames from a canvas/video element using `MediaRecorder` with `video/webm` codec, then optionally re-encode to MP4 client-side using FFmpeg.wasm or upload the WebM directly.

**Practicality at 1080x1920 on a modern laptop:**
- MediaRecorder captures at real-time speed only — it cannot accelerate past playback speed. A 15-second animation takes at least 15 seconds to capture.
- At 1080x1920: the Remotion Player renders to a canvas. Canvas capture via `captureStream()` works, but:
  - The browser's compositor must drive the animation at full speed with no dropped frames. At 1080x1920 @30fps, a modern M-series Mac handles this fine. A mid-tier Windows laptop may drop frames if the JS animation is heavy, causing the captured video to stutter.
  - Browser tab must stay in the foreground — `captureStream()` pauses or degrades when the tab is backgrounded.
- **Verdict: Practical on high-end hardware (M1+, modern desktop GPU), unreliable on mid-tier laptops at 1080x1920.** At 720x1280 (scaled down 50%), it becomes broadly reliable.
- Output format from `MediaRecorder` is WebM (VP8/VP9). Safari does not support `MediaRecorder` for video capture of canvas streams (as of 2025, only audio is supported in Safari). This is a significant compatibility issue.

**CORS constraints on canvas capture with external assets:**
- Any image or font loaded from a cross-origin domain taints the canvas. Once tainted, `canvas.toBlob()` and `captureStream()` throw a SecurityError.
- Remotion animations frequently load images and fonts from external CDNs or user-supplied URLs. This is a fundamental blocker unless:
  1. All assets are proxied through your own origin (adds server infra).
  2. Assets are hosted with `Access-Control-Allow-Origin: *` AND loaded with `crossOrigin="anonymous"` (works for many public CDNs; fails for user-uploaded S3 objects without correct bucket policy).
- **This is the single biggest practical barrier to MediaRecorder-based export.** It cannot be solved purely client-side unless asset handling is strictly controlled from the start.

**When it makes sense:** Low-resolution, asset-light demos on controlled hardware. Not a reliable path for a product.

---

### 4. FFmpeg.wasm (Client-Side Encode)

`ffmpeg.wasm` (Fabio Spampinato's port) compiles FFmpeg to WebAssembly. It can encode a sequence of PNG frames into MP4 (H.264 via `libx264`).

**Workflow:**
1. Render Remotion animation frame-by-frame to canvas (no real-time constraint — can use Remotion's `renderStill` export or manual frame stepping).
2. Export each frame as a PNG Blob.
3. Feed frames to FFmpeg.wasm to encode as H.264 MP4.

**Performance at 1080x1920 @30fps, 15s (450 frames):**
- FFmpeg.wasm runs single-threaded in the browser (SharedArrayBuffer is required for the multi-threaded build, which in turn requires COOP/COEP headers that break many third-party integrations).
- Single-threaded H.264 encode of 450 frames at 1080x1920: approximately **8-20 minutes** on a modern laptop. This is unusably slow for a product.
- Memory pressure: 450 frames * 1080*1920*4 bytes = ~3.5 GB of raw frame data. The browser will OOM before encoding completes on most machines.
- At 720x1280: ~1.5 GB, still significant. Encode time drops to ~3-8 minutes, still too slow.
- The multi-threaded build (`ffmpeg.wasm` with `@ffmpeg/ffmpeg` v0.12+) reduces encode time by 4-8x if COOP/COEP headers are set — but those headers prevent `<iframe>` embeds, Google OAuth popups, and third-party scripts from working, which likely conflicts with the app's architecture.

**CORS:** Same canvas-taint issue as MediaRecorder for frame capture. Same mitigations required.

**When it makes sense:** Low-resolution (<540p), short-duration (<5s) clips on controlled hardware with no cross-origin assets. Not viable as a primary MP4 export path at 1080x1920.

---

## GIF Export Options

### 1. gif.js / gifshot (In-Browser)

`gif.js` uses Web Workers to encode GIF frames. `gifshot` is a higher-level wrapper.

**Performance at 1080x1920:**
- GIF is inherently 256-color palette-indexed. A 1080x1920 GIF at 15s @15fps (GIF is typically capped at 15fps for file size) would be enormous: rough estimate 80-200 MB. This is unusable as a deliverable.
- At 400x711 (typical social story thumbnail scale) @15fps, a 15s GIF is 15-40 MB — borderline acceptable.
- Encode time in-browser at thumbnail resolution: 30-90 seconds via gif.js workers. Acceptable.

**Quality:** GIF's 256-color limit makes it poor for photorealistic content but acceptable for flat design / motion graphics with limited color palettes.

**Recommendation for GIF:** Target 400-600px width at 10-15fps, 3-8 seconds max. Full 1080x1920 GIF is not a realistic output.

### 2. Server-Side ffmpeg Conversion from MP4

If a server-side render already produced an MP4, ffmpeg can convert to GIF with dithering:
```
ffmpeg -i input.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i input.mp4 -i palette.png -vf "fps=12,scale=480:-1:flags=lanczos,paletteuse" output.gif
```
The two-pass palette approach produces significantly better GIF quality than single-pass.

**Cost:** Minimal if piggybanking on a server that already has ffmpeg (same Fly.io/Railway server or Lambda Layer). No meaningful additional cost per render.

**Latency:** 5-30 seconds for a 480px wide GIF conversion on a server with the MP4 already available.

**Recommendation:** If the v0 path includes a server-side render, add GIF as a free second output. If not, offer in-browser GIF at reduced resolution only.

---

## Code Export

### Option A: Download the .tsx File

The simplest form of code export: serialize the Remotion composition source to a `.tsx` file and offer it as a download.

**What metadata needs to be embedded:**
- `fps`, `durationInFrames`, `width`, `height` — passed as props or hardcoded in the composition.
- Any imported asset URLs (fonts, images) — these must either be absolute URLs or the user must be informed they need to re-provide assets locally.
- The list of `npm` packages imported (e.g., `remotion`, any animation helpers used by the AI). Without knowing the versions, a user who runs `npm install` may get incompatible versions.
- A comment block at the top noting the Remotion version the composition was generated against.

**Round-trip import feasibility:** A bare `.tsx` file can be re-imported into the app if the app has a file upload flow that:
1. Parses the TSX to extract the composition name and props.
2. Validates it compiles without errors (requires a server-side TypeScript check or in-browser transpile).
3. Re-injects it as the active composition.

This is feasible but requires careful implementation. The biggest footgun: if the AI generates component names dynamically (e.g., `export const MyComp = ...`), the import parser must handle arbitrary names, not just a fixed export name.

### Option B: ZIP Bundle with package.json

Package the TSX alongside a minimal `package.json`, `tsconfig.json`, and a `README.md` explaining how to run it.

**Contents of the ZIP:**
```
export/
  src/
    MyComposition.tsx
  package.json          # { "dependencies": { "remotion": "^4.x", "react": "^18" } }
  tsconfig.json         # standard Remotion tsconfig
  remotion.config.ts    # minimal config pointing at the composition
  README.md             # "run: npm install && npx remotion preview"
```

**Advantages over bare TSX:**
- User can `npx remotion preview` immediately without any setup beyond `npm install`.
- Version pins prevent dependency drift.
- Provides a complete standalone artifact that works offline.

**Disadvantages:**
- ZIP generation requires a bit more server logic (or client-side `jszip`).
- The bundle must be tested against actual Remotion versions — a generated composition that references an API that changed between Remotion 4.x minor versions will fail silently.

**Round-trip import from ZIP:** More complex than from TSX. The app would need to unzip, find the entry composition, and re-import. Adds meaningful complexity for v0.

**Recommendation:** Offer the bare `.tsx` download for v0 (simplest to implement). The ZIP bundle is a v1 enhancement. Round-trip import is a v2 feature — scope it only after the export path is stable.

---

## Cost/Complexity Matrix

| Approach | $/render (15s 1080x1920) | User latency | Setup complexity | Reliability | v0 viable? |
|---|---|---|---|---|---|
| Remotion Lambda | $0.05-$0.20 | 60-120s | High (AWS IAM, S3) | High | Stretch goal |
| Self-hosted Remotion (Fly.io) | $0.10-$0.25 (amortized) | 3-8 min | Medium | High | No (latency) |
| MediaRecorder API | $0 | ~15s + overhead | Low | Low (CORS, browser) | No (reliability) |
| FFmpeg.wasm | $0 | 8-20 min | Low | Low (OOM, speed) | No |
| GIF in-browser (gif.js) | $0 | 30-90s (small) | Low | Medium (low-res only) | Yes (low-res) |
| GIF server-side (ffmpeg) | ~$0 extra | 5-30s | Low (if server exists) | High | Yes (if server exists) |
| TSX download | $0 | <1s | Very low | High | Yes |
| ZIP bundle | $0 | <2s | Low | High | Yes (v1) |

---

## Recommended v0 Export Strategy

### Immediate v0 (ship fast, zero infra)

1. **Code export (TSX download):** Implement first. Zero cost, zero infra, immediately useful for developers. Embed the Remotion version and composition metadata in a comment block. This is the "escape hatch" that lets power users take work out of the tool entirely.

2. **In-browser GIF at reduced resolution (gif.js):** Offer at 480px width, capped at 8 seconds. This gives users a shareable artifact without any server infrastructure. Clearly label it as "preview quality" in the UI. Use `gif.js` with workers — it's battle-tested and straightforward to integrate.

### v0.5 (after first user feedback, add server render)

3. **Remotion Lambda for MP4:** This is the right long-term answer for MP4. The $0.10-$0.20/render cost is reasonable to absorb in early v0 (first 500 renders cost <$100). Set up Lambda once, expose a `/api/render` endpoint, and deliver a pre-signed S3 URL when complete. Poll for status with a simple progress bar.
   - Use Remotion's `renderMediaOnLambda` + `getRenderProgress` SDK functions — the API is well-designed.
   - Gate behind a "Render MP4" button that sets expectations about the 60-120s wait.
   - Add server-side ffmpeg GIF conversion as a free second output from the same Lambda render.

### What to defer

- **Self-hosted Remotion render:** Inferior to Lambda in every dimension (slower, doesn't scale). Skip it.
- **MediaRecorder / FFmpeg.wasm for MP4:** CORS issues and performance make these unreliable for a product. They are not worth the debugging investment.
- **ZIP bundle / round-trip import:** Meaningful added complexity. Target for v1 after export is stable.

### Key implementation notes

- **Asset proxying is required for reliable MediaRecorder/canvas capture** if that path is ever revisited. Every external URL (Google Fonts, user-uploaded images, icon CDNs) must be proxied through your own origin. Budget for this before attempting any canvas-capture approach.
- **Remotion Lambda cold starts are the main UX risk.** Provisioned concurrency ($10-15/month per function) eliminates cold starts entirely and is worth it once renders are user-facing.
- **File size expectations:** A 15s 1080x1920 H.264 MP4 at Remotion's default CRF is approximately 15-40 MB depending on motion complexity. Set a download timeout and show file size in the UI before download starts.
- **Round-trip import (TSX -> app):** The most important design constraint is that the AI generates a single named export with a stable prop interface. Enforce this in the code generation prompt from day one, even if import isn't implemented yet — retrofitting it is painful.
