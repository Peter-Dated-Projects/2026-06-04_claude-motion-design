---
id: frontend-options-and-local-claude
root: architecture
type: architecture
status: current
summary: "Ranked evaluation of all six frontend delivery options for the motion design app, with concrete wiring for the recommended approach: how Claude CLI, Remotion Skills, @remotion/mcp, and the live preview connect."
created: 2026-06-04
updated: 2026-06-04
---

# Frontend Delivery Options + Local Claude Code Architecture

## TL;DR

For v0/v1, stay with the pure browser app (Elysia backend + direct Claude API + user-provided API key). It is the lowest-friction path and covers everything needed for the core loop. A VS Code extension or Tauri desktop app is the right next step if "no API key required" becomes a hard requirement — both can spawn Claude Code CLI with the user's own session, load Skills, and wire @remotion/mcp cleanly. The Claude Desktop Extension route is a useful distribution add-on but cannot deliver the custom 3-panel UI this product needs.

---

## 1. Ranked Options

### Tier 1: Ship now

**Option 1 — Pure browser app (current baseline)**

- Auth: user provides Anthropic API key in settings (stored encrypted in DynamoDB or browser localStorage; never proxied through our server unencrypted). No OAuth path exists — see [[anthropic-oauth-2026]].
- Skills: inject Remotion best-practices as `--append-system-prompt` text on each API call, or embed the SKILL.md content in the system prompt. No CLAUDE.md or user installation required.
- @remotion/mcp: not used directly. Elysia backend can run `npx @remotion/mcp@latest` as a sidecar to do doc lookups during code generation, but this is optional — the Remotion Skills content in the system prompt covers the same ground for a single-file edit workflow.
- Preview: esbuild-WASM in a browser worker + sandboxed iframe + Remotion Player. See [[code-execution-sandbox]].
- 3-panel UI: standard React layout — chat left, code center, preview right — no constraints from the delivery model.
- Distribution: deploy to any CDN/host; user visits URL.
- Tradeoff: user must generate an Anthropic API key and paste it in. Minor friction, but universal.

### Tier 2: Next if API key is a hard blocker

**Option 3 — VS Code extension**

- Auth: extension spawns `claude` CLI as a Node.js child process using the user's already-authenticated Claude Code session. No API key prompt needed.
- Skills: write `SKILL.md` files to the workspace `.claude/skills/remotion/` on first load; Claude Code picks them up automatically.
- @remotion/mcp: pass `--mcp-config ./remotion-mcp-config.json` when spawning the CLI subprocess.
- Preview: WebView panel renders an iframe with esbuild-WASM + Remotion Player. postMessage works normally across the extension/WebView boundary.
- 3-panel UI: implement as a WebView panel — full React app, no restrictions.
- Distribution: VS Code Marketplace; `ext install our-extension-id`.
- Tradeoff: narrows audience to VS Code users; adds a separate release pipeline. Good fit if target users are developers.

**Option 4 — Tauri desktop app**

- Auth: Rust backend spawns `claude` CLI with `std::process::Command`; uses user's Claude Code session.
- Skills: app ships `.claude/skills/remotion/SKILL.md` in its resources and copies it to the project directory on first use.
- @remotion/mcp: same `--mcp-config` flag passed at CLI spawn time.
- Preview: esbuild-WASM runs in the embedded WebView (Webkit on macOS, WebView2 on Windows). Same iframe sandbox approach as the web app.
- 3-panel UI: full React app bundled as a static asset inside the Tauri app.
- Distribution: signed installer download (macOS .dmg, Windows .exe). Tauri 2.x is production-ready; auto-update is built in.
- Bundle: ~3–10 MB (vs ~200 MB for Electron).
- Tradeoff: Rust backend requires new expertise; macOS code signing requires an Apple Developer account ($99/yr); release pipeline is heavier than a web deploy.

### Tier 3: Viable but complex

**Option 2 — Browser app + local WebSocket bridge (sidecar)**

- Auth: sidecar binary (`npx claude-motion-bridge`) spawns Claude CLI on the user's machine; no API key required; auth comes from the user's Claude Code session.
- Installation friction: user must run `npx claude-motion-bridge` once and keep it running. This is meaningfully worse than "visit a URL."
- Security model: CORS headers required on the sidecar (`Access-Control-Allow-Origin: https://ourapp.com`); Private Network Access (PNA) preflight required (Chrome sends `Access-Control-Request-Private-Network: true` before any cross-origin fetch to localhost; sidecar must respond `Access-Control-Allow-Private-Network: true`); bind to `127.0.0.1` only; generate a random pairing token at install time, user pastes it into the web app settings.
- Skills + MCP: sidecar starts Claude CLI with `--mcp-config` and `--append-system-prompt-file` flags.
- Preview: iframe + esbuild-WASM still in the browser as normal.
- Tradeoff: substantial complexity (CORS, PNA, token pairing, sidecar lifecycle management) for marginal benefit over a VS Code extension or Tauri app. Do not build this for v0.

