---
id: claudedesignskills-research
root: research
type: research
status: current
summary: "Research summary of github.com/freshtechbro/claudedesignskills: a web/3D animation skills library that is mostly irrelevant to Remotion, with three narrow patterns worth considering for remotion-skills.txt adaptation."
created: 2026-06-05
updated: 2026-06-05
---

# Research: freshtechbro/claudedesignskills

Researched 2026-06-05. Source: https://github.com/freshtechbro/claudedesignskills

---

## 1. What the repo contains

A collection of 22 Claude Code plugin skills organized into 27 installable plugins for browser-based web development. Each skill is a `SKILL.md` file teaching Claude how to use a specific library.

**Skill categories:**
- Core 3D & Animation: Three.js, GSAP/ScrollTrigger, React Three Fiber, Framer Motion, Babylon.js
- Extended 3D & Scroll: A-Frame, Vanta, PlayCanvas, PixiJS, Locomotive Scroll, Barba.js
- Animation & Components: React Spring, Magic UI, AOS, Anime.js, Lottie
- 3D Authoring: Blender, Spline, Rive, Substance 3D
- Meta-skills: web3d-integration-patterns, modern-web-design

The repo is a browser/web animation library, not a Remotion-specific resource. It assumes a DOM runtime, npm-installed dependencies, and live user interaction (scroll, hover, drag, gestures). None of these apply to Remotion's model (programmatic frame rendering, no DOM, no npm installs in the animation sandbox, no user interaction).

---

## 2. Animation techniques NOT already covered in remotion-skills.txt

### 2a. Clip-path reveals

Not mentioned anywhere in remotion-skills.txt. Clip-path animations are well-suited to Remotion since they compose cleanly with `interpolate` and require no DOM interaction:

```tsx
// Panel wipe reveal (replaces or supplements T8 Section Transition)
const progress = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
const clipY = interpolate(progress, [0, 1], [1920, 0]);
// applied as: clipPath: `inset(${clipY}px 0 0 0)`

// Text line reveal (grows down from top edge -- replaces opacity fade for a crisper feel)
const clipH = interpolate(enter, [0, 1], [0, 96]);
// applied as: clipPath: `inset(0 0 ${96 - clipH}px 0)`
```

Clip-path reveals read as more editorial than opacity fades for Display/Headline text entrances. Directional wipes (top-down, left-right) also give Template T8 more flexibility than pure opacity-based transitions.

### 2b. Per-element staggered exits

remotion-skills.txt defines `soft-exit` as a single block exit applied to the entire scene. It does not cover staggering exits per element. For multi-element scenes (e.g., animated list T5), reversing the entrance stagger on exit creates polish:

```tsx
// Exit: reverse order (last element exits first), shorter delay than entrance
const exitDelay = (ITEMS.length - 1 - index) * 3; // 3f stagger, reversed
const exitStart = durationInFrames - 18;
const exitOpacity = interpolate(frame, [exitStart + exitDelay, exitStart + exitDelay + 10], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) });
```

The spring preset table in remotion-skills.txt handles entrance staggering well; this is an addendum for exit choreography.

### 2c. Depth / glassmorphism surface treatment

remotion-skills.txt defines palette `surface` tokens (e.g., P1 surface `#161B26`) but gives no guidance on layering or depth hierarchy within a scene. The modern-web-design skill in the repo defines a useful elevation model and frosted glass treatment:

- Elevation layers use progressively larger shadow blur: `0 2px 8px rgba(0,0,0,0.18)` (raised card) to `0 16px 32px rgba(0,0,0,0.32)` (modal/hero card)
- Glassmorphism: `background: rgba(255,255,255,0.08); backdropFilter: blur(12px) saturate(160%); border: 1px solid rgba(255,255,255,0.12)` -- creates a frosted panel distinct from a flat surface token

In Remotion, `backdropFilter` renders in the browser-based Remotion Player but may not survive server-side rendering. Use with caution and test render output. A plain semi-transparent surface with a subtle border is a safer fallback.

---

## 3. Specific sections worth adapting

| Source skill | What to adapt | Notes |
|---|---|---|
| modern-web-design | Clip-path reveal patterns (section 2a above) | Add as Template T11 or motion preset alternative |
| modern-web-design | Elevation shadow scale for surface depth | Add to Section 6 (Spacing + Layout) as a "depth" note |
| motion-framer | Per-element staggered exit choreography (section 2b above) | Add to Section 7 (Motion Presets) under soft-exit |
| animejs | Timeline overlap operator concept (`-=N`) | Already handled by Remotion's `delay:` param; no action needed |

The spring physics presets in Framer Motion (Gentle/Wobbly/Stiff/Slow with stiffness+damping values) overlap substantially with the named presets already in remotion-skills.txt (smooth-settle, snappy-entrance, emphasis-pop, etc.). No new presets are warranted.

---

## 4. What to skip (irrelevant, redundant, or outside our context)

| Category | Why to skip |
|---|---|
| All Three.js / React Three Fiber / Babylon.js / A-Frame / PlayCanvas skills | No 3D WebGL primitives in Remotion; no GLTF/mesh loading |
| GSAP ScrollTrigger | Scroll-driven animation; Remotion is frame-based, no scroll |
| Lottie animations | External asset dependency; our import constraints forbid it |
| Vanta.js / PixiJS / Locomotive Scroll | Browser-DOM libraries; no import path in Remotion sandbox |
| Blender / Spline / Substance 3D / Rive | 3D authoring tools; output formats not importable in Remotion |
| Gesture animations (whileHover, whileTap, whileDrag) | No user interaction in rendered video |
| Scroll-reveal libraries (AOS, Barba.js) | Scroll-driven; not applicable |
| Accessibility / prefers-reduced-motion | Rendered video; no user agent query available |
| Page transitions (Barba.js, View Transitions API) | Route-based; not applicable |
| Layout animations (Framer Motion `layout` prop) | DOM layout model; Remotion uses absolute positioning |
| React Spring `useSpring`/`useTrail` hooks | Not available in Remotion; use Remotion's `spring()` instead |
| OKLCH color system | Advanced CSS color function; use hex (Remotion renders in Chromium but hex is simpler and verified) |
| Fluid typography (`clamp()`) | Not applicable; Remotion canvas is fixed 1080x1920 |
| `will-change` / `requestAnimationFrame` patterns | Remotion handles render scheduling; these are browser optimization hints |

---

## Summary judgment

The freshtechbro/claudedesignskills repo is a web animation library skills collection with almost no Remotion-relevant content. It reinforces existing principles (animate transform+opacity, spring physics, stagger) but adds only three actionable patterns:

1. **Clip-path reveals** as an alternative to opacity fades for text and panel transitions (Template T8 extension + motion pattern addition).
2. **Per-element staggered exits** to reverse the entrance choreography for multi-element scenes.
3. **Depth/elevation model** for surface layering within a scene.

These three are candidates for a targeted remotion-skills.txt update. None require a structural rewrite -- they slot into existing sections (7, 8, or a short addition to 6).
