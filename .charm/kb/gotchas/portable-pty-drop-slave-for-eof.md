---
id: portable-pty-drop-slave-for-eof
root: gotchas
type: gotcha
status: current
summary: "With portable-pty you must drop the slave PtyPair half after spawn_command, or the master reader never sees EOF and the child-wait/terminal://exit never fires; also PTY output is raw bytes so chunk-split UTF-8 must be buffered before emitting as a String."
created: 2026-06-04
updated: 2026-06-04
---

Two traps in `pty_bridge.rs` when driving the interactive `claude` session over a
PTY.

## 1. Drop the slave or you never see EOF

`openpty` returns a `PtyPair { master, slave }`. After
`pair.slave.spawn_command(cmd)`, the parent process still holds an open slave fd.
The master's reader only returns `Ok(0)` (EOF) once **all** slave fds are closed —
so if you keep `pair.slave` around, the reader thread blocks forever even after the
child exits, the `child.wait()` path is fine but the reader leaks, and you lose the
clean stream teardown. We explicitly `drop(pair.slave)` right after spawning.

`terminal://exit` itself is emitted from a dedicated wait thread on `child.wait()`,
guarded by a generation counter so a stale session's exit doesn't clear a newer one
(a new `terminal_open` supersedes the old, killing it via a cloned `ChildKiller`).

## 2. PTY bytes are raw — buffer split UTF-8 before emitting

The IPC contract emits `terminal://data { data: String }`, but a PTY read can split
a multi-byte UTF-8 char across chunk boundaries. Calling `String::from_utf8_lossy`
per chunk would corrupt those chars into U+FFFD. The reader keeps a pending byte
buffer and only emits the longest valid-UTF-8 prefix each read, holding back an
incomplete trailing sequence for the next read (ANSI escapes are ASCII, so splitting
them is harmless). Genuinely invalid bytes are substituted and skipped.

Part of the embedded-PTY architecture — see [[0001-embedded-interactive-claude-pty]].
