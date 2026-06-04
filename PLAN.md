# Claude Motion Design — Implementation Plan

## What this is

A Tauri 2.x desktop app for 2 Finks marketers. Users chat with Claude to generate and
iteratively edit Remotion animation TSX files. Live preview in a 1080x1920 phone-format
player. Export TSX or ZIP project for sharing. Zero cloud costs — runs entirely locally
using the user's existing Claude Max subscription via the `claude` CLI.

## How to start (new session instructions)

1. Read this file fully.
2. Read `.charm/kb/synthesis.md` for architecture background — but NOTE: the synthesis.md
   reflects an old web-app architecture (Next.js + Bun + DynamoDB). The decided architecture
   is the Tauri-local one described in this file. This file is authoritative.
3. Create all 13 tickets below using `mcp__charm__create_tickets` (batches of 3).
4. Spawn T-IMPL-001 first. When it completes, spawn T-IMPL-002, T-IMPL-003, T-IMPL-004 in parallel.
5. Continue wave by wave per the dependency graph.

---

## Decided Architecture

| Concern | Decision |
|---|---|
| App shell | Tauri 2.x (Rust + Vite/React WebView) |
| Claude integration | Rust spawns `claude -p --output-format stream-json --mcp-config {path} --append-system-prompt-file {path} [--resume {sessionId}]` |
| Preview sandbox | esbuild-WASM worker -> postMessage -> sandboxed iframe (null-origin) -> Remotion Player |
| React/Remotion in iframe | Loaded from CDN (unpkg) — requires internet on first load, cached after |
| Storage | `{appDataDir}/projects/{slug}/` — plain JSON files, no database |
| Export | Tauri `dialog.save()` native picker; ZIP for project sharing |
| Dimensions | 1080x1920 hardcoded everywhere |
| Safe zones | System prompt + toggleable overlay in preview panel |
| Skills | `remotion-skills.txt` bundled in app resources, injected via `--append-system-prompt-file` |
| MCP | `remotion-mcp-config.json` bundled, wires `@remotion/mcp@latest` docs search |
| Session | UUID per project stored in `project.json`; passed via `--resume` for conversation continuity |
| No backend | No Vercel, no Bun API, no DynamoDB, no AWS, no cloud costs |
| Sharing | ZIP export/import |

---

## Project folder layout (per project)

```
{appDataDir}/projects/{slug}/
  project.json        -- { id, name, slug, createdAt, updatedAt, sessionId }
  animation.tsx       -- current animation code (full file, replaced on each Claude response)
  conversation.json   -- [ { role, content, timestamp }, ... ]
  assets/             -- images/fonts dropped in by user
```

---

## Dependency Graph

```
T-IMPL-001 (Tauri scaffold)
  |
  +----------+----------+
  T-IMPL-002  T-IMPL-003  T-IMPL-004        Wave 2 — 3 parallel workers
 (storage)   (bridge)    (UI shell)
  |             |            |
  +-------------+------------+
                |
  +------+------+------+------+------+
  T-005  T-006  T-007  T-010  T-011        Wave 3 — 5 parallel workers
 (chat) (monaco)(esbuild)(prompt)(zip)
                  |
              +---+---+
            T-008   T-012                  Wave 4 — 3 parallel workers
          (preview)(export)
              |
            T-009                          Wave 4b
          (replay)
              |
            T-013                          Wave 5 — integration
```

Wave 3 max parallelism = 5 workers.

---

## Tickets

### T-IMPL-001 — Tauri Project Scaffold

**Depends on:** nothing
**Touches:** `/*`, `src-tauri/*`, `src/*`, `package.json`, `tauri.conf.json`

Initialize Tauri 2.x project with React + TypeScript + Vite.

Tasks:
- Run `create-tauri-app` with React+TypeScript+Vite preset (or initialize manually)
- Add Tauri plugins to `Cargo.toml`: `tauri-plugin-dialog`, `tauri-plugin-shell`, `tauri-plugin-fs`
- Configure `tauri.conf.json`:
  - `productName: "claude-motion"`
  - `windows[0]`: min-size 1200x800, title "Claude Motion"
  - Enable `dialog`, `shell`, `fs` allowlists