**Option 5 — Electron desktop app**

- Functionally equivalent to Tauri; easier for Node.js-only teams.
- ~150–200 MB bundle is the primary objection. For a creative tool, download size matters more than for an internal utility.
- Choose Electron if the team has zero Rust exposure and needs to ship fast; choose Tauri for any new project.

### Tier 4: Supplementary channel only

**Option 6 — Claude Desktop Extension (MCP-based)**

See dedicated section below.

---

## 2. Concrete Wiring for the Top Option (Browser App)

```
User browser
  Next.js frontend (localhost:3000 or CDN)
    - Chat panel: React state + SSE consumer
    - Code panel: Monaco editor (read-only while Claude is editing)
    - Preview panel: sandboxed iframe
      - esbuild-WASM worker compiles user's TSX
      - Remotion Player renders inside iframe
      - postMessage for hot-reload signals

  <-- HTTP/SSE -->

Elysia backend (localhost:3001 or server)
  - POST /api/generate: accepts {prompt, currentCode, conversationHistory}
  - Calls Anthropic SDK with:
      model: claude-opus-4-8 (or sonnet-4-6)
      system: [Remotion best-practices from SKILL.md content]
      messages: [...conversationHistory, {role:"user", content: prompt + currentCode}]
  - Streams SSE response back to browser
  - Parses DONE event; extracts updated TSX; sends to browser
  - Browser updates Monaco editor + triggers esbuild recompile

Anthropic API
  - Direct SDK call from Elysia
  - ANTHROPIC_API_KEY: user's key, stored in DynamoDB per-user record (AES-256 encrypted at rest)
  - No OAuth; no subscription delegation
```

### How Remotion Skills inject into this flow

The Remotion Skills are SKILL.md files that teach Claude Remotion idioms and constraints. In the browser-app model (no local Claude Code), inject the Skills content as system prompt text:

```ts
// In Elysia handler
import { readFileSync } from 'fs'

const remotionSkillContent = readFileSync('./remotion-skill-context.txt', 'utf-8')

const response = await anthropic.messages.create({
  model: 'claude-opus-4-8',
  system: `You are a Remotion animation expert. Here are Remotion best practices:\n\n${remotionSkillContent}`,
  messages: conversationMessages,
  stream: true,
})
```

The `remotion-skill-context.txt` file is the content of `remotion-dev/skills` SKILL.md, checked into the repo. This gives Claude the Remotion rules without requiring the user to install anything.

---

## 3. CLI Invocation for Local Claude Session with Remotion Context

For the sidecar and desktop-app options, this is how to spawn Claude with full Remotion context:

### mcp-config.json

```json
{
  "mcpServers": {
    "remotion-docs": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"],
      "env": {}
    }
  }
}
```

`@remotion/mcp` is a documentation-retrieval MCP server that indexes Remotion's docs into a vector database via CrawlChat. It exposes search tools Claude uses automatically when it needs to look up Remotion APIs. It is not a code-execution or rendering tool — it is documentation context.

### CLI invocation (non-interactive / print mode)

```bash
claude -p \
  --mcp-config ./remotion-mcp-config.json \
  --append-system-prompt-file ./remotion-context.txt \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --tools "Read,Edit,Bash" \
  --permission-mode auto \
  --max-budget-usd 0.50 \
  "Edit src/Animation.tsx: add a fade-in entrance for the title text"
```

### stream-json output shape

Each line of stdout is a JSON object. The key types:

```
{"type":"system","subtype":"init",...}          // session metadata
{"type":"assistant","message":{...}}             // final assistant message
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}  // token delta (with --include-partial-messages)
{"type":"result","subtype":"success","cost_usd":0.012,...}  // final result
```

To extract text tokens in real time:
```bash
claude -p ... | jq -rj 'select(.type=="stream_event" and .event.delta.type?=="text_delta") | .event.delta.text'
```

### Session resumption

```bash
# Resume most recent session in this directory (simple)
claude -c -p "Continue refining the animation"

# Resume specific session by ID (reliable in automation)
claude -r "2026-06-04-animation-session" -p "Add a second scene"

# Fork a session (new ID, same history)
claude -r <session-id> --fork-session -p "Try a different approach"
```

