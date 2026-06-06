---
id: roto-trim-rebases-start-frame
root: gotchas
type: gotcha
status: current
summary: "When a clip range trims the source before upload (trim_video), the reference startFrame MUST be rebased by clipStart*fps, because rotoscope_video re-clips the file it receives with gte(n, start_frame) -- frame indices in the trimmed file start at 0 = clipStart. The leftover trim temp file is also not cleaned up."
created: 2026-06-06
updated: 2026-06-06
---

The roto submit flow has two stacked clips, and the second is frame-index based, so
trimming the front of the source shifts the reference frame.

`trim_video` (roto_media.rs) writes a temp mp4 of `[clipStart, clipEnd]` via ffmpeg
`-ss/-t`. The frontend then hands that temp path to `rotoscope_video`. But
`rotoscope_video` -> `clip_video` (rotoscoping.rs) does its OWN frame-accurate cut on
whatever file it gets, using the `select=gte(n,start_frame)` filter -- i.e. it treats
`start_frame` as an index into the file it receives. Since the trim dropped the first
`clipStart` seconds, frame index 0 of the trimmed file is the old `clipStart`, so the
reference `startFrame` (picked on the SOURCE timeline) is wrong by `clipStart*fps`
frames unless rebased.

RotoVideoPanel's `runJob` does this rebase only when a clip is set:
`effectiveStartFrame = max(0, startFrame - round(clipStart * fps))`. Points are spatial
coords on the reference frame and are NOT rebased.

Store fields (`clipStart`/`clipEnd`, rotoStore) are stored SOURCE-relative on purpose --
the rebase happens at submit time, not in the store, so the scrubber UI and the
ReviewModal clip row both reason in source time.

Two more traps:
- The trimmed temp file (`claudemotion_trim_*.mp4` in the OS temp dir) is NOT deleted.
  `rotoscope_video` removes only its own scratch clip, not the trim input it was handed.
  The OS reclaims temp eventually; a post-job cleanup is a future-ticket candidate.
- The 60s cap is enforced client-side in RotoVideoPanel (`exceedsCap`) mirroring the
  service's `MAX_VIDEO_SECONDS=60`; it disables Generate rather than letting the upload
  fail with a 400. See also [[clip-copy-overshoots-cap-keyframe]] for why a copy-based
  cut can't be trusted as an exact bound (this trim re-encodes, so it's accurate).