- Frontend `package.json`: React 18, TypeScript, Vite, Zustand, `@monaco-editor/react`, `@remotion/player`, `esbuild-wasm`
- Verify `cargo tauri dev` opens a blank window with hot-reload working
- Add `.gitignore` entries: `src-tauri/target/`, `dist/`, `node_modules/`

Deliverable: `cargo tauri dev` opens a React app in a native window.

---

### T-IMPL-002 — Local Project Storage

**Depends on:** T-IMPL-001
**Touches:** `src-tauri/src/commands/projects.rs`, `src-tauri/src/lib.rs`, `src/store/projectStore.ts`, `src/types/index.ts`

Implement project CRUD via Tauri commands backed by the local filesystem.

Rust commands (register all in `lib.rs`):
```rust
list_projects()          -> Vec<ProjectMeta>
create_project(name)     -> Project
open_project(slug)       -> Project
delete_project(slug)     -> ()
save_animation(slug, code) -> ()
load_animation(slug)     -> String
save_conversation(slug, messages) -> ()
load_conversation(slug)  -> Vec<Message>
```

TypeScript types in `src/types/index.ts`:
```ts
interface Project {
  id: string; name: string; slug: string;
  createdAt: string; updatedAt: string; sessionId: string | null;
}
interface Message { role: 'user' | 'assistant'; content: string; timestamp: string }
interface ProjectMeta { id: string; name: string; slug: string; updatedAt: string }
```

Zustand `useProjectStore` in `src/store/projectStore.ts`:
- State: `projects: ProjectMeta[]`, `activeProject: Project | null`, `isLoading: boolean`
- Actions: `loadProjects()`, `createProject(name)`, `openProject(slug)`, `deleteProject(slug)`

Project folder path: `{appDataDir}/projects/{slug}/`
Slug generation: kebab-case from name + timestamp suffix if collision.

---

### T-IMPL-003 — Claude CLI Bridge (Rust)

**Depends on:** T-IMPL-001
**Touches:** `src-tauri/src/claude_bridge.rs`, `src-tauri/src/commands/claude.rs`, `src-tauri/resources/remotion-skills.txt`, `src-tauri/resources/remotion-mcp-config.json`, `src-tauri/build.rs`

Spawn the `claude` CLI as a subprocess and stream its NDJSON output as Tauri events.

Resource files to bundle in `src-tauri/resources/`:

**`remotion-mcp-config.json`:**
```json
{
  "mcpServers": {
    "remotion-docs": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"],
      "env": {}
    }
  }
}
```

**`remotion-skills.txt`** (full content — see Prompt Engineering section below for exact wording):
The Remotion coding rules + safe zone constraints injected as an appended system prompt.

On app startup: copy both resource files to `{appDataDir}/claude-config/` if not already present.

**`ClaudeBridge` in `claude_bridge.rs`:**
```rust
pub struct ClaudeBridge { child: Option<Child> }

impl ClaudeBridge {
    pub fn send(&mut self, app: AppHandle, prompt: String, session_id: Option<String>, project_dir: String)
    // Builds args, spawns subprocess, reads stdout line-by-line
    // Parses NDJSON lines:
    //   stream_event + text_delta  -> emit app.emit("claude://token", { text })
    //   result + subtype:success   -> emit app.emit("claude://done", { full_text, cost_usd })
    //   error                      -> emit app.emit("claude://error", { message })

    pub fn cancel(&mut self)
    // Kills the child process
}
```

CLI args pattern:
```
claude -p \
  --mcp-config {appDataDir}/claude-config/remotion-mcp-config.json \
  --append-system-prompt-file {appDataDir}/claude-config/remotion-skills.txt \
  --output-format stream-json \
  [--resume {session_id}] \
  "{prompt}"
```

Tauri commands:
```rust
invoke_claude(slug: String, prompt: String, session_id: Option<String>) -> ()
cancel_claude() -> ()
check_claude_installed() -> bool   // runs `which claude`
```

---

### T-IMPL-004 — 3-Panel React UI Shell

**Depends on:** T-IMPL-001
**Touches:** `src/App.tsx`, `src/components/layout/`, `src/store/uiStore.ts`

