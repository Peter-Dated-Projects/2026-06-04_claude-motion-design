---
id: roto-frameskip-is-output-only-not-propagation
root: gotchas
type: gotcha
status: current
summary: "In the rotoscoping microservice, frame_skip decimates OUTPUT only -- SAM2 still init_states + propagates over EVERY extracted frame; ffmpeg extracts all frames, and the loop writes a PNG only where frame_idx % (frame_skip+1)==0. Don't 'optimize' by extracting/propagating fewer frames or mask quality collapses."
created: 2026-06-06
updated: 2026-06-06
---

In `microservices/rotoscoping/`, `frame_skip` is purely an **output decimation**
control. The pipeline is:

1. `ffmpeg_helper.extract_frames()` extracts **every** frame of the clip to JPEGs
   (`%05d.jpg`, 0-based). It does NOT skip frames.
2. `sam2_engine.run_job()` runs `init_state` on the full frame dir and
   `propagate_in_video` over the **whole** sequence -- SAM2 needs the contiguous
   sequence for temporal mask propagation quality.
3. Only inside the propagation loop do we write a PNG, and only for frames where
   `frame_idx % (frame_skip + 1) == 0` (matching the proposal's IMPLEMENTATION
   snippet, NOT the storage-example numbering).

The tempting "optimization" of extracting or propagating only every Nth frame is
wrong: it breaks SAM2's frame-to-frame tracking and the masks degrade. The cost
of propagating all frames is intentional.

Output PNGs are named `frame_{idx+1:04d}.png` (1-based) from the 0-based
`frame_idx`. See also [[roto-sam2-api-assumptions-unrun-on-mac]].
