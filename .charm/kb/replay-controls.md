---
id: replay-controls
root: architecture
type: architecture
status: current
summary: "Remotion Player programmatic control API, custom replay controls via postMessage, loop/speed/frame-step, auto-replay UX, filmstrip verdict, and phone-bezel approach for the 1080x1920 preview panel."
created: 2026-06-04
updated: 2026-06-04
---

# Live Replay and Replay Controls for Remotion Animations

## Context

The preview panel renders Claude-generated Remotion animations inside a sandboxed iframe (see
[[code-execution-sandbox]]). The `<Player>` component from `@remotion/player` lives inside that
null-origin iframe, so the parent page cannot reach its React tree directly. All playback control
crosses the iframe boundary via `postMessage`. This note covers the full control API surface and
how to build a custom control bar on top of it.

---

## Remotion Player API Surface (`@remotion/player` v4.x)

### Imperative ref API (`PlayerRef`)

```typescript
import { Player, PlayerRef } from '@remotion/player'

const playerRef = useRef<PlayerRef>(null)
// ...
<Player ref={playerRef} ... />
```

| Method | Description |
|---|---|
| `playerRef.current.play()` | Start playback |
| `playerRef.current.pause()` | Pause playback |
| `playerRef.current.toggle()` | Toggle play/pause |
| `playerRef.current.seekTo(frame: number)` | Jump to exact frame (integer) |
| `playerRef.current.getCurrentFrame()` | Returns current frame as `number` |
| `playerRef.current.isPlaying()` | Returns `boolean` |
| `playerRef.current.getContainerNode()` | Returns the root `HTMLDivElement` |
| `playerRef.current.pauseAndReturnToPlayStart()` | Pauses and seeks back to where play began |
| `playerRef.current.mute()` / `unmute()` | Audio mute control |
| `playerRef.current.setVolume(v: number)` | Volume 0-1 |

### Event listeners

All events are subscribed via `playerRef.current.addEventListener(event, handler)`:

| Event | Payload | When |
|---|---|---|
| `'play'` | `undefined` | Playback starts |
| `'pause'` | `undefined` | Playback pauses |
| `'seeked'` | `{ detail: { frame } }` | After a `seekTo()` settles |
| `'ended'` | `undefined` | Reached last frame (no loop) |
| `'timeupdate'` | `{ detail: { frame } }` | Every rendered frame during playback |
| `'error'` | `{ detail: { error } }` | Render error in the composition |
| `'fullscreenchange'` | `{ detail: { isFullscreen } }` | Fullscreen toggled |
| `'volumechange'` | `{ detail: { volume, isMuted } }` | Volume/mute changed |

`timeupdate` fires on `requestAnimationFrame` cadence — every frame during playback and once after
`seekTo`. This is the source of truth for the scrubber position.

### Declarative props that affect playback

| Prop | Type | Effect |
|---|---|---|
| `controls` | `boolean` | Show/hide the built-in control bar; set `false` for a custom bar |
| `loop` | `boolean` | Loop playback automatically |
| `autoPlay` | `boolean` | Start playing immediately on mount |
| `playbackRate` | `number` | Playback speed multiplier (0.5, 1, 2, etc.) |
| `initialFrame` | `number` | Frame to render on first mount |
| `moveToBeginningWhenEnded` | `boolean` | Seek to frame 0 when ended instead of freezing on last frame |
| `showVolumeControls` | `boolean` | Include volume in the built-in bar |
| `renderPlaybackRateControlled` | `boolean` | Tie rAF rate to `playbackRate` (default true) |
| `spaceKeyToPlayOrPause` | `boolean` | Built-in spacebar shortcut |
| `clickToPlay` | `boolean` | Click on video to play/pause |

Changing `loop` or `playbackRate` after mount requires re-rendering the `<Player>` with a new prop
value. The ref API has no `setLoop()` or `setRate()` methods. The iframe host document must hold
these as React state and re-render on a postMessage command.

---

## Architecture: Custom Controls via postMessage

Since the Player lives inside a sandboxed iframe, the control bar lives in the parent and
communicates over the iframe bridge already established in [[code-execution-sandbox]].

### Protocol extension

Extend the existing postMessage protocol with player-control message types:

**Parent -> Iframe (commands):**

