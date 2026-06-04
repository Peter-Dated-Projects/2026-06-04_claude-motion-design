# Claude Motion - Setup Brief

A Tauri desktop app for generating and editing Remotion animations by chatting with
Claude. Live 1080x1920 phone preview, TSX/ZIP export. Runs entirely locally off your
Claude CLI - no backend, no cloud cost.

## Prerequisites

You need three things installed:

1. **Node.js 18+** and npm - for the frontend (React + Vite).
2. **Rust + Cargo** (stable) - for the Tauri shell. Install via https://rustup.rs.
   On macOS you also need the Xcode command line tools (`xcode-select --install`).
3. **Claude Code CLI**, authenticated. Install from https://claude.ai/code, then run
   `claude login` once in your terminal. The app shells out to this binary; if it is
   missing or unauthenticated, the app shows an onboarding gate instead of failing.

First run needs network access (to fetch npm/cargo deps and let the Remotion MCP server
start). After that, the live preview works fully offline - the Remotion runtime is
bundled into the app, not loaded from a CDN.

## Setup

From the project root:

```
npm install
```

That pulls the frontend dependencies. Cargo dependencies are fetched on the first
`tauri` command, so the first launch is slow (a full Rust compile, a few minutes).

## Run it

```
npm run tauri dev
```

This builds the local preview runtime, starts Vite on port 1420, compiles the Rust
shell, and opens the native window with hot reload. There is no separate build step for
the preview runtime - it runs automatically before dev.

To produce a distributable bundle instead:

```
npm run tauri build
```

## First-run smoke test

Walk these to confirm the whole loop works (the visual steps are the ones no automated
test can cover):

1. Launch with no projects -> onboarding asks you to name your first animation.
2. Create a project -> the three panels (chat / code / preview) render.
3. Type "Create a bouncing red circle" -> tokens stream into chat, code lands in the
   Monaco editor, and the circle actually renders in the phone preview.
4. Select the spring call in the editor, type "make it bouncier" -> Claude edits just
   that part.
5. Use the replay controls: play, pause, scrub to a frame, step one frame.
6. Toggle the safe-zone overlay -> red strips appear at the platform-correct positions.
7. Export TSX -> the native save dialog opens and writes the file.
8. Export ZIP, then import that ZIP -> a duplicate project opens.
9. Quit and relaunch -> the last project reopens with its full chat history.
10. Turn on airplane mode -> the preview still renders (local runtime, no network).

## If something is off

- **"Claude Code not found"** on launch -> install the CLI and run `claude login`, then
  hit "Check again". You can also set or override the CLI path in Settings (the gear).
- **App opens but a generation fails with an auth error** -> run `claude login` in your
  terminal.
- **Preview shows a red error banner** -> that is a compile error in the generated code;
  the validate-retry loop re-prompts Claude up to twice, but a persistent failure lands
  here. Edit in Monaco or ask Claude to fix it.
- **First launch hangs for minutes** -> that is the initial Rust compile, not a hang. It
  is fast on subsequent runs.

## What this is

Two Finks marketers chatting an animation into existence, iterating with Claude, and
exporting a Remotion TSX file or a shareable ZIP. Format is hardcoded to 1080x1920
(vertical, TikTok/Reels/Shorts). The canonical spec for every component lives in
PLAN.md.
