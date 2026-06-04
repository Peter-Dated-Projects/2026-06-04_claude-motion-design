---
id: app-owns-loop-state
root: conventions
type: convention
status: current
summary: "App.tsx is the integration root: it owns the animation `code` state and the single useClaude instance; ChatPanel/CodePanel/PreviewPanel are controlled via props; edits and generations auto-save via save_animation."
created: 2026-06-04
updated: 2026-06-04
---

The full chat -> code -> preview loop is wired in `src/App.tsx`, not inside the
panels. As of T-032:

- **`code` state lives in App.** It is loaded from the active project's
  `animation.tsx` (`invoke("load_animation")`) on project switch and passed down
  to both `CodePanel` (`code` prop) and `PreviewPanel` (`code` prop, added in
  T-032 -- it used to hardcode `SAMPLE_CODE`). PreviewPanel still falls back to
  `SAMPLE_CODE` when `code` is empty so the preview is never blank.
- **`useClaude` is instantiated in App, not ChatPanel.** ChatPanel was refactored
  from self-driving to a controlled, presentational component
  (`messages/streamingText/isGenerating/isWaiting/onSend/onCancel/disabled`
  props). This concentrates the loop (generated code, auto-save, error toasts,
  cancel) in one place. `onCodeGenerated` -> `setCode` + `save_animation`.
- **Auto-save is implicit.** Both Monaco edits (`onCodeChange`, already debounced
  500ms) and Claude generations write `save_animation` immediately. Cmd+S is a
  manual save on top, with a success toast.
- **Keyboard shortcuts are split by owner, deliberately:** Cmd/Ctrl+Enter send is
  in `ChatPanel` (it owns the textarea); Space play/pause is in `ReplayControls`
  (scoped to the preview container, see [[replay-controls-self-wired]]); Cmd/Ctrl+S
  save and Escape cancel are global listeners in App. Don't duplicate these across
  layers.
- **No feedback loop** between setCode and Monaco: `MonacoEditor` guards
  `editor.getValue() === code` before re-applying, so a generated-code `setValue`
  does not bounce back through `onCodeChange` and move the cursor.

Cross-panel data still follows [[panel-state-via-parent-props]]; this note is the
concrete shape that took at the integration root.
