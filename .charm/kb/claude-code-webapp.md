---
id: claude-code-webapp
root: architecture
type: architecture
status: current
summary: "Whether embedding a local Claude Code session in a browser is feasible, how it works, and a comparison to the simpler Elysia-backend API-key approach for the motion design app."
created: 2026-06-04
updated: 2026-06-04
---

# Embedding Claude Code in a Web App - Local Instance Architecture

## TL;DR

Running Claude Code locally and piping it to a browser is **architecturally possible** but adds significant complexity for this use case. For the motion design app (user chats, Claude edits a TSX animation file, preview updates), direct Claude API calls from the Elysia backend are simpler, cheaper to operate, and cover everything we need. A local Claude Code approach only makes sense if we need full filesystem access or want to avoid holding credentials on our backend at any cost — and even then, the right wrapper is a desktop app (Tauri/Electron), not a bare browser-to-localhost connection.

---

## 1. Claude Code SDK — What It Exposes

As of March 2026, Anthropic renamed the "Claude Code SDK" to the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` in npm, `claude-agent-sdk` in PyPI).

**What it is:** A Node.js / Python library that runs the same agent loop and tools as Claude Code. It bundles a native Claude Code binary as an optional dependency so you do not need Claude Code installed separately.

**Key interface (TypeScript):**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.ts",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message); // streams NDJSON events
}
```

**What it can do:** Read files, edit files, run bash commands, glob/grep codebases, browse the web, manage subagents, connect to MCP servers, resume sessions, run hooks at each agent lifecycle point.

**What it cannot do (relevant to our use case):**
- It **cannot run in a browser**. It spawns native OS processes and requires Node.js or Python. There is no browser/WASM build.
- It requires an **Anthropic API key** (`ANTHROPIC_API_KEY`). Third-party apps cannot use a user's claude.ai subscription login — Anthropic banned subscription OAuth delegation in Feb 2026 (see [[anthropic-oauth-2026]]).
- Since June 15, 2026, Agent SDK and `claude -p` usage on subscription plans draws from a separate **monthly Agent SDK credit pool**, distinct from interactive usage.

**Bottom line:** The Agent SDK is a server-side Node.js / Python library. To use it in a "web app," your Elysia backend would call it, not the browser frontend. This does not accomplish the goal of using the user's own Claude credentials — the API key still lives on your backend.

---

## 2. xterm.js + PTY over WebSocket (Interactive Mode)

This is the approach used by Code Quest (open-source project, May 2026) and tools like ttyd and wetty.

**Architecture:**

```
Browser (xterm.js) <-> WebSocket <-> Local bridge server (node-pty) <-> Claude Code CLI process
```

**How Claude Code is driven:**

Claude Code's CLI accepts `--output-format stream-json --input-format stream-json` flags, which switch it to NDJSON-based machine-readable I/O. Each line is a structured event:
- `system` — session metadata, init, api_retry events
- `assistant` — Claude's partial and final responses
- `user` — input acknowledgements
- `result` — final result payload
- `control_request` — permission prompts ("may I edit this file?")

The bridge reads stdout line-by-line and forwards events to the browser via WebSocket. The browser's responses are written back to Claude's stdin.

**Code Quest's Summoner pattern (the real-world reference):**

Code Quest's three-tier split: `Browser → WebSocket → Cloud relay server → Local Summoner binary → Claude Code CLI`. The Summoner runs on the user's machine, uses the user's existing Claude Code session (no API key required from the user), and the cloud server never touches local files.

**Why interactive mode avoids the June 2026 billing change:** Interactive `claude` CLI sessions don't draw from the new SDK credit pool. Only `claude -p` and the Agent SDK do.

**Complexity:** The local bridge server (the Summoner equivalent) needs to be installed and running on the user's machine. This is a significant UX burden — it's a sidecar binary the user must download, keep running, and trust with filesystem access.

---

## 3. Does Claude Code Expose a Local HTTP/WebSocket Server?

**Short answer: no.** Claude Code does not natively expose a `--port` flag or built-in HTTP/WebSocket API that a browser can connect to directly.

