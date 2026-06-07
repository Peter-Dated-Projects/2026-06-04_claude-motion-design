# Proposal: Roto Editor & Controls UX Improvements

**Status: DRAFT**

---

## Context

The rotoscoping editor (left "Video" pane) and its controls section below have several rough edges accumulated across implementation sprints. The video element uses the browser's native controls, which exposes browser-native UI chrome that is stylistically inconsistent with the app and includes many irrelevant controls (volume, airplay, pip). The clip range control works mechanically but its interaction model is awkward — the "Set Start Frame" button overloads clip-start and reference-frame semantics that should be separate. The RotoControls panel underexplains its options and carries a stale default (frameSkip=3, meaning every 4th frame, with no explanation). The review modal repeats these problems and adds new ones: "every 4th frame" with no fps figure, and "Estimated frames: unavailable (unprobed)" even when the video has been probed.

This proposal addresses all of them.

---

## Problems

### 1. Native video controls are wrong for this surface

The current video element is rendered as `<video controls>`, which uses the browser's built-in control bar. That bar includes: play/pause, current-time scrubber, duration, volume, playback speed, AirPlay, and PiP. Of those, only scrubbing and play/pause matter here. Volume is irrelevant (no audio use case in rotoscoping). AirPlay and PiP are system affordances that are confusing in a panel. Speed control already exists in the custom controls row being proposed. The browser control bar is also visually inconsistent with the rest of the app.

### 2. The clip range bar is always full-width and does not reflect an unset range correctly

The clip range track shows a solid blue bar from 0% to 100% whenever neither bound is set (i.e. "no clip, use full video"). This reads as "the whole bar is selected" which is correct semantically, but visually indistinguishable from a state where a clip has actually been set from 0% to 100%. The track needs to communicate "no clip set" differently from "clip set to the full length".

More importantly, the current ClipRangeControl is a free-standing subsystem underneath the video, with its own Set Start / Set End buttons. It is used both for clip trimming (temporal window sent to the service) and implicitly for reference-frame placement (Set Start nudges the playhead). This conflation makes the interaction model confusing: two "start" concepts (clip start and reference start frame) are collapsed into one button.

### 3. "Set Start Frame" button semantics are confusing

"Set Start Frame" locks the reference frame from which SAM2 propagates masks. It is not the same as the clip start time, but pressing Set Start in the clip range control implicitly nudges the playhead and the user may use that as the reference frame. The current layout invites this confusion because both controls are visually adjacent and labeled similarly ("Set Start" / "Set Start Frame").

The request is to remove "Set Start Frame" as a button entirely. The start frame should default to the first frame of whatever clip is selected (or frame 0 if no clip). The separate "Select Region" action initiates the clip selection panel.

### 4. Frame readout says "est. @ 30fps" even after probing

The status bar shows `frame 0 (est. @ 30fps)` before a video is probed, but keeps showing `(est. @ 30fps)` even after `video.fps` is populated by the ffprobe pass. This is a display bug — `video.fps` is already on the store after probing. The readout should show `frame X @ {video.fps}fps` once probed, and only fall back to the `(est. @ 30fps)` label when not yet probed.

### 5. Output FPS needs a direct float input with a source-fps ceiling

