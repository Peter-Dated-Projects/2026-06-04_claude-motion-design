# ClaudeMotion — Skills & Context Management

This document covers the skills system and context management work for the Claude animation assistant. It is the authoritative source for what exists, what needs to be built, and in what order.

---

## How the skills pipeline works today

```
src-tauri/resources/
  remotion-skills.txt          <- embedded at compile time via include_str!
  remotion-image-skills.txt    <- embedded but NOT yet wired into delivery
  remotion-mcp-config.json     <- Remotion MCP server config

claude_bridge.rs
  ensure_claude_config()       <- on app launch: materializes both files to
                                  {appDataDir}/claude-config/
  SKILLS_FILE = "remotion-skills.txt"   <- only this one is passed to CLI

pty_bridge.rs
  PtyBridge::open()            <- spawns: claude
                                    --mcp-config {config_dir}/remotion-mcp-config.json
                                    --append-system-prompt-file {config_dir}/remotion-skills.txt
                                    (cwd = {documentDir}/ClaudeMotion/projects/{slug}/)

projects.rs
  create_project()             <- scaffolds: project.json, animation.tsx, assets/
                                  (no theme.ts, motion.ts, components/ yet)

sandbox-compiler.worker.ts     <- esbuild in TRANSFORM mode (single file only;
                                  relative imports do not resolve)
```

Claude writes `animation.tsx` directly to the project dir. The file watcher (`file_watch.rs`) picks up changes and pushes them to the preview iframe. The preview runs the Remotion Player inside a sandboxed iframe that loads React/Remotion from bundled local files (no CDN).

---

## What exists now

| Artifact | Status | Notes |
|---|---|---|
| `remotion-skills.txt` | Done | Sections 1-13 including intent gate, motion presets, Disney principles, component vocabulary |
| `remotion-image-skills.txt` | Done | Image-to-code workflow, JSON schema, 5 CSS/SVG recipes, fallback table |
| `claude_bridge.rs` delivery | Partial | Only `remotion-skills.txt` is materialized + passed to the CLI; image skills file exists on disk but is not appended |
| MCP config | Done | Remotion docs search via `@remotion/mcp` |
| Single-file animation.tsx | Done | Full project CRUD + watcher + preview |
| Multi-file esbuild | Not started | Blocked on switching compiler from transform to bundle mode |
| Project scaffolding (theme.ts / motion.ts) | Not started | Blocked on multi-file compiler |
| Dynamic skills injection (file tree in prompt) | Not started | Blocked on multi-file compiler |

---

## Plan of action

### Phase 1 — Wire the image skills file (1 Rust change, ~30 min)

**Goal:** `remotion-image-skills.txt` gets appended to every Claude session so Claude knows how to handle image references.

**Approach:** Concatenate both skills files at materialize time into a single combined output. This avoids uncertainty about whether `claude` CLI accepts multiple `--append-system-prompt-file` flags and requires no change to `pty_bridge.rs`.

**File to change:** `src-tauri/src/claude_bridge.rs`

Steps:
1. Add `const IMAGE_SKILLS_CONTENTS: &str = include_str!("../resources/remotion-image-skills.txt");`
2. Add `pub const IMAGE_SKILLS_FILE: &str = "remotion-image-skills.txt";` (materialize separately, for debuggability)
3. In `ensure_claude_config()`, also materialize the image skills file
4. Change `SKILLS_FILE` delivery: concatenate `SKILLS_CONTENTS + "\n\n" + IMAGE_SKILLS_CONTENTS` into the materialized file, OR pass a second `--append-system-prompt-file` arg in `pty_bridge.rs::open()`

Decision point: test locally whether `claude --append-system-prompt-file a.txt --append-system-prompt-file b.txt` works. If yes, pass both. If not, concatenate at materialize time.

---

### Phase 2 — Multi-file esbuild compiler (largest change)

**Goal:** Claude can write `import { P } from './theme'` and `import { AnimatedWord } from './components/AnimatedWord'` and they resolve at preview time.

**Blocker:** `sandbox-compiler.worker.ts` uses `esbuild.transform()` which only processes a single string. Relative imports silently vanish.

**What needs to change:**

1. **`sandbox-compiler.worker.ts`**: Switch from `esbuild.transform()` to `esbuild.build()` with a virtual filesystem plugin. The plugin intercepts module resolution: bare imports (`react`, `remotion`, `@remotion/player`) resolve to the existing CDN/bundled shims; relative imports (`./theme`, `./components/AnimatedWord`) are resolved by reading the actual project file from disk (via Tauri invoke) or by receiving the full file map as a message from the frontend.

2. **Frontend → worker message protocol**: The frontend currently sends `{ code: string }`. Extend to `{ files: Record<string, string> }` where `files` is the full project source tree (all `.ts`/`.tsx` files). The compiler worker builds from this in-memory virtual FS.

3. **`projects.rs` `create_project()`**: Scaffold `theme.ts` and `motion.ts` alongside `animation.tsx` when a new project is created. Content is the default Midnight Pop tokens and the five named spring configs from `remotion-skills.txt` Section 8.