The VS Code extension runs a **local MCP server** that the Claude CLI connects to for IDE-specific features (diagnostics, diff viewing, cell execution). That server:
- Binds to `127.0.0.1` on a **random high port** (not user-configurable)
- Requires a **fresh random auth token** generated at each extension activation, stored in `~/.claude/ide/` with 0600 permissions
- Is used only for extension-to-CLI communication, not as a general API surface
- Is **not reachable from a browser** (the browser is a different process and doesn't have the token)

To expose Claude Code to a browser, you must build a bridge layer (PTY + WebSocket server) on top of the CLI process. There is no shortcut via a built-in flag.

---

## 4. VS Code Extension Architecture

The extension works as follows:

1. The extension process (running inside VS Code's Node.js host) spawns the `claude` CLI binary as a child process.
2. The extension starts a local MCP server on `127.0.0.1:<random port>`, and the CLI auto-connects to it.
3. Communication between the extension panel and the CLI goes through this MCP channel: extension sends prompts, reads streamed responses; CLI reads your current selection and opens diffs via MCP tools.
4. Auth token is written to `~/.claude/ide/` — only readable by the current user, preventing other processes from hijacking the connection.

**What this means for browser replication:** You cannot replicate this from a browser tab — browsers cannot spawn child processes or read the local filesystem. You can replicate it from:
- An **Electron** or **Tauri** desktop app (both have a native process side that can spawn binaries and run a local WebSocket server for the embedded webview).
- A **VS Code extension** (already done by Anthropic).

---

## 5. Electron vs Tauri for a Desktop App Wrapper

If we decide to ship a desktop app that embeds a browser UI and runs Claude Code locally:

| Factor | Electron | Tauri |
|---|---|---|
| Bundle size | ~150–200 MB | ~3–10 MB |
| Memory use | Higher (Chromium embedded) | Lower (OS native WebView) |
| Backend language | Node.js | Rust |
| Process spawning | `child_process` / `node-pty` — trivial | Rust `std::process::Command` — straightforward |
| Chromium consistency | Identical across platforms | OS WebView varies (Webkit on macOS, Chromium on Windows) |
| Maturity | Very mature, wide ecosystem | Tauri 2.x is production-ready as of 2025-2026 |
| Security model | Permissive by default | Locked down by default (explicit capability grants) |

**Recommendation if building a desktop app:** Tauri. Smaller install, more secure defaults, and Rust's process handling is well-suited to spawning and managing the Claude Code CLI subprocess. WebView inconsistency is an acceptable tradeoff for a tool-focused app.

**Electron** is fine too and easier if the team already knows Node.js end-to-end — but 200 MB downloads for a motion design tool will cause friction.

---

## 6. Security Model for Localhost Connections

If the web app (served from `https://ourapp.com`) connects to a local server (`http://localhost:PORT`):

**CORS:** The local server must explicitly allow the remote origin. Add:
```
Access-Control-Allow-Origin: https://ourapp.com
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```
The browser enforces this; the local server must opt in.

**DNS rebinding:** A malicious site can remap a domain it controls to `127.0.0.1` after DNS TTL expires, then make your browser think it's talking to a legitimate origin. Defense:
- Validate the `Host` header on every request (reject anything other than `localhost` or `127.0.0.1`).
- Require a bearer token in every request header (a secret the user gets from the web app after install-time pairing).

**Private Network Access (PNA):** Chrome is rolling out stricter rules for requests from public origins to private/local addresses. Expect a preflight `OPTIONS` request before every cross-origin fetch to `localhost`. The local server must respond correctly to PNA preflights (send `Access-Control-Allow-Private-Network: true`).

**Binding:** Always bind to `127.0.0.1`, not `0.0.0.0`. The latter exposes the local server to the LAN, which is a real attack surface.

**Install-time pairing:** Generate a random token when the local sidecar installs. The user pastes it into the web app settings once, or the web app deep-links to the sidecar to exchange the token automatically. Every subsequent WebSocket connection must present this token.

---

## 7. Feasibility Verdict for the Motion Design Use Case

### What the app needs

The core loop:
1. User types a chat message
2. Claude sees the current TSX animation code
3. Claude returns an edited version of that code
4. The browser re-renders the preview

This is a **stateless code-generation task**. Claude does not need to run bash commands, read from the filesystem autonomously, or maintain a long-lived agent loop. It needs: context (current file content) + instruction + output (new file content).

### Does local Claude Code help?

| Concern | Local Claude Code | Direct Claude API |
|---|---|---|
| User's own credentials (no API key on backend) | Yes — uses Claude Code session | No — API key must live somewhere |
| Avoid per-call API costs on our backend | Yes | No (unless user provides key) |
| Complexity | High (sidecar or desktop app) | Low |
| Latency | Same (both call Anthropic's API) | Same |
| Need for full agent loop | Not needed for a single file edit | Not needed |
| Context window management | Agent SDK handles it | We manage it (simple for single-file edits) |
| Works in-browser without install | No | Yes |
| File access beyond what we pass | Yes (reads filesystem) | Only what we include in prompt |

**The agent loop adds no value here.** Claude Code's power comes from autonomously reading many files, running tests, and iterating. For our use case we know exactly what context to provide (the current TSX file), so we send it in the prompt and Claude returns the result. We never need the agent to autonomously poke around.

### Recommended approach

**For v0–v1:** Use the Elysia backend to call the Anthropic Client SDK directly. Accept the API key via user settings (stored in browser localStorage, never on our servers), and pass it as a header to the Elysia backend which proxies the call. This keeps our backend stateless relative to credentials.

Alternatively, follow the API-key-as-user-config pattern: each user enters their API key in the app settings, it's stored encrypted server-side tied to their user record in DynamoDB.

**If no-credential-on-backend is a hard requirement later:** Build a Tauri desktop app. The Rust layer spawns Claude Code CLI (interactive mode), manages a local WebSocket server on a random port, and the embedded WebView connects to it. No sidecar install UX friction, full filesystem access, user's own credentials. This is the path VS Code took and it's the right choice for a proper desktop experience.

**Do NOT build the browser-to-sidecar approach** for v0. The install-pairing-CORS-PNA-token-management complexity is disproportionate to the benefit at this stage.

---

## Architecture Comparison Table

| Approach | Auth | Complexity | Browser-only | Works in v0 |
|---|---|---|---|---|
| Elysia backend + Claude API (user-provided key) | User's own API key, not stored on server | Low | Yes | Yes |
| Elysia backend + Claude API (server API key) | Server-held key | Low | Yes | Yes |
| Agent SDK in Elysia backend | Server or user API key, runs in Node.js server process | Medium | Yes (server does the work) | Yes |
| Browser → local sidecar binary → Claude Code CLI | User's Claude Code session | High | No (sidecar install required) | No |
| Tauri/Electron desktop app → Claude Code CLI | User's Claude Code session | High (new distribution model) | No (desktop app) | No |
| claude.ai OAuth delegation | User's subscription | N/A | N/A | Blocked (banned Feb 2026) |

---

## Related Notes

- [[anthropic-oauth-2026]] — OAuth delegation is not available; API keys are the only sanctioned method
- [[backend-architecture]] — Elysia + Bun monolith, SSE for Claude streaming
- [[code-execution-sandbox]] — esbuild-WASM in-browser compile for live preview
