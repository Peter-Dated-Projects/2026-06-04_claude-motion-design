# Decisions

ADR-style records: what we chose and **why**. Name files with a zero-padded prefix,
e.g. `0001-single-git-tree.md`.

_No notes yet. Add atomic notes in this directory and list each one in the table below
(see `../CONTRIBUTING.md`)._

| Note | Summary | Status |
|---|---|---|
| [../animation-libraries.md](../animation-libraries.md) | Remotion is the recommended library for AI-generated mobile motion graphics; beats alternatives on LLM-friendliness, native 9:16 support, and video export. | current |
| [../auth-google-oauth.md](../auth-google-oauth.md) | Google OAuth hd restriction, NextAuth.js vs custom Bun flow, JWT vs opaque tokens, DynamoDB schema for users + sessions, session middleware sketch | current |
| [../code-execution-sandbox.md](../code-execution-sandbox.md) | Recommended live preview architecture: esbuild-WASM in-browser compile + sandboxed iframe with postMessage hot-reload; Docker/gVisor server-side for MP4 export | current |