Sessions are stored in `~/.claude/projects/<hash>/` as `.jsonl` files. In automation, always use `--resume` with an explicit session ID rather than `--continue` — `--continue` occasionally creates a new session in non-interactive mode.

### System prompt flags

All four work with `-p`:

| Flag | Use when |
|---|---|
| `--system-prompt "..."` | Replacing the entire prompt (non-coding agent, custom identity) |
| `--system-prompt-file path` | Same but from a file |
| `--append-system-prompt "..."` | Adding Remotion/domain context on top of default coding behavior |
| `--append-system-prompt-file path` | Same but from a file (preferred for large Skills content) |

For this use case, `--append-system-prompt-file` is correct: keep Claude's default coding-assistant identity and safety instructions, and append Remotion best practices on top.

### Skills installation path

`npx skills add remotion-dev/skills` uses the Agent Skills open standard (`agentskills.io`). The `skills` CLI (from `vercel-labs/skills`) installs to `~/.agents/skills/<skill-name>/SKILL.md` by default (Agent Protocol standard path). Claude Code reads from `~/.claude/skills/<skill-name>/SKILL.md` — there is currently a mismatch between these two paths.

**Practical options:**
1. **Project-level install** (most reliable): copy the Remotion SKILL.md to `.claude/skills/remotion/SKILL.md` in the project root. Claude Code auto-discovers project-level skills.
2. **Global symlink**: `ln -s ~/.agents/skills/remotion ~/.claude/skills/remotion` after running `npx skills add`.
3. **Programmatic injection**: use `--append-system-prompt-file` to inject the SKILL.md content at invocation time without any installation step. This is the cleanest approach for the browser-app and sidecar models where you control the CLI flags.
4. **No install required for browser-app**: since we are calling the Anthropic API directly (not running Claude Code), embed the SKILL.md content in the system prompt directly.

---

## 4. Skills License Assessment for Finks

Remotion's license is clear:

- **Free**: individuals, non-profits, and for-profit companies with **3 or fewer employees**.
- **Commercial license required**: for-profit companies with **4 or more employees**.

Finks has more than 3 employees. **A commercial Remotion license is required before shipping any product that includes `@remotion/*` packages** — including `@remotion/player`, `@remotion/core`, etc.

The Remotion Agent Skills SKILL.md file itself (the markdown instructions) is not covered by this license — it is reference content. The license requirement applies to the npm packages used at runtime in the product.

**Action required**: purchase a company license at `remotion.pro` before v1 launch. The Skills add-on has no separate cost beyond the base license. Contact `hi@remotion.dev` to confirm the license scope for your specific use case (SaaS vs on-premise, distribution model, etc.).

---

## 5. Claude Desktop Extension — Serious Contender or Dead End?

**Verdict: useful supplementary channel, dead end for the core product.**

### What Claude Desktop Extensions can do

A Desktop Extension (`.mcpb` file) bundles an MCP server into a single installable package. Users double-click to install — no terminal required. The extension can expose tools (`create_animation`, `preview_animation`, `export_animation`) that Claude invokes from the native chat interface.

Claude Desktop also supports **MCP App widgets**: self-contained HTML files that render inside the chat window. A widget could show a Remotion preview frame or a thumbnail. However:
- Widgets are static HTML loaded in a sandboxed context — a full Remotion Player running esbuild-WASM inside a chat widget is architecturally plausible but untested and likely to hit memory and security restrictions.
- The widget surface is small and fixed; you cannot implement a resizable 3-panel layout.
- There is no way to present a custom full-screen code editor inside Claude Desktop.

### What it cannot do

- Custom 3-panel UI (chat + code editor + video preview).
- A resizable, full-featured code editor (Monaco or similar).
- Direct user input to the code panel.

### Where it is useful

- **Discovery channel**: publish a `.mcpb` that gives Claude Desktop the `create_animation` and `export_animation` tools. Users who already have Claude Desktop can generate Remotion animations directly in chat without visiting the web app. This is a low-cost distribution add-on.
- **Demo / viral moment**: the conversational "generate a video by prompting Claude" use case is compelling on social media. Claude Desktop + our MCP extension is a quick path to that demo.
- **Not the product**: the full 3-panel experience with live preview, code editing, and project management requires the web app or desktop app.

---

## Related Notes

- [[anthropic-oauth-2026]] — no OAuth for third-party apps; API keys are the only path
- [[claude-code-webapp]] — detailed architecture comparison for local Claude Code approaches
- [[code-execution-sandbox]] — esbuild-WASM in-browser compile + sandboxed iframe for live preview
- [[backend-architecture]] — Elysia + Bun monolith, SSE streaming
- [[export-rendering-pipeline]] — MP4 and GIF export strategies
