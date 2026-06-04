# Image and File Handling with Claude API

Research completed 2026-06-04. Covers token costs, supported formats, the Files API, motion-design-specific use cases, graphic generation capability, vision model availability, and prompt caching.

---

## 1. Image Input Token Cost

Claude calculates image token costs by dividing the (possibly downscaled) image into tiles and charging a fixed token count per tile.

**Scaling step (applied first):**
- The image is scaled down (maintaining aspect ratio) to fit within a bounding box of **1568 x 1568 px** for claude-3 and claude-3.5+ models.
- If both dimensions already fit, no scaling occurs.

**Tile calculation:**
- The scaled image is divided into **512 x 512 px tiles** (rounded up at the edges).
- Each tile costs approximately **750–800 tokens** for Sonnet/Haiku models; Opus is similar.
- There is also a small base overhead (~85 tokens) added once per image.

**Example — 1080 x 1920 portrait (common social media vertical):**
```
Original: 1080 x 1920
Fits within 1568-wide box? Height 1920 > 1568 → scale by 1568/1920 = 0.8167
Scaled:   882 x 1568
Tiles:    ceil(882/512) x ceil(1568/512) = 2 x 4 = 8 tiles
Tokens:   85 (base) + 8 x ~765 = ~6,205 tokens
```

**Rule of thumb for estimates:** `tokens ≈ (scaled_width * scaled_height) / 750`

For the same portrait:
```
(882 x 1568) / 750 ≈ 1,843 tokens
```
The tile formula is more accurate; the rough formula underestimates by ~3x because it ignores partial tiles. Use the tile calculation for cost projections.

**Comparison to text:**
- 6,200 tokens ≈ ~4,650 words of text.
- A typical brief text description of the same image might be 50–200 tokens.
- Sending the image is 30–100x more expensive in tokens than a text description — but provides ground truth for visual details Claude cannot infer from a description.

---

## 2. Supported Formats and Limits

| Property | Value |
|---|---|
| Accepted formats | JPEG, PNG, GIF (static and animated), WebP |
| Max file size per image | 5 MB |
| Max images per API request | 20 (varies by model; check current docs) |
| Max pixel dimensions | ~8,000 x 8,000 px (server-side limit; larger images are rejected) |
| Color modes | RGB, RGBA, grayscale — all accepted |

**GIF notes:**
- Animated GIFs are accepted, but Claude processes only the **first frame** of an animated GIF — it does not see motion.
- For multi-frame analysis, extract individual frames and send as separate image blocks.

**Video:**
- No native video input. MP4, MOV, WebM, etc. are not accepted.
- Workaround: extract key frames (e.g., with ffmpeg) and send as individual images. For a 10-second clip at 24 fps you'd extract a representative subset (e.g., 1 frame/sec = 10 images ≈ 60k tokens at 1080x1920).

---

## 3. Files API

Anthropic ships a **Files API** (available as of mid-2025) that lets you upload a file once and reference it by `file_id` in subsequent requests instead of re-sending base64 data every time.

**How it works:**
```
POST /v1/files                  # upload — returns file_id
Content-Type: multipart/form-data

# Then in a messages request:
{
  "role": "user",
  "content": [
    {
      "type": "image",
      "source": {
        "type": "file",
        "file_id": "file_abc123"
      }
    }
  ]
}
```

**Key properties:**
- Files persist on Anthropic's servers until explicitly deleted (`DELETE /v1/files/{file_id}`).
- Supported file types through Files API: images (JPEG, PNG, GIF, WebP), PDFs, plain text, and certain other document types.
- File size limit: same 5 MB per file for images.
- Files are scoped to your API key (org-level, not per-user).

**For the motion design app:** The Files API is the correct approach for persistent brand assets — logos, style reference images, color palette swatches. Upload once at session start (or when the user provides assets), store the `file_id` in session state, and reference it in every subsequent message instead of re-encoding 5 MB of PNG each time.

---

## 4. Use Cases for the Motion Design App

### 4a. "Animate this logo" (user uploads PNG)

