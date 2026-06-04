---
id: frontend-backend-sync
root: architecture
type: architecture
status: current
summary: "Recommended sync strategy between Next.js frontend and Elysia backend after Claude editing sequences: server-side persist-before-DONE, optimistic preview, Zustand + localStorage safety net."
created: 2026-06-04
updated: 2026-06-04
---

# Frontend-Backend Sync After Claude Editing Sequences

## Context

The frontend holds live animation code in Zustand state. Claude streams a response (TSX code + prose) over SSE. After Claude finishes, three things must be persisted to the backend: (1) the new code version to S3 + DynamoDB ProjectVersion, (2) the assistant Message appended to the conversation, and (3) the Project item updated with the new `codeS3Key` and `codeVersion`. The question is how to trigger and confirm this sync reliably.

---

## 1. Sync Trigger

**Recommendation: server-side persist before closing the SSE stream; the `[DONE]` event carries the sync result.**

The `[DONE]` SSE event is the clean terminal signal. But instead of making the `[DONE]` event a pure signal and relying on the client to fire a separate sync request, the backend should do the persist _before_ emitting `[DONE]`, then include the saved metadata in the `[DONE]` payload.

Why server-side is better than a client-side POST after `[DONE]`:
- The server already has the full accumulated response in memory (it assembled it to stream to Claude).
- No race condition between "stream ended" and "sync request arrives."
- No extra round trip — the client has confirmation immediately when `[DONE]` fires.
- Atomicity: if the backend persist fails, it can emit an `[ERROR]` event instead of `[DONE]`, and the client knows to retry or surface the failure.

The backend must detect the end of the Claude response. Anthropic's SDK emits `message_stop` as the final streaming event; this is the moment to extract code, persist, and then close the SSE.

```ts
// Server: SSE stream handler (simplified)
async start(controller) {
  let fullText = ''
  try {
    for await (const chunk of anthropicService.streamCompletion(systemPrompt, userMessage)) {
      fullText += chunk
      controller.enqueue(sseChunk({ type: 'token', text: chunk }))
    }

    // Claude sequence complete — extract code and persist
    const extractedCode = extractTsxCodeBlock(fullText)
    const { versionId, messageId } = await conversationService.persistAfterStream({
      projectId, conversationId, assistantText: fullText, code: extractedCode
    })

    controller.enqueue(sseChunk({ type: 'done', versionId, messageId, hasCode: !!extractedCode }))
  } catch (err) {
    controller.enqueue(sseChunk({ type: 'error', message: String(err) }))
  } finally {
    controller.close()
  }
}
```

`persistAfterStream` runs three writes:
1. `S3.putObject` — upload code blob (if code was extracted).
2. `DynamoDB.PutItem` — write new `ProjectVersion` (if code was extracted).
3. `DynamoDB.PutItem` — append the assistant `Message`.
4. `DynamoDB.UpdateItem` — update `Project.updatedAt`, `codeS3Key`, `codeVersion` (if code was extracted).

Writes 1–4 can be parallelized except that the S3 key must be known before writes 2 and 4. In practice: fire S3 first (`await`), then run DynamoDB writes 2/3/4 in parallel.

**What counts as end-of-sequence:** the Anthropic SDK's `message_stop` event, which arrives after all `content_block_delta` events. The backend's async generator `streamCompletion` already exits the loop at this point (the generator completes). No need to inspect `stop_reason` separately.

**Mid-stream partials:** the client should not treat any mid-stream state as a "completed response." Code extraction and sync only happen server-side after the generator exits cleanly.

---

## 2. Optimistic vs Confirmed Sync

**Recommendation: optimistic preview, confirmed persistence.**

- **Optimistic preview**: update the Remotion composition in the iframe as tokens arrive. As soon as Claude starts producing TSX code in the stream, the client can parse the partial code block and hot-reload the preview. This gives the user live feedback without waiting for persist.
- **Confirmed persistence**: wait for the `done` SSE event (which carries `versionId`) before treating the edit as "saved." Update Zustand's `currentVersionId` and clear the "unsaved changes" indicator only when `done` arrives.

This means the UX has two states: "preview updating" (optimistic, during stream) and "saved" (confirmed, after `done`). A small indicator (e.g., a spinning dot -> checkmark in the editor header) communicates this without blocking the user.

Do NOT wait for the backend persist before updating the preview. That would add visible latency (the persist takes ~200-500ms after `[DONE]`) and makes the UX feel sluggish.

