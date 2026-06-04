---
id: design-motion-principles
root: research
type: research
status: current
summary: "Prescriptive, copy-pasteable Remotion motion library -- named spring/interpolate presets with exact numbers, timing budgets, staging rules, and an anti-pattern table -- so a code-gen model can produce professional-looking animations mechanically."
related:
  - research/multi-file-architecture
created: 2026-06-04
updated: 2026-06-04
---

# Motion design as concrete Remotion presets

This is a **rule library, not an essay**. It is meant to be folded into
`src-tauri/resources/remotion-skills.txt` so the animation model produces
professional motion by default. Every preset is real numbers you can paste.

## How a code-gen model should apply this

1. Pick a **preset by role** (entrance, emphasis, exit, idle) from the table in
   "Named presets" -- do not invent spring numbers from scratch.
2. Animate **only `transform` and `opacity`** (translate, scale, rotate). Never
   animate `width/height/top/left/margin` -- they cause layout reflow and read as
   janky. This is non-negotiable.
3. Apply a **timing budget** (enter / hold / exit) so the clip has rhythm.
4. **Stagger** multiple elements; never animate everything on the same frame.
5. Drive the focal point first.

All presets respect the sandbox: `react`, `react-dom`, `remotion`,
`@remotion/player` only; `spring`, `interpolate`, `interpolateColors`,
`useCurrentFrame`, `useVideoConfig`, `Sequence`, `AbsoluteFill`; inline CSS/SVG;
1080x1920; author-controllable `fps`/`durationInFrames`. Numbers below assume
**fps 30** unless stated; scale frame counts by `fps/30` if the author raises fps.

---

## Spring physics primer (so the numbers are derivable, not magic)

Remotion `spring({ frame, fps, config: { mass, damping, stiffness }, ... })`
solves a damped harmonic oscillator. The single most useful fact:

```
critical damping  c_crit = 2 * sqrt(stiffness * mass)
damping ratio     zeta   = damping / c_crit
```

- `zeta < 1` -> **underdamped**: overshoots the target then settles (bounce).
- `zeta = 1` -> **critically damped**: fastest arrival with NO overshoot.
- `zeta > 1` -> **overdamped**: slow, sluggish, no overshoot.

Overshoot amount and settle time follow from `zeta`:

```
overshoot %  ~  exp(-zeta * pi / sqrt(1 - zeta^2))    // underdamped only
settle (2%)  ~  4 / (zeta * sqrt(stiffness / mass))   // seconds; *fps for frames
```

So a preset is just a choice of **how much bounce** (`zeta`) and **how fast**
(`stiffness`, and `mass` for weight). The project default
`{ mass: 1, damping: 12, stiffness: 100 }` has `zeta = 12 / (2*sqrt(100)) = 0.6`
-> a noticeable ~9% overshoot. That is fine for playful entrances but too bouncy
for body text.

Two `spring()` features worth using:

- **`delay: <frames>`** -- the clean way to stagger; the spring stays still then
  starts. Prefer this over manually offsetting `frame`.
- **`durationInFrames: <n>`** -- time-normalizes the spring so it completes in
  exactly `n` frames regardless of config. Use it when you need a spring's feel
  but a guaranteed finish time before a `Sequence` cut.

Springs are for **position/scale/rotation**. They overshoot, so do NOT spring
`opacity` (it clamps at 0/1, wasting the overshoot and risking a flicker). Fade
with `interpolate` + easing instead (see "Easing").

---

## Named presets (paste these)

| Preset | config (mass, damping, stiffness) | zeta | overshoot | settle @30fps | Use for |
|---|---|---|---|---|---|
| `snappy-entrance` | 1, 18, 200 | 0.64 | ~7% | ~13f (0.43s) | Primary element arriving on screen |
| `smooth-settle`   | 1, 22, 120 | 1.00 | 0% | ~16f (0.53s) | Body text, captions, calm UI |
| `emphasis-pop`    | 1, 14, 260 | 0.43 | ~20% | ~15f (0.5s) | CTA, numbers, icon, "look here" |
| `heavy-drop`      | 1.8, 25, 180 | 0.69 | ~5% | ~17f (0.57s) | Weighty objects, logo slam, cards |
| `quick-tick`      | 0.6, 12, 240 | 0.50 | ~16% | ~9f (0.3s) | Tiny fast UI accents, counters |

### snappy-entrance -- the workhorse

Fast arrival, just enough overshoot to feel alive. Default for "a thing appears".

```tsx
const enter = spring({
  frame,
  fps,
  config: { mass: 1, damping: 18, stiffness: 200 },
});
// drive transform; fade via interpolate (see below)
const translateY = interpolate(enter, [0, 1], [40, 0]); // rise 40px into place
const scale = interpolate(enter, [0, 1], [0.92, 1]);
```

### smooth-settle -- no-bounce, professional

Critically damped: arrives crisply, never wobbles. Use for anything textual or
when bounce would look toy-like.

```tsx
const settle = spring({ frame, fps, config: { mass: 1, damping: 22, stiffness: 120 } });
const translateX = interpolate(settle, [0, 1], [-60, 0]);
```

