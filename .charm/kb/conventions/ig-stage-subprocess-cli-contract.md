---
id: ig-stage-subprocess-cli-contract
root: conventions
type: convention
status: current
summary: "ig-pipeline stage CLIs the Rust backend spawns emit exactly one machine-parseable JSON line on stdout, send all human/diagnostic text to stderr, and gate any standalone smoke/fixture run behind no-args or --smoke so it never runs (or pollutes stdout) when real argv flags are present."
created: 2026-06-06
updated: 2026-06-06
---

The Rust IG backend spawns each `scripts/ig-pipeline/*.ts` stage as a subprocess
and parses its stdout, so the stage CLIs follow one contract:

- **stdout is the machine channel.** When a stage is invoked in its
  subprocess-driven mode it prints exactly ONE line to stdout: a single
  `JSON.stringify(...)` of the stage's result. Nothing else goes to stdout in
  that mode.
  - `score.ts --json` -> one line of the full `ScoreResult` (`{ scored, kept }`).
  - `store.ts --results <file|-> --out <root> --id <id> [--date YYYY-MM-DD]`
    -> one line `{ dir, briefJson, extractionMd }` (all absolute).
- **stderr is the human channel.** Confirmations ("wrote extraction to ...") and
  non-fatal diagnostics (score's "too few survivors" warning via `onWarn`) go to
  `console.error`, never stdout. A malformed/empty input exits non-zero with a
  stderr message and prints nothing to stdout (don't emit a partial line first).
- **Smoke/fixture entries are gated.** A stage's standalone smoke harness runs
  only on no-args or an explicit `--smoke` flag; it must not execute, or print to
  stdout, when real argv flags are present (`store.ts`'s `import.meta.main`
  dispatches on this).
- **Position-independent boolean flags are stripped before positional parsing.**
  `score.ts` removes every `--json` token before `resolveFrameArgs`, so a stray
  flag is never `resolve()`d into a bogus frame path.
- **Expose a `--date` pin** for anything whose output embeds the wall clock
  (store's folder name via `resolveExtractionPaths`) so the caller/tests can make
  it deterministic. Parse `YYYY-MM-DD` as a LOCAL `Date` (`new Date(y, m-1, d)`)
  to match `lib/paths.ts` `dateStamp`'s local `getFullYear/Month/Date` getters.

This is the explicit additive-only exception to PROJECT.md's "no Bun-side
rewrite" non-goal: add a CLI surface, never change stage math/thresholds/layout
or any exported function's behavior. See the related reject-reason trap in
[score-reject-reason-vs-below-top-n](../gotchas/score-reject-reason-vs-below-top-n.md)
-- `JSON.stringify` omits an undefined `rejectReason`, so a below-top-N survivor
correctly serializes as `kept:false` with no `rejectReason` key.
