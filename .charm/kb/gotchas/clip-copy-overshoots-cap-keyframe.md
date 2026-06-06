---
id: clip-copy-overshoots-cap-keyframe
root: gotchas
type: gotcha
status: current
summary: "ffmpeg `-t N -c copy` cuts on the NEXT keyframe, so clip.mp4's real duration can exceed the cap (measured 30.07s for a 30s cap); ClipResult.clippedDurationSeconds is therefore NOT a hard `<= CLIP_SECONDS` bound despite the type comment -- downstream stages must not assume it."
created: 2026-06-06
updated: 2026-06-06
---

The Stage 0 clip uses `ffmpeg -y -i <src> -t <CLIP_SECONDS> -c copy <clip.mp4>`
for an instant stream copy (no re-encode). Because `-c copy` can only cut on a
keyframe boundary, ffmpeg keeps copying until the next keyframe at/after the
`-t` mark. On a 30 fps test source with a 30s cap, the produced clip probed at
**30.066667s** -- slightly OVER the cap, not at or under it.

Consequences:

- `clip.ts` re-probes the produced `clip.mp4` to report the TRUE
  `clippedDurationSeconds`, so the reported number is honest (it will read ~30.07,
  not a clean 30).
- The `ClipResult.clippedDurationSeconds` doc comment in `types.ts` says
  "`<= CLIP_SECONDS`". That is aspirational, not guaranteed -- the real value can
  exceed the cap by up to one keyframe interval. Any later stage (frames, score)
  that derives a frame count or a time budget from this MUST tolerate a small
  overshoot rather than assuming a hard ceiling.
- `wasClipped` is decided by comparing the ORIGINAL source duration against
  `CLIP_SECONDS + 0.1s` tolerance (not the clip's duration, and not a strict
  `>`), so a source at ~30s is not spuriously flagged as clipped even though its
  copied clip might read 30.0x.

If an exact `<= CLIP_SECONDS` bound is ever required, it costs a re-encode
(drop `-c copy`), which is far slower -- not worth it for a 30s analysis clip.

Related error-path finding: ffprobe/ffmpeg run on a non-existent INPUT file exit
non-zero with "No such file or directory" -> surfaces as a `SpawnError` of kind
`non_zero_exit` (code 1), which is correctly distinct from `binary_not_found`
(the binary itself missing from PATH). Both give actionable messages.
