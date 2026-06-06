---
id: claude-cli-no-image-flag
root: gotchas
type: gotcha
status: current
summary: "The `claude` CLI has NO `--image` flag (verified 2.1.167); to analyze local images in print mode you list their absolute paths in the prompt text and pass `--allowedTools \"Read\"` so the agent reads them with its multimodal Read tool. Brief is in the JSON envelope's `.result`. Budget ~40-60s, ~$0.21, ~12 turns for 11 frames with claude-sonnet-4-6."
created: 2026-06-06
updated: 2026-06-06
---

The Instagram-pipeline proposal assumed `claude -p "<prompt>" --image frame.jpg ...`.
That flag does not exist. `--file file_id:relative_path` is for downloading remote
file resources at startup, not attaching local images.

Verified working mechanism (spike, 2026-06-06, CLI 2.1.167):

```bash
echo "<prompt that lists the absolute frame paths, in order>" | \
  claude -p --model claude-sonnet-4-6 --allowedTools "Read" --output-format json
```

The agent issues one Read tool call per referenced path (Read is multimodal and
handles JPEG/PNG), then returns the answer as the `.result` string field of the
JSON envelope (parse it again if you asked for JSON). Run as a non-interactive
subprocess, frames never touch any interactive PTY context.

Cost/latency from the spike (11 kept frames, claude-sonnet-4-6): ~41s wall,
~$0.21, ~12 turns (one Read per frame, so latency scales ~linearly with frame
count). A `--input-format stream-json` variant sending inline image content blocks
in a single user message would collapse the per-frame Read round-trips into one
turn — likely faster/cheaper, unverified, flagged as a follow-up optimization.