Three resizable panels + toolbar + status bar.

Layout structure:
```
+--[Toolbar: project dropdown | + New | gear icon]--------+
|  ChatPanel  |  CodePanel  |  PreviewPanel               |
+--[StatusBar: frame counter | fps | safe zone toggle]----+
```

Panels:
- CSS flex row, `min-width: 180px` each
- Drag handle between panels (div with `cursor: col-resize`, mouse drag updates flex-basis)
- Default widths: chat 25%, editor 37%, preview 38%
- Persist widths to localStorage

`useUIStore` in `src/store/uiStore.ts`:
```ts
interface UIState {
  panelWidths: [number, number, number]
  isGenerating: boolean
  showSafeZone: boolean
  safeZonePlatform: 'universal' | 'tiktok' | 'instagram' | 'youtube'
  selection: { text: string; startLine: number; endLine: number } | null
}
```

Components:
- `src/components/layout/Toolbar.tsx` — project dropdown, new button, settings button
- `src/components/layout/StatusBar.tsx` — frame display, safe zone toggle
- `src/components/ChatPanel/ChatPanel.tsx` — placeholder "Chat coming soon"
- `src/components/CodePanel/CodePanel.tsx` — placeholder "Editor coming soon"
- `src/components/PreviewPanel/PreviewPanel.tsx` — placeholder "Preview coming soon"

---

### T-IMPL-005 — Chat Panel + Claude Streaming

**Depends on:** T-IMPL-003, T-IMPL-004
**Touches:** `src/components/ChatPanel/`, `src/hooks/useClaude.ts`

Full chat UI with streaming Claude responses.

`useClaude` hook in `src/hooks/useClaude.ts`:
- Listen to `claude://token` -> append text to pending assistant message bubble
- Listen to `claude://done` -> finalize bubble; extract `<code>` tag via regex `/<code>([\s\S]*?)<\/code>/`; call `onCodeGenerated(code)`
- Listen to `claude://error` -> show error toast; set `isGenerating: false`
- `send(prompt, currentCode, selection)`: calls `buildPrompt()` then `invoke('invoke_claude', ...)`
- Saves conversation after each round via `invoke('save_conversation', ...)`

`ChatPanel.tsx`:
- Message list: user bubbles right-aligned (blue), assistant left-aligned (gray)
- Streaming: pending assistant bubble grows in real time
- Loading: animated ellipsis while waiting for first token
- Input `<textarea>`: Enter sends, Shift+Enter newline, disabled while generating
- "Stop" button during generation (calls `invoke('cancel_claude')`)
- Empty state: "Describe an animation to get started..."
- Auto-scroll to bottom on new message

`MessageBubble.tsx`: renders markdown in assistant messages (use `react-markdown` or simple whitespace preservation)

---

### T-IMPL-006 — Monaco Code Editor

**Depends on:** T-IMPL-004
**Touches:** `src/components/CodePanel/`, `src/hooks/useMonaco.ts`

Monaco editor with TSX support and selection tracking.

`CodePanel.tsx`:
- Dynamic import `@monaco-editor/react` (avoids blocking initial render)
- Language: `typescript`, monaco compiler options `jsx: 'react'`, `target: 'ES2020'`
- Theme: `vs-dark`
- Read-only overlay while `useUIStore.isGenerating` is true (pointer-events none + visual tint)
- On mount: set initial code from `useProjectStore.activeProject` animation.tsx
- On `onCodeGenerated(code)`: `editor.setValue(code)` + brief yellow flash diff animation (500ms)

`useMonaco.ts`:
- `editor.onDidChangeCursorSelection` -> debounce 200ms -> compute selected text -> `useUIStore.setSelection(...)`
- `editor.onDidChangeModelContent` -> debounce 500ms -> emit to esbuild worker for recompile

Additional features:
- Copy button in panel header
- Line count display in status bar

---

### T-IMPL-007 — esbuild-WASM Sandbox + Remotion Preview

**Depends on:** T-IMPL-004
**Touches:** `src/workers/sandbox-compiler.worker.ts`, `src/assets/sandbox-frame.html`, `src/components/PreviewPanel/PreviewPanel.tsx`, `scripts/build-preview-runtime.mjs`, `package.json`, `src-tauri/resources/`