```typescript
type PlayerCommand =
  | { type: 'PLAYER_PLAY' }
  | { type: 'PLAYER_PAUSE' }
  | { type: 'PLAYER_SEEK'; frame: number }
  | { type: 'PLAYER_STEP'; delta: 1 | -1 }       // +1 or -1 frame
  | { type: 'PLAYER_SET_LOOP'; loop: boolean }
  | { type: 'PLAYER_SET_RATE'; rate: number }      // 0.5 | 1 | 2
```

**Iframe -> Parent (state updates):**

```typescript
type PlayerEvent =
  | { type: 'PLAYER_STATE'; frame: number; isPlaying: boolean; durationInFrames: number; fps: number }
  | { type: 'PLAYER_ENDED' }
  | { type: 'PLAYER_ERROR'; error: string }
```

### Iframe host additions

In `sandbox-frame.html`, wire the Player ref to the message listener:

```typescript
// inside the module script that already handles RENDER messages
const playerRef = { current: null }  // set after Player mounts

window.addEventListener('message', (e) => {
  if (e.data?.type === 'PLAYER_PLAY')  playerRef.current?.play()
  if (e.data?.type === 'PLAYER_PAUSE') playerRef.current?.pause()
  if (e.data?.type === 'PLAYER_SEEK')  playerRef.current?.seekTo(e.data.frame)
  if (e.data?.type === 'PLAYER_STEP') {
    const next = (playerRef.current?.getCurrentFrame() ?? 0) + e.data.delta
    playerRef.current?.pause()
    playerRef.current?.seekTo(Math.max(0, next))
  }
  if (e.data?.type === 'PLAYER_SET_LOOP') setLoop(e.data.loop)   // React state setter
  if (e.data?.type === 'PLAYER_SET_RATE') setRate(e.data.rate)   // React state setter
})

// Wire timeupdate to broadcast state to parent
useEffect(() => {
  const ref = playerRef.current
  if (!ref) return
  const handler = (e) => {
    window.parent.postMessage({
      type: 'PLAYER_STATE',
      frame: e.detail.frame,
      isPlaying: ref.isPlaying(),
      durationInFrames,
      fps,
    }, parentOrigin)
  }
  ref.addEventListener('timeupdate', handler)
  ref.addEventListener('seeked', handler)
  return () => { ref.removeEventListener('timeupdate', handler); ref.removeEventListener('seeked', handler) }
}, [playerRef.current])
```

### Parent control bar (React)

```typescript
const [frame, setFrame] = useState(0)
const [isPlaying, setIsPlaying] = useState(false)
const [duration, setDuration] = useState(0)
const [loop, setLoop] = useState(false)
const [rate, setRate] = useState(1)

// Receive state from iframe
useEffect(() => {
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'PLAYER_STATE') {
      setFrame(e.data.frame)
      setIsPlaying(e.data.isPlaying)
      setDuration(e.data.durationInFrames)
    }
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}, [])

const send = (cmd: PlayerCommand) =>
  iframeRef.current?.contentWindow?.postMessage(cmd, appOrigin)

// Scrubber: frame-accurate, integer resolution
<input
  type="range" min={0} max={duration - 1} step={1} value={frame}
  onMouseDown={() => send({ type: 'PLAYER_PAUSE' })}
  onChange={e => send({ type: 'PLAYER_SEEK', frame: Number(e.target.value) })}
/>

// Play/pause
<button onClick={() => send({ type: isPlaying ? 'PLAYER_PAUSE' : 'PLAYER_PLAY' })}>
  {isPlaying ? 'Pause' : 'Play'}
</button>

// Frame step
<button onClick={() => send({ type: 'PLAYER_STEP', delta: -1 })}>-1</button>
<button onClick={() => send({ type: 'PLAYER_STEP', delta: 1 })}>+1</button>

// Loop toggle
<button onClick={() => { const next = !loop; setLoop(next); send({ type: 'PLAYER_SET_LOOP', loop: next }) }}>
  {loop ? 'Loop On' : 'Loop Off'}
</button>

// Speed picker
<select value={rate} onChange={e => { const r = Number(e.target.value); setRate(r); send({ type: 'PLAYER_SET_RATE', rate: r }) }}>
  <option value={0.5}>0.5x</option>
  <option value={1}>1x</option>
  <option value={2}>2x</option>
</select>
```

---

## Loop Playback

