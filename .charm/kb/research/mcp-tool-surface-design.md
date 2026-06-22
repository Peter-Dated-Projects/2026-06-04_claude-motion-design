---
id: mcp-tool-surface-design
root: research
type: architecture
status: current
summary: "Weftly's experience: don't map HTTP APIs 1:1 to MCP tools -- agents 'roomba' across many fine-grained tools and get confused; collapse to fewer, higher-altitude tools that internalize choreography, and split identify (pure reasoning) from execute (file mutation)."
related:
  - research/claude-skills-podcast-clipper
created: 2026-06-07
updated: 2026-06-07
---

# MCP Tool Surface Design: Lessons from Weftly

Source: Reddit r/ClaudeAI post by Weak-Purple-6054 (Weftly video editing skills)

Weftly built five Claude Code skills for transcript-driven video editing (filler removal, intro clip identification, blog post generation) plus a paid cloud tier gated by MPP/402.

## The critical insight: tool surface collapse

They started with 12 MCP tools mapping 1:1 to their HTTP API endpoints. Claude would "roomba" — run the 7-step upload flow manually and confusingly, often getting lost mid-choreography.

They collapsed to 5 tools, invested time in the tool definitions, and the problem mostly disappeared.

**Rule:** agents are not good at sequencing many fine-grained tools. Tools should be at the right altitude — one tool that handles internal choreography, not seven tools the agent must sequence correctly. Never do a 1:1 mapping between HTTP API endpoints and MCP tools.

## Identify / execute split

They separated:
- **Identification** (`identify-intro-clip`) — pure transcript reasoning, free, reversible, cheap
- **Execution** (`extract-clip`) — actual file manipulation, side-effectful, expensive

Benefits:
- Iterate on identification without touching files
- Natural human confirmation gate between "what to do" and "do it"
- Cheaper to run during exploration

## Local file / remote API bridge

Problem: transcription API takes a URL; editing workflows start from local files.

Solution: `transcribe_local` — a single MCP tool that wraps the full HTTP upload choreography internally. The agent sees one call instead of seven.

This is the same principle as tool surface collapse applied to the local↔remote boundary.

## .words.json as interchange format

Their transcript format is a per-word timestamp file with a public JSON schema. Skills work against any `.words.json` regardless of which transcription service produced it. Interop by design — the skill isn't locked to their API.

## MPP + 402 authentication (experimental)

They use Machine Payments Protocol: the payment IS the credential. No API key, no checkout redirect. The agent signs and pays inline via a local USDC wallet proxy.

Flow:
1. Tool call (no credential)
2. `payment_required` response with challenge + amount
3. `mppx:sign` (local stdio proxy, wallet)
4. Tool call retry with payment credential
5. Job starts

Still brittle (Claude gets confused in the loop occasionally), but the pattern is interesting for agent-native capability gating. Not relevant to this project's current architecture.

## Relevance to this project

The tool surface collapse and identify/execute split are directly applicable if we expose MCP tools for the design flow (e.g., a "find best animation moment" step before actually rendering). Keep tool count low, definitions precise, and separate reasoning steps from mutation steps.