In-browser TSX compilation + sandboxed iframe Remotion preview.

> VERIFIED CONSTRAINTS (researched 2026-06-04 — do not revert to the patterns these replace):
> 1. **`@remotion/player` has NO UMD build.** v4.0.471 publishes only `dist/cjs/index.js` (CommonJS) and
>    `dist/esm/index.mjs` (ESM); there is no `dist/index.umd.js` and no `unpkg`/`browser` field. The URL
>    `unpkg.com/@remotion/player@latest/dist/index.umd.js` 404s. There is no `window.RemotionPlayer` global
>    to load. (React/ReactDOM DO ship real UMD builds; only the Player does not.)
> 2. **Tauri on macOS is WebKit (WKWebView).** ESM importmaps inside sandboxed iframes are buggy on WebKit,
>    so the importmap-from-CDN delivery is NOT safe here either. Avoid importmaps.
> 3. **`eval()` / `new Function()` need `script-src 'unsafe-eval'`.** Rather than grant that, inject the
>    compiled bundle as a blob-URL `<script>` (`script-src blob:`).
>
> RESOLUTION: bundle the preview runtime LOCALLY as a Tauri resource (no CDN). This makes preview work
> fully offline (satisfies smoke-test step 10) and removes every network/importmap risk above.

**Preview-runtime prebuild — `scripts/build-preview-runtime.mjs`** (run as an npm `prebuild`/`predev` step):
- esbuild-bundle `@remotion/player` + `remotion` into a single IIFE, `globalName: 'RemotionRuntime'`,
  marking `react`/`react-dom` as external mapped to the `React`/`ReactDOM` window globals.
- Output to `src-tauri/resources/preview-runtime.js` (exposes `window.RemotionRuntime.Player`, etc.).
- Also copy React + ReactDOM 18 UMD production builds and `esbuild.wasm` from `node_modules` into
  `src-tauri/resources/` so nothing is fetched from a CDN at runtime.
- All three (`react`, `react-dom`, `@remotion/player`) are bundled to exact pinned versions from
  `package.json` — keep them in sync with whatever a future MP4 server-render would use.

**`sandbox-compiler.worker.ts`:**
```ts
// Initialize esbuild-wasm once; wasm served locally via Tauri asset protocol (no CDN)
await esbuild.initialize({ wasmURL: '/preview-runtime/esbuild.wasm', worker: false })

self.onmessage = async ({ data }) => {
  if (data.type === 'compile') {
    try {
      const result = await esbuild.transform(data.code, {
        loader: 'tsx',
        format: 'iife',
        globalName: 'AnimationExports',
        jsx: 'transform',                 // classic runtime -> uses global React; no auto-import resolution
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
      })
      self.postMessage({ type: 'compiled', bundle: result.code })
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) })
    }
  }
}
```
Note: the generated TSX imports React/Remotion. esbuild in `transform` mode leaves the `import` statements
in place (it cannot resolve them). Strip/rewrite bare imports so the bundle references the window globals
instead — simplest: a tiny pre-pass that removes `import ... from 'react' | 'remotion' | '@remotion/player'`
lines and prepends `const React = window.React, Remotion = window.RemotionRuntime; const { ... } = Remotion`.
Confirm the exact destructuring set against the skills prompt's allowed API list.

