---
id: terminal-is-pty-io-not-code-source
root: gotchas
type: gotcha
status: current
summary: "The embedded Claude terminal (TerminalPanel) is pure PTY I/O; the editor/preview `code` state comes from the animation://changed file watcher, NOT from parsing terminal output -- never scrape terminal bytes for code."
created: 2026-06-04
updated: 2026-06-04
related:
  - useclaude-validate-retry-second-worker
---

The app pivoted away from the headless `claude -p` + `<code>`-scrape chat loop
to an EMBEDDED interactive Claude Code terminal. Two consequences that are easy
to get wrong:

1. **TerminalPanel is only a terminal.** It spawns the PTY (`terminal_open`),
   writes `terminal://data` bytes to xterm, pipes `term.onData` to
   `terminal_input`, and resizes via FitAddon + a ResizeObserver. It does NOT
   inspect, buffer, or parse the output stream for animation code. Claude edits
   `animation.tsx` itself with its own tools.

2. **The display source of truth is the file watcher, not the terminal.**
   App.tsx owns `code` and updates it ONLY from the `animation://changed` event
   (backed by the backend `watch_animation` notify watcher). Both the user
   (Monaco) and Claude (terminal) can write `animation.tsx`; the watch is what
   reconciles them. If you ever need "what did Claude produce", read the file /
   listen to `animation://changed` -- do not try to recover it from terminal
   scrollback.

This is why the old chat machinery is gone: `useClaude`, `ChatPanel/*`,
`codeExtractor.ts`, and `promptBuilder.ts` were deleted, and the App-level
streaming/generating/timeout/error-toast wiring went with them. The companion
`useclaude-validate-retry-second-worker` gotcha is superseded -- that
validate-and-retry loop lived inside the deleted `useClaude`.
