---
id: rust-raw-string-hex-color-collision
root: gotchas
type: gotcha
status: current
summary: Seeding TS/CSS with hex colors via a Rust r#"..."# raw string breaks -- the sequence "# inside e.g. "#0B0E14" closes the delimiter early; use r##"..."## (extra hash).
created: 2026-06-05
updated: 2026-06-05
---

When inlining file contents (theme.ts, CSS, etc.) as a Rust string const, the
seed pattern in `projects.rs` uses raw strings (`const X: &str = r#"..."#;`) to
avoid escaping the double quotes in font stacks.

The trap: a CSS/JS hex color literal like `"#0B0E14"` contains the byte sequence
`"#`, which is exactly the `r#"` raw-string *closing* delimiter. So `r#"... bg:
"#0B0E14" ..."#` terminates the string at the first hex color, and the rest of
the file body is parsed as Rust source -- yielding a cascade of confusing errors
(`expected ';', found 0B0E14`, `prefix 'Neue' is unknown`) plus every
`#[tauri::command]` in the module disappearing (the macro can't expand a module
that doesn't parse).

Fix: bump the hash count so the delimiter no longer appears in the body --
`r##"..."##` (or more). The body would have to contain `"##` to collide again.
Files with no hex colors (e.g. motion.ts) are fine with a single `r#"`.
