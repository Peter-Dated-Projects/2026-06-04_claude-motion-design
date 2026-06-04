---
id: claude-cli-stream-json-flags
root: gotchas
type: gotcha
status: superseded
related: 0001-embedded-interactive-claude-pty
summary: "SUPERSEDED (print-mode removed). `claude -p --output-format stream-json` requires `--verbose`, and incremental text_delta tokens only appear with `--include-partial-messages`."
created: 2026-06-04
updated: 2026-06-04
---

> **Superseded by [[0001-embedded-interactive-claude-pty]].** The headless
> `claude -p` NDJSON bridge this note describes has been removed in favor of an
> embedded interactive PTY session. Kept for historical context; the flags below
> no longer apply to this codebase.


The Claude CLI bridge (T-022) streams the `claude` CLI's NDJSON output. The arg list
in the ticket/PLAN was `claude -p --mcp-config ... --append-system-prompt-file ...
--output-format stream-json [--resume ...] "{prompt}"`. That list is incomplete — two
extra flags are required or the feature silently does the wrong thing:

1. **`--verbose`** — `--output-format stream-json` in print mode (`-p`) is rejected
   without it. The CLI errors out at launch.

2. **`--include-partial-messages`** — without it you do NOT get incremental
   `stream_event` lines carrying `text_delta`. You only get whole assistant-message
   events, so the per-token streaming the UI expects (`claude://token`) never fires;
   text would arrive in one lump at the end. The ticket explicitly parses
   `stream_event + text_delta`, so this flag is load-bearing.

Both are added in `claude_bridge.rs::send`.

NDJSON shapes the bridge parses:
- `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}` -> `claude://token`
- `{"type":"result","subtype":"success","result":"...","total_cost_usd":N,"session_id":"..."}` -> `claude://done` (cost field is `total_cost_usd`, not `cost_usd`)
- `{"type":"result", is_error:true}` or `{"type":"error",...}` -> `claude://error`

Also note: the bridge spawns `claude` with `std::process::Command` directly, NOT the
Tauri shell plugin. `shell:default` cannot execute arbitrary binaries, so the shell
route would need a scoped `shell:allow-execute` capability. Driving the subprocess
from Rust sidesteps the capability model (see [[tauri-plugin-three-place-wiring]]).
