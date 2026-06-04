---
id: remotion-mcp
root: decisions
type: decision
status: current
summary: "Remotion's official MCP is doc-search-only; tool-invoking MCP (render, scaffold) is community-only and the team closed the feature request as not planned."
created: 2026-06-04
updated: 2026-06-04
---

# Remotion MCP: What Exists and What It Means

## TL;DR

Remotion ships an official `@remotion/mcp` package, but it is a **documentation context provider**, not a tool-invoking MCP server. It does not scaffold components, trigger renders, or introspect compositions. The GitHub issue asking for those capabilities was closed as "not planned." Several community MCP servers do expose tool-calling, but they are lightly maintained proof-of-concepts. The more impactful AI integration Remotion officially supports is their **Agent Skills** system.

---

## Official: @remotion/mcp

**Package:** `@remotion/mcp` on npm  
**What it does:** Indexes Remotion's documentation into a vector database (via CrawlChat) and exposes semantic search over that index to AI editors via MCP.  
**What it does NOT do:** It exposes no tools for project scaffolding, render triggering, composition introspection, or CLI operations.

**Installation (Cursor / VS Code):**
```json
{
  "mcpServers": {
    "remotion-documentation": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"]
    }
  }
}
```

**Status:** Test phase, no authentication required. Usage restrictions may be added if costs grow.

**Team position on tool-calling MCP:** GitHub issue #5153 ("Improve MCP functionality") proposed adding render-triggering and composition-introspection tools. The Remotion team closed it as **not planned**.

---

## Official: Agent Skills (more impactful than MCP)

Remotion's primary AI integration strategy is their **Agent Skills** system, released January 2026.

- Skills are a curated collection of domain-specific rules, patterns, and best practices for AI coding agents working on Remotion projects.
- Installed with: `npx skills add remotion-dev/skills`
- Also offered during `bun create video` project init.
- Works with Claude Code, Codex, Cursor, and other agents.
- Hosted on agentskills.io and maintained in the remotion-dev/remotion GitHub repo.
- **License:** Free for individuals, non-profits, and companies with <=3 employees. Commercial license required for 4+ employee companies.

Skills change the quality of raw TSX generation meaningfully — they encode Remotion-specific idioms (spring animations, useCurrentFrame patterns, interpolate usage, composition structure) that LLMs don't reliably get right from training data alone.

Remotion also exposes documentation as machine-readable markdown (append `.md` to any doc URL, or use `Accept: text/markdown`), which agents can fetch inline.

---

## Community MCP Servers

A small ecosystem of community tool-invoking MCP servers exists. Quality varies widely.

| Server | Tools exposed | Maturity |
|---|---|---|
| `dev-arctik/remotion-video-mcp` | 18 tools: init_project, create_scene, update_scene, render_video, start_preview, capture_frame, audio sync, asset import | 3 commits, 0 stars — proof-of-concept |
| `stephengpope/remotion-media-mcp` | AI media generation (images, video, music, SFX, speech, subtitles) for Remotion | Community, unclear maintenance |
| `mcp-use/remotion-mcp-app` | MCP App with live Remotion Player widget in chat; model writes TSX, server compiles, player renders in-chat | Interesting prototype |
| `IBM/chuk-remotion` (chrishayuk) | Design-system-first approach, design tokens, YouTube-optimized presets | IBM-adjacent but unclear status |
| `smilish67/rodumani` | Remotion editor MCP server | Minimal info |

**Notable:** `josephtandle-remotion` appears on PulseMCP — no detail retrieved.

---

## How This Changes the Prompt Engineering Approach (vs RES-09 raw TSX generation)

### @remotion/mcp (doc search)

Adds documentation grounding to the AI's context at query time. This is additive — Claude can answer "what is the right way to use interpolateColors?" by fetching live docs rather than relying on training data. It does **not** change the generation approach fundamentally; the output is still raw TSX.

### Agent Skills

This is the highest-leverage official integration. Adding `remotion-dev/skills` to a Claude Code session means Claude has Remotion-specific idioms injected as agent rules. This improves TSX quality without changing the architecture: output is still React/TSX, but following established patterns for the framework.

**Recommended for the motion design app:** Include Remotion Skills in the system prompt or via the skills mechanism when Claude is generating animation components.

### Community tool-invoking MCP servers

If a mature tool-invoking MCP server existed (official or community), it would change the architecture meaningfully: instead of Claude generating complete TSX files, it could call `create_scene`, `update_scene`, `render_video` etc. as atomic operations with error feedback. This is a better model for iterative editing.

However, none of the community servers are production-ready. Building a thin custom MCP layer over Remotion's CLI (`npx remotion render`, `npx remotion studio`) is low-effort and would be more reliable than adopting a 3-commit community server.

### Recommendation

For the motion design app:
1. **Include Remotion Skills** in Claude's context for generation quality.
2. **Use @remotion/mcp** optionally for documentation grounding.
3. **Do not rely on community MCP servers** — build a minimal custom tool wrapper (render trigger, project scaffold) if tool-calling is needed.
4. The core generation loop from RES-09 (Claude generates TSX -> Remotion renders) remains the right architecture. MCP adds quality and ergonomics but doesn't invalidate the approach.

---

## Sources

- https://www.remotion.dev/docs/ai/mcp
- https://www.remotion.dev/docs/ai/skills
- https://www.remotion.dev/docs/ai/
- https://www.npmjs.com/package/@remotion/mcp
- https://github.com/remotion-dev/remotion/issues/5153
- https://github.com/dev-arctik/remotion-video-mcp
- https://github.com/stephengpope/remotion-media-mcp
- https://github.com/mcp-use/remotion-mcp-app
- https://www.pulsemcp.com/servers/josephtandle-remotion
