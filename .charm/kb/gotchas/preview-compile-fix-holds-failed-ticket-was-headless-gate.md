---
id: preview-compile-fix-holds-failed-ticket-was-headless-gate
root: gotchas
type: gotcha
status: current
summary: "The 'failed' preview-hang ticket (esbuild-wasm init) was a headless-tester limitation, not a code defect -- the fix in commit b9e5226 holds; re-verification confirmed build + wasm version-match + WebAssembly.compile all pass. Don't re-investigate it; the only open item is a live-webview visual confirm at the human gate."
created: 2026-06-04
updated: 2026-06-04
---

The preview-compile-hang ticket (former T-003 -> re-examined as T-013) shows as
`failed` on the board even though commit b9e5226 committed a working fix. That is
misleading: the tester marked it failed only because its headline acceptance
criterion -- "run the app and visually confirm the SAMPLE_CODE preview renders" --
needs a live Tauri webview, which a headless tester context cannot drive. The code
itself was never a defect.

Re-verification (T-013) confirmed the fix in `src/workers/sandbox-compiler.worker.ts`
holds, with no behavior change needed:

- `tsc && vite build` pass; the `sandbox-compiler.worker` chunk emits and references
  the hashed `esbuild-[hash].wasm` asset.
- `src-tauri/resources/esbuild.wasm` (~12 MB) passes `WebAssembly.compile(bytes)` --
  the exact step `initEsbuild()` runs after fetch -> arrayBuffer -- and the binary
  embeds the matching `0.25.12` version string, so `esbuild.initialize({ wasmModule })`
  will not reject on a version mismatch.
- The error-surfacing path in `PreviewPanel.tsx` is fully wired: a worker
  `{type:'error'}` reply (which the 10s init timeout guarantees will fire on any
  init failure) sets the error banner and clears `isLoading`, so there is no silent
  infinite spinner on the init path. See
  [[esbuild-wasm-init-fetch-and-timeout]] for the fix mechanics.

The only thing neither a headless worker nor a headless tester can perform is the
live-webview visual confirm; that belongs at the human gate (`bun run tauri dev`,
watch SAMPLE_CODE render; optionally force an init failure and confirm the red
banner appears within ~10s).

Process takeaway: a `failed` verdict on a preview/webview ticket may just mean the
headless tester could not run the visual gate -- read the ticket's activity log
before assuming the code is broken.

Residual (out of scope for the init fix, noted for completeness): if a compile
succeeds but the sandbox iframe never posts `sandboxReady`/`renderOk`, `isLoading`
would stay true -- a different infinite-spinner path living in the iframe runtime,
not the esbuild init covered here.
