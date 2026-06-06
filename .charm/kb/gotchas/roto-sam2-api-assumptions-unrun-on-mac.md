---
id: roto-sam2-api-assumptions-unrun-on-mac
root: gotchas
type: gotcha
status: current
summary: "The rotoscoping SAM2 engine was written on a Mac (no CUDA) and never executed; three runtime assumptions are unverified and flagged VERIFY in sam2_engine.py: (1) add_new_points_or_box NEEDS obj_id= (the proposal snippet omits it), (2) propagate_in_video yields mask logits shaped (num_objs,1,H,W) thresholded at >0 for alpha, (3) model/config/checkpoint-URL must move together (config.py). Verify these first when it first runs on the Windows box."
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

The CUDA startup guard (refuse to run if `torch.cuda.is_available()` is False) is
expected to fire on any non-CUDA machine -- that's correct behavior, not a bug.

See also [[roto-frameskip-is-output-only-not-propagation]].
