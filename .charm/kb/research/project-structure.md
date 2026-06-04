---
id: project-structure
root: research
type: research
status: current
summary: "Design proposal for the on-disk project layout: a src/ source tree (animation.tsx as entry) plus a chats/ folder holding N conversations, each with its own resumable embedded-CLI session id; covers the project.json schema evolution (schemaVersion, activeChatId, drop the dead sessionId), lazy-migrate-on-open from today's flat layout, and the touchpoints + phased sequencing (depends on T-014's compiler work). Key grounding: today's sessionId and conversation.json are both VESTIGIAL -- never written/read -- so multi-chat defines chat persistence for the first time, against an embedded claude CLI that keeps its own session store keyed by cwd."
created: 2026-06-04
updated: 2026-06-04
---

# Project file structure: src/ tree + multiple chats per project

RESEARCH / DESIGN PROPOSAL (T-040). No code was changed by this ticket. Every
claim about current behavior is grounded in the code at HEAD with file paths;
verify those paths before acting on this.

This note owns two layers T-014 did **not** cover: the overall on-disk **schema**
and the **multi-chat** model (storing N conversations per project). For the
`src/` tree, the compiler rewrite, the recursive watcher, the file map, and the
editor tree, T-014's `multi-file-architecture.md` is authoritative -- this note
aligns with and cites it rather than re-deriving it. Read that note first.

---

## TL;DR

1. Move source under `src/` (`src/animation.tsx` as the entry / default-export
   root, plus `src/components/`, `src/theme.ts`, `src/easing.ts` per T-014).
   Keep project metadata, `assets/`, and a new `chats/` folder at the project
   root, outside `src/`.
2. Add a `chats/` folder: one JSON file per chat, each carrying its own
   `id`, `title`, `createdAt`, `updatedAt`, the embedded-CLI `sessionId` it
   resumes, and (optionally) a mirrored message log. `project.json` gains
   `schemaVersion` and `activeChatId`.
3. **The load-bearing finding:** today's `sessionId` field and
   `conversation.json` are **both vestigial** -- nothing in the codebase writes
   or reads either (see "Grounding" below). So multi-chat is not generalizing a
   working single-chat mechanism; it is defining chat persistence for the first
   time. The hard part is not the JSON -- it is making the embedded `claude` PTY
   actually resume a specific session, which it does not do today.
4. Migration is `schemaVersion` + lazy-migrate-on-open: an unversioned project
   is migrated to v2 the first time it is opened, moving sources into `src/` and
   wrapping any existing conversation into a single chat. No data is lost, but
   because the vestigial fields were never populated, in practice there is little
   real data to migrate -- mostly a layout move.
5. Sequencing: the `src/` move can ship independently and should land with or
   just after T-014's Phase 2 (recursive watch + file map), because both touch
   `file_watch.rs` / `load_animation` / `save_animation` on the same paths.
   Multi-chat is a **separate, larger** effort gated on solving CLI session
   resume (section 2.4) and should not be blocked on the `src/` move.

---

## Grounding: how storage works today (verify before acting)

Each project is a folder at `{documentDir}/ClaudeMotion/projects/{slug}/`
(`projects.rs:127-139`, `claude_bridge.rs:68-74`; the root is hand-duplicated in
**four** places per decision 0002 -- `projects.rs`, `claude_bridge.rs`,
`export.rs`, `zip.rs`). The folder contains:

- `project.json` -- metadata. The Rust struct is `Project { id, name, slug,
  created_at, updated_at, session_id: Option<String> }` (`projects.rs:93-102`),
  serialized camelCase, mirrored by the TS `Project` interface
  (`types/index.ts:4-11`).
- `animation.tsx` -- the single source file the whole app is wired to. Seeded
  empty on create (`projects.rs:232-233`); read/written only by
  `load_animation` / `save_animation` (`projects.rs:258-277`).
- `conversation.json` -- seeded `"[]"` (`projects.rs:234-235`); read/written
  only by `load_conversation` / `save_conversation` (`projects.rs:279-306`),
  which (de)serialize a flat `Vec<Message>` where `Message { role, content,
  timestamp }` (`projects.rs:113-119`).
- `assets/` -- created on project create (`projects.rs:217`).

### The two findings that reframe this whole ticket

**Finding 1 -- `sessionId` is vestigial.** The field exists in the Rust struct
(`projects.rs:101`), is initialized to `None` on create (`projects.rs:227`), and
is mirrored in TS (`types/index.ts:10`). But a repo-wide search shows **no code
path ever writes a non-`None` value or reads it for any purpose** -- there is no
`set_session` command, and the PTY spawn does not consume it. It is dead schema.

