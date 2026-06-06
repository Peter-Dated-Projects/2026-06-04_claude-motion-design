---
id: ig-extraction-md-frontmatter
root: conventions
type: convention
status: current
summary: "ig-pipeline extraction.md YAML frontmatter quotes every string scalar via JSON.stringify (a valid YAML double-quoted subset) and emits absent numbers as the bare keyword null, never hand-rolled escaping."
created: 2026-06-06
updated: 2026-06-06
---

`store.ts` writes the durable `extraction.md` with a YAML frontmatter block that a
later UI/Tauri reload phase will parse, so the frontmatter must always parse.

Two idioms keep it robust, both in `renderExtractionMd`:

- **String scalars are quoted with `JSON.stringify`, not hand-rolled.** JSON's
  string escaping is a valid subset of YAML's double-quoted scalar syntax, so
  `JSON.stringify(value)` yields a frontmatter-safe scalar for free. This matters
  most for the source URL, which routinely carries `:`, `&`, `#`, and `"` -- all
  YAML-significant. Verified parsing a URL like
  `https://e.com/r/?a="b": c & #d` round-trips. Don't reach for a YAML lib or
  bespoke escaping here.
- **Absent numbers become the bare keyword `null`, never the string `"undefined"`.**
  `AnalyzeResult.costUsd/durationMs/numTurns` can be non-finite if analyze
  couldn't parse the CLI envelope; `yamlNumber` emits `null` for anything not
  `Number.isFinite`, so the key stays present and typed-null rather than a broken
  `undefined` token.

Testing note: this Bun runtime island ships no YAML parser, and neither
system `python3` (no PyYAML) nor Bun/Node have one either. To validate frontmatter
parses, use Ruby (`ruby -ryaml`), which is present on macOS by default.