**Recommended approach:**
1. Receive the PNG on the backend (multipart upload from frontend).
2. Upload to Anthropic Files API → get `file_id`.
3. In the first Claude message, include the image block (by `file_id`) plus a text prompt: "Analyze this logo's shape, colors, and composition. Then write a Remotion component that animates it with [style]."
4. Claude will identify the visual structure (text vs. icon parts, colors) and produce Remotion/React code.
5. Store `file_id` in session so follow-up messages can reference the same logo without re-upload.

**What Claude can extract from a logo PNG:**
- Brand colors (hex values)
- Rough layout (text position, icon position)
- Shape complexity (can it be animated as paths vs. divs)
- Aspect ratio and bounding box

**What Claude cannot do:**
- Extract vector paths from a raster PNG. It can describe or approximate shapes but cannot output exact SVG path data from a PNG — it can only generate approximations. If the user needs path-accurate animation, they should provide an SVG source file.

### 4b. "Make something like this" (user uploads reference GIF/video)

**GIF:** Claude sees only the first frame. Tell the user this limitation; prompt should ask Claude to infer intent from the static frame plus any textual description. Alternatively extract 2–3 key frames and send as separate images.

**Video (MP4, etc.):** Not accepted natively. Frontend should either:
- Reject with a message: "Video upload is not yet supported — try a GIF or describe the style you want."
- Or server-side: extract key frames with ffmpeg, send a 5–10 frame sample to Claude.

### 4c. "Recreate this" (user pastes/uploads a screenshot)

- Screenshot at typical screen resolution (1440 x 900) fits within the 1568-bounding-box without scaling.
- Tiles: ceil(1440/512) x ceil(900/512) = 3 x 2 = 6 tiles → ~4,675 tokens.
- Claude can describe the layout, identify animation timing cues from motion-blur or ghost frames, and generate Remotion code that approximates the visual.
- Caveat: font identification from screenshots is approximate; Claude infers font family from shape but cannot guarantee exact match.

---

## 5. Claude's Graphic Generation Capability

**Claude cannot directly output rendered images.** It is a text (and code) model only. Its graphic-related outputs:

| Output type | Supported | Notes |
|---|---|---|
| SVG markup (as text) | Yes | Can write valid SVG XML that renders correctly in browsers |
| Canvas2D JS code | Yes | Generates `ctx.fillRect(...)`, `ctx.arc(...)`, etc. |
| CSS animations | Yes | keyframes, transforms, transitions |
| Remotion/React components | Yes | Primary use case for this app |
| Raster images (PNG, JPEG) | No | Cannot output binary image data |
| Three.js / WebGL shaders | Yes (code) | Generates JS/GLSL; rendering happens client-side |
| Lottie JSON animations | Yes (code) | Can produce Lottie JSON structures |

**SVG generation quality:** Claude performs well at generating SVG for geometric shapes, icons, and simple illustrations when given a clear description. For complex organic illustrations it will produce something approximate, not pixel-perfect. For the motion design app, SVG is the right format for logo reconstruction from reference images when exact paths are needed.

**Practical implication for the app:** Claude's role is always *code generator*, not *image generator*. The rendering pipeline (Remotion, browser canvas, Three.js) does the actual pixel production. This is a fundamental architecture constraint.

---

## 6. Vision Model Availability

All models in the **Claude 3 family and later** support image input:

| Model | Vision support | Notes |
|---|---|---|
| claude-3-haiku-20240307 | Yes | Cheapest vision option |
| claude-3-sonnet-20240229 | Yes | Balanced |
| claude-3-opus-20240229 | Yes | Most capable, most expensive |
| claude-3-5-haiku-20241022 | Yes | Fast, low cost |
| claude-3-5-sonnet-20241022 | Yes | Strong coding + vision |
| claude-3-7-sonnet-20250219 | Yes | Best code quality for this app |
| claude-haiku-4-5 (2025+) | Yes | |
| claude-sonnet-4-6 (2025+) | Yes | Current default recommended |

**Claude 2.x and earlier:** No vision support.

**Recommendation for this app:** Use `claude-sonnet-4-6` (or equivalent current Sonnet) as the default. It has strong code generation quality and vision capability at reasonable cost. Offer Haiku 4.5 as a "fast/cheap" tier if real-time iteration is needed and visual analysis is minimal (i.e., code refinement rounds with no new images).

