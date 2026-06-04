---
id: esbuild-wasm-init-fetch-and-timeout
root: gotchas
type: gotcha
status: current
summary: "The sandbox compiler must fetch esbuild.wasm bytes itself + WebAssembly.compile (not pass wasmURL) and cap init with a timeout, or a hung/wrong-MIME asset load strands the preview on 'Compiling preview...' forever with no error."
created: 2026-06-04
updated: 2026-06-04
---

`src/workers/sandbox-compiler.worker.ts` initializes esbuild-wasm once on the
first compile. Two non-obvious traps make this strand the preview forever:

1. **Implicit `wasmURL` uses streaming compile, which is MIME-strict.** Passing
   `esbuild.initialize({ wasmURL })` lets esbuild fetch the wasm internally with
   `WebAssembly.compileStreaming`, which requires the response to carry
   `Content-Type: application/wasm`. Tauri's asset protocol does not reliably set
   that, so the streaming compile can reject/stall. Fix: `fetch(wasmURL)` ->
   `arrayBuffer()` -> `WebAssembly.compile(bytes)` -> `initialize({ wasmModule })`.
   Non-streaming compile ignores MIME entirely.

2. **No timeout = infinite spinner.** `PreviewPanel`'s `isLoading` only clears on
   a `renderOk`/`renderError` from the sandbox or an `{type:'error'}` worker reply.
   If init never settles (hung asset fetch under the Tauri protocol), none of
   those fire and the user is stuck on "Compiling preview..." with no error. Wrap
   init in a timeout (currently 10s) that rejects; the `onmessage` catch turns the
   rejection into an `{type:'error'}` reply so the red banner shows the reason.

Also clear the cached `initPromise` on failure so a later compile retries instead
of re-awaiting a permanently-rejected init.

This same worker file doubles as the validation worker in `src/hooks/useClaude.ts`
(see [[useclaude-validate-retry-second-worker]]), so a clean error reply on init
failure matters there too -- a hang would freeze the post-generation validation
gate, not just the preview.
