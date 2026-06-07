---
id: roto-model-size-swap-and-sse-stage-labels
root: gotchas
type: gotcha
status: current
summary: "The SAM2 service honors per-job model_size by swapping the single resident predictor only on an actual size change (warm reuse otherwise); the swap surfaces over the EXISTING progress SSE as stage labels downloading_model / loading_model (and queued), which the frontend must match VERBATIM."
created: 2026-06-07
updated: 2026-06-07
---

T-006 made the rotoscoping microservice (`microservices/rotoscoping/`) honor a
per-job `model_size` (tiny/small/base_plus/large). Key non-obvious facts:

**Swap, not co-load, only on change.** `sam2_engine.load_predictor(size)` reuses
the warm `_predictor` when `size == _resident_size` (NO teardown, NO reload, NO
download -- the common repeated-jobs case stays as fast as before). Only on a
differing size does it `_teardown_predictor()` (drop the only ref +
`torch.cuda.empty_cache()`) and rebuild. `load_predictor(None)` means "whatever is
resident, else the launched default" -- that's why `run_job`'s internal
`load_predictor()` call and startup both stay correct without passing a size.
`resident_size()` / `model_label()` expose the live state; `/health` reports the
RESIDENT label, not the launched default.

**Serialized by GPU_LOCK, never mid-job.** The download+swap run inside
`_ensure_model_for_job(job, size)`, called from `_run_job_blocking` while holding
`GPU_LOCK`, BEFORE any GPU work. A job POSTed during a swap blocks on the lock and
stays at the `Job` default stage `queued` until it acquires it -- no extra emit
needed.

**SSE stage-label contract (frontend must match VERBATIM).** The download+swap
surface as new stage values on the EXISTING `GET /rotoscope/{job_id}/progress`
stream, AHEAD of the frame stages -- there is no new endpoint:
- `downloading_model` -- `progress` = checkpoint download fraction (0..1), ticked
  at ~1% granularity. Emitted ONLY when the requested size's checkpoint is missing
  (one-time per size; all checkpoints kept cached under `models/`, never evicted).
- `loading_model` -- predictor being (re)built into VRAM; no numeric progress.
- `queued` -- waiting behind GPU_LOCK (the `Job` default stage).
These three strings are the contract for the model-size frontend tickets
(rotoStore field + RotoControls segmented control + useRotoJobQueue passthrough);
changing them on either side silently breaks the loading UX.

**Build + naming split.** Standardized on SAM2 **2.0** (the `072824` URL date) --
what config defaulted to and the only build the engine's API assumptions were
written against. `config.MODEL_SIZES` spells out each size's triple because the
Hydra config uses the SHORT code (`t`/`s`/`b+`/`l`) while the checkpoint uses the
LONG name (`tiny`/`small`/`base_plus`/`large`) -- you cannot derive one from the
other. `config.model_triple(size)` resolves it; the legacy `ROTO_SAM2_*` env vars
still work but ONLY override the DEFAULT size's triple (backwards compat). All
three files still carry VERIFY-on-CUDA caveats (never run on the Mac dev box).
See [[roto-sam2-api-assumptions-unrun-on-mac]].
