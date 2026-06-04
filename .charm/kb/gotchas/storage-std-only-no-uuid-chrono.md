---
id: storage-std-only-no-uuid-chrono
root: gotchas
type: gotcha
status: current
summary: "Local project storage hand-rolls UUIDv4 and RFC3339 from std because the ticket scope excluded Cargo.toml -- don't 'fix' them by reaching for the uuid/chrono crates without adding the deps first."
created: 2026-06-04
updated: 2026-06-04
---

`src-tauri/src/commands/projects.rs` generates project ids and timestamps with
small std-only helpers (`new_id`, `rfc3339`/`now_rfc3339`) instead of the `uuid`
and `chrono` crates. This is intentional: the storage ticket's `touches` scope
did not include `Cargo.toml`, so adding dependencies was out of scope. The
helpers are self-contained:

- `new_id()` produces a UUIDv4-shaped string from the nanosecond clock plus a
  monotonic `AtomicU64` counter, with version/variant bits set per RFC 4122. It
  is collision-safe for a single-user local store but is NOT cryptographically
  random -- do not use it where unpredictability matters.
- `rfc3339()` formats UNIX epoch seconds as UTC via Hinnant's civil_from_days
  algorithm. Timestamps are always `...Z` (UTC) and sort lexicographically by
  recency, which `list_projects` relies on for its newest-first ordering.

If a future ticket legitimately needs richer time/uuid handling, add `uuid` and
`chrono` to `Cargo.toml` (in a ticket whose scope includes it) and swap these
helpers out -- don't half-migrate.