Remotion Player supports loop natively via the `loop` prop. Set `loop={true}` to loop indefinitely.
The `ended` event is suppressed when `loop` is true. Toggling loop after mount requires a prop
change (React re-render in the iframe), not a ref call — so the iframe must hold `loop` in local
state and re-render `<Player loop={loop}>` when the postMessage arrives.

`moveToBeginningWhenEnded={true}` is a gentler alternative to loop: when the animation ends, it
returns to frame 0 but stays paused (good for "click to replay" behavior).

---

## Playback Speed

`playbackRate` is a `<Player>` prop, not a ref method. Supported: any positive number. Practical
range: 0.25, 0.5, 1, 2, 4. Like `loop`, changing speed after mount requires a re-render with the
new prop value — hold it in iframe React state and re-render on `PLAYER_SET_RATE` message.

`renderPlaybackRateControlled` (default true) ties the rAF rate to `playbackRate`, so 0.5x runs at
half the normal frame rate. Setting it to false gives you manual control over when frames render,
which is only needed for custom thumbnail generators.

---

## Frame Stepping

Stepping one frame at a time:

```typescript
// In iframe (on PLAYER_STEP message):
playerRef.current.pause()
playerRef.current.seekTo(Math.max(0, Math.min(duration - 1, current + delta)))
```

No native `stepForward()` / `stepBackward()` method exists in the Player ref — it is always
`seekTo(currentFrame +/- N)`. Resolution is per-integer-frame (no sub-frame seeking).

Recommended keyboard shortcuts (wired in the parent, not inside the sandboxed iframe):
- `ArrowRight` / `ArrowLeft` — step ±1 frame
- `Shift+ArrowRight` / `Shift+ArrowLeft` — step ±10 frames
- `Space` — play/pause

---

## Auto-Replay on Code Change

**Recommendation: auto-play from frame 0 when new code renders.**

Rationale:
- The composition has changed; the animation at the user's current scrubber position may look
  completely different or may error.
- Tools like Framer, Rive, and Jitter all auto-restart on code/state change. This is the
  established pattern.
- It communicates clearly that a new animation has loaded.

**Exception — preserve frame when user is paused and scrubbing:**
- If `isPlaying === false` AND the user moved the scrubber manually in the last 2 seconds, preserve
  the frame. This lets the user iterate on a specific moment without losing their position.
- Use a `lastUserSeekTime` ref to track this.

**Implementation:**

```typescript
function onCodeUpdate(source: string) {
  const preserveFrame = !isPlaying && (Date.now() - lastUserSeekTime < 2000)
  compiler.postMessage({ source })
  // After compile completes (in compiler.onmessage):
  iframeRef.current?.contentWindow?.postMessage({
    type: 'RENDER',
    code: bundle,
    currentFrame: preserveFrame ? frame : 0,
    autoPlay: !preserveFrame,
  }, appOrigin)
}
```

In the iframe, extend the `RENDER` handler to call `playerRef.current.seekTo(currentFrame)` and
then `playerRef.current.play()` if `autoPlay` is true.

---

## Thumbnail / Filmstrip Strip

**Verdict: not worth building in v0.**

**Why it's hard:**
- Remotion's `<Player>` is a live playback component, not a still-frame renderer. There is no
  built-in "render N stills" API exposed client-side.
- Rendering a filmstrip means either:
  a. Mounting N invisible `<Player>` instances at fixed frames — each with its own rAF loop. At 10
     thumbnails this is 10x the React render overhead. On a 1080x1920 composition this will visibly
     degrade main-thread performance.
  b. Using the server-side Remotion renderer (`@remotion/renderer`) to generate stills. Adds a
     server call per code change, with 1-3 s latency. Not acceptable during live iteration.
  c. Using `OffscreenCanvas` — not compatible with Remotion's DOM/React composition model.

**Alternative for v0:** Show only a frame counter and a simple progress bar. Display
`frame / durationInFrames` as text (`3 / 90`). This is zero-cost and gives sufficient feedback.

**v1 path:** After the user explicitly requests an export, generate thumbnails as a side effect of
the server-side render. Cache them in S3 and load them lazily into the scrubber on the next
preview load. This adds no live-editing latency.

---

## Sync Between Code Panel and Preview

**Verdict: defer to v1; no good v0 story.**

There is no native Remotion API that maps a code region (line number, AST node) to a frame range.
You would need to:
1. Parse the generated code's `interpolate()` / `spring()` calls to extract frame ranges.
2. Build a synthetic timeline from those ranges.
3. Map editor cursor position to the nearest timeline event.

