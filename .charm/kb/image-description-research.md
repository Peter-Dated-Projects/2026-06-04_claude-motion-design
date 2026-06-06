---
id: image-description-research
root: research
type: research
status: current
summary: "Workflow and prompt schema for describing images to Claude so it can recreate them as CSS/SVG/React code within Remotion's no-external-assets constraint."
created: 2026-06-05
updated: 2026-06-05
---

# Image Description Methods for Claude-Driven Motion Design Replication

## Context and Constraint

The Remotion sandbox only permits: CSS gradients, SVG shapes inline in JSX, web-safe system fonts, and React/Remotion primitives. No `staticFile`, no `<img>` with URLs, no canvas, no external fonts. Imports must stay within `react`, `react-dom`, `remotion`, and `@remotion/player`. This hard constraint shapes every recommendation below -- the goal is not pixel-perfect photo reconstruction but faithful visual impression through abstractions the sandbox permits.

---

## 1. Claude Vision Capability Assessment

Claude can reliably extract from an image when prompted:

- **Object/element identification** -- names and semantic roles (logo, background, headline, card)
- **Dominant color palette** -- primary fill colors, accent tones, background hue (hex approximations)
- **Spatial layout** -- rough grid position (top/center/bottom, left/right), alignment (centered vs. left-aligned), stacking order
- **Typography** -- font weight class (thin/regular/bold/black), case (uppercase/mixed), approximate size (large/medium/small), and verbatim text content via OCR
- **Background character** -- solid fill, gradient direction (radial vs. linear), multi-color wash
- **Shape vocabulary** -- whether the visual is geometric/flat, photographic, illustrative, diagrammatic

**Reliable:** text extraction, color identification, object naming, rough spatial relationships, logo/icon shape class.

**Unreliable:** pixel-exact coordinates, font family name, precise geometry of complex paths, colors in photographic scenes with mixed lighting.

**Practical implication:** use Claude vision to extract a structured intermediate description; treat the description as *approximately correct*, not as a pixel spec.

---

## 2. Recommended Workflow (Step by Step)

### Step 1 -- Structured image extraction prompt

Send the image to Claude with this extraction prompt (or a close paraphrase). The image should come *before* the text in the message (Claude processes image-first better):

```
Analyze this image and produce a structured visual scene description in the following JSON format.
Be concrete. Use hex codes for all colors. Describe positions as fractions of the canvas
(0.0 = left/top, 1.0 = right/bottom). Describe sizes as fractions of canvas width/height.

{
  "background": {
    "type": "solid | linear-gradient | radial-gradient | multi-layer",
    "colors": ["#hex1", "#hex2"],
    "direction": "to bottom | to right | radial center | ...",
    "description": "one sentence"
  },
  "palette": {
    "dominant": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "text": "#hex"
  },
  "layers": [
    {
      "id": "element-name",
      "type": "rect | ellipse | path | text | icon | image-region",
      "description": "what this element is semantically",
      "position": { "cx": 0.5, "cy": 0.5 },
      "size": { "w": 0.4, "h": 0.1 },
      "fill": "#hex",
      "stroke": "#hex or null",
      "opacity": 1.0,
      "z": 1,
      "notes": "any non-obvious shape detail, gradient direction, border-radius, etc."
    }
  ],
  "typography": [
    {
      "content": "verbatim text",
      "role": "headline | subhead | body | caption | label",
      "size_class": "display | large | medium | small",
      "weight": "400 | 600 | 700 | 800 | 900",
      "color": "#hex",
      "alignment": "center | left | right",
      "position": { "cx": 0.5, "cy": 0.3 }
    }
  ],
  "mood": "one-sentence visual impression for creative interpretation",
  "recreation_strategy": "brief note on what abstraction to use (flat geometry, gradient fields, etc.)"
}
```

### Step 2 -- Review and annotate the extraction

Spot-check the returned JSON for obviously wrong colors or positions. For logos or brand assets the user recognizes, correct hex codes manually if needed. The extraction is a scaffold, not a finished spec.

### Step 3 -- Pass to Claude for code generation

Include the JSON description in the animation prompt alongside the Remotion constraint reminder. Example:

