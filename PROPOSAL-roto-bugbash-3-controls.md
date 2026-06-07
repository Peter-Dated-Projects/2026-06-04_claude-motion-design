# Rotoscoping Bug Bash 3 — Video Playback Controls Overhaul

Five improvements to how video is navigated, clipped, and played back across the
rotoscoping workspace. Covers the source-video timeline, the sequence output
player, the reference-frame auto-selection shortcut, fps accuracy, and comparison
source resolution.

---

## 1. Resolve-style clip-range timeline with visual regions

**Problem.** The current `ClipRangeControl` has a thin track and two text inputs
that are hard to read at a glance. Users have no visual sense of which portion of
the video is selected versus unselected. There is no spacebar shortcut to toggle
playback without clicking the video element.

**Proposed UX.** Replace `ClipRangeControl` with a full-width timeline that
mirrors DaVinci Resolve's range bar:

- The track spans the full clip duration.
- By default `clipStart` and `clipEnd` are null, which the track renders as a
  full-width selected region in the accent color.
- When `clipStart` is set (via "Set Start" or by clicking the track), the region
  to the left of the marker is rendered with a darkened overlay (e.g. 50%
  semi-transparent `#000`). The selected region (right of start marker) renders
  at full brightness.
- When `clipEnd` is also set, only the region between the two markers is at full
  brightness; both flanks are darkened.
- The playhead is a thin white vertical rule that moves with `currentTime`.
- Clicking anywhere on the track seeks the video to that position (already
  implemented -- keep the `onPointerDown` seek logic).
- "Set Start" and "Set End" buttons stamp the current playhead position, same as
  today. The two time-text inputs (editable MM:SS.f) remain alongside the buttons
  for keyboard entry.

No changes to `rotoStore` or the backend -- this is purely a `ClipRangeControl`
visual/style change in `RotoVideoPanel.tsx`.

**Spacebar play/pause.** Add a `keydown` listener on `window` with a guard that
checks `document.activeElement` is not an editable element before firing:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (!video || !playerRef.current) return;
    const el = document.activeElement as HTMLElement | null;
    const tag = el?.tagName ?? "";
    // Block when focus is in any text-entry surface, including contenteditable
    // (used by some rich-text widgets and Monaco's accessibility layer).
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      el?.isContentEditable
    ) return;
    if (e.code === "Space") {
      e.preventDefault();
      const v = playerRef.current;
      v.paused ? void v.play() : v.pause();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [video]);
```

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx` (`ClipRangeControl`,
`RotoVideoPanel`).

---

## 2. Auto-set reference frame to first frame of selected clip

**Problem.** Users set a clip range and then separately lock a reference frame for
SAM2 point placement. If they forget to re-navigate before clicking "Set Start
Frame", the reference frame ends up somewhere outside (or far from) the clip,
which produces a misleading point-placement overlay.

**Fix.** When `clipStart` is set and `startFrame` has not yet been locked, advance
the video element to `clipStart` seconds so the first frame of the selected
section is automatically displayed before the user clicks "Set Start Frame".

This is a one-way nudge, not a hard override. The user can still scrub away from
`clipStart` before locking. The intent is to reduce the common mistake where the
reference frame is left at `t=0` while the clip starts at `t=15`.

Implementation: in `ClipRangeControl`'s `onSetStart` callback (in
`RotoVideoPanel`), after calling `setClipStart(currentTime)`, also call:

```tsx
if (startFrame == null && playerRef.current) {
  // Nudge to clip start only if the user has not already locked a frame;
  // do not clobber a frame the user intentionally set before picking the range.
  playerRef.current.currentTime = currentTime;
  setCurrentTime(currentTime);
}
```

