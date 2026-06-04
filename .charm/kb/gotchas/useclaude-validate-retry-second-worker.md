---
id: useclaude-validate-retry-second-worker
root: gotchas
type: gotcha
status: current
summary: "useClaude runs its OWN second esbuild-wasm worker to validate generated code before preview, and the syntax-error retry loop re-invokes Claude (--resume) up to twice WITHOUT showing the failed attempts as chat bubbles."
created: 2026-06-04
updated: 2026-06-04
---

The `claude://done` handler in `src/hooks/useClaude.ts` does NOT hand generated
code straight to the editor/preview. It first gates the code through a validate
+ retry loop (PLAN.md T-IMPL-013 / T-IMPL-010):

1. `extractCode(full_text)` — no `<code>` block means a plain conversational
   reply; finalize the bubble and stop.
2. `validateCode(code)` — transform-compile to catch syntax/transform errors.
3. Valid -> finalize the assistant bubble, `onCodeGenerated(code)`, reset retry.
4. Invalid and `retryCount < 2` -> re-invoke `invoke_claude` (same `--resume`
   session) with an `<error>...</error>` fix prompt; `isGenerating` stays true.
5. Retries exhausted -> accept the last attempt anyway (so the preview's red
   banner shows the real error) and set `error`.

Two things that will surprise you:

- **There are TWO esbuild-wasm instances.** `validateCode` spins up its OWN
  module-level `sandbox-compiler.worker.ts` worker, separate from the one
  `PreviewPanel` owns. It is created lazily on the first generation (not at app
  start) and fails OPEN — if the validator worker crashes, code is treated as
  valid rather than trapping the user. Don't "dedupe" these workers without
  lifting the preview's worker up to a shared owner; they are intentionally
  independent today. See [preview-sandbox-csp] and the preview compile path.

- **Intermediate failed attempts are invisible in the chat.** Only the terminal
  turn (valid, no-code, or retries-exhausted) is pushed to `messages` /
  persisted. The fix-prompt round-trips are NOT added as user/assistant bubbles
  — the live streaming bubble just resets each retry. The Claude session itself
  (via `--resume`) still contains the full exchange server-side, so the
  persisted conversation and the resumed session can differ (consistent with the
  existing session-id persistence gap in [claude-bridge-event-payloads-snake-case]).