**`sandbox-frame.html`** (served via Tauri asset protocol, loaded as iframe src — all assets LOCAL):
```html
<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'none'">
</head>
<body style="margin:0;background:#000">
  <div id="root"></div>
  <!-- All runtime served locally from src-tauri/resources via the Tauri asset protocol; NO CDN -->
  <script src="/preview-runtime/react.production.min.js"></script>
  <script src="/preview-runtime/react-dom.production.min.js"></script>
  <script src="/preview-runtime/preview-runtime.js"></script>
  <script>
    let playerRef = null

    function runBundle(code) {
      // Inject as a blob-URL <script> instead of eval() — avoids CSP 'unsafe-eval'
      return new Promise((resolve, reject) => {
        const blob = new Blob([code], { type: 'text/javascript' })
        const url = URL.createObjectURL(blob)
        const s = document.createElement('script')
        s.src = url
        s.onload = () => { URL.revokeObjectURL(url); resolve() }
        s.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
        document.head.appendChild(s)
      })
    }

    window.addEventListener('message', async ({ data }) => {
      if (data.type === 'render') {
        try {
          await runBundle(data.bundle)        // sets window.AnimationExports
          const Component = window.AnimationExports.default
          window.ReactDOM.createRoot(document.getElementById('root')).render(
            window.React.createElement(window.RemotionRuntime.Player, {
              component: Component,
              durationInFrames: 150, fps: 30,
              compositionWidth: 1080, compositionHeight: 1920,
              ref: r => { playerRef = r },
              style: { width: '100%', height: '100%' }
            })
          )
          window.parent.postMessage({ type: 'renderOk' }, '*')
        } catch (err) {
          window.parent.postMessage({ type: 'renderError', message: String(err) }, '*')
        }
      }
      if (data.type === 'play') playerRef?.play()
      if (data.type === 'pause') playerRef?.pause()
      if (data.type === 'seek') playerRef?.seekTo(data.frame)
      if (data.type === 'setSpeed') playerRef?.setPlaybackRate(data.speed)
      if (data.type === 'setLoop') playerRef?.setLoop(data.loop)
    })

    requestAnimationFrame(function tick() {
      if (playerRef) {
        window.parent.postMessage({
          type: 'frameUpdate', frame: playerRef.getCurrentFrame(), totalFrames: 150
        }, '*')
      }
      requestAnimationFrame(tick)
    })
  </script>
</body>
</html>
```

**`PreviewPanel.tsx`:**
- Create Web Worker from `sandbox-compiler.worker.ts`
- `<iframe sandbox="allow-scripts" src="tauri://localhost/sandbox-frame.html">`
- On new code (from Monaco or Claude): send `{ type: 'compile', code }` to worker
- On worker `compiled`: send `{ type: 'render', bundle }` to iframe via postMessage
- On worker `error` or iframe `renderError`: show red error banner with message + line number
- Loading overlay: spinner for first WASM init (disappears after first successful compile)
- `ResizeObserver` on container div -> update CSS `transform: scale(containerHeight / 1920)` on iframe wrapper
- First task of this ticket: implement and run `build-preview-runtime.mjs` and confirm the Player mounts
  one frame from the local bundle BEFORE building the rest (this is the de-risking spike).

---

### T-IMPL-008 — Phone Bezel + Safe Zone Overlay

**Depends on:** T-IMPL-007
**Touches:** `src/components/PreviewPanel/PhoneBezel.tsx`, `src/components/PreviewPanel/SafeZoneOverlay.tsx`, `src/components/PreviewPanel/PreviewPanel.tsx`

Visual chrome around the 1080x1920 preview.

**`PhoneBezel.tsx`** (CSS only, no dependency):
```tsx
// Outer: rounded corners, shadow, thin dark border (generic phone silhouette)
// Inner: clips to screen area, houses the scaled iframe
const style = {
  outer: { borderRadius: 48, boxShadow: '0 24px 80px rgba(0,0,0,0.7)', border: '2px solid #333', background: '#1a1a1a', padding: 12 },
  screen: { borderRadius: 4, overflow: 'hidden', background: '#000' }
}
```

**`SafeZoneOverlay.tsx`:**
```tsx
const SAFE_ZONES = {
  universal: { top: 140, bottom: 370, left: 30, right: 160 },
  tiktok:    { top: 140, bottom: 370, left: 30, right: 150 },
  instagram: { top: 130, bottom: 340, left: 30, right: 160 },
  youtube:   { top: 140, bottom: 360, left: 30, right: 160 },
}
// Props: show: boolean, platform: keyof typeof SAFE_ZONES
// Renders: absolutely positioned over iframe (pointer-events none)
// 4 rgba(255,0,0,0.12) strips for unsafe regions
// 1px rgba(255,200,0,0.8) border at safe-zone inner edge
// Optional labels: "Caption area", "Action buttons", etc. in small gray text
```

Platform selector dropdown in preview toolbar.
Toggle button: "Safe Zone" label with eye icon (default on during editing, auto-off on play).