The Output FPS field works correctly as a text input that maps to frameSkip. But there is no enforcement of an upper bound of the source fps (typing 120fps for a 30fps source produces frameSkip=0 which is correct behavior, but gives no feedback that you're asking for more frames than exist). The input should clamp to a maximum equal to `video.fps` and show a warning when the entered value exceeds it. The minimum remains 1fps (or lower for very slow stop-motion).

### 6. Custom resolution expands downward and pushes the controls scroll area

When the user selects "Custom" in the Resolution segmented group, a W/H input block drops in below the button row, pushing the Quality section and the Generate button down and potentially off-screen on short panels. The request is for the custom dimension inputs to expand inline to the right of the "Custom" button rather than downward, keeping the total vertical height stable.

### 7. Quality tooltip on hover does not explain what the options actually mean

The quality options have `title` attributes set to hint strings (`"No re-encode (copy as-is)"`, `"~CRF 18 (large, near-lossless)"`, etc.) — these show on hover as native browser tooltips, which are delayed and small. The request is to surface these as visible tooltip bubbles directly on hover: show the hint text as a small label below (or above) the hovered button so it is immediately readable without waiting.

### 8. Review modal: Output FPS row shows "every 4th frame" with no fps value

When the video is probed, the review modal has enough information to show the exact output fps. Instead it shows `every 4th frame` (a description of frameSkip=3, the default), which answers the wrong question. A user who set Output FPS to 7.5fps in the controls wants to see `7.5 fps` in the review, not a description of the internal frame-skip integer. The "every Nth frame" hint can be a secondary annotation but should not be the primary value.

The default frameSkip=3 (every 4th frame) was chosen as a reasonable default for 30fps source (7.5 output fps), but it is never explained in the UI. After changing the frame-skip to be derived from a user-entered fps value, this confusion mostly disappears — but the review modal still needs to display the computed fps as the primary value.

### 9. Review modal: Estimated frames shows "unavailable (unprobed)" after probing

The estimate formula requires `duration` and `sourceFps`, both of which are on `rotoStore.video` after the ffprobe pass. The "unavailable (unprobed)" fallback should only appear before the probe completes. After probing, the estimate is always computable and should always be shown.

### 10. Review modal: no model size row

The review modal summarizes every parameter the user has set, but model size is not listed even after the model size selector is added (per the assets/controls proposal). It should be a row in the summary.

---

## Proposed Changes

### Custom video playback controls

Replace `<video controls>` with `<video>` (no native controls) and build a two-row control bar below the video element.

**Row 1 — Clip region track.** A 50px-tall track bar (matching the request) that visualizes the selected clip region. When no clip is set, the bar is rendered at low opacity to communicate "no selection active". When a start and/or end is set, the selected region fills at full opacity and the flanks darken as they do now. The track is still seekable by click/drag. No "CLIP RANGE" label, no "Clear" button inline — Clear moves into the right-click menu or a small icon.

**Row 2 — Playback controls.** Three groups:
- Left: speed selector (0.25x, 0.5x, 1x buttons, or a small dropdown). The speed selector sets `videoEl.playbackRate`.
- Center: rewind-to-start icon, play/pause icon, skip-to-end icon. Rewind seeks to `clipStart ?? 0`; skip seeks to `clipEnd ?? duration`. Play/pause toggles `videoEl.paused`.
- Right: current time readout `MM:SS.s / MM:SS.s` and frame readout `frame N @ Xfps`.

All icons are SVG inline (same pattern as the rest of the app). No volume, no AirPlay, no PiP, no full-screen, no picture-in-picture.

### Remove "Set Start Frame", add "Select Region"

Remove the `<button>Set Start Frame</button>` and the `roto-video__set-start` CSS. The reference frame is now set automatically to the first frame of the selected clip region (or frame 0 if no region is set). When the user clicks "Select Region", the ClipRangeControl activates — the track in row 1 becomes interactive and they drag or use Set Start / Set End to define the region. Once a region is selected, the reference frame is implicitly `clipStart`. "Select Region" replaces the old button's position in the `roto-video__scrub-row`.

This removes the separate `setStartFrame` call from `lockStartFrame()`. The store's `startFrame` is instead derived: `clipStart != null ? Math.round(clipStart * fps) : 0`, computed at the time the job is enqueued rather than stored independently. This eliminates the two-step "Set Start Frame, then place points" flow. The user's steps become: load video → select region (optional) → place points → generate.

The "Change frame" escape (the locked-bar row with "Reference frame: N") is removed with it, since there is no manual lock step anymore.

### Fix frame readout

Change:
```
frame {Math.max(0, Math.round(currentTime * fps))}
{video.fps == null ? " (est. @ 30fps)" : null}
```
To:
```
frame {N} @ {video.fps != null ? `${video.fps}fps` : "~30fps"}
```
Display the fps accurately once probed. The `(est. @ 30fps)` parenthetical is replaced with a consistent `@ Xfps` format.

### Output FPS ceiling + feedback

Add a validation check after parsing the user's fps input: if the entered value exceeds `sourceFps`, show a warning label below the input — "Max source fps is Xfps" — and clamp the committed frameSkip to 0 (which produces frameSkip=0, meaning every frame). Do not reject the value outright; just clamp and label it.

### Custom resolution expands inline

When `resolution.preset === "custom"`, instead of rendering the `roto-controls__custom` block as a new row below the segment group, append the W/H inputs inline after the "Custom" segment button in the same flex row. The segment group grows to accommodate them. The "Maintain aspect ratio" checkbox becomes a small icon toggle adjacent to the inputs rather than a labeled checkbox on a new line. This keeps the custom state contained to the resolution row without adding height to the controls section.

### Quality hover tooltips

Replace the native `title` attribute on each quality segment button with a custom tooltip. On hover, render a small absolute-positioned div below the button that shows the hint text immediately (no browser delay, consistent with the app's visual style). The tooltip auto-dismisses on mouse-leave. The hint strings already exist in `QUALITY_OPTIONS`; this is a rendering change only.

### Review modal: accurate Output FPS row

When the video is probed, display the computed output fps as the primary value:
```
Output FPS     7.5 fps  (every 4th frame, source 30fps)
```
When not probed (no `video.fps`), show:
```
Output FPS     every 4th frame  (source fps unknown)
```
The "every Nth frame" phrasing moves to a secondary annotation in parentheses, not the lead value.

### Review modal: always show frame estimate when probed

Remove the "unavailable (unprobed)" fallback when `video` is loaded and probed. If `video.fps` and `video.durationSeconds` are both present, the estimate is always computable. The fallback only fires when the video has not completed probing (i.e. `video.fps == null`), at which point it reads "probing video..." rather than the current "unavailable (unprobed)" which sounds like a permanent error.

Consider scoping the frame estimate to the clip duration if a region is set: `Math.ceil((clipDuration * sourceFps) / (frameSkip + 1))` instead of the full video duration.

### Review modal: add Model row

Add a Model row to the `<dl>` summary:
```
Model          Base+ (SAM2 base_plus)
```
Shown only after model size selection is implemented (can be deferred until that feature lands).

---

## Files touched

| File | Changes |
|---|---|
| `src/components/RotoPanel/RotoVideoPanel.tsx` | Remove `<video controls>`, build custom control bar (2 rows), remove Set Start Frame button + lockStartFrame, add Select Region affordance, fix frame readout, remove ClipRangeControl separate Set Start/End buttons (keep track interactive), remove locked-bar |
| `src/components/RotoPanel/RotoControls.tsx` | Output FPS ceiling + warning label, custom resolution inline expansion, quality hover tooltip component |
| `src/components/RotoPanel/ReviewModal.tsx` | Output FPS row shows computed fps first, frame estimate uses clip duration when applicable, remove "unavailable (unprobed)" when probed, add Model row |
| `src/store/rotoStore.ts` | `startFrame` becomes derived at enqueue time (remove independent `setStartFrame` action, or keep it but auto-populate from clip) |
| `src/hooks/useRotoJobQueue.ts` | Derive `startFrame` from `clipStart` at enqueue time if not explicitly set |

---

## What is not changing

The `ClipRangeControl` component's seek track and region-visualization logic is preserved — only the button row below it (Set Start / Set End / time inputs) needs rethinking, and the track itself moves to row 1 of the new control bar. The ffprobe probe path (`video.fps`, `video.durationSeconds`) is already working and does not change. The `frameSkip` store value remains the canonical representation; the fps input continues to be a derived view over it.

---

## Open question: Select Region flow

The "Select Region" button replaces "Set Start Frame" in the scrub row. The question is whether clicking it should:

**Option A** — Open a clip-time input inline (time fields for start/end, same as the existing Set Start / Set End inputs). Simple, no new UI component.

**Option B** — Activate a drag-on-track mode: clicking "Select Region" highlights the track and the user drags a range handle directly. More direct but requires new pointer interaction on the track that coexists with the seek-on-click behavior.

Option A is lower risk and already has the implementation in `ClipRangeControl`. Option B is the more natural video-editing interaction but needs the track to distinguish between "seek click" and "range-select drag". Recommend Option A for the first pass.
