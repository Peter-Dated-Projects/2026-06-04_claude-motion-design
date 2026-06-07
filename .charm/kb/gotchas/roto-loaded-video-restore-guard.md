---
id: roto-loaded-video-restore-guard
root: gotchas
type: gotcha
status: current
summary: "RotoAssetsPanel restores the last-loaded video inside refresh() from the per-project key roto:loadedVideo:<slug>, but MUST guard with useRotoStore.getState().video?.path !== stored — loadVideo() resets the whole setup, so an unguarded reload of the already-loaded path wipes in-progress work on every refresh."
created: 2026-06-07
updated: 2026-06-07
---

The Project Assets panel persists the last-loaded source video per project under
the localStorage key `roto:loadedVideo:<slug>` and restores it on mount. The
restore runs *inside* `refresh()` (after `list_project_videos` returns), not in a
separate effect, because that is the only place the fresh `vids` list is in scope
to validate the stored path against.

Two non-obvious constraints make this safe:

- **Guard against reloading the already-loaded path.** `refresh()` runs on mount
  AND after `pickVideo`/`removeVideo`. `rotoStore.loadVideo()` resets the entire
  setup (`...FRESH_SETUP`), so calling it with the path that is already loaded
  silently discards any in-progress clip/point selection. The restore therefore
  reads the live store via `useRotoStore.getState().video?.path` (not the stale
  render-closure `video`) and only loads when the stored path differs.

- **Route every load through one helper.** All load paths (file picker,
  double-click, Load button, context-menu Load) go through `loadVideoPath()`,
  which writes the key then loads; all unload paths (Clear buttons, context-menu
  Clear, removing the loaded video) go through `clearLoadedVideo()`, which removes
  the key then resets. If any load/unload bypasses these, the persisted key drifts
  out of sync with what is actually loaded and the next mount restores the wrong
  thing (or nothing).

Related: the store reset behavior is [[roto-store-no-cancel-reducer]] (reset wipes
the whole setup); media wiring history in [[roto-media-wiring-landed-t006]].
