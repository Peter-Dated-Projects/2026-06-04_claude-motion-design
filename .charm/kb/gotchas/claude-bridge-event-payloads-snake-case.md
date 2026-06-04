---
id: claude-bridge-event-payloads-snake-case
root: gotchas
type: gotcha
status: current
summary: "Claude bridge event payloads (claude://done etc.) are snake_case (full_text/session_id/cost_usd) — those Rust structs lack #[serde(rename_all)], unlike Project/Message which are camelCase; and no command persists session_id alone."
created: 2026-06-04
updated: 2026-06-04
---

Two related traps when consuming the Claude CLI bridge from the frontend.

## 1. Event payload fields are snake_case, not camelCase

The bridge emits `claude://token`, `claude://done`, `claude://error`. Their payload
structs in `src-tauri/src/claude_bridge.rs` (`TokenPayload`, `DonePayload`,
`ErrorPayload`) have **no `#[serde(rename_all = "camelCase")]`**, so they serialize
with their raw Rust field names:

- `claude://done` -> `{ full_text, cost_usd, session_id }`  (NOT `fullText`/`sessionId`)
- `claude://token` -> `{ text }`
- `claude://error` -> `{ message }`

This is the opposite of the storage types: `Project` and `Message`
(`src-tauri/src/commands/projects.rs`) DO carry `rename_all = "camelCase"`, so on
that side you read `sessionId`, `createdAt`, etc. Mixing the two casings silently
yields `undefined` (no type error, since `event.payload` is generic) — the chat
just never finalizes or never extracts code. The frontend listener interfaces in
`src/hooks/useClaude.ts` are written to match the snake_case wire shape.

## 2. There is no command to persist session_id on its own

`invoke_claude` accepts a `sessionId` for `--resume` continuity and `claude://done`
returns the new `session_id`, but the only persistence commands are
`save_conversation` (messages) and `save_animation` (code). `Project.session_id`
is written to project.json only at `create_project` (as `None`) — nothing updates
it afterward. So `useClaude` keeps the session id in a ref for in-session
continuity, but it is lost on app restart. Closing this requires a new backend
command (e.g. `set_session_id`) — deferred to integration (T-032), outside the
T-024 frontend scope.
