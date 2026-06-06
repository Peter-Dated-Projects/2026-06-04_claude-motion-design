---
id: ig-frames-4digit-vs-store-3digit
root: gotchas
type: gotcha
status: current
summary: "ig-pipeline frames.ts writes raw candidates as 4-digit frame_%04d.jpg (ffmpeg counter); lib/paths frameFileName + store stage use 3-digit frame_NNN.jpg for the kept survivors -- two different file sets, do not assume one naming."
created: 2026-06-06
updated: 2026-06-06
---

In `scripts/ig-pipeline`, frame filenames use two different zero-pad widths on
purpose, for two different sets of files:

- **frames.ts (extraction)** writes *every candidate* ffmpeg samples at 2fps,
  using ffmpeg's own counter pattern `frame_%04d.jpg` -> `frame_0001.jpg` (4
  digits). These land in `<outDir>/frames/`.
- **lib/paths.ts `frameFileName(i)` / store stage** name the *kept survivors*
  `frame_001.jpg` (3 digits, via `padStart(3, "0")`) when writing them into the
  extraction folder.

So a store-stage author who reuses `frameFileName` and a frames-stage author who
greps for `frame_%04d` are both correct -- they are naming different things. Do
not "unify" them to one width without realizing the frames stage hands ffmpeg a
literal pattern string (ffmpeg owns the counter) while the store stage builds
each name in TS.

Consequence for whoever wires them together (run.ts / store): the kept
`ScoredFrame.path` values point at the 4-digit candidate files; if store needs
the proposal's 3-digit layout it must copy/rename, not assume the names already
match. frames.ts also clears+recreates only the `frames/` subdir each run (stale
guard), so don't expect candidate files to persist across re-runs.
