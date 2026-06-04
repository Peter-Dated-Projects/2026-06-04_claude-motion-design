---
id: canonical-canvas-is-vertical
root: gotchas
type: gotcha
status: current
summary: "The shipped system prompt (remotion-skills.txt) is canonical: canvas is vertical 1080x1920 (FIXED), with default fps 30 / durationInFrames 150. The prompt-engineering.md research note still says 1920x1080 — do not 'fix' the prompt to match it."
created: 2026-06-04
updated: 2026-06-04
---

`src-tauri/resources/remotion-skills.txt` is the authoritative system prompt — it is
appended to Claude's system prompt at runtime via `--append-system-prompt-file`. It
specifies a **vertical** composition: `width 1080, height 1920`, with `fps 30` and
`durationInFrames 150` (5s) as DEFAULTS, matching the TikTok/Reels/Shorts target format.

Update (T-033): fps and durationInFrames are now DEFAULTS, not fixed -- an animation may
override them by exporting `fps`/`durationInFrames` (see [[animation-can-export-fps-duration]]).
Width and height stay hard-fixed at 1080x1920; that part of this note still holds.

The earlier research note `.charm/kb/prompt-engineering.md` (from T-009) still describes a
**horizontal** `1920x1080` canvas and lists slightly different vocabulary. That note is
exploratory research, not the shipped contract. The numbers in it are stale.

Trap: a future agent reading `prompt-engineering.md` could "correct" `remotion-skills.txt`
to 1920x1080 and silently break every generated animation — the preview sandbox, phone
bezel, and safe-zone overlay all assume a 1080x1920 portrait frame. When the two disagree,
`remotion-skills.txt` (and PLAN.md section T-IMPL-010) wins.

Safe-zone constants baked into the prompt and tied to the 1080x1920 frame: text within
x 30-920 / y 140-1550; captions bottom edge above y=1480; hero zone x 150-930 / y 300-1420;
nothing critical within 370px of the bottom (platform UI overlay).