If you want a guaranteed zero-overshoot regardless of config, add
`overshootClamping: true` to the config -- but tuning `zeta >= 1` is smoother.

### emphasis-pop -- attention magnet

Big overshoot punch. Reserve for ONE focal element (CTA, a number, an icon).
Overuse kills its emphasis.

```tsx
const pop = spring({ frame, fps, config: { mass: 1, damping: 14, stiffness: 260 } });
const scale = interpolate(pop, [0, 1], [0.6, 1]); // pops past 1 to ~1.15 then settles
```

### heavy-drop -- weight and impact

Higher `mass` reads as heavier/slower. Pair with a tiny squash on landing
(Disney squash-and-stretch) for a satisfying thud.

```tsx
const drop = spring({ frame, fps, config: { mass: 1.8, damping: 25, stiffness: 180 } });
const translateY = interpolate(drop, [0, 1], [-200, 0]);
// optional landing squash, peaks right as it lands (~frame 17):
const squashY = interpolate(frame, [15, 18, 24], [1, 0.88, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
const squashX = interpolate(frame, [15, 18, 24], [1, 1.12, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
```

### gentle-float / breathe -- continuous idle motion (NOT a spring)

For hold periods, give hero content a slow living drift so static frames don't
feel dead. Use a sine of frame, low amplitude.

```tsx
const floatY = Math.sin((frame / fps) * Math.PI * 2 * 0.35) * 10; // 0.35Hz, +/-10px
const breathe = 1 + Math.sin((frame / fps) * Math.PI * 2 * 0.25) * 0.02; // +/-2% scale
```

Keep amplitude small (<= 12px translate, <= 3% scale) or it reads as drifting,
not breathing.

### Fades -- always `interpolate`, never spring

```tsx
// fade-in over 10 frames, ease-out
const opacity = interpolate(frame, [0, 10], [0, 1], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
  easing: Easing.out(Easing.cubic),
});
```

### soft-exit -- leave gracefully

Exits are faster than entrances and accelerate out (ease-IN). Fade + a small
drift in the direction of travel.

```tsx
// for a clip ending at durationInFrames; start exit 14 frames before the end
const { durationInFrames } = useVideoConfig();
const exitStart = durationInFrames - 14;
const exitOpacity = interpolate(frame, [exitStart, durationInFrames], [1, 0], {
  extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic),
});
const exitY = interpolate(frame, [exitStart, durationInFrames], [0, -30], {
  extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic),
});
```

---

## Timing & staging budget (the rhythm that reads professional)

For a typical **3-5s clip** (90-150 frames @30fps), split the screen time:

| Phase | Share of clip | What happens |
|---|---|---|
| **Enter** | first 12-20% | Elements arrive (staggered). Cap any single entrance at ~20f. |
| **Hold / read** | middle 55-70% | Content is still (or `gentle-float`). Give the eye time to read. |
| **Exit** | last 10-15% | Elements leave (`soft-exit`), faster than they entered. |

Concrete defaults:

- Entrance duration per element: **12-18 frames** (0.4-0.6s). Shorter = snappier.
- Minimum hold for a line of text: **~0.5s of reading time per ~7 words**, floor
  ~20 frames. Never cut a focal element before it can be read.
- Exit duration: **8-14 frames** -- exits should be quicker than entrances.

### Stagger / overlap (multiple elements)

- **Stagger step: 3-5 frames per item** @30fps (~100-160ms). This is the single
  biggest "looks designed vs looks amateur" lever.
- **Overlap**: start item N+1 *before* item N finishes settling -- use the
  spring `delay` while the previous spring is still resolving. Sequential,
  non-overlapping entrances feel slow and mechanical.
- Cap total stagger so the last item still lands inside the Enter budget. For 6
  items at a 4-frame step the last starts at frame 20 -- fine; at 8 frames it
  starts at 40 and eats the hold -- too slow.

```tsx
// staggered list of items, each using snappy-entrance with a per-index delay
const enter = spring({
  frame,
  fps,
  delay: index * 4, // 4-frame stagger
  config: { mass: 1, damping: 18, stiffness: 200 },
});
```

---

## Easing (why linear looks amateur)

Nothing in the physical world starts or stops instantly at constant velocity, so
**linear motion reads as fake/cheap**. The brain expects acceleration. Disney
calls this *slow in / slow out*; every modern motion system mandates it.

Rules:

- **Entrances: ease-OUT** (decelerate) -- fast start, gentle landing. Feels
  responsive. `Easing.out(Easing.cubic)` or the spring presets above.
- **Exits: ease-IN** (accelerate) -- the element commits and leaves.
  `Easing.in(Easing.cubic)`.
- **On-screen moves between two states: ease-IN-OUT.**
  `Easing.inOut(Easing.cubic)`.
- **Springs** already encode slow-in/slow-out via physics; that's why they're the
  default for arrivals.

Material's standard curves, expressed as `Easing.bezier` (drop-in for the
`easing` option of `interpolate`):

