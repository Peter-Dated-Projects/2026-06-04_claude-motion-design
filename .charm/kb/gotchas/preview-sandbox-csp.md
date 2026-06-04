---
id: preview-sandbox-csp
root: gotchas
type: gotcha
status: current
summary: "A sandbox=\"allow-scripts\" iframe (no allow-same-origin) runs on an opaque origin, so CSP script-src 'self' matches nothing and external <script src> is blocked — the preview runtime must be inlined ('unsafe-inline') or blob:, regardless of how it's served."
related:
  - architecture/preview-sandbox
created: 2026-06-04
updated: 2026-06-04
---

The original T-IMPL-007 plan specified the preview iframe as `sandbox="allow-scripts"` with CSP
`script-src 'self' blob:`, loading the runtime via `<script src="/preview-runtime/react...js">`.
**That combination is internally inconsistent and cannot work.**

A `sandbox` attribute that omits `allow-same-origin` forces the iframe document onto a unique
**opaque origin**. CSP `'self'` resolves to *the document's own origin* — which is opaque — so it
can never match a real URL. Every external `<script src=...>` is CSP-blocked, no matter whether
the file is served by the Tauri asset protocol, Vite, or anything else. Adding `allow-same-origin`
would fix the CSP but defeats the whole point of the sandbox (the iframe could then reach the
app origin).

Resolution used in T-026: deliver the runtime as **inline** `<script>` blocks (PreviewPanel
inlines react / react-dom / preview-runtime into the iframe via `srcDoc`), with CSP
`script-src 'unsafe-inline' blob:`. The compiled *user* animation is still injected via a
**blob: URL** `<script>` (not eval / new Function), so we never need `'unsafe-eval'`.
`connect-src 'none'` keeps the sandbox fully offline, so `'unsafe-inline'` is not a meaningful
weakening here — it only permits the scripts we author, and the opaque origin + no-network
isolation are intact.

Takeaway: if you want CSP `'self'` to mean anything inside an iframe, the iframe needs a real
origin (i.e. `allow-same-origin`). With a properly isolated sandbox, your only options for
running code are inline (`'unsafe-inline'` or per-script hashes) or `blob:`.
