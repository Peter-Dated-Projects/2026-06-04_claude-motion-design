---
id: terminal-reopen-must-bypass-slug-effect
root: gotchas
type: gotcha
status: current
summary: "TerminalPanel's PTY (re)open is keyed on the active slug, so re-selecting the SAME project never re-fires it; any relaunch (e.g. Restart after exit) must call the open path directly, not rely on a slug change."
created: 2026-06-04
updated: 2026-06-04
---

In `TerminalPanel.tsx` the PTY session is opened by a `useEffect` whose dependency
is the active project `slug`. React only re-runs that effect when the dep changes,
so once a session ends (`terminal://exit` -> `setExited(true)`), re-selecting the
**same** project does nothing — the slug is unchanged. The only accidental
"restart" was switching projects and back.

Any feature that needs to relaunch the current session (the Restart button added in
T-012) must invoke the open path **directly** rather than trying to nudge the slug.
The open logic is factored into one memoized `openSession()` shared by both the
slug effect and the button:

- `setExited(false)` -> `termRef.current?.clear()` -> `invoke('terminal_open',{slug})`
  -> `terminal_resize` to current cols/rows; `setExited(true)` on failure.
- A `useRef` re-entrancy guard (`openingRef`) blocks a double-spawn from rapid
  clicks or an in-flight open racing a slug change — a plain `useState` is too slow
  because its update is async.

Safe to call repeatedly: `PtyBridge::open` kills any predecessor and spawns fresh.
Note a restart is a brand-new `claude` session (no `--resume`), so prior
conversation context is lost. Related: [[terminal-is-pty-io-not-code-source]].
