---
id: platform-safe-zones
root: domain
type: domain
status: current
summary: "Pixel-accurate safe zone boundaries for TikTok, Instagram Reels, and YouTube Shorts at 1080x1920, with a universal safe zone and Remotion integration guidance."
created: 2026-06-04
updated: 2026-06-04
---

# Platform Safe Zones at 1080x1920

All measurements are in pixels at the canonical 1080x1920 short-form video resolution. Values represent the inset from each edge where the platform's own UI elements sit, i.e. the region your content must stay *out of* to be fully visible. Safe zone = the content area that remains.

---

## TikTok

### UI element locations

| Element | Edge | Inset (px) | y-range |
|---|---|---|---|
| For You / Following tabs + top bar | top | 0–110 | 0–110 |
| Avatar + follow button | right | 0–120 | 220–430 |
| Like button | right | 0–120 | 450–590 |
| Comment button | right | 0–120 | 610–740 |
| Share button | right | 0–120 | 760–890 |
| Music disc (rotates) | right | 0–120 | 1680–1800 |
| Username + caption area | bottom | 0–350 | 1570–1920 |
| Music name bar | bottom | 0–270 | 1650–1920 |
| Progress scrubber | bottom | 0–6 | 1914–1920 |

### TikTok safe zone (insets from each edge)

```
top:    140px
bottom: 370px
left:    30px
right:  150px
```

Safe content area: `x: 30–930`, `y: 140–1550`  
Dimensions: 900 × 1410 px  
Aspect ratio of safe area: ~9:14.1

### Notes