**Finding 2 -- `conversation.json` is vestigial.** `save_conversation` /
`load_conversation` exist as Tauri commands (`projects.rs:279-306`) but have
**zero frontend callers** -- only `save_animation` / `load_animation` /
`terminal_open` are invoked from `src/` (App.tsx:201/245/320,
TerminalPanel.tsx:57). The chat is entirely the embedded `claude` terminal; no
app-managed message log is being persisted to `conversation.json`.

**Why this matters.** The embedded chat is a raw interactive `claude` PTY:
`pty_bridge.rs:87-90` spawns `claude --mcp-config <cfg> --append-system-prompt-file
<skills>` in the project dir, with **no `--resume` and no `--session-id`**. Every
`terminal_open` (TerminalPanel.tsx:57, fired on slug change) starts a **fresh**
session; a new open kills the previous one ("single active session",
pty_bridge.rs:14, 61-62). Continuity across opens is whatever the `claude` CLI
itself persists in its own session store -- which it keys by **working directory**
(the project dir). The app neither captures nor controls that session id.

So "today there is one `sessionId` + one `conversation.json`" is true only as
*schema*. Behaviorally there is **zero** app-managed chat persistence. Multi-chat
must therefore design chat persistence from scratch, and its central problem is
section 2.4 (making the PTY resume a chosen session), not the file layout.

### Other single-file couplings (from T-014, re-verified)

- `file_watch.rs` filters events to `animation.tsx` by name and emits one
  string. T-014 owns generalizing this to a recursive watch + file map.
- `export.rs:73-75` reads only `animation.tsx` (single-`.tsx` export). But
  `zip.rs` already zips the **whole** project folder (header lines 3-6, entries
  prefixed `{slug}/`), so the ZIP export/import path is *already* layout-agnostic
  and needs no change for `src/` or `chats/`. Only the single-file `.tsx` export
  is coupled.

---

## 1. Proposed directory layout

ASCII only. `src/` for source (aligned with T-014 section 4 option (b)); metadata,
`assets/`, and `chats/` stay at the project root, outside `src/`, so the recursive
source watch has an unambiguous scope (watch `src/`).

```
{documentDir}/ClaudeMotion/projects/{slug}/
  project.json            <- metadata: schemaVersion, id, name, slug,
                             createdAt, updatedAt, activeChatId
  src/                    <- THE source tree (watched recursively; T-014)
    animation.tsx         <- entry point / default-export root composition (*)
    theme.ts              <- shared design tokens (colors, fonts, spacing)
    easing.ts             <- shared spring/easing helpers
    components/           <- reusable presentational components
      Card.tsx
      Logo.tsx
  chats/                  <- N conversations (the new multi-chat layer)
    index.json            <- chat order + lightweight list (id,title,updatedAt)
    {chatId}.json         <- one chat: meta + sessionId + message log
    {chatId}.json
  assets/                 <- media referenced by the animation
    logo.png

  (*) = entry point. The bundler builds from src/animation.tsx and the sandbox
        renders its default export (window.AnimationExports.default).
```

Mapping from today's flat layout:

```
TODAY (flat)                         PROPOSED (v2)
  project.json            ---------->  project.json   (+ schemaVersion, activeChatId; - sessionId)
  animation.tsx           ---------->  src/animation.tsx
  conversation.json       ---------->  chats/{chatId}.json  (wrapped as one chat) + chats/index.json
  assets/                 ---------->  assets/   (unchanged)
  (Claude-created files)  ---------->  src/...   (e.g. src/components/*, moved under src/)
```

Design choices and why:

- **`src/` not flat root.** T-014 left flat-vs-`src/` open; this note recommends
  `src/` because the moment `chats/` exists at the root, a flat source layout
  makes the recursive watcher's "what is source?" filter ambiguous (it would have
  to exclude `chats/`, `assets/`, `project.json` by name). `src/` makes the watch
  scope a single directory. This is the more invasive option (touches
  `load_animation`/`save_animation`/export/prompt) but it pays for itself the
  instant multi-chat lands.
- **`chats/` outside `src/`.** Chats are project metadata, not compiled source.
  Keeping them out of `src/` means the bundler/watcher never sees them.
