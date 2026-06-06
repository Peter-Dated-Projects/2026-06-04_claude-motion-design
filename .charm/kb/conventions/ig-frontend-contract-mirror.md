---
id: ig-frontend-contract-mirror
root: conventions
type: convention
status: current
summary: "src/types/ig.ts hand-mirrors the Bun scripts/ig-pipeline/types.ts contract in camelCase; the Rust IG backend must serde-serialize camelCase or the JSON won't deserialize as-is on the frontend."
created: 2026-06-06
updated: 2026-06-06
---

The frontend's view of the IG-pipeline contract lives in `src/types/ig.ts`. It is a
HAND-MAINTAINED MIRROR (re-declared, not imported) of `scripts/ig-pipeline/types.ts`,
because that Bun project sits outside the app's tsconfig. Field names and shapes are
copied verbatim so the JSON crosses the Rust/JS boundary with no remap layer.

Load-bearing details to preserve when touching either side:

- The Bun contract is camelCase. The Rust IG backend (T-025,
  `src-tauri/src/commands/ig_pipeline.rs`) MUST serialize its event payloads
  camelCase (`#[serde(rename_all = "camelCase")]`) for `ScoredFrame` / `StageProgress`
  / `DownloadResult` / `ClipResult` / `Brief` to deserialize on the frontend as-is.
  If a payload lands snake_case, fix it on the Rust side — do not widen the TS types.
- `RejectReason` is the literal union `"low_sharpness" | "insufficient_change"`. Keep
  it a union (the reject-overlay tooltip switches on the exact values); never collapse
  to `string`.
- `ScoredFrame.delta` is `number | null` (null on the first frame — no predecessor).
  Don't coerce null to 0.

The igStore (`src/store/igStore.ts`) consuming these is deliberately Tauri-free: every
action is a pure reducer, and the `invoke`/`listen` wiring is deferred to the
integration ticket (T-031). The store keeps the scorer's `kept` separate from the
user's `overrideKept` so a toggled frame retains its original `rejectReason`.

Related: [[ig-stage-subprocess-cli-contract]] (the stdout JSON the Rust backend parses).
