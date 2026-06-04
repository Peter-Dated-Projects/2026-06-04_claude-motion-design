---
id: synthesis
root: decisions
type: decision
status: current
summary: "Consolidated architecture decisions for the Claude motion design app, synthesized from 9 research streams."
created: 2026-06-04
updated: 2026-06-04
---

# Architecture Synthesis: Claude Motion Design App

This document is the single source of truth for all architectural decisions. Each section
references the relevant KB file for detail. When a decision here conflicts with a sub-document,
this document wins (it incorporates any updates made during the tester review pass).

---

## Stack Decisions at a Glance

| Layer | Decision | Rationale |
|---|---|---|
| Animation library | **Remotion** | Declarative JSX + frame-as-pure-function = most LLM-friendly format |
| Live preview sandbox | **esbuild-WASM in-browser + sandboxed iframe** | No server round-trip, ~100-400ms hot-reload, CSP-isolated |
| Claude auth | **User-supplied API key** | Anthropic has no OAuth for third-party apps (confirmed) |
| Claude key storage | **DynamoDB + AWS KMS envelope encryption** | AES-256-GCM with per-row IV; KMS audit trail |
| Streaming | **SSE via Anthropic SDK `.stream()`** | Unidirectional, reconnects automatically, no WS complexity |
| Code generation output | **Full file replacement wrapped in `<code>` tag** | More reliable than diffs; validation is trivial |
| v0 export | **TSX download + in-browser GIF (480px, gif.js)** | Zero infra; useful immediately |
| v0.5 export | **Remotion Lambda for MP4** | ~$0.05-$0.20/render, 60-120s, proper server-authoritative render |
| Auth | **Custom Google OAuth in Bun backend** | Single auth plane; no NextAuth dual-session complexity |
| Session tokens | **Opaque tokens in DynamoDB with sliding TTL** | Revocable (offboarding); negligible overhead at internal scale |
| Database | **DynamoDB single-table design** | All access patterns share a user/project root; ElectroDB for TypeScript |
| Code storage | **S3 pointers for animation code; inline for metadata** | DynamoDB 400KB item limit; S3 for version blobs |
| Backend framework | **Elysia on Bun** | Bun-native, end-to-end type inference, built-in SSE/WS support |
| DI pattern | **Manual container, 3-environment builders** | No decorators needed; fully typed; trivial to swap in tests |
| Test runner | **bun:test** | Zero config, 20-40x faster than Jest, Jest-compatible API |
| Code editor | **Monaco Editor (dynamic import)** | First-class selection API; TypeScript/JSX language support |
| State management | **Zustand** | Slice-based subscriptions; avoids Context re-render storm |
| Preview scaling | **CSS `transform: scale()` via ResizeObserver** | GPU-composited, no reflow |
| Next.js router | **App Router** | Server component pre-fetches project; client shell handles editor |
| Vercel runtime | **Edge for `/api/chat`; Node for auth/session** | No timeout on Edge streaming; DynamoDB SDK works on Node |

---

## Critical Non-Obvious Findings

These are the things that would have caused a wrong turn without the research.

### 1. Anthropic has no OAuth

There is no "connect Claude account" OAuth flow. Users must paste an API key from
console.anthropic.com. Claude.ai subscriptions do NOT grant API access — they are entirely
separate products. Onboarding copy must be explicit about this.

**Implication:** Store API key encrypted with KMS. Provide a clear "where do I get this?" link
in the UI. Users who only have Claude.ai Pro will be confused — address this proactively.

### 2. FFmpeg.wasm and MediaRecorder are dead ends for 1080x1920

Neither is viable at full resolution:
- FFmpeg.wasm: 8-20 min encode time; ~3.5 GB RAM for 450 frames. OOM on most machines.
- MediaRecorder: real-time only (15s video takes 15s to capture); canvas taint from cross-origin
  assets; Safari doesn't support canvas stream capture.

The only reliable MP4 path is server-side Remotion Lambda or a persistent render server.
Do not waste implementation time on either client-side approach.

### 3. Web Workers cannot run Remotion

Remotion's `<Player>` requires the DOM (`requestAnimationFrame`, `HTMLCanvasElement`). It cannot
run in a Web Worker or a Cloudflare Worker V8 isolate. The only viable preview sandbox is a
sandboxed iframe in the browser.

### 4. esbuild-WASM is 7 MB — cache it or pay a 1-3s first-load penalty

Load esbuild-WASM via a Service Worker cache. First cold compile is 1-3s (WASM init); subsequent
warm compiles are 100-400ms. Use a loading overlay for the first compile.

### 5. `hd` parameter in Google OAuth is a UX hint only — validate server-side

Stripping `hd=finks.ai` from the OAuth URL allows any Google account to sign in unless the server
validates `payload.hd === 'finks.ai'` after token exchange. Setting the consent screen to
"Internal" in Google Cloud Console adds a second layer of defense.

### 6. DynamoDB 400 KB item limit affects animation code

Complex Remotion components can easily exceed 400 KB. Store code in S3 at
`s3://motion-design-code/projects/{projectId}/versions/{versionId}/code.tsx` and keep only the
S3 key in DynamoDB. Do this from day one — retrofitting it is painful.

### 7. Remotion Lambda cold starts are the UX risk for MP4 export

Provisioned concurrency ($10-15/month per function) eliminates cold starts entirely. Budget for
this before launching MP4 export publicly. Without it, the first render request each morning
takes 15-20 seconds before rendering even begins.

### 8. Full file replacement beats diffs for LLM output

The research independently confirmed what Remotion's own AI tooling does: full file replacement
in a `<code>` tag. Diffs require the model to reason about the patch applying cleanly to a base
it cannot see directly. Full file adds tokens but eliminates a failure mode. At typical animation
file sizes (<200 lines) the token cost is immaterial.