- **`chats/index.json`** is a denormalized convenience: the chat-switcher UI can
  render the list (id, title, updatedAt, ordering) without opening every chat
  file. It is rebuildable from the `{chatId}.json` files, so it is a cache, not a
  source of truth -- on any inconsistency, rebuild it by scanning `chats/*.json`.

---

## 2. Multiple chats per project (the core new design)

### 2.1 Per-chat file schema

One file per chat, `chats/{chatId}.json`:

```json
{
  "id": "f1e2d3c4-...",
  "title": "Intro animation pass",
  "createdAt": "2026-06-04T12:30:00Z",
  "updatedAt": "2026-06-04T13:05:00Z",
  "sessionId": "abc123-claude-cli-session-id-or-null",
  "messages": [
    { "role": "user", "content": "...", "timestamp": "..." },
    { "role": "assistant", "content": "...", "timestamp": "..." }
  ]
}
```

- `id` -- chat identifier, minted by the same `new_id()` UUIDv4-shaped helper
  projects already use (`projects.rs:44-65`). The filename is `{id}.json`.
- `title` -- human label for the switcher. Default "Chat 1", "Chat 2", ... or
  derived from the first user message; user-renameable.
- `createdAt` / `updatedAt` -- RFC3339 via the existing `now_rfc3339()`
  (`projects.rs:89-91`); `updatedAt` bumped on every message append, same pattern
  as `touch_updated_at` (`projects.rs:328-332`).
- `sessionId` -- **the resumable embedded-CLI session id for THIS chat.** This is
  the field that the old top-level `project.json.sessionId` should have been, now
  per-chat. `null` until the chat's first PTY session produces a resumable id
  (see 2.4 for the hard part: capturing it).
- `messages` -- optional mirrored log of the conversation (the `Message` shape
  already in `projects.rs:113-119`). See 2.5 on whether the app should maintain
  this at all.

`chats/index.json`:

```json
{
  "order": ["chatId-a", "chatId-b"],
  "chats": [
    { "id": "chatId-a", "title": "Intro animation pass", "updatedAt": "..." },
    { "id": "chatId-b", "title": "Outro variants", "updatedAt": "..." }
  ]
}
```

### 2.2 How a chat relates to the code it produces

**Recommendation: all chats in a project share the one `src/` tree. Chats are NOT
branches of the code.** A chat is a *conversation thread*; the code is the single
shared artifact all threads edit.

Rationale, grounded in how the app works:

- The preview, watcher, and (eventually) bundler all key off **one** entry,
  `src/animation.tsx` (T-014 section 4; `window.AnimationExports.default`). There
  is exactly one live preview per open project. Giving each chat its own code
  variant would require per-chat source trees, per-chat watch scopes, and a
  "which variant is the preview showing?" selector -- a large jump in complexity
  for a v1.
- The embedded `claude` CLI's cwd is the project dir (`pty_bridge.rs:67`). All
  chats run in that same cwd and therefore edit the same files. Per-chat code
  would mean per-chat cwd, which fragments the project on disk.

So: chats are like multiple conversations with the same engineer about the same
codebase -- "let's redo the intro" in one thread, "tweak the color palette" in
another -- all mutating one `src/` tree. This keeps the preview/watcher/export
contracts from T-014 completely unchanged.

(Branching the code per chat is a real future feature -- see Open Questions -- but
it is a different, bigger product and should not gate basic multi-chat.)

### 2.3 Active chat, switching, creating, deleting