---

### T-IMPL-009 — Replay Controls

**Depends on:** T-IMPL-008
**Touches:** `src/components/PreviewPanel/ReplayControls.tsx`, additions to `src/assets/sandbox-frame.html`

Playback controls below the phone bezel.

Controls row:
```
[|<] [<] [Play/Pause] [>] [>|]  [——scrubber——o——]  0:02.15 / 0:05.00  [0.5x][1x][2x]  [Loop]
```

State (in `useUIStore` or local to ReplayControls):
- `currentFrame: number` — updated from iframe `frameUpdate` messages
- `totalFrames: number` — from composition config (default 150)
- `isPlaying: boolean`
- `speed: 0.5 | 1 | 2`
- `loop: boolean`

postMessage commands sent to iframe (already handled in sandbox-frame.html from T-007):
- Play/Pause: `{ type: 'play' }` / `{ type: 'pause' }`
- Frame step: `{ type: 'seek', frame: currentFrame + 1 }` / `{ type: 'seek', frame: currentFrame - 1 }`
- Jump to start/end: `{ type: 'seek', frame: 0 }` / `{ type: 'seek', frame: totalFrames - 1 }`
- Scrubber drag: `{ type: 'seek', frame: scrubberValue }`
- Speed: `{ type: 'setSpeed', speed }`
- Loop: `{ type: 'setLoop', loop }`

Auto-play on successful new compilation.
Keyboard shortcut: Space = play/pause when PreviewPanel is focused.

Time display: `formatTime(frame, fps) -> "0:02.15"` utility function.

---

### T-IMPL-010 — Prompt Engineering + Remotion Skills

**Depends on:** T-IMPL-003
**Touches:** `src-tauri/resources/remotion-skills.txt`, `src/lib/promptBuilder.ts`, `src/lib/codeExtractor.ts`

System prompt content and client-side prompt assembly.

**`remotion-skills.txt`** full content:

```
You are an expert Remotion animation engineer. Your only output is a single TypeScript/React file (TSX) that can be dropped directly into a Remotion composition.

Rules:
- Output the COMPLETE file, from the first import to the last line. No truncation, no "..." placeholders.
- Wrap the entire file in a single <code> XML tag and nothing else. No markdown fences, no prose, no explanation outside that tag.
- Every animation MUST use Remotion's useCurrentFrame, useVideoConfig, and spring/interpolate primitives. Never use CSS transitions or setTimeout.
- Composition format: fps 30, durationInFrames 150, width 1080, height 1920. Use useVideoConfig() to read these at runtime; do not hardcode them.
- Spring physics defaults unless user specifies: { mass: 1, damping: 12, stiffness: 100 }.
- Keep component names PascalCase and export a single default component.
- Do not import anything not available in a standard @remotion/player + React 18 environment.

Animation vocabulary:
- Easing: Easing.bezier, Easing.spring, Easing.linear, Easing.out(Easing.ease), Easing.inOut(Easing.cubic)
- Remotion helpers: spring, interpolate, interpolateColors, useCurrentFrame, useVideoConfig, Sequence, Audio, Img, AbsoluteFill
- Keyframe idiom: interpolate(frame, [0, 15, 30], [0, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })

Safe zone constraints (IMPORTANT — always follow):
The canvas is 1080x1920. Keep ALL text, logos, and important visuals within the safe zone:
  x: 30 to 920 (avoid left 30px and right 160px)
  y: 140 to 1550 (avoid top 140px and bottom 370px)
For captions/subtitles, keep bottom edge above y=1480.
For hero content (faces, product shots, CTAs), use center focus zone: x 150-930, y 300-1420.
Never place critical content within 370px of the bottom edge — platform UI (captions, action buttons) covers that region on TikTok, Instagram Reels, and YouTube Shorts.

If the request is ambiguous, make a creative choice and implement it. Do not ask clarifying questions.
```

