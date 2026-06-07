---
id: roto-sam2-api-assumptions-unrun-on-mac
root: gotchas
type: gotcha
status: current
summary: "The rotoscoping SAM2 engine was written on a Mac (no CUDA) and never executed; four runtime assumptions are unverified and flagged VERIFY in sam2_engine.py: (1) add_new_points_or_box NEEDS obj_id= (the proposal snippet omits it), (2) propagate_in_video yields mask logits shaped (num_objs,1,H,W) thresholded at >0 for alpha, (3) model/config/checkpoint-URL must move together (config.py), (4) T-009/T-017: build_sam2_video_predictor accepts a use_flash_attn kwarg (gated on Ada/Hopper/Blackwell), with TWO separate fallbacks -- ImportError rebuilds with use_flash_attn=False, TypeError (signature mismatch) rebuilds OMITTING the kwarg since passing False would also raise. Verify these first when it first runs on the Windows box."
created: 2026-06-06
updated: 2026-06-06
---

`microservices/rotoscoping/sam2_engine.py` and `main.py` could not be run during
implementation (developed on a Mac with no CUDA; cu128 torch wheels don't even
install there). The syntax/import-clean checks were done with `py_compile` and by
importing only the torch-free modules. The GPU paths carry `VERIFY:` comments.
The three things most likely to break on first real run:

1. **`add_new_points_or_box` requires `obj_id`.** The proposal's code snippet
   omits it, but the real SAM2 API needs an object id. The engine passes a
   constant `_OBJ_ID = 1` (single subject). If the installed sam-2 build has a
   different signature, this is the first call to check.

2. **Mask tensor shape.** `propagate_in_video` is assumed to yield
   `(frame_idx, obj_ids, mask_logits)` with `mask_logits` shaped
   `(num_objs, 1, H, W)` (or `(num_objs, H, W)`). `_mask_to_alpha` takes object
   0, squeezes extra dims, thresholds `> 0.0`, scales to 0/255. If alpha comes
   out empty/inverted/transposed, fix it here.

3. **Model identity is a 3-tuple that must move together.**
   `SAM2_CHECKPOINT_NAME` + `SAM2_CONFIG_NAME` + `SAM2_CHECKPOINT_URL` in
   `config.py` must all match the installed sam-2 version (original release vs a
   2.1 build use different file names and a `configs/sam2.1/...` config path).
   Never hardcode these in the engine -- they're funneled through config.py on
   purpose.

4. **`build_sam2_video_predictor(..., use_flash_attn=...)` (T-009, hardened in
   T-017).** The GPU probe gates FlashAttention on Ada/Hopper/Blackwell and passes
   the kwarg to the build call. The build is wrapped in TWO separate except arms
   that MUST stay separate -- they need different fallbacks:
   - `ImportError` (the `flash-attn` package isn't installed): rebuild with
     `use_flash_attn=False`, which skips the flash import path.
   - `TypeError` (the installed sam-2 build's signature doesn't accept
     `use_flash_attn` at all): rebuild OMITTING the kwarg entirely. The subtlety:
     passing `use_flash_attn=False` here raises the SAME `TypeError`, so the
     ImportError-style fallback does NOT work for this case.

   Originally (T-009) only `ImportError` was caught and `TypeError` surfaced
   loudly. That was wrong for this target: a signature mismatch crashes startup on
   exactly the flash-capable GPUs (Ada/Hopper/Blackwell) this gates flash on, and
   `main.py`'s lifespan only catches `RuntimeError` -> ungraceful crash. T-017
   added the `TypeError` arm. Both catches are still deliberately specific (not
   bare `Exception`) so genuine build errors (bad checkpoint/config) are not
   swallowed. STILL UNVERIFIED on real CUDA hardware.

The CUDA startup guard (refuse to run if `torch.cuda.is_available()` is False) is
expected to fire on any non-CUDA machine -- that's correct behavior, not a bug.
T-009 added a one-time `_probe_gpu()` in `load_predictor` that ALSO raises
`RuntimeError` on a non-CUDA box; `main.py`'s lifespan catches it, logs CRITICAL,
and exits cleanly (so Mac/CPU is a clean exit, not a stack trace).

See also [[roto-frameskip-is-output-only-not-propagation]].