The "Set Start Frame" button behavior is unchanged -- the user still clicks it to
lock the reference. The nudge just moves the playhead so the locked frame is the
clip's first frame by default.

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx`.

---

## 3. Playback controls for the SequencePlayer output

**Problem.** `SequencePlayer` auto-plays on a `setInterval` with no user controls
-- no play/pause, no scrubber, no frame counter the user can interact with. Outputs
longer than a few seconds are unnavigable.

**Proposed UX.** Add a minimal control bar below the sequence stage:

- Play/Pause button (spacebar-bound, same guard as section 1).
- A scrub track (fraction of `count` frames): dragging the handle sets `frame`
  directly and pauses playback, same interaction model as `ClipRangeControl`.
- A readout: `frame N / total @ X fps`.

The interval timer becomes conditional: only fires when `playing === true`. A
`useEffect` starts / clears the interval based on `playing`, same pattern as the
current unconditional one.

State additions (local to `SequencePlayer`, not the store):

```tsx
const [playing, setPlaying] = useState(true);   // starts playing on load
const [frame, setFrame] = useState(0);           // promoted from effect-only
```

Spacebar in the sequence player context: same `keydown` guard as section 1, but
targeted at the `SequencePlayer`'s `playing` state toggle instead of
`playerRef.current`.

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx` (`SequencePlayer`).

---

## 4. Use actual source fps for sequence playback

**Problem.** `effectiveFps` in `RotoOutputsPanel` computes
`ASSUMED_FPS / (frameSkip + 1)` where `ASSUMED_FPS = 30`. When the source video
is not 30fps -- common for 24fps film or 60fps screen recordings -- the sequence
plays at the wrong speed and the comparison timeline (bug bash 2, section 7) drifts.

**Fix: store source fps in meta.json.**

In the backend `_finalize` (or wherever `meta.json` is written), add
`source_fps: float` from the probed video metadata. The ffmpeg probe already
happens in `ffmpeg_helper.extract_frames` (which receives the source path) -- the
fps is in the stream info and can be returned alongside it.

Specifically: have `extract_frames` return the detected fps as a Python `float`,
propagate it up through `run_job`, and write it to `meta.json`. No schema changes
needed -- it is a new optional key; old outputs without it fall back to the 30fps
assumption.

**Fractional fps strings.** ffmpeg reports frame rate as an AVRational fraction
(e.g. `30000/1001` for NTSC 29.97, `24000/1001` for film 23.976). Python's
`float()` does not parse fractions and `eval` is unsafe. Use the stdlib
`fractions.Fraction` to convert reliably:

```python
from fractions import Fraction

def _parse_fps(fps_str: str) -> float:
    """Parse an ffmpeg AVRational fps string (e.g. '30000/1001') to float."""
    try:
        return float(Fraction(fps_str))
    except (ValueError, ZeroDivisionError):
        return 30.0  # safe fallback
```

Call this on the `r_frame_rate` or `avg_frame_rate` field from the ffprobe JSON
output in `ffmpeg_helper.py`.

On the frontend: `RotoOutput` gains `sourceFps: number | null`. The backend
`list_rotoscope_outputs` already reads `meta.json`; add `source_fps` to the
deserialization. `effectiveFps` in `RotoOutputsPanel` uses it if present:

```ts
function effectiveFps(frameSkip: number | null, sourceFps: number | null): number {
  const fps = sourceFps ?? ASSUMED_FPS;
  return fps / ((frameSkip ?? 3) + 1);
}
```

The `ComparisonPlayer`'s sync math (`sourceFps / (frameSkip + 1)`) in
`src/components/RotoPanel/ComparisonPlayer.tsx` benefits from the same field once
it is available in the loaded sequence's `LoadedSequence.fps`.

**Files:** `microservices/rotoscoping/ffmpeg_helper.py` (return fps),
`microservices/rotoscoping/sam2_engine.py` (write to meta.json),
`src-tauri/src/commands/roto_media.rs` (deserialize source_fps),
`src/components/RotoPanel/RotoOutputsPanel.tsx` (effectiveFps).

---