**`src/lib/promptBuilder.ts`:**
```ts
export function buildPrompt(opts: {
  currentCode: string | null
  selection: { text: string; startLine: number; endLine: number } | null
  userRequest: string
}): string {
  const parts: string[] = []
  if (opts.currentCode) {
    if (opts.selection) {
      // Inject <selection> tags around the selected region inline in current_code
      const annotated = annotateSelection(opts.currentCode, opts.selection)
      parts.push(`<current_code>\n${annotated}\n</current_code>`)
    } else {
      parts.push(`<current_code>\n${opts.currentCode}\n</current_code>`)
    }
  }
  parts.push(`<user_request>\n${opts.userRequest}\n</user_request>`)
  return parts.join('\n\n')
}
```

**`src/lib/codeExtractor.ts`:**
```ts
export function extractCode(response: string): string | null {
  const match = response.match(/<code>([\s\S]*?)<\/code>/)
  if (match) return match[1].trim()
  // Fallback: if response looks like valid TSX (starts with import), return as-is
  if (response.trim().startsWith('import')) return response.trim()
  return null
}
```

Validation + retry logic (in `useClaude.ts`):
1. Extract code with `extractCode()`
2. Send to esbuild worker with `{ type: 'validate', code }` (transform only, no mount)
3. If syntax error and `retryCount < 2`: re-send to Claude with appended `<error>{message}</error>` context
4. On success: call `onCodeGenerated(code)`

---

### T-IMPL-011 — ZIP Export/Import

**Depends on:** T-IMPL-002, T-IMPL-004
**Touches:** `src-tauri/src/commands/zip.rs`, `src-tauri/Cargo.toml`, `src/components/layout/ProjectMenu.tsx`

Add `zip` crate to `Cargo.toml`: `zip = "0.6"`

**`zip.rs` Tauri commands:**

```rust
// Export: zip the project folder, save to user-chosen path
async fn export_project_zip(app: AppHandle, slug: String) -> Result<String, String> {
    // 1. Walk {appDataDir}/projects/{slug}/
    // 2. Create ZIP in memory (zip::ZipWriter)
    // 3. Show dialog::save() with filter [("ZIP", "zip")]
    // 4. Write ZIP bytes to chosen path
    // 5. Return chosen path (for success toast)
}

// Import: open ZIP, extract to projects dir, return new project
async fn import_project_zip(app: AppHandle) -> Result<Project, String> {
    // 1. Show dialog::open() with filter [("ZIP", "zip")]
    // 2. Read ZIP bytes
    // 3. Extract to {appDataDir}/projects/{slug}/
    //    Handle collision: if slug exists, append -2, -3
    // 4. Read project.json, return Project
}
```

UI: "Export ZIP" and "Import ZIP" items in the project dropdown menu in Toolbar.tsx.
Success toast: "Saved to ~/Desktop/my-project.zip" / "Imported: my-project"

---

### T-IMPL-012 — TSX Export

**Depends on:** T-IMPL-007, T-IMPL-011
**Touches:** `src/components/layout/ExportMenu.tsx`, `src-tauri/src/commands/export.rs`

Export button in top toolbar.

**`export.rs` Tauri command:**
```rust
async fn export_tsx(app: AppHandle, slug: String) -> Result<String, String> {
    // 1. Read current animation.tsx content
    // 2. dialog::save({ defaultPath: "{slug}.tsx", filters: [("TypeScript", "tsx")] })
    // 3. Write TSX to chosen path
    // 4. Copy assets/ folder to same directory
    // 5. Return path for success toast
}
```

**`ExportMenu.tsx`:**
- "Export TSX" button (active)
- "Export MP4" (disabled, tooltip: "Coming soon")
- "Export ZIP" (delegates to T-IMPL-011)
- Success/error toast notifications

---

### T-IMPL-013 — Integration, Onboarding & Polish

**Depends on:** T-IMPL-005, T-IMPL-006, T-IMPL-007, T-IMPL-008, T-IMPL-009, T-IMPL-010, T-IMPL-011, T-IMPL-012
**Touches:** `src/App.tsx`, `src/components/Onboarding.tsx`, `src/components/Settings.tsx`

Wire everything together and handle edge cases.

**Startup check:**
```ts
// On app mount
const installed = await invoke('check_claude_installed')
if (!installed) showOnboardingModal()
```

