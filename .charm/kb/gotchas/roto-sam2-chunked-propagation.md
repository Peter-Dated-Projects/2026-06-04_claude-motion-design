---
id: roto-sam2-chunked-propagation
root: gotchas
type: gotcha
status: current
summary: "SAM2 run_job now propagates in CHUNK_SIZE=150 frame windows; each chunk gets its own temp sub-dir of symlinks (Linux) or copies (Windows), a fresh init_state, and a reset_state+empty_cache in a finally block. The carry mask (CPU bool ndarray from the last frame's logits) seeds chunk 1+ via add_new_mask (AttributeError fallback: add_new_points_or_box)."
created: 2026-06-06
updated: 2026-06-06
---

## What changed

`run_job` in `sam2_engine.py` now processes propagation in chunks of
`config.CHUNK_SIZE` (150) frames instead of one monolithic call. This
bounds peak CPU RAM regardless of clip length: `output_dict` accumulates
at most 150 entries per `init_state` call instead of 1800+ for a 60s
clip at 30fps.

## How the chunk loop works

1. `num_chunks = ceil(total_frames / CHUNK_SIZE)`.
2. Per chunk: create a temp dir (via `tempfile.mkdtemp` beside `frames_dir`),
   populate it with symlinks (Linux/macOS) or `shutil.copy2` copies (Windows)
   of that chunk's JPEGs renamed to a 0-based `00000.jpg` sequence.
3. `init_state` on the temp dir. Chunk 0 prompts with `add_new_points_or_box`.
   Chunk 1+ tries `predictor.add_new_mask(state, 0, OBJ_ID, carry_mask)` (positional
   args, no kwarg); falls back to `add_new_points_or_box` on `AttributeError`
   (API absent in some SAM2 builds).
4. `propagate_in_video` loop: `source_frame_idx = chunk_start + chunk_local_idx`
   for globally-unique output filenames; `global_frames_processed` drives the
   `0.1 + 0.85 * (...)` progress formula.
5. After propagation, save `carry_mask = (last_logits > 0.0).cpu().numpy()` (bool).
6. Per-chunk `finally`: `reset_state`, `empty_cache`, `rmtree(chunk_dir)`.

## Windows note

NTFS symlinks require admin/Developer Mode; the code detects `os.name == 'nt'`
and falls back to a shallow copy. This costs disk I/O but is safe.

## Outer finally safety net

`state` and `current_chunk_dir` are also cleaned up in the outer `run_job`
finally for the case where a cancellation or exception bypasses the inner
chunk finally (e.g. raised during symlink setup before `init_state`).

## _save_transparent_png signature change

The function now takes a 5th positional arg `source_frame_idx` (the global
index, used for the output filename). `frame_idx` (the chunk-local index)
still selects the JPEG to read from `frames_dir`.