---

## Architecture Diagram

```
Browser (Next.js on Vercel)
  |
  +-- ChatPanel (Zustand: messages, isStreaming)
  |      |
  |      +-- SSE stream -> Bun API /conversations/:id/stream
  |
  +-- CodePanel (Monaco Editor)
  |      |
  |      +-- onSelectionChange -> Zustand: selection { text, startLine, endLine }
  |      |
  |      +-- code changes -> esbuild Worker (esbuild-WASM)
  |                               |
  |                               +-- compiled bundle -> postMessage
  |
  +-- PreviewPanel
         |
         +-- sandboxed iframe (null origin, CSP: connect-src 'none')
                |
                +-- Remotion <Player> at 1080x1920, scaled via CSS transform
                |
                +-- postMessage receives compiled bundle + currentFrame

Bun API (deployed separately, e.g. Fly.io or Railway)
  |
  +-- Elysia routes (auth, projects, conversations, render)
  |
  +-- Manual DI container (prod/dev/test)
  |      |
  |      +-- prod: DynamoDBDocumentClient (real), Anthropic SDK (user key), S3Client
  |      +-- dev:  DynamoDB Local (localhost:8000), Anthropic SDK, S3 (localstack)
  |      +-- test: InMemoryRepositories, MockAnthropicService
  |
  +-- Services: AuthService, ProjectService, ConversationService,
  |             AnthropicService (streams to SSE), RenderService
  |
  +-- Repositories: UserRepository, ProjectRepository, ConversationRepository
         |
         +-- DynamoDB (ElectroDB): motion-design table (single-table)
         +-- S3: motion-design-code bucket (animation code blobs)

AWS
  +-- DynamoDB: motion-users, motion-sessions, motion-design tables
  +-- S3: motion-design-code bucket
  +-- KMS: CMK for API key encryption
  +-- Lambda (v0.5+): Remotion Lambda for MP4 export
```

---

## Monorepo Structure

```
/
  apps/
    web/          -- Next.js 15, App Router, Vercel deploy
    api/          -- Bun + Elysia monolith
  packages/
    types/        -- Shared TypeScript types (Project, Message, etc.)
    prompt/       -- SYSTEM_PROMPT constant + prompt builders (shared by api + tests)
```

---

## DynamoDB Tables

Three tables (separate from the single-table for projects/conversations):

| Table | PK | SK | Purpose |
|---|---|---|---|
| `motion-users` | `userId` | — | User profile + encrypted Anthropic key |
| `motion-sessions` | `sessionToken` | — | Auth sessions with sliding TTL |
| `motion-design` | `PK` (composite) | `SK` (composite) | Projects, versions, conversations, messages |

Plus one S3 bucket: `motion-design-code` for animation code blobs.

Full schema detail: see `dynamodb-schema.md` and `auth-google-oauth.md`.

---

## Claude Prompt Architecture

Every call to Claude uses the same structure:

```
System: SYSTEM_PROMPT (cached via cache_control: ephemeral)

User turn:
  [<current_code>...</current_code>]   -- omitted for first generation
  [<selection>...</selection>]         -- inline inside current_code, if user selected text
  <user_request>...</user_request>

Expected response: <code>...complete TSX...</code>
```

Validation pipeline: extract `<code>` tag -> TypeScript syntax check (esbuild transform) ->
import allowlist check -> render probe (frame 0 + frame 15) -> retry on failure (max 2 retries).

Full prompt template and example pairs: see `prompt-engineering.md`.

---

## v0 Implementation Order

This is the recommended build order to get to a usable product fastest:

1. **Auth** — Google OAuth (Bun backend, finks.ai domain restriction, DynamoDB sessions)
2. **API key onboarding** — collect + KMS-encrypt the user's Anthropic key
3. **Project CRUD** — create/list/open projects (DynamoDB + S3 for code)
4. **Chat panel + Claude streaming** — SSE from Bun -> Next.js EventSource; bare text for now
5. **Code panel** — Monaco Editor, read-only first, then editable, then selection tracking
6. **Live preview** — esbuild-WASM worker + sandboxed iframe + Remotion Player
7. **Full loop** — wire chat -> Claude -> code panel -> preview; validate error recovery
8. **TSX export** — download button; trivial once code is in state
9. **In-browser GIF export** — gif.js at 480px; "preview quality" label

v0.5 additions (after first user feedback):
- Remotion Lambda MP4 export
- Version history (ProjectVersion items in DynamoDB)
- Conversation history persistence (reload and resume)

---

## Key Open Questions (not resolved by research)

1. **Where does the Bun API deploy?** Fly.io and Railway are both viable. The Remotion server-side
   renderer (for v0.5 MP4 export) needs Chromium, which means a Docker-capable host with 2+ GB
   RAM. Fly.io machines scale to zero and support Docker. Confirm before infrastructure work.

2. **Single AWS account or separate per environment?** Separate accounts (dev/staging/prod) is the
   correct answer for IAM isolation, but adds setup time. For a small internal tool, a single
   account with environment-prefixed resource names is acceptable if access is tightly controlled.

3. **Font loading in the preview sandbox.** Google Fonts loaded from a cross-origin URL will taint
   the canvas (blocking MediaRecorder, which we're not using, but also potentially blocking
   Remotion's server-side renderer if fonts aren't allowed through the CSP). Pre-load fonts via
   the Remotion `@remotion/google-fonts` package or a self-hosted font proxy from day one.

4. **Model selection UX.** Research recommends Sonnet as default, Opus for complex generations,
   Haiku for quick tweaks. Should the user see this picker, or should the backend select
   automatically based on request complexity? Auto-selection is better UX but harder to implement
   correctly. Start with Sonnet-only and add the picker in v1.
