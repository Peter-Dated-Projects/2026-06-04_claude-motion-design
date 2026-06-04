# Decisions

ADR-style records: what we chose and **why**. Name files with a zero-padded prefix,
e.g. `0001-single-git-tree.md`.

| Note | Summary | Status |
|---|---|---|
| [0001-embedded-interactive-claude-pty.md](0001-embedded-interactive-claude-pty.md) | Pivoted from headless `claude -p` NDJSON scraping to an EMBEDDED interactive claude session in a PTY; Claude edits files with its own tools and we sync via a file watcher on animation.tsx. | current |
| [0002-project-files-in-user-documents.md](0002-project-files-in-user-documents.md) | Project files move from the hidden app_data_dir to ~/Documents/ClaudeMotion/projects/ as user-owned documents; claude-config stays in app_data_dir. | current |
| [0003-react-mosaic-panel-layout.md](0003-react-mosaic-panel-layout.md) | Replace the hand-rolled 3-panel resize layout with react-mosaic-component tiling so panels can be dragged by their headers into any split; chosen over zero-dep custom and over dockview. | current |
| [../animation-libraries.md](../animation-libraries.md) | Remotion is the recommended library for AI-generated mobile motion graphics; beats alternatives on LLM-friendliness, native 9:16 support, and video export. | current |
| [../auth-google-oauth.md](../auth-google-oauth.md) | Google OAuth hd restriction, NextAuth.js vs custom Bun flow, JWT vs opaque tokens, DynamoDB schema for users + sessions, session middleware sketch | current |
| [../code-execution-sandbox.md](../code-execution-sandbox.md) | Recommended live preview architecture: esbuild-WASM in-browser compile + sandboxed iframe with postMessage hot-reload; Docker/gVisor server-side for MP4 export | current |
| [../anthropic-oauth-2026.md](../anthropic-oauth-2026.md) | As of mid-2026, no OAuth delegation exists for third-party apps — subscription OAuth was banned Feb 2026; API keys are the only sanctioned method; WIF and MCP OAuth are distinct and do not apply | current |
