---
id: 0004-light-theme
root: decisions
type: decision
status: current
summary: "The whole app was switched from dark to a single LIGHT theme (not a toggle); the mosaic shell class was renamed .mosaic-dark -> .mosaic-light and Monaco uses theme=\"vs\"."
created: 2026-06-04
updated: 2026-06-04
---

T-046 converted the app from its original dark palette to a coherent LIGHT theme.
This is a pragmatic, one-way switch -- there is NO dark/light toggle system; the
dark values were replaced in place.

Consistent light palette now used across chrome and panels:
- panel body `#ffffff`; app / preview letterbox `#f3f3f3` / `#e9e9e9`
- chrome bars (toolbar, status bar, tab strip, panel/window headers, dropdowns) `#f0f0f0`
- borders `#d4d4d4` (primary), `#e0e0e0` (subtle)
- text `#1f1f1f` primary, `#6a6a6a`/`#888` muted, `#999` faint
- buttons `#ffffff` w/ `#cfcfcf` border, hover `#e8e8e8`
- selected/active uses the existing blue accent `#3b82f6` with a `#dbeafe` fill
- semantic colors (success green, error red, warn amber) were kept as accents,
  with their container backgrounds lightened (e.g. preview error strip is now
  `#fdecea` / `#b71c1c`)

Non-obvious pointers for future work:
- The react-mosaic shell override class was renamed `.mosaic-dark` -> `.mosaic-light`
  in BOTH App.css and App.tsx. Grep for `mosaic-light` (not `mosaic-dark`). The
  mechanism in [[mosaic-blueprint-theme-overrides-dark]] still holds: `<Mosaic>` is
  mounted with `className=""` to drop the bundled Blueprint theme, and we paint the
  chrome from scratch -- now to light instead of dark.
- Monaco editor theme is `theme="vs"` (light) in MonacoEditor.tsx, was `vs-dark`.
- The xterm terminal (TerminalPanel) was lightened too: TERMINAL_THEME bg `#ffffff`,
  fg `#1f1f1f`. Caveat: the embedded `claude` CLI emits an ANSI palette tuned for
  dark backgrounds, so some bright ANSI colors (yellow/cyan) have weaker contrast on
  white. Acceptable for now; revisit with a custom ANSI palette if it reads poorly.
- Intentionally left dark: PhoneBezel's device body (`#1a1a1a`) and the iframe
  screen (`#000`) -- that is the phone mock + the animation's own canvas, not app
  chrome.