**`Onboarding.tsx`:**
- Modal: "Claude Code not found. Install it from claude.ai/code then run `claude login` in your terminal."
- "Check again" button re-invokes `check_claude_installed`
- First project prompt: if `projects.length === 0`, show "Name your first animation project" input

**`Settings.tsx` (gear icon panel):**
- Claude CLI path (auto-detected via `which claude`, overridable)
- MCP status indicator (green/red)
- Skills file path display
- App version

**Error states:**
- Claude not logged in (auth error in stderr) -> toast: "Run `claude login` in your terminal"
- Network error -> toast with retry button
- Compile error -> red banner in preview (already T-007), no retry
- Generation timeout (>60s no token) -> toast with stop option

**Keyboard shortcuts:**
- `Cmd+Enter`: send chat message
- `Escape`: cancel generation
- `Space`: play/pause (when preview focused)
- `Cmd+S`: save animation manually (normally auto-saves)

**Window title:** `{project name} — Claude Motion`

**Full loop wire-up:**
```
user types in ChatPanel
  -> useClaude.send(prompt, currentCode, selection)
  -> promptBuilder.buildPrompt(...)
  -> invoke('invoke_claude', { slug, prompt, sessionId })
  -> Rust: spawn claude CLI subprocess
  -> claude://token events -> ChatPanel streaming bubble
  -> claude://done -> codeExtractor.extractCode()
  -> esbuild worker validate (retry loop if syntax error)
  -> onCodeGenerated(code):
     1. invoke('save_animation', slug, code)
     2. Monaco.setValue(code)
     3. esbuild worker recompile -> preview auto-plays
     4. invoke('save_conversation', slug, messages)
```

---

## File Structure (final)

```
claude-motion/
  src/
    App.tsx
    main.tsx
    types/index.ts
    store/
      projectStore.ts
      uiStore.ts
    components/
      layout/
        Toolbar.tsx
        ProjectMenu.tsx
        ExportMenu.tsx
        StatusBar.tsx
      ChatPanel/
        ChatPanel.tsx
        MessageBubble.tsx
      CodePanel/
        CodePanel.tsx
      PreviewPanel/
        PreviewPanel.tsx
        PhoneBezel.tsx
        SafeZoneOverlay.tsx
        ReplayControls.tsx
      Onboarding.tsx
      Settings.tsx
    hooks/
      useClaude.ts
      useMonaco.ts
    workers/
      sandbox-compiler.worker.ts
    lib/
      promptBuilder.ts
      codeExtractor.ts
    assets/
      sandbox-frame.html
  src-tauri/
    src/
      main.rs
      lib.rs
      claude_bridge.rs
      commands/
        projects.rs
        claude.rs
        zip.rs
        export.rs
    resources/
      remotion-skills.txt
      remotion-mcp-config.json
    Cargo.toml
    tauri.conf.json
```

---

## Build Wave Summary

| Wave | Tickets | Workers needed |
|---|---|---|
| 1 | T-IMPL-001 | 1 |
| 2 | T-IMPL-002, T-IMPL-003, T-IMPL-004 | 3 |
| 3 | T-IMPL-005, T-IMPL-006, T-IMPL-007, T-IMPL-010, T-IMPL-011 | 5 |
| 4 | T-IMPL-008, T-IMPL-009, T-IMPL-012 | 3 |
| 5 | T-IMPL-013 | 1 |

---

## Verification (end-to-end smoke test)

Run after T-IMPL-013 completes:

1. Launch fresh (no projects) -> onboarding "Name your first animation" appears
2. Create project "Test Anim" -> 3-panel renders
3. Type "Create a bouncing red circle" -> tokens stream -> code in Monaco -> preview renders circle
4. Select the spring call in Monaco -> type "make it bouncier" -> Claude updates spring params only
5. Replay controls: play, pause, scrub to frame 75, step forward one frame
6. Toggle safe zone overlay -> red strips appear at correct positions
7. Export TSX -> native dialog opens -> file saved to Desktop
8. Export ZIP -> ZIP created; import ZIP -> duplicate project opens correctly
9. Close and relaunch -> last project auto-opens with full conversation history
10. Airplane mode on -> verify Claude still works (local CLI, no network needed post-install)
