---
id: roto-sam2-memory-offload-and-frame-cleanup
root: gotchas
type: gotcha
status: current
summary: "The rotoscoping memory budget rests on three SAM2 init_state offload flags (offload_state_to_cpu is the load-bearing one for long clips on a 16GB card) plus deleting the extracted-frames dir right after run_job returns; both are UNVERIFIED on the Mac dev box (no CUDA, cu128 torch/sam2 not installable), so they carry VERIFY-on-CUDA comments."
created: 2026-06-06
updated: 2026-06-06
---

The rotoscoping microservice's VRAM/scratch footprint is controlled in two places, both added in T-011.

**SAM2 offload flags (sam2_engine.py `run_job`).** `predictor.init_state(...)` is called with `offload_video_to_cpu=True`, `offload_state_to_cpu=True`, `async_loading_frames=True` (SAM2 v1.0 API — no SAM2 source changes). `offload_state_to_cpu` is the one that actually makes long clips viable on a 16GB card; without it the per-frame memory bank grows in VRAM until OOM. These flags are NOT runtime-verified here: the dev box is a Mac with no CUDA and the cu128 torch / sam2 packages are not installable on it, so the whole GPU path carries a `# VERIFY on CUDA` comment (matching the file's existing convention). If you bump the sam2 package, re-confirm the flag names still exist.

**Frame-dir cleanup timing (main.py `_run_job_blocking`).** The extracted source JPEGs (`frames_dir`) are deleted with `shutil.rmtree(frames_dir, ignore_errors=True)` immediately after `run_job` returns, BEFORE `_zip_output` runs in `_finalize`. This is deliberate: it stops the scratch footprint from being doubled (frames + zip) during zipping. It only fires on the success path — on cancel/error `run_job` raises, so this line is skipped and the caller's `except` handlers `rmtree` the entire `work_dir` anyway. Only the frames dir is removed; `output/` and `result.zip` live on until the `/result` endpoint's cleanup callback.

**Memory instrumentation coupling.** `sam2_engine.log_memory(logger, label)` reports CPU current/peak via `tracemalloc`, which only works while tracing. `tracemalloc.start()` is called once (idempotent) at the top of `_run_job_blocking` before `extract_frames`, so every downstream snapshot (after extract_frames / init_state / add_new_points_or_box / every 50 propagation frames / after reset_state) has a real figure. If you move the memory logging earlier than that start call, the CPU portion silently drops out rather than reporting a misleading 0. CUDA figures are guarded by `torch.cuda.is_available()` so the line is harmless on a CPU-only box.

Related: [[roto-client-async-job-flow]] (the client side of this service).
