---
id: player-ref-no-speed-loop
root: gotchas
type: gotcha
status: current
summary: "@remotion/player's PlayerRef has NO setPlaybackRate or setLoop methods — playback speed and loop are controlled via the `playbackRate` and `loop` PROPS, so changing them means re-rendering the Player, not calling the ref."
related:
  - architecture/preview-sandbox
  - replay-controls.md
created: 2026-06-04
updated: 2026-06-04
---

The T-IMPL-007 plan sketch called `playerRef.setPlaybackRate(speed)` and
`playerRef.setLoop(loop)`. **Neither method exists.** Verified against
`@remotion/player@4.0.471` `dist/cjs/player-methods.d.ts`, the full `PlayerMethods` ref surface
is: `play`, `pause`, `toggle`, `seekTo`, `getCurrentFrame`, `requestFullscreen`,
`exitFullscreen`, `isFullscreen`, `setVolume`, `getVolume`, `isMuted`, `isPlaying`, `mute`,
`unmute`, `pauseAndReturnToPlayStart`, plus `getContainerNode` / `getScale`.

Speed and loop are **props** on `<Player playbackRate=... loop=... />`, not imperative methods.
So in the preview sandbox, `setSpeed` / `setLoop` messages update local render state and
**re-render** the Player with the new props (React reconciles the existing instance, so the
current frame/position is preserved). This matters for the replay controls (T-030), which must
drive speed/loop by prop, while play/pause/seek go through the ref.