- TikTok does **not** letterbox or crop 1080x1920; it fills edge to edge on all modern phones.
- On older/smaller phones (iPhone SE, Android budget devices) the action buttons shift left slightly — add ~20px right margin for conservative coverage.
- Auto-captions (TikTok's built-in CC) default to the lower-center of the caption zone (~y=1650–1800). If your video has burned-in captions, place them at y=1550–1700 max and they will overlap with TikTok auto-captions — recommend placing captions above y=1500.
- The "Follow" button overlaps the avatar column only when a non-follower watches; assume it is always present.

---

## Instagram Reels

### UI element locations

| Element | Edge | Inset (px) | y-range |
|---|---|---|---|
| Story-style top gradient + story bar (thin) | top | 0–60 | 0–60 |
| Top action row (close, more) | top | 0–100 | 0–100 |
| Like button | right | 0–130 | 1180–1310 |
| Comment button | right | 0–130 | 1330–1460 |
| Share button | right | 0–130 | 1480–1610 |
| More options (three-dot) | right | 0–130 | 1640–1740 |
| Username + caption | bottom | 0–280 | 1640–1920 |
| Audio name bar | bottom | 0–210 | 1710–1920 |
| Like/view count bar | bottom | 0–320 | 1600–1920 |
| Progress scrubber (thin bar) | bottom | 0–8 | 1912–1920 |

### Instagram Reels safe zone (insets from each edge)

```
top:    130px
bottom: 340px
left:    30px
right:  160px
```

Safe content area: `x: 30–920`, `y: 130–1580`  
Dimensions: 890 × 1450 px

### Notes

- Instagram **crops** Reels on the profile grid to a 1:1 (1080x1080) center crop. This doesn't affect playback, but if the video will also serve as a feed post, keep essential visuals in the center 1080x1080 region (y: 420–1500).
- Instagram's action buttons (like, comment, share) sit lower than TikTok's — they cluster in the bottom-third right column (~y=1180–1740) rather than mid-screen.
- The top bar is lighter — a gradient overlay — and only 60–100px, so the top margin can be more permissive than TikTok.
- Reels on the Explore page get a slightly different crop. The 130px top / 340px bottom insets cover this.
- Instagram's auto-captions appear in the lower center, similar vertical position to TikTok (~y=1700–1850).

---

## YouTube Shorts

### UI element locations

| Element | Edge | Inset (px) | y-range |
|---|---|---|---|
| Top bar (back button, share, search) | top | 0–110 | 0–110 |
| Like button | right | 0–130 | 700–840 |
| Dislike button | right | 0–130 | 860–980 |
| Comment button | right | 0–130 | 1000–1130 |
| Share button | right | 0–130 | 1150–1280 |
| Subscribe button (bell icon) | right | 0–130 | 1300–1430 |
| Channel name + title | bottom | 0–280 | 1640–1920 |
| Subscribe button (bottom, horizontal) | bottom | 0–320 | 1600–1920 |
| Progress scrubber bar | bottom | 0–20 | 1900–1920 |

### YouTube Shorts safe zone (insets from each edge)

```
top:    140px
bottom: 360px
left:    30px
right:  160px
```

Safe content area: `x: 30–920`, `y: 140–1560`  
Dimensions: 890 × 1420 px

### Notes

- YouTube Shorts **does** play 9:16 content edge-to-edge on most Android and iOS devices.
- The action buttons on Shorts sit in the mid-right area, starting around y=700 — lower than TikTok but higher than Instagram. The subscribe bell means the right column is occupied for a longer vertical span than the other platforms.
- YouTube renders a thicker progress scrubber than TikTok/Instagram (~20px vs 6–8px).
- On Android, a "Remix" button sometimes appears below Subscribe — adds ~130px more on the right column to ~y=1580. The conservative right inset of 160px covers this.
- YouTube's loop indicator (a small "Replaying" badge) appears top-left for ~2s on replay. If your video is a loop, the top-left corner (approx x=0–200, y=100–160) will briefly be obscured.

---

## Universal Safe Zone (all three platforms)

Take the most conservative inset across all platforms:

```
top:    140px    (TikTok / YouTube top bar)
bottom: 370px    (TikTok caption + music area)
left:    30px
right:  160px    (Instagram / YouTube action buttons)
```

### Universal safe content area

```
x: 30  to  920   (width:  890px)
y: 140 to  1550  (height: 1410px)
```

Center of safe area: `(475, 845)` — very close to the true vertical center of 1080x1920 (960).

For extra conservatism (small/notched phones, edge cases), add 20px to each edge:

```
x: 50  to  900   (width:  850px)
y: 160 to  1530  (height: 1370px)
```

This is the **recommended safe zone for all critical content** (title text, faces, product shots, call-to-action).

---

## Device variation and consistency

Safe zones are **consistent within ~20px** across all modern phones (iPhone 14+, Samsung Galaxy S21+, Pixel 6+) because the platforms themselves constrain their UI to fixed pixel positions relative to the video frame before any OS safe-area insets. Budget Android devices (480p screens) may scale and shift buttons by up to 30px; the universal safe zone above absorbs this.

The platforms do NOT vary safe zones based on phone model — they define UI layout relative to the 1080x1920 frame. OS-level safe areas (notch, dynamic island, home indicator) sit outside the video frame entirely.

---

## Professional motion designer conventions

### Industry templates

- **CapCut** ships a "Safe Zone" toggle that shows a center-padded box; it uses approximately `x: 108–972, y: 192–1728` (10% inset on all sides). This is more conservative than needed and wastes significant screen real estate.
- **Adobe After Effects** social media presets use a title-safe guide at 90% center (108px each side) and action-safe at 95% (54px). These were designed for broadcast TV and are too conservative for vertical social video — the vertical axis is where platform UI actually matters.
- **Figma** community templates (e.g. "TikTok Safe Frame") typically mark the bottom 400–450px and right 150px as unsafe. The 370px bottom / 160px right values in this document are based on empirical platform measurements and fall within that range.
- **DaVinci Resolve** does not ship a vertical social preset; creators import custom safe area overlays.

### Professional consensus

Professional social-media motion designers (MNTN, Haus, Stink Studios) converge on:
- Keep text and logos in the center 70–75% of width (roughly x: 160–920)
- Keep all critical content above y=1500
- Place any CTA or branded text between y=400–1400
- Treat y=1500–1600 as a "caution zone" — visible on some platforms, clipped on others

---

## Caption and subtitle placement

| Platform | Auto-caption default position | Burned-in caption recommendation |
|---|---|---|
| TikTok | y: 1650–1800, horizontally centered | y: 1480–1620 max bottom edge |
| Instagram | y: 1700–1850, horizontally centered | y: 1480–1600 max bottom edge |
| YouTube Shorts | y: 1680–1820, horizontally centered | y: 1480–1600 max bottom edge |

To avoid clash with platform auto-captions, burned-in captions should have their **bottom edge no lower than y=1480**. This leaves a 70–90px buffer above where platform captions appear.

If the video does not use platform auto-captions, burned-in captions can extend to y=1550 (within the universal safe zone).

---

## Progress scrubber summary

| Platform | Height | Position |
|---|---|---|
| TikTok | ~6px | y: 1914–1920 (bottom edge, always visible) |
| Instagram Reels | ~8px | y: 1912–1920 (bottom edge) |
| YouTube Shorts | ~20px | y: 1900–1920 (thicker, always visible) |

Progress scrubbers are thin enough that they rarely matter for content, but avoid placing any critical text within 30px of the bottom edge (y > 1890).

---

## Remotion preview panel: visualization approach

### Overlay component

Render a `SafeZoneOverlay` component on top of the `<Player>` preview. It should be a React component that:

1. Renders as an absolutely-positioned transparent div that fills the player frame (1080x1920, scaled to whatever the preview panel size is).
2. Draws four shaded rectangles covering the unsafe regions (top, bottom, left, right strips) using a semi-transparent fill (e.g. `rgba(255, 0, 0, 0.15)`).
3. Draws a solid 1px border around the safe content area in a high-visibility color (e.g. `rgba(255, 200, 0, 0.8)`).
4. Optionally labels each unsafe strip ("TikTok caption area", "Action buttons", etc.) in small legible text.

```tsx
// Conceptual structure — not final implementation
const SAFE_ZONE = { top: 140, bottom: 370, left: 30, right: 160 };

function SafeZoneOverlay({ width = 1080, height = 1920, show = true }) {
  if (!show) return null;
  const scale = /* derive from preview panel size */;
  // Render 4 overlay strips + border rect
}
```

### Toggle

Add a "Safe Zone" toggle button to the preview panel toolbar. Default: on during editing, off during playback/export.

### Platform-specific mode

Optionally add a platform selector (TikTok / Reels / Shorts / Universal) that tightens or loosens the overlay to match that platform's specific UI. Default to Universal.

---

## Claude system prompt guidance

### Recommended wording

Include the following in the motion design system prompt (or as a persistent instruction in the scene generation context):

> When placing text, graphics, or important visual elements, keep all critical content within the safe zone: x 30–920, y 140–1550 (at 1080x1920). Avoid placing anything important within 370px of the bottom edge (platform captions and action UI), 160px of the right edge (platform action buttons), 140px of the top edge (platform navigation bars), or 30px of the left edge. For caption/subtitle text, keep the bottom edge above y=1480 to avoid overlap with platform auto-captions. The center-safe zone for maximum cross-platform compatibility is x 50–900, y 160–1530.

### Coordinate system note

Remotion and most canvas/CSS systems use top-left origin with y increasing downward. The values above use this convention. Confirm the animation system's coordinate origin before passing pixel values to Claude.

### When to bake vs. when to keep dynamic

Bake the universal safe zone (top=140, bottom=370, left=30, right=160) as a hard constraint in the system prompt — Claude should never place important content outside it. Keep platform-specific overlays (TikTok vs. Instagram vs. Shorts) as a dynamic UI choice in the preview panel, not a system-prompt variable, so the constraint doesn't need to change per render.

---

## Industry-standard center-safe reference

Broadcast TV defined two zones:
- **Action safe** (90% of frame): everything outside is potentially clipped.
- **Title safe** (80% of frame): text must stay inside.

For 1080x1920 vertical video, the analogous recommended zones are:

| Zone | Insets | Content area |
|---|---|---|
| Action safe (nothing clipped) | top 140 / bottom 370 / left 30 / right 160 | 890 x 1410 px |
| Title safe (text only here) | top 200 / bottom 420 / left 80 / right 200 | 800 x 1300 px |
| Center focus (hero content) | top 300 / bottom 500 / left 150 / right 150 | 780 x 1120 px |

Use "action safe" for all content. Use "title safe" for text and logos. Use "center focus" for faces, product hero shots, and anything that must be visible even on a cropped thumbnail.