4. **`file_watch.rs`**: Currently only watches `animation.tsx`. Extend to watch all `.ts`/`.tsx` files in the project dir, emitting `file-changed` events so the frontend can re-read the file map and trigger recompile.

5. **`projectStore.ts`**: On file change, read all changed source files via `read_file` and push an updated file map to the compiler worker.

Import rules the compiler must enforce (matches `remotion-skills.txt` Section 1):
- Bare imports: `react`, `react-dom`, `remotion`, `@remotion/player` only
- Relative imports: any `.ts`/`.tsx` in the project dir
- All other bare imports: hard error in the compiler output (not a silent failure)
- No dynamic imports, no `require()`

Circular import guard: `animation.tsx` imports components and theme/motion; components import theme/motion only; theme/motion have no internal cross-imports. Compiler should detect cycles and report them as errors.

---

### Phase 3 — Scaffold shared modules on project creation

**Goal:** Every new project starts with `theme.ts` and `motion.ts` pre-populated so Claude sees them immediately and imports from them rather than inlining tokens.

**Depends on:** Phase 2 (compiler must resolve relative imports before this has any effect).

**Files to change:** `src-tauri/src/commands/projects.rs` `create_project()`

Scaffold content:
- `theme.ts`: exports `P` (Midnight Pop tokens), `DISPLAY`, `BODY` font stacks
- `motion.ts`: exports the five named `SpringConfig` constants + `fadeIn`, `softExit`, `gentleFloat` utility functions
- `components/` directory: created but empty (Claude adds to it as needed)

The skills file `Section 10 (Component Vocabulary)` already documents the expected API surface. Claude will use it immediately once the compiler resolves the imports.

---

### Phase 4 — Dynamic file tree injection into the skills prompt

**Goal:** The skills prompt Claude receives includes a live listing of which shared files actually exist in the current project, so Claude never tries to import a component that hasn't been created yet.

**Depends on:** Phase 2 and 3.

**Approach:**

In `pty_bridge.rs::open()`, before spawning the CLI:
1. Read the project's source tree via `list_project_files(slug)` equivalent in Rust
2. Build a short `components/` listing (file names only)
3. Write a per-session `project-context.txt` to `claude-config/` with the live file tree
4. Pass it as a third `--append-system-prompt-file` argument

Content of `project-context.txt` (generated at session open):
```
================================================================
CURRENT PROJECT FILES
================================================================
Source files in this project (relative imports only):
  animation.tsx      <- entry point; your primary file
  theme.ts           <- design tokens (import { P, DISPLAY, BODY })
  motion.ts          <- spring configs + utilities (import { SNAPPY, fadeIn, ... })
  components/
    AnimatedWord.tsx
    GradientBg.tsx
    [... whatever exists ...]

Missing files listed in Section 10 are not yet created. Write them inline until
you create the component file, then refactor to import.
```

This is the cheapest form of dynamic context: a small text file written per session open, no architectural change to the prompt system.

---

## Key files at a glance

| File | Role |
|---|---|
| `src-tauri/resources/remotion-skills.txt` | Main system prompt: runtime rules, safe zones, intent gate, palettes, typography, motion presets, templates, component vocabulary |
| `src-tauri/resources/remotion-image-skills.txt` | Image reference mode: extraction workflow, CSS/SVG recipes, fallback table |
| `src-tauri/resources/remotion-mcp-config.json` | MCP config wiring `@remotion/mcp` for Remotion docs search |
| `src-tauri/src/claude_bridge.rs` | Embeds + materializes skills files; resolves `claude` binary |
| `src-tauri/src/pty_bridge.rs` | Spawns `claude` CLI with skills + MCP; handles PTY I/O |
| `src-tauri/src/commands/projects.rs` | Project CRUD; `create_project` scaffolds initial files |
| `src/workers/sandbox-compiler.worker.ts` | esbuild-WASM compiler; currently transform-mode single-file |
| `src/store/projectStore.ts` | Frontend project state; triggers recompile on file changes |

---

## Decision log

**Why concatenate skills files rather than passing multiple `--append-system-prompt-file` flags?**
The `claude` CLI's support for repeated flags is not documented. Concatenation at materialize time is always safe, requires one fewer CLI arg, and produces a single file that's easy to inspect on disk. If multiple flags are confirmed to work, Phase 1 can be revised to pass both separately, which makes conditional loading per-session easier.

**Why not add image skills to the main file directly?**
Authoring separation: `remotion-skills.txt` covers generation rules that apply to every prompt; `remotion-image-skills.txt` covers a specific input mode (user provides a visual reference). Keeping them separate makes both easier to update independently and leaves room for conditional loading (e.g. only append image skills when the message contains an image attachment, once Tauri message inspection is available).

**Why deliver theme.ts / motion.ts as project scaffolding rather than global shared files?**
Projects are self-contained: the user exports them as a ZIP with all source. A global shared lib would break portability. Per-project copies, scaffolded at creation, keep each project independently openable.

**Why is the component vocabulary in the skills file if the components don't exist yet?**
It pre-establishes the naming convention and API surface. When multi-file lands, Claude already knows the expected shape of each component. Until then, the "PREFER-EXISTING RULE" is effectively a no-op (no files to import) but teaches Claude the vocabulary it will use once scaffolding is in place.