---

## 7. Practical Cost Comparison: Text-Only vs. Image Session

Scenario: 10-turn conversation about building a motion graphic. Session contains 3–5 reference images at 1080 x 1920.

**Image token cost (per image):**
- 1080 x 1920 scaled to 882 x 1568 → 8 tiles → ~6,200 tokens per image

**With 5 images:**
- Image tokens: 5 x 6,200 = 31,000 tokens (input only, one-time)
- Typical text tokens per turn: ~500 in + ~1,000 out = 1,500/turn
- 10 turns text: 15,000 tokens
- **Total with images: ~46,000 tokens input + 10,000 tokens output**

**Text-only session (same conversation, no images):**
- 10 turns: 5,000 in + 10,000 out = 15,000 tokens total

**Cost at claude-sonnet-4-6 pricing (approximate as of 2025):**
- Input: $3/MTok → images add ~$0.093; text adds ~$0.015 → total input ~$0.108
- Output: $15/MTok → ~$0.15
- **Total with images: ~$0.26 per session**
- **Text-only: ~$0.225 per session** (output dominates)

**Conclusion:** For a typical session, images add roughly 40–60% to input token cost, but since output tokens dominate overall cost, the total session cost increase is modest (~15–25%). Images are **not prohibitively expensive** for this use case.

The cost becomes significant only if images are re-sent on every turn (5 images x 10 turns = 50 image-send events = 310,000 image tokens). Mitigation: use the Files API and prompt caching (see below) to avoid re-encoding, and structure the conversation so reference images are sent once in an early turn.

---

## 8. Prompt Caching with Images

Images **can** be cached using `cache_control`. The syntax is identical to caching text blocks:

```json
{
  "role": "user",
  "content": [
    {
      "type": "image",
      "source": { "type": "file", "file_id": "file_abc123" },
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "This is our brand logo. Keep it in context for all subsequent animation requests."
    }
  ]
}
```

**Cache behavior:**
- Cache TTL: 5 minutes (ephemeral). Resets on each cache hit within the TTL window.
- Cache hits cost ~10% of the original input token price.
- Cache misses cost normal input price plus a small write surcharge (~25%).

**Recommended architecture for the motion design app:**

```
Turn 1 (session setup):
  [system prompt, cache_control]     ← cached
  [brand images x5, cache_control]   ← cached
  [user text prompt]                 ← not cached (changes each turn)

Turns 2–N (iteration):
  [system prompt]        ← cache HIT (5min TTL resets)
  [brand images x5]      ← cache HIT
  [growing conv history] ← partially cached
  [new user message]     ← not cached
```

With caching, the 31,000 image tokens are paid at full price once, then at 10% on each subsequent turn. For 10 turns, total image input cost drops from `10 x $0.093 = $0.93` to `$0.093 + 9 x $0.0093 ≈ $0.18` — an 81% reduction.

**Important:** cache_control must be placed on the same content block position across requests for the cache to hit. If the image block position or surrounding context changes (e.g., new messages inserted before it), the cache will miss. Pin reference images in the system prompt or as the first user message to keep the position stable.

---

## Summary and Recommendations for the Motion Design App

| Question | Answer |
|---|---|
| Token cost for 1080x1920 image | ~6,200 tokens (8 tiles) |
| Formats supported | JPEG, PNG, GIF (1st frame only), WebP |
| File size limit | 5 MB per image |
| Files API available? | Yes — upload once, reference by file_id |
| Video input? | No — extract key frames as workaround |
| Claude generates images? | No — generates SVG/code only |
| Vision on all models? | Yes, Claude 3+ family |
| Prompt caching for images? | Yes — use cache_control: ephemeral |

**Recommended implementation:**
1. Accept PNG/JPEG/WebP uploads only (no video at v0).
2. Upload to Anthropic Files API on receipt; store `file_id` in session.
3. Send reference images in the first user message or system prompt with `cache_control`.
4. Re-use `file_id` references (not base64) in all subsequent messages.
5. Use `claude-sonnet-4-6` or latest equivalent Sonnet as default model.
6. Budget ~$0.25–0.50 per typical session including 3–5 reference images.
