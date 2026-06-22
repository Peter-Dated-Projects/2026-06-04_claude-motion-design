---
id: claude-skills-podcast-clipper
root: research
type: architecture
status: current
summary: "Didier Lopes' get-y2b-clips skill (YouTube → transcript + metadata + MP4 clips) demonstrates that pre-building Python tools beats on-the-fly script generation for Claude Code skills: consistent, fast, predictable execution."
related:
  - research/mcp-tool-surface-design
created: 2026-06-07
updated: 2026-06-07
---

# Claude Skill: Podcast → Shareable Clips (get-y2b-clips)

Source: https://didierlopes.com/blog/i-built-a-claude-skill-that-turns-podcasts-into-shareable-clips/

## What it does

Takes a YouTube URL and produces per-clip outputs in one shot:
- `metadata.json` — titles, timestamps, selection rationale
- `transcript.txt` — formatted for social sharing
- `clip.mp4` — subtitled video, ready to distribute

Optional inputs: clip count, duration constraints, topic focus.

## Key architectural finding: pre-build tools, don't generate scripts

The author went through three phases:

1. **Make it work** — wire up I/O, let Claude do the heavy lifting
2. **Make it good** — iterate on output quality (transcript formatting, subtitle burn-in, richer metadata)
3. **Make it fast** — pre-build Python tools so Claude calls them instead of writing throwaway scripts each run

Phase 3 is the critical insight. When Claude generates scripts inline, every run is slower and less consistent. Pre-built tools give the skill a stable, fast execution surface.

## Skills as a middle layer

Positioned as between a rigid CLI and a full sub-agent:
- More composable than a CLI (Claude reasons about what to call and when)
- Less overhead than a sub-agent (no separate spawned agent, no coordination protocol)
- Agent "traverses the tooling universe" rather than executing predetermined commands

## Relevance to this project

The pre-built tools pattern applies to any Claude Code skill we write for remotion-skills.txt or the design flow: define atomic Python/TS tools the skill can call rather than having Claude write and run ad-hoc scripts. Faster, more reliable, easier to debug.
