# Decisions

ADR-style records: what we chose and **why**. Name files with a zero-padded prefix,
e.g. `0001-single-git-tree.md`.

| Note | Summary | Status |
|---|---|---|
| [0009-roto-overlay-preview-coexistence.md](0009-roto-overlay-preview-coexistence.md) | In RotoVideoPanel, the point-placement overlay and clip preview coexist via showOverlay = !playing && atReferenceFrame: rest-on-frame-0 shows PointOverlay, playing/scrubbing off frame 0 shows a live preview <video>, and Rewind homes the playhead to re-show the overlay -- no lock/unlock mode. | current |
| [0008-roto-reference-frame-is-clip-frame-zero.md](0008-roto-reference-frame-is-clip-frame-zero.md) | The roto SAM2 reference frame is always frame 0 of the selected clip (clipStart, else frame 0), derived automatically at enqueue; the manual "Set Start Frame" lock step was removed and clip selection became a drag-on-track interaction. | current |
| [0007-ig-pipeline-bun-runtime.md](0007-ig-pipeline-bun-runtime.md) | The Instagram reel->brief pipeline is built as Bun + TypeScript scripts under scripts/ig-pipeline/, CLI-runnable/testable with no UI or Tauri wiring in v1; chosen over Node and Python (which would add a second bundled runtime). | current |
| [0001-embedded-interactive-claude-pty.md](0001-embedded-interactive-claude-pty.md) | Pivoted from headless `claude -p` NDJSON scraping to an EMBEDDED interactive claude session in a PTY; Claude edits files with its own tools and we sync via a file watcher on animation.tsx. | current |
| [0002-project-files-in-user-documents.md](0002-project-files-in-user-documents.md) | Project files move from the hidden app_data_dir to ~/Documents/ClaudeMotion/projects/ as user-owned documents; claude-config stays in app_data_dir. | current |
| [0003-react-mosaic-panel-layout.md](0003-react-mosaic-panel-layout.md) | Replace the hand-rolled 3-panel resize layout with react-mosaic-component tiling so panels can be dragged by their headers into any split; chosen over zero-dep custom and over dockview. | current |
| [0004-light-theme.md](0004-light-theme.md) | The whole app was switched from dark to a single LIGHT theme (not a toggle); the mosaic shell class was renamed .mosaic-dark -> .mosaic-light and Monaco uses theme="vs". | current |
| [0005-assets-as-data-uris.md](0005-assets-as-data-uris.md) | Project image assets are surfaced to the frontend as inline base64 data: URIs (not the Tauri asset:// protocol), and the Assets view is display-only until multi-file compilation lands. | current |
| [0006-multi-file-preview-virtual-fs.md](0006-multi-file-preview-virtual-fs.md) | Preview compiler moved from esbuild.transform to esbuild.build with an in-memory virtual-FS plugin so animation.tsx resolves relative project imports; allow-listed bare imports still rewritten to window globals, watcher went recursive + .ts/.tsx emitting {paths}. | current |
| [../animation-libraries.md](../animation-libraries.md) | Remotion is the recommended library for AI-generated mobile motion graphics; beats alternatives on LLM-friendliness, native 9:16 support, and video export. | current |
| [../auth-google-oauth.md](../auth-google-oauth.md) | Google OAuth hd restriction, NextAuth.js vs custom Bun flow, JWT vs opaque tokens, DynamoDB schema for users + sessions, session middleware sketch | current |
| [../code-execution-sandbox.md](../code-execution-sandbox.md) | Recommended live preview architecture: esbuild-WASM in-browser compile + sandboxed iframe with postMessage hot-reload; Docker/gVisor server-side for MP4 export | current |
| [../anthropic-oauth-2026.md](../anthropic-oauth-2026.md) | As of mid-2026, no OAuth delegation exists for third-party apps — subscription OAuth was banned Feb 2026; API keys are the only sanctioned method; WIF and MCP OAuth are distinct and do not apply | current |