This requires a custom AST parser pass on every code update, plus editor integration (cursor
change events). The implementation cost is high and the mapping is heuristic (an `interpolate`
call at line 20 may reference a frame range that overlaps with another). Not worth the complexity
until the basic editor is working and users actually report needing this.

**Pragmatic v0 alternative:** Clicking a frame in the scrubber highlights nothing in the code
editor; clicking a line in the code editor does not seek the preview. Users navigate via the
scrubber.

---

## Mobile Preview Framing (Phone Bezel)

The 1080x1920 composition is a 9:16 portrait format — a native phone screen ratio. Wrapping it in
a phone bezel provides immediate visual context that this is a mobile animation.

**Options:**

### Option A: DIY CSS phone frame (recommended for v0)

Zero dependencies. A `div` with:

```css
.phone-frame {
  position: relative;
  width: 280px;            /* visual width; scales the 1080x1920 down to fit */
  aspect-ratio: 9 / 19.5; /* slightly taller than 9:16 to include bezel chrome */
  border-radius: 36px;
  border: 8px solid #1a1a1a;
  background: #000;
  box-shadow: 0 0 0 2px #333, 0 20px 60px rgba(0,0,0,0.5);
  overflow: hidden;
}

/* Dynamic island notch */
.phone-frame::before {
  content: '';
  position: absolute;
  top: 10px; left: 50%; transform: translateX(-50%);
  width: 100px; height: 28px;
  background: #000;
  border-radius: 14px;
  z-index: 10;
}
```

The iframe (or a scaled `<div>` wrapping it) sits inside this container, scaled down via
`transform: scale()` to fit the display width.

### Option B: `react-device-frameset`

npm package (`react-device-frameset`) that provides pre-drawn SVG device frames for iPhone, Pixel,
etc. Adds ~50 KB to the bundle. Overkill for v0 but useful if device-specific accuracy matters.

### Option C: `react-phone-mockup`

Similar to `react-device-frameset`; slightly smaller bundle. Same tradeoff.

**Recommendation:** DIY CSS frame (Option A) for v0. No extra dependency, easily themeable (dark /
light frame), and the dynamic-island cutout takes ~10 lines of CSS. If the team wants device-
accurate bezels for marketing screenshots later, swap to `react-device-frameset` at that point.

**Scaling the Player inside the frame:**

The Remotion `<Player>` must be sized at the true composition dimensions (1080x1920) and then
scaled down:

```tsx
const COMP_WIDTH = 1080
const COMP_HEIGHT = 1920
const DISPLAY_WIDTH = 260  // pixels inside the bezel

<div className="phone-frame">
  <div style={{
    width: COMP_WIDTH,
    height: COMP_HEIGHT,
    transform: `scale(${DISPLAY_WIDTH / COMP_WIDTH})`,
    transformOrigin: 'top left',
  }}>
    <Player
      compositionWidth={COMP_WIDTH}
      compositionHeight={COMP_HEIGHT}
      style={{ width: '100%', height: '100%' }}
      ...
    />
  </div>
</div>
```

Or, equivalently, pass `style={{ width: DISPLAY_WIDTH, height: DISPLAY_WIDTH * (COMP_HEIGHT / COMP_WIDTH) }}`
directly to `<Player>` — Remotion scales the composition internally when `compositionWidth` and
`compositionHeight` differ from the CSS dimensions.

---

## Summary / v0 Decisions

| Feature | v0 recommendation |
|---|---|
| Play / pause / seek | Yes — postMessage bridge to `PlayerRef` methods |
| Loop toggle | Yes — iframe React state + prop re-render |
| Playback speed (0.5x, 1x, 2x) | Yes — iframe React state + prop re-render |
| Frame stepping (+/-1, +/-10) | Yes — `seekTo(current +/- N)` |
| Auto-replay on code change | Yes — play from frame 0; preserve frame if user paused + scrubbing |
| Scrubber | Yes — `<input type="range">` with per-frame integer resolution |
| Filmstrip thumbnails | No — defer to v1 (server-side after export) |
| Code-to-frame sync | No — defer to v1 |
| Phone bezel | Yes — DIY CSS (no dependency) |
| Built-in Remotion control bar | No — set `controls={false}`, build custom bar |
