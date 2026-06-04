---
id: mosaic-blueprint-theme-overrides-dark
root: gotchas
type: gotcha
status: current
summary: "react-mosaic-component.css bundles the blueprint LIGHT theme as .mosaic.mosaic-blueprint-theme rules at specificity (0,4,0), and <Mosaic> applies that class by default; a lower-specificity dark override loses, so pass className=\"\" to drop the cosmetic class (structural rules are unscoped) and theme from scratch."
created: 2026-06-04
updated: 2026-06-04
---

The 3-panel shell uses `react-mosaic-component` v6 (pinned `^6.2.0`; npm's
`latest` tag is a `7.0.0-beta0` prerelease, so do NOT install unpinned). We
import `react-mosaic-component/react-mosaic-component.css` for the layout.

The trap: that single CSS file bundles **both** the structural rules and the
Blueprint *light* theme. Two facts collide:

- `<Mosaic>`'s `className` prop **defaults to `"mosaic-blueprint-theme"`** — so
  unless you override it, every mosaic gets the light theme class.
- The light cosmetic rules are written as `.mosaic.mosaic-blueprint-theme
  .mosaic-window .mosaic-window-body { background: #f6f7f9 }` etc. — specificity
  **(0,4,0)**. A hand-rolled `.mosaic-dark .mosaic-window-body { background:#1a1a1a }`
  is only (0,2,0) and **loses**, so you get a white/light-gray body no matter
  what you write (this is the "white chrome" you were told to avoid).

What actually works (current implementation in `App.tsx` / `App.css`):

- Pass `className=""` to `<Mosaic>`. The root keeps the base `mosaic` /
  `mosaic-drop-target` classes (the component prepends them), but drops
  `mosaic-blueprint-theme`. All the **structural** rules (`.mosaic-root` abs
  positioning, `.mosaic-tile`, `.mosaic-split` drag geometry, `.mosaic-window-*`
  flex layout, `.mosaic-window-body { background: white }`) are **unscoped**, so
  they still apply.
- Now the only light rule left is the unscoped `.mosaic-window-body { background:
  white }` at (0,2,0); a `.mosaic-dark .mosaic-window-body` override (also (0,2,0),
  loaded later because App.css is imported after the mosaic CSS) wins. Theme the
  rest (toolbar bg, title color, splitter line, drop-target) freely from there.

Alternative not taken: Blueprint also ships a dark variant gated on a `bp4-dark`
class (`.mosaic.mosaic-blueprint-theme.bp4-dark .mosaic-window-body { background:
#252a31 }`). Adding `className="mosaic-blueprint-theme bp4-dark"` gives a dark
theme "for free", but its palette (#252a31, bluish) doesn't match this app's
#1a1a1a/#161616/#232323, and its (0,5,0) rules then fight *your* fine-tuning. The
`className=""` route gives full palette control with no specificity war.

Also: the default `MosaicWindow` renders split/expand/remove toolbar controls.
We pass `toolbarControls={<></>}` and `display:none` the `.mosaic-window-controls`
so a user can't *remove* a panel (no way to bring it back); rearrange-by-drag and
splitter-resize still work. Layout persists to localStorage (`claude-motion:panelLayout`).