```
Recreate the following visual as a Remotion composition. The only allowed primitives are:
CSS gradients, inline SVG in JSX, web-safe system fonts, and Remotion/React primitives.
No external images, no staticFile, no fonts from the network.

Visual description:
<paste JSON from Step 1>

Map each layer to its closest CSS/SVG equivalent. Where photographic detail is impossible,
use color-field abstractions (dominant-color radial gradients, flat geometric shapes).
Animate in with snappy-entrance; hold with gentle-float; exit with soft-exit.
```

### Step 4 -- Iterative refinement

Have Claude render, show the visual, and ask targeted corrections: "the gradient on the background should lean more blue", "the logo mark needs thicker stroke". Because the extraction is in structured form, corrections are concrete rather than vague.

---

## 3. CSS/SVG Recreation Patterns (Description -> Code)

### 3a. Photograph / hero image

**What works:** color-field abstraction. Extract 3-5 dominant color zones from the image; map each to a CSS radial or linear gradient layer.

Example description layer:
```json
{ "type": "image-region", "description": "sunset sky", "fill": "#FF7043", "notes": "fades to deep purple at top" }
```

Output pattern in JSX:
```tsx
<div style={{
  position: 'absolute', inset: 0,
  background: 'linear-gradient(to bottom, #2D1B69 0%, #FF7043 60%, #FFD54F 100%)'
}} />
```

Stack 2-3 radial gradient blobs on top for color complexity:
```tsx
<div style={{
  position: 'absolute', inset: 0,
  background: `
    radial-gradient(ellipse 60% 40% at 30% 70%, rgba(255,112,67,0.7), transparent),
    radial-gradient(ellipse 80% 60% at 70% 30%, rgba(45,27,105,0.9), transparent)
  `
}} />
```

### 3b. Logo / wordmark / icon

**What works:** SVG path primitives for geometric logos; letter-based wordmarks in system fonts with exact brand hex.

For a geometric logo (e.g., a circle-with-slash or interlocking shapes), describe the primitives extracted:
```json
{ "type": "path", "description": "left arc of logo", "fill": "#1565C0", "notes": "semicircle, flat side right" }
```

Output pattern:
```tsx
<svg width="120" height="120" viewBox="0 0 120 120">
  <path d="M 60 10 A 50 50 0 0 0 60 110" fill="#1565C0" />
  <path d="M 60 10 A 50 50 0 0 1 60 110" fill="#E53935" />
</svg>
```

For wordmarks: use the closest system-font weight to match the brand weight and apply the exact brand hex via `color`.

### 3c. UI screenshot / product mockup

**What works:** layered `<div>` rectangles for cards/panels, `border-radius` for rounded corners, `box-shadow` for elevation, system fonts for text labels.

Description extraction yields a set of `rect` layers with fills and text layers. The code maps each rect to an absolutely-positioned `<div>` with fractional-position mapped to px coordinates inside the 1080x1920 canvas.

Example mapping (layer cx=0.5, cy=0.4, w=0.7, h=0.1 on a 1080x1920 canvas):
```tsx
const cardX = 0.5 * 1080 - (0.7 * 1080) / 2;  // left edge
const cardY = 0.4 * 1920 - (0.1 * 1920) / 2;  // top edge
// width = 756, height = 192
```

### 3d. Branded slide / presentation frame

**What works:** background rectangle in brand color, geometric accent bar (thin colored rectangle), headline in Bold Impact stack, subhead in Neutral Modern. The design token system in `remotion-skills.txt` section 4-6 already covers this.

For brand images where the user supplies the palette, override the default palette fields in the description JSON with the extracted brand hex codes.

### 3e. Gradient / abstract background

**What works:** directly translates -- CSS multi-stop linear/radial gradients are expressive enough for most abstract backgrounds. Extract color stops and positions from the description.

---

## 4. Limitations and Graceful Fallback Strategies

| Visual element | Recreatable? | Fallback |
|---|---|---|
| Flat geometric logo | Yes -- SVG primitives | -- |
| Wordmark / typographic logo | Yes -- system font + hex | -- |
| Abstract gradient background | Yes -- CSS gradients | -- |
| UI screenshot / card layout | Yes -- div rectangles | -- |
| Simple icon / pictogram | Partial -- SVG path for simple shapes | Replace with Unicode glyph or omit |
| Illustration / line art | Partial -- SVG paths for simple figures | Simplify to 3-5 dominant shapes |
| Photograph (people, landscape) | No | Color-field abstraction (3-5 gradient blobs) |
| Complex texture (fabric, skin, stone) | No | Flat color fill in dominant tone |
| Photorealistic 3D render | No | Abstract geometric composition with palette |
| Custom brand font | No (no @font-face) | Closest-weight system font + compensation via weight/tracking |
| Drop shadow / blur effect (photo) | Partial -- `box-shadow`/`filter: blur()` in CSS, or SVG `feDropShadow` | Use inline SVG `<filter>` if needed |
| Animated GIF / video frame | No | Extract one keyframe, apply color-field method |