- **Active chat** = `project.json.activeChatId`. It is the chat whose terminal
  session is currently bound to the embedded PTY and whose messages the UI shows.
  Exactly one active chat per open project (mirrors the "single active PTY
  session", pty_bridge.rs:14).
- **Switch chat:** set `activeChatId`, then re-bind the PTY to that chat's
  session. With today's PTY model that means `terminal_close` + `terminal_open`
  -- and to preserve the conversation, `terminal_open` must resume that chat's
  `sessionId` (section 2.4). Without resume, switching chats silently starts a
  fresh CLI session and the old conversation is only recoverable from the CLI's
  own cwd-keyed store, not per-chat. **This is why 2.4 is the real work.**
- **Create chat:** mint id, write `chats/{id}.json` with `sessionId: null` and
  empty messages, prepend to `index.json.order`, set `activeChatId`, open a fresh
  PTY session (no `--resume`). The first session establishes a new CLI session id
  to capture.
- **Delete chat:** remove `chats/{id}.json`, drop from `index.json`. If it was
  active, fall back to the most-recently-updated remaining chat (or create a
  fresh one if none remain, so a project always has >=1 chat). Deleting a chat
  does **not** touch `src/` -- the code it produced stays. Decide (Open
  Questions) whether to also tell the CLI to forget the underlying session.

### 2.4 The hard part: binding the PTY to a per-chat session

This is the crux, and it is genuinely unsolved in the current code.

Today: `pty_bridge.rs:87-90` spawns `claude` with `--mcp-config` and
`--append-system-prompt-file` but **no session flags**. To make N chats each
resume their own conversation, two things must be added:

1. **Capture** the CLI session id a fresh session creates, and store it on the
   chat's `sessionId`. The Claude CLI writes session state under its own config
   dir keyed by cwd; the app needs a reliable way to learn the id of the session
   it just spawned (e.g. a CLI flag to set/emit the session id, or reading the
   CLI's session index for this cwd). This needs verification against the actual
   `claude` CLI surface available in this app -- do not assume a specific flag
   exists; spike it.
2. **Resume** a stored session when binding a chat: spawn with the
   resume/session flag set to the chat's `sessionId`. `PtyBridge::open` would
   take an optional `session_id` and append the appropriate flag.

Honest risk: if the embedded `claude` CLI does not expose stable
set-session-id / resume-by-id flags in this app's version, true multi-chat
resume is not achievable without a CLI upgrade or a different integration (e.g.
the app managing transcripts itself and replaying context). In that case the
fallback is 2.5's "app-owned transcript" model, where the app stores messages and
the resume story is best-effort. **Validate the CLI session surface before
committing to the per-chat-`sessionId` design** -- it is the load-bearing
assumption.

### 2.5 Should the app mirror messages into `{chatId}.json`?

Two options:

- **(a) Session-id only (thin).** Store just `sessionId` per chat; let the CLI
  own the transcript. The `messages` array stays empty/absent. Simplest, but the
  chat list cannot show a preview of the conversation, and history is only as
  durable as the CLI's store. Depends entirely on 2.4 working.
- **(b) App-owned transcript (thick).** The app captures terminal I/O (or hooks
  the CLI) and writes `messages` into `{chatId}.json`, reviving the dormant
  `Message` type and `save_conversation`-style persistence. More robust and
  switcher-friendly, and it is the natural fallback if 2.4's resume cannot be made
  reliable -- but capturing clean structured messages from a raw xterm PTY stream
  (TerminalPanel pipes raw bytes, TerminalPanel.tsx:97-99) is non-trivial.

Recommendation: start **(a)** if 2.4's session resume verifies; keep `messages`
in the schema as optional so (b) can be layered in for the switcher preview
without a schema break. If 2.4 does **not** verify, (b) becomes mandatory.

---

## 3. Metadata schema evolution

`project.json` v2 (Rust `Project`, `projects.rs:93-102`; TS `types/index.ts:4-11`):

```jsonc
{
  "schemaVersion": 2,        // NEW: absent/0/1 => legacy flat layout
  "id": "...",
  "name": "...",
  "slug": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "activeChatId": "chatId-a" // NEW: which chat is bound to the PTY
  // sessionId: REMOVED from project.json -> moves per-chat (chats/{id}.json)
}
```

- **Add `schemaVersion`** (integer). Drives lazy migration (section 5). Treat
  absent as legacy (v1/flat).
- **Add `activeChatId`** (string). The currently bound chat.
- **Drop `sessionId`** from `project.json`. It was vestigial (Finding 1); its
  *intent* (a resumable CLI session) now lives per-chat as
  `chats/{id}.json.sessionId`. Removing it from the top level is the honest move
  -- keeping a second, project-level session id would re-create the ambiguity
  multi-chat is meant to resolve.

Rust impact: `Project` gains `schema_version: u32` and `active_chat_id:
Option<String>`, loses `session_id`. `ProjectMeta` (`projects.rs:104-111`) is
unchanged (it already omits sessionId). A new `Chat` struct mirrors 2.1. Because
`read_project_meta` uses `serde_json::from_str` (`projects.rs:164-169`), make new
fields tolerant: `#[serde(default)]` on `schema_version` / `active_chat_id` so a
legacy `project.json` still deserializes (this is what makes lazy migration
possible -- see section 5).

---

## 4. Components / code organization conventions

Aligned with T-014 section 4 so the prompt and compiler agree:

- `src/animation.tsx` -- entry; the only default export the sandbox renders.
- `src/components/` -- reusable presentational components (named exports).
- `src/theme.ts` -- shared design tokens (colors, fonts, spacing).
- `src/easing.ts` -- shared spring/easing helpers (the prompt already teaches a
  spring vocabulary; this is its home).
- Cross-file imports are **relative** (`./`, `../`) only; the only permitted bare
  imports are `react`, `remotion`, `@remotion/player` (T-014 section 1's
  resolver errors on anything else). No third-party npm.

`remotion-skills.txt` must teach this layout (T-014 section 5 owns the prompt
edits) -- and must not be flipped to multi-file until the bundler supports it
(T-014's sequencing warning). Establishing `src/` as the root in the prompt is
part of the same prompt change.

---

## 5. Migration (schemaVersion + lazy-migrate-on-open, no data loss)

Trigger migration in `open_project` (`projects.rs:240-247`): read
`project.json`; if `schemaVersion` is absent or `< 2`, run `migrate_v1_to_v2`
before returning, then re-read.

`migrate_v1_to_v2(dir)`:

1. Create `src/` if absent. Move `animation.tsx` -> `src/animation.tsx`. Move any
   other Claude-created `.tsx`/`.ts` at the root into `src/` (preserving relative
   structure; `components/` -> `src/components/`). Leave `assets/` and
   `project.json` at the root.
2. Create `chats/`. If `conversation.json` exists and is a non-empty array,
   wrap it into one chat file: mint a chat id, write `chats/{id}.json` with
   `title: "Imported chat"`, the parsed messages, `sessionId: null` (the legacy
   top-level `sessionId` was vestigial, so there is no real session to carry
   over -- if it ever held a value, copy it, but expect `null`). If
   `conversation.json` is empty/absent, create one empty default chat. Write
   `chats/index.json`. Set `project.json.activeChatId` to that chat.
3. Set `schemaVersion: 2`, drop `sessionId`, write `project.json`.
4. Leave the old `animation.tsx` / `conversation.json`? **No -- move, do not
   copy**, to avoid two sources of truth the watcher could both see. But do the
   moves atomically per file and only delete the originals after the new files
   are written, so a crash mid-migration leaves a recoverable state.

Because both legacy fields were vestigial (section "Grounding"), in practice
migration is mostly the `src/` move plus seeding one empty chat -- there is rarely
real conversation data to preserve. Still implement the wrap step: any project
where someone manually populated `conversation.json` must not lose it.

Safety:

- Idempotent: a v2 project is detected by `schemaVersion >= 2` and skipped.
- `#[serde(default)]` on the new fields (section 3) means a half-migrated or
  legacy file still deserializes, so a failed migration never bricks
  `list_projects` (which already skips unparseable folders, `projects.rs:190-191`).
- Lazy (on open), not a bulk migration on startup: only touches projects the user
  actually opens, and never runs on a project being read by `list_projects`.

---

## 6. Touchpoints and sequencing

Code areas that change, grouped by the two independent efforts:

### Effort A -- `src/` move (ships with/after T-014 Phase 2)

- `projects.rs`: `create_project` seeds `src/animation.tsx` (not root);
  `load_animation`/`save_animation` target `src/animation.tsx`;
  `read/write_project_meta` learn the v2 fields; add `migrate_v1_to_v2` in
  `open_project`.
- `file_watch.rs`: watch `src/` recursively + emit a file map -- **owned by
  T-014 Phase 2**. The `src/` move and the recursive watch must land together (or
  the watcher move must come first), because both rewrite the same
  `animation.tsx`-path assumption; splitting them risks a window where the watcher
  watches the old path.
- `export.rs`: single-`.tsx` export reads `src/animation.tsx`; for a real
  multi-file export, copy the `src/` tree (T-014 Phase 5). `zip.rs` needs **no
  change** -- it already zips the whole folder.
- `remotion-skills.txt`: teach `src/` + conventions -- **owned by T-014
  section 5 / Phase 3**, ships in lockstep with the bundler.

### Effort B -- multi-chat (separate, larger, gated on 2.4)

- `projects.rs`: add `Chat` struct + commands: `list_chats`, `create_chat`,
  `delete_chat`, `rename_chat`, `set_active_chat`, `load_chat`, and
  `save_chat_messages` (reviving the dormant `Message` persistence). Maintain
  `chats/index.json`.
- `pty_bridge.rs`: `PtyBridge::open` takes an optional `session_id` and appends
  the CLI resume/session flag (section 2.4). Capture the session id a fresh
  session creates and persist it to the active chat. **This is the
  spike/verification gate -- do not build the rest of B until the CLI session
  surface is confirmed.**
- `claude_bridge.rs` / `pty_bridge.rs`: cwd stays the project dir (shared `src/`
  tree); no per-chat cwd.
- Frontend: chat switcher UI (likely in/near `TerminalPanel` or a new chat rail),
  `projectStore` gains chat list + `activeChatId`, `terminal_open` carries the
  active chat's session, and (option 2.5b) terminal output capture -> messages.
  `types/index.ts`: add `Chat`; update `Project` (drop `sessionId`, add
  `schemaVersion`, `activeChatId`).

### Phased order (each step leaves the app working)

1. **A1 -- schema + migration, no behavior change.** Add `schemaVersion` /
   `activeChatId` (serde-default), `migrate_v1_to_v2`, move source to `src/`,
   point `load/save_animation` at `src/animation.tsx`. Coordinate with T-014's
   watcher change so the watched path moves at the same time. App still
   single-chat; preview unchanged.
2. **A2 -- (T-014 Phases 1-4)** bundler + recursive watch + file map + read-only
   file tree. Multi-file works; still single-chat.
3. **B0 -- session-resume spike (GATE).** Prove `claude` can set/capture/resume a
   session id in this app. Green -> proceed; red -> fall back to 2.5(b)
   app-owned-transcript design before proceeding.
4. **B1 -- chats backend.** `chats/` schema, chat commands, per-chat `sessionId`,
   `PtyBridge::open(session_id)`. `create_project` seeds one default chat.
5. **B2 -- chat switcher UI.** List/create/switch/delete/rename; re-bind PTY on
   switch.
6. **B3 -- transcript mirroring (optional / required-if-B0-red).** Capture
   messages into `{chatId}.json` for switcher previews and durability.
7. **A3 -- multi-file export** (T-014 Phase 5): copy the `src/` tree.

Dependency summary: **A1 must coordinate with T-014's watcher move (Phase 2).
Effort B depends on A1 (for `activeChatId` on `project.json`) but is otherwise
independent of T-014's compiler work and is gated on its own B0 spike.**

---

## 7. Honest tradeoffs and open questions for Peter

- **The whole multi-chat resume story hinges on the embedded CLI's session
  surface (2.4), which is unverified.** If `claude` in this app cannot reliably
  set/capture/resume a session id by id, per-chat `sessionId` does not work and
  we are forced into app-owned transcripts (2.5b) with best-effort resume. This
  is the single biggest risk and the first thing to spike. Do not design the UI
  around guaranteed resume until B0 is green.
- **We are designing persistence for features that were never wired.** Both
  `sessionId` and `conversation.json` are vestigial today. That is freeing (no
  legacy data to preserve, so migration is mostly a layout move) but also a
  warning: the previous attempt to model a session id on `project.json` was added
  and never used. Confirm there is real product demand for multiple chats before
  paying the B-effort cost -- a single embedded terminal may be enough for the v0
  wedge.
- **Chats share one `src/` tree vs. branching code per chat.** This note
  recommends shared (2.2) for v1 because per-chat code variants explode the
  preview/watcher/export model. But "fork the animation in a new chat and compare"
  is a genuinely compelling product feature for a motion-design tool (try-three-
  directions). It is a separate, bigger effort (per-chat source snapshots + a
  preview selector); flag it as a deliberate future, not an oversight.
- **`src/` move cost.** Moving sources under `src/` is more invasive than keeping
  them flat (touches load/save/export/prompt and must coordinate with T-014's
  watcher). The payoff is an unambiguous watch scope once `chats/` and `assets/`
  share the root. If multi-chat is deferred indefinitely, the flat layout (T-014
  option (a)) stays viable and the `src/` move can wait.
- **Complexity vs. the single-file simplicity we have.** Today's flat one-file
  project is dead simple and the app works. Both `src/` and multi-chat add real
  surface (a `Chat` type, 6+ new commands, PTY session plumbing, a switcher UI,
  migration). Sequence so each step ships value alone (the phased plan does this),
  and be willing to stop after the `src/` move if multi-chat does not earn its
  keep.
- **Transcript capture from a raw PTY (if 2.5b).** TerminalPanel streams raw
  bytes (TerminalPanel.tsx:97-99); reconstructing clean structured user/assistant
  messages from an xterm stream is fiddly. If we need app-owned transcripts,
  investigate whether the CLI can emit a structured session log we read instead of
  scraping the terminal.