```ts
// Zustand store sketch
interface EditorStore {
  code: string           // current code (optimistic; updated during stream)
  syncedVersionId: string | null  // confirmed by backend; null = unsaved
  syncStatus: 'idle' | 'streaming' | 'saving' | 'saved' | 'error'
}

// On token received:
set({ code: accumulatedCode, syncStatus: 'streaming' })

// On done event:
set({ syncedVersionId: versionId, syncStatus: 'saved' })

// On error event:
set({ syncStatus: 'error' })
```

---

## 3. Conflict Resolution

**Recommendation: disable send while stream/sync is in-flight; no concurrent message ordering needed.**

This is a single-user tool with no collaboration. The user cannot (and should not) send a new message while a Claude sequence is running. The UI should disable the message input while `syncStatus` is `streaming` or `saving`.

If for some reason a second message is queued (e.g., via an API call or a race condition), the correct behavior is:
- **Queue, not last-write-wins.** The second message should wait until the first sync completes (`done` event received). This avoids using a stale project version as the Claude context base.
- Implemented as a simple `pendingMessage` field in Zustand. When `done` fires and `pendingMessage` is set, dispatch it immediately.

Last-write-wins (allowing concurrent messages that overwrite each other's versions) would corrupt version history and should not be used.

There is no need for CRDT or OT because code edits are not character-level concurrent; they are sequence-level (one full Claude response at a time).

---

## 4. Sync Feedback Channel

**Recommendation: piggyback on the existing SSE stream; no separate WebSocket or polling needed.**

The SSE stream already provides a bidirectional-enough channel for this use case:
- Tokens flow server-to-client during generation.
- The `done` event carries sync confirmation (`versionId`, `messageId`).
- The `error` event carries failure info.

No separate WebSocket, polling, or webhook is needed. The frontend gets sync confirmation in the same event stream it was already consuming.

The only additional consideration: if the backend persist takes longer than expected (e.g., a DynamoDB throttle), the SSE connection stays open until `done` fires. This is fine — SSE connections are long-lived by design and reconnect automatically. The backend should set a 30s timeout on the persist phase and emit an `error` event if it exceeds that.

**Fire-and-forget is explicitly not recommended.** If the frontend fires a sync POST and doesn't wait for confirmation, there is no reliable way to know whether the version was saved, which breaks the "unsaved changes" indicator and version history reliability.

---

## 5. Local-First Patterns

**Recommendation: localStorage checkpoint as a safety net; no ElectricSQL/PowerSync needed.**

ElectricSQL and PowerSync are designed for relational sync across multiple clients (multi-device, multi-user). They add significant infrastructure (a Postgres-backed sync server, a client-side SQLite store, conflict resolution at the row level). None of this complexity is warranted for a single-user, single-tab code editor.

The right "local-first" addition is a **localStorage checkpoint**:

```ts
// After each successful code extraction (optimistic, before persist):
localStorage.setItem(`draft:${projectId}`, JSON.stringify({
  code: extractedCode,
  timestamp: Date.now(),
  syncedVersionId: null  // not yet confirmed
}))

// After confirmed save (done event):
localStorage.setItem(`draft:${projectId}`, JSON.stringify({
  code: extractedCode,
  timestamp: Date.now(),
  syncedVersionId: versionId
}))

// On page load:
const draft = localStorage.getItem(`draft:${projectId}`)
if (draft) {
  const { code, syncedVersionId } = JSON.parse(draft)
  if (!syncedVersionId) {
    // Show "you have unsaved changes from a previous session" prompt
  }
}
```

This protects against: tab crash mid-sync, network error during persist, browser reload during generation. The draft code is always available even if the backend save failed.

Limit the localStorage entry to the last 1 draft per project (overwrite on each new generation). Don't try to build a full offline sync layer here.

---

## 6. Elysia-Specific

**No built-in sync/pub-sub in Elysia.** Elysia's primitives for this use case:

- `ReadableStream` for SSE — used to stream tokens and emit `done`/`error` events.
- `afterHandle` lifecycle hook — can be used to run side effects after the handler returns. However, for a streaming endpoint, `afterHandle` fires when the `ReadableStream` is _returned_ to Elysia, not when the stream _closes_. Do not rely on `afterHandle` for post-stream persistence; do the persist inside the `ReadableStream.start()` callback (before `controller.close()`), as shown in section 1.
- **Elysia does not have a built-in message queue or pub-sub.** If a future multi-user requirement needs server-to-client push (e.g., a collaborator's changes), the right addition is a Redis pub-sub channel or a Bun-native `BroadcastChannel`, not Elysia itself.

For the current single-user use case, no additional Elysia primitives are needed beyond the SSE pattern already established in the backend architecture.

---

## 7. Failure Handling

**Strategy: optimistic state preserved in Zustand + localStorage; one automatic retry; user toast on persistent failure.**

### Failure scenarios and responses

| Scenario | Detection | Response |
|---|---|---|
| S3 upload fails | `persistAfterStream` throws | Emit SSE `error` event; retry once after 2s; if still failing, emit `error` |
| DynamoDB throttle | `persistAfterStream` throws | Same retry logic |
| Network error during SSE stream | `EventSource` / `fetch` disconnects | Browser auto-reconnects SSE; for `fetch`+`ReadableStream`, client should retry the full request if it gets no `done` within 60s |
| Client-side tab crash before `done` | No signal | localStorage draft recovery on next load |
| Backend timeout during persist (>30s) | Server-side timeout | Emit SSE `error` event with `{ code: 'SYNC_TIMEOUT' }` |

### What NOT to lose

The code the user just generated (the optimistic state in Zustand + localStorage) must never be silently discarded. Even on backend failure, the user's code is preserved in the browser. They can:
1. Retry the save manually (a "Save" button or auto-retry).
2. Copy the code from the editor.
3. Reload and see the localStorage draft recovery prompt.

### Retry implementation

```ts
async function persistWithRetry(payload: SyncPayload, retries = 1): Promise<SyncResult> {
  try {
    return await conversationService.persistAfterStream(payload)
  } catch (err) {
    if (retries > 0) {
      await sleep(2000)
      return persistWithRetry(payload, retries - 1)
    }
    throw err
  }
}
```

One retry is sufficient. More aggressive retry is not warranted — if DynamoDB is throttling after two attempts, the right response is to surface the error and let the user decide, not to loop silently.

### User notification

On persistent failure: show a toast ("Could not save — your code is preserved in the editor. Try again?") with a manual retry button that re-POSTs the code. The "unsaved changes" indicator stays visible until confirmation.

---

## Recommended Sequence Diagram

```
User submits message
        |
        v
Frontend: disable input, set syncStatus='streaming'
        |
        v
POST /conversations/{id}/stream  -->  Elysia SSE handler opens
        |                                     |
        |                             Anthropic stream starts
        |                             tokens flow...
        v
SSE data: { type: 'token', text: '...' }  (many events)
        |
        v
Frontend: accumulate text buffer
Frontend: if partial TSX code block detected -> hot-reload preview (optimistic)
        .
        . (stream continues...)
        .
[Claude generation complete on backend]
        |
        v
Backend: extract TSX code block from full text
Backend: S3.putObject(code) -> codeS3Key
Backend: DynamoDB.PutItem(ProjectVersion) \
Backend: DynamoDB.PutItem(Message)         > in parallel
Backend: DynamoDB.UpdateItem(Project)     /
        |
        v
SSE data: { type: 'done', versionId, messageId, hasCode: true }
        |
        v
Frontend: set syncStatus='saved', syncedVersionId=versionId
Frontend: update localStorage draft with confirmed versionId
Frontend: re-enable input
Frontend: final preview render with confirmed code
        |
        v
[Flow complete]

--- On error path ---
Backend persist fails (after 1 retry):
        |
        v
SSE data: { type: 'error', code: 'SYNC_FAILED', message: '...' }
        |
        v
Frontend: set syncStatus='error'
Frontend: show toast with manual retry
Frontend: code stays in Zustand + localStorage (not lost)
```

---

## Summary: Recommended Decisions

| Question | Recommendation |
|---|---|
| Sync trigger | Server-side persist before `[DONE]`; `done` SSE event carries `versionId` |
| Optimistic vs confirmed | Optimistic preview during stream; confirmed save indicator after `done` |
| Conflict resolution | Disable input during stream/sync; queue pending message; no concurrent writes |
| Sync feedback channel | Piggyback on existing SSE stream; no WebSocket or polling needed |
| Local-first | localStorage draft checkpoint per project; no ElectricSQL/PowerSync |
| Elysia primitives | Persist inside `ReadableStream.start()` before `controller.close()`; no `afterHandle` for streaming endpoints |
| Failure handling | 1 auto-retry; preserve code in Zustand + localStorage; toast with manual retry on persistent failure |