```tsx
const standard   = Easing.bezier(0.2, 0.0, 0.0, 1.0); // general on-screen move
const decelerate = Easing.bezier(0.0, 0.0, 0.2, 1.0); // entering (ease-out)
const accelerate = Easing.bezier(0.4, 0.0, 1.0, 1.0); // exiting (ease-in)
```

Reference UI durations (Material): standard transitions 200-300ms, large/complex
375-500ms. At 30fps that's **6-9 frames** for small, **11-15 frames** for large.
Short-form video tolerates the upper end since the viewer isn't interacting.

---

## Choreography (avoid "everything at once")

- **One focal point at a time.** Establish the hero, *then* bring in supporting
  elements. Two things fighting for the eye = no focal point.
- **Focal-point-first ordering.** Animate the most important element first (or
  give it the boldest preset, `emphasis-pop`), supporting elements after with
  calmer presets (`smooth-settle`).
- **Use `Sequence` for scene structure**, `delay`/staggered `frame` for
  intra-scene timing. `Sequence` cleanly remaps `frame` to 0 at its start, so
  presets inside it "just work" without manual offset math.
- **Overlapping action / follow-through**: child elements should lag their
  parent slightly and a trailing element can keep moving after the lead settles
  (the spring overshoot *is* follow-through).
- **Arcs, not straight lines** for anything traveling a distance: drive `x` and
  `y` with different ranges/easings so the path curves. Straight-line motion
  reads as robotic.
- **Anticipation** for emphatic moves: a tiny counter-move before the main one
  (e.g. dip down 4px over 3 frames, then `emphasis-pop` upward). Sells weight.

```tsx
<AbsoluteFill>
  <Sequence durationInFrames={45}>{/* scene 1: hero in */}</Sequence>
  <Sequence from={40} durationInFrames={60}>{/* scene 2 overlaps by 5f */}</Sequence>
</AbsoluteFill>
```

---

## Anti-patterns (and the fix)

| Anti-pattern | Why it looks bad | Fix |
|---|---|---|
| Linear fades/moves | Reads fake; brain expects acceleration | Add `easing` (ease-out in, ease-in out) or use a spring |
| Everything animates on frame 0 | No hierarchy, chaotic | Stagger 3-5f per element; focal point first |
| Spring on `opacity` | Overshoot clamps, can flicker | Fade with `interpolate` + easing |
| Over-bouncy (damping too low, e.g. <10 at stiffness 100) | Toy-like, unprofessional | Raise damping toward `zeta>=0.7`; use `smooth-settle` for text |
| Animating `width/height/top/left/margin` | Layout reflow -> jank | Animate `transform` + `opacity` only |
| Entrances too long (>~0.8s) | Sluggish, viewer waits | Cap entrances ~12-20f; exits even shorter |
| No hold time | Viewer can't read before it moves/cuts | Budget 55-70% of clip as a still/float hold |
| Uniform speed/size for all elements | Flat, no focal point | Differentiate: bold preset for hero, calm for rest |
| Exit same speed as entrance | Feels like it doesn't want to leave | Exits faster + ease-IN (accelerate out) |
| Static hero held dead-still for seconds | Lifeless | Add `gentle-float`/`breathe` during hold |
| Hardcoding fps/duration numbers in component body | Breaks when author changes them | Read via `useVideoConfig()`; scale frame counts by `fps/30` |
| Critical content in bottom 370px | Covered by platform UI | Keep within safe zone (see remotion-skills.txt) |

---

## Grounding (sources, each mapped to a concrete rule above)

- **Disney's 12 Principles of Animation** -- Thomas & Johnston, *The Illusion of
  Life* (1981). Directly used: *Slow In/Slow Out* -> easing section; *Timing* ->
  frame budgets & `mass`; *Squash & Stretch* -> `heavy-drop` landing squash;
  *Anticipation* -> counter-move before pop; *Staging* -> one focal point;
  *Follow-through & Overlapping Action* -> stagger + spring overshoot; *Arcs* ->
  curved travel; *Exaggeration* -> `emphasis-pop`. (Disney's principles remain
  the standard reference base for motion graphics.)
- **Material Design Motion** -- duration ranges (200-500ms) and the
  standard/decelerate/accelerate easing curves; source of the `Easing.bezier`
  values. (m2.material.io/design/motion, m3.material.io motion guidance.)
- **Apple Human Interface Guidelines -- Motion** -- ease-in-out default,
  spring physics for interactive/arriving elements, restraint over spectacle.
- **Robert Penner's easing equations / easings.net** -- the in/out/in-out
  taxonomy and the "linear is wrong" baseline.
- **Val Head, *Designing Interface Animation* (2016)** and **Rachel Nabors,
  *Animation at Work*** -- staging, choreography, focal-point-first, restraint.
- **Remotion docs** -- `spring()` (mass/damping/stiffness, `delay`,
  `durationInFrames`, `overshootClamping`), `interpolate`, `Easing`, `Sequence`
  frame remapping. (remotion.dev/docs/spring, /docs/easing, /docs/interpolate.)

The damping-ratio and settle-time formulas are standard second-order
control-system results (`zeta = c / (2*sqrt(km))`), which is exactly the model
Remotion's `spring` integrates -- so the preset numbers are computed, not guessed.