## 5. Comparison uses source_clip from output folder

**Problem.** The "Compare" toggle in `RotoVideoPanel` shows the left half as
`rotoStore.video` -- whatever the user currently has loaded in the setup pane.
If the user loaded a different video after the job ran, or if no video is loaded,
the comparison is against the wrong source. The correct comparison source is
always the exact clip that was processed, which is stored as `source_clip.mp4`
inside the output folder (written at job finalization, per bug bash 2 section 8).

**Fix.** When the user clicks "Compare" on a sequence in `RotoOutputsPanel`, load
the source clip from the output folder as the comparison source rather than
relying on `rotoStore.video`.

Implementation:

1. `RotoOutputsPanel` adds a "Compare" button per row (alongside the existing
   action buttons). It is only shown when `files[o.dir]?.sourceClip != null`.

2. Clicking "Compare":
   - Calls `rotoStore.loadSequence(...)` to load the output sequence (same as
     double-click today).
   - Also calls `rotoStore.loadVideo({ path: files[o.dir].sourceClip! })` so the
     comparison source is the stored clip.
   - Sets a flag in the parent that activates comparison mode automatically.

   Currently `loadVideo` clears `loadedSequence`; that needs to change. Add a new
   store action `loadVideoForComparison(video: LoadedVideo)` that sets `video`
   without clearing `loadedSequence`, for this exclusive use case:

   ```ts
   loadVideoForComparison: (video) => set({ video }),
   ```

   **Stale-sequence guard.** Because `loadVideoForComparison` does not clear
   `loadedSequence`, a caller that later calls `loadVideo` (the regular path) on a
   different file will correctly clear the sequence (existing behavior). However,
   if a caller invokes `loadVideoForComparison` twice in a row with two different
   videos (e.g., the user clicks "Compare" on two different outputs), the sequence
   from the first call is still in the store when the second video loads, producing
   a mismatched pair. The caller (the "Compare" button handler in
   `RotoOutputsPanel`) must therefore call `rotoStore.loadSequence(...)` and
   `rotoStore.loadVideoForComparison(...)` as an atomic pair in a single handler
   -- never one without the other. Document this as a caller contract in the
   `loadVideoForComparison` store action JSDoc.

3. `RotoVideoPanel` reads `loadedSequence` and `video` and, when the "Compare"
   button in `RotoOutputsPanel` triggered the load, both are set simultaneously,
   so `canCompare` is true and comparison mode activates.

4. In the `ComparisonPlayer`, the left half always renders the `videoUrl` derived
   from `rotoStore.video` (the source clip). Nothing changes in `ComparisonPlayer`
   itself -- the fix is upstream.

For backward compat: when `sourceClip` is null (older outputs that predate the
compose step), the "Compare" button is hidden and the existing manual workflow
(load sequence + source video separately, click the Compare toggle in the Video
pane header) still works.

**Files:** `src/store/rotoStore.ts` (new `loadVideoForComparison` action),
`src/components/RotoPanel/RotoOutputsPanel.tsx` (Compare button),
`src/components/RotoPanel/RotoVideoPanel.tsx` (auto-activate comparison).

---

## Implementation order

1. **Section 4** (source fps in meta.json) -- pure backend change, no UI dep.
   Do first; the fps is needed by sections 3 and 5 for accurate playback.

2. **Section 1** (Resolve-style timeline + spacebar) -- isolated client change,
   no backend needed. Low risk.

3. **Section 2** (auto-set reference frame) -- three-line logic addition inside
   the Set Start handler. Trivial, no deps.

4. **Section 3** (SequencePlayer controls) -- depends on nothing; the spacebar
   guard from section 1 can be extracted into a shared hook.

5. **Section 5** (comparison from source_clip) -- requires `source_clip.mp4` to
   be present in existing output folders (bug bash 2 section 8 must be live).
   Add the `loadVideoForComparison` action and wire the Compare button last.
