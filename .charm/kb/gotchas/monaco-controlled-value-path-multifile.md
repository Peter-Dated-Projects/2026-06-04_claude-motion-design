---
id: monaco-controlled-value-path-multifile
root: gotchas
type: gotcha
status: current
summary: "The CodePanel Monaco editor is multi-file via @monaco-editor/react's `path` prop (one model per file, retains content/undo/scroll) plus a controlled `value`; the library's value-sync effect skips the first render and is keyed only on value-prop change, so per-file content is not clobbered on tab switch -- but parent state MUST hold each open file's latest content or a stale value will executeEdits over the live model."
created: 2026-06-04
updated: 2026-06-04
---

# Monaco multi-file editor: path-per-model + controlled value (T-041)

The Code panel (`src/components/CodePanel/`) is a VS Code-style editor: a
file-tree rail, editor tabs, and one Monaco instance. Multi-file works through
two `@monaco-editor/react` `<Editor>` props, and the interaction between them is
non-obvious enough to bite.

## How it works

- **`path` prop = one model per file.** When `path` changes,
  @monaco-editor/react saves the current model's view state, swaps to (or creates)
  the model for the new path, and restores that path's view state. So each open
  tab keeps its own content, undo history, and scroll position automatically --
  you do NOT manage models yourself. Switching tabs is just changing `path`.
- **`value` prop = controlled content.** A new model is created with `value` as
  its initial text. Verified in the library source (`dist/index.mjs`): the
  value-sync effect (a) is wrapped in a custom hook that **skips the first
  render**, and (b) has dependency `[value]` only -- it fires when the `value`
  prop changes, NOT on every keystroke. When it fires it uses cursor-preserving
  `executeEdits` (not `setValue`), and only if `value !== editor.getValue()`.

## The trap

Because the value-sync effect runs on any `value`-prop change and overwrites the
live model, **the parent must keep each open file's `value` equal to that file's
latest edited content.** In this app:

- The entry file `animation.tsx` uses `code` (App.tsx), mirrored from disk by the
  `animation://changed` watcher.
- Every other open file's content is cached in `App.tsx`'s `fileContents` record
  and updated synchronously inside the change handler, *before* the disk write.

If you ever let `value` go stale relative to the model (e.g. drive it from a
debounced/lagging source while the user is mid-edit), a later unrelated re-render
that changes `value` back to the stale text will `executeEdits` it over the live
model and silently lose edits. Keep the parent the source of truth and update it
on the same tick as the change event.

## Other constraints carried in this design

- `src/hooks/useMonaco.ts` is the change-OUT path (debounced `onCodeChange`,
  selection, line count) and was deliberately left untouched (out of T-041's
  `touches`). The change flow is still useMonaco's `onDidChangeModelContent`
  listener, not the `<Editor onChange>` prop -- don't add a second emitter.
- The offline loader wiring (`loader.config({ monaco })` + `?worker`
  `MonacoEnvironment`) must stay -- see [[monaco-cdn-offline-loader]].
- Scope honesty: the editor is multi-file but the sandbox compiler still bundles
  ONLY `animation.tsx` (esbuild transform mode). Editing any other file saves to
  disk via the `write_file` command but does NOT affect the preview yet -- the
  CodePanel shows an "only animation.tsx drives the preview" hint and an `entry`
  badge. The multi-file compiler is a separate future change (see the
  multi-file-architecture research note).
