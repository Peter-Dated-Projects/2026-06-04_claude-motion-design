---
id: layout-pass-validator-substring-and-payload
root: gotchas
type: gotcha
status: current
summary: "The layout-pass forbidden-pattern validator scans the loaded animation source (not event.payload.code — T-067 changed animation://changed to {paths}), and because the match is naive substring the SEED scaffold must avoid the literal tokens or it self-triggers on its own comment."
created: 2026-06-05
updated: 2026-06-05
---

The two-pass generation layout validator (App.tsx) checks animation.tsx for
`useCurrentFrame` / `spring(` / `interpolate(` / `Easing` during the layout pass
and types a `[LAYOUT PHASE] ...` correction into the PTY via `terminal_input`.

Two non-obvious traps when building/extending it:

1. **Payload shape.** The original two-pass spec said to scan
   `event.payload.code` in the `animation://changed` handler. That is stale — the
   multi-file compiler work changed the watcher payload to `{ paths: string[] }`
   (no `code`). The validator must run inside the entry-changed branch, scanning
   the string returned by the `load_animation` invoke that already runs there, not
   a `code` field on the event.

2. **Naive substring self-trigger.** The match is `src.includes(pattern)` (no TS
   parse — intentional, per the v1 spec). The proposal's layout starter scaffold
   carries a comment listing the forbidden APIs ("useCurrentFrame, spring,
   interpolate intentionally absent"). Seeding that scaffold fires
   `animation://changed`, and the bare word `useCurrentFrame` in the comment
   matches — so the validator fires on the seed itself before Claude writes
   anything. The layout starter's comment must therefore avoid the literal tokens
   (reworded to "Motion APIs are intentionally not imported here..."). False
   positives on Claude-authored comments are still accepted for v1, but the
   app-controlled seed must never trip it.

Gating: the scan runs only when the active pass mode (held in a ref, set
synchronously before the seed save) is `"layout"`, so the motion-pass seed — which
prepends the motion imports back — and normal `mode=None` sessions never fire it.
The motion seed PREPENDS a `// layout locked` header + a second `from "remotion"`
import rather than replacing the file, so the layout work is preserved (the extra
remotion import is legal because the layout pass forbade those four symbols).