**Guiding principle for fallbacks:** match the *mood and palette* rather than the literal content. A photograph of a sunset becomes a gradient wash in the same warm tones. A photograph of a product becomes a colored rectangle with the product name in type. Users care more that the animation feels like their brand than that it literally recreates the image.

---

## 5. Best Handoff Format Assessment

Four formats were considered:

1. **Natural language scene description** -- good for simple images; too ambiguous for complex multi-element layouts; Claude can misinterpret "left side" as relative to foreground object vs. canvas.

2. **Structured JSON schema** (recommended above) -- best balance of precision and LLM parseability. Fractional positions avoid canvas-size assumptions. Named types constrain the output vocabulary. Claude's structured output guarantee (available via JSON schema enforcement) can be used to guarantee the format.

3. **Layered component spec (React/JSX pseudocode)** -- useful for users who already know what layers they want; skip the vision extraction step and go straight to describing the component tree.

4. **Spatial grid description** -- divide the frame into a NxM grid (e.g., 4x6), describe what occupies each cell. Useful when the image is a clean layout (slide, poster, dashboard); too coarse for organic compositions.

**Recommendation:** JSON schema for most cases, spatial grid as a quick shorthand for clean layout images, natural language only for mood/texture additions to an otherwise code-described scene.

---

## 6. Relationship to Current remotion-skills.txt

The existing skill file covers *generation from text prompts* well: palettes, spring presets, templates, typography scale. What it does not cover:

- How to receive a visual reference (an image) and extract a description from it
- A structured intermediate format for passing that description into a code generation prompt
- CSS/SVG pattern recipes for the most common image types (photo, logo, UI)

The workflow above is **additive**: the extraction step feeds into the existing generation vocabulary. When implementing, the extracted palette can be dropped into the `P` object from the skill file, and the layer types map to the existing template vocabulary (T10 for backgrounds, T7 for logos, etc.).

The recommended addition to `remotion-skills.txt` (or a new companion skill file) would be a section titled "Image Reference Mode" that includes:
- The extraction prompt template (Step 1 above)
- The 5 CSS/SVG pattern recipes (Section 3)
- The fallback table (Section 4)

---

## 7. Tools and Prior Art Worth Citing

No installation is required to use these -- they are reference points for technique.

- **StarVector** (`starvector/starvector-8b-im2svg` on HuggingFace) -- multimodal LLM fine-tuned specifically for image-to-SVG; uses ViT encoder + LLM adapter. Shows that VLMs can produce clean SVG code from images when the output vocabulary is constrained to primitives.

- **Chat2SVG** (CVPR 2025, `chat2svg.github.io`) -- hybrid LLM+diffusion system for SVG from text. Its 4-step pipeline (prompt expansion -> object decomposition -> layout planning -> SVG code gen with constrained primitives) is a validated architecture for the extraction-then-generation pattern recommended here.

- **LLM4SVG** (CVPR 2025, `github.com/ximinng/LLM4SVG`) -- foundation model fine-tune for SVG understanding/generation. Demonstrates that adding semantic token layers to standard LLM fine-tunes significantly improves SVG structure adherence.

- **LLM Blueprint** (arxiv 2310.10640) -- structured decomposition of complex image prompts into bounding-box layouts before code generation. The bounding-box-as-fraction approach in this note's JSON schema draws from this.

- **CSS-Tricks: Drawing Images with CSS Gradients** -- practical walkthrough of the multi-layer gradient technique. Confirms the complexity ceiling (stylized illustration, not photorealism) and the debugging challenge.

- **Keyframer** (arxiv 2402.06071) -- GPT-4 + CSS animation for SVG inputs. Adjacent prior art: demonstrates LLM code generation on structured SVG inputs with iterative refinement.
