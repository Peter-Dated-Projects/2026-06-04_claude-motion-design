---
id: anthropic-api-integration
root: architecture
type: architecture
status: current
summary: "Anthropic has no OAuth for third-party apps; user-supplied API keys are the only billing-delegation path, stored encrypted in DynamoDB via KMS."
created: 2026-06-04
updated: 2026-06-04
---

# Anthropic / Claude API Integration

Research for T-003. Covers OAuth feasibility, key storage, billing model, model selection, streaming, structured output, and context window strategy.

---

## 1. OAuth / OIDC — not available

As of mid-2025, **Anthropic does not offer OAuth 2.0 or OIDC** for third-party applications. There is no "Sign in with Claude" or delegated-billing flow. The only public-facing auth surface is console.anthropic.com, which is for direct customers only.

**Implication:** The app cannot bill API calls to a user's Anthropic account automatically. The only viable delegation path is having the user paste their own API key into the app.

---

## 2. User-supplied API key — UX and security model

Since OAuth is unavailable, users must supply their own Anthropic API key. The recommended pattern:

### Collection UX
- Prompt once during onboarding, after Google OAuth login.
- Show a masked input (`sk-ant-...••••••••`) with a "reveal" toggle.
- Link directly to console.anthropic.com/settings/keys with "Create key" instructions.
- Never log or echo the raw key in server responses.

### Storage — encryption at rest
Store in DynamoDB with envelope encryption:

```
Table: UserSettings (pk: userId)
  anthropicApiKeyEncrypted: Buffer   // AES-256-GCM ciphertext
  anthropicApiKeyIv: string          // 12-byte IV, base64
  anthropicApiKeyTag: string         // 16-byte GCM auth tag, base64
```

Use **AWS KMS** (CMK per-tenant or shared CMK with per-row context) for the data encryption key. Pattern:

1. On save: call `kms.generateDataKey()`, encrypt the API key with the plaintext DEK, store ciphertext + encrypted DEK + IV.
2. On use: call `kms.decrypt()` to recover DEK, decrypt API key in-memory, pass to SDK call, discard DEK immediately.

Never store the plaintext key or DEK in DynamoDB. KMS audit trail via CloudTrail gives you per-use logging for free.

### Key scoping
Anthropic API keys are not yet scopable per endpoint or model (as of mid-2025 — this may change). Communicate this to users: their key grants full Anthropic API access, so they should create a dedicated key for this app and can revoke it independently.

### Key rotation
Provide a "Rotate API key" button in settings — it re-runs the same collect → encrypt → store flow and overwrites the old ciphertext.

---

## 3. Billing model — Claude.ai subscription vs Anthropic API

These are **two separate products with separate billing**:

| Product | What it gives | Billing |
|---|---|---|
| Claude.ai (claude.ai) | Chat interface, Projects, some integrations | Subscription ($20/mo Pro, $25/mo Team) |
| Anthropic API (api.anthropic.com) | Programmatic access, SDK, all models | Pay-per-token (no subscription; prepaid credits or invoice) |

A Claude.ai Pro subscription gives **no API access**. Users who only have a Claude.ai account must separately sign up at console.anthropic.com and add a credit card for API billing.

**Implication for onboarding copy:** Be explicit — "You need an Anthropic API key from console.anthropic.com, not your Claude.ai login."

---

## 4. Model selection for Remotion TSX code generation

Recommended hierarchy (as of June 2026):

| Model | Use case | Notes |
|---|---|---|
| `claude-sonnet-4-6` | Default for code generation | Best cost/quality tradeoff; 200k context; fast enough for streaming UX |
| `claude-opus-4-8` | Complex multi-component animations | Slower, ~5x cost; reserve for "expert mode" or large refactors |
| `claude-haiku-4-5` | Autocomplete / short suggestions | Fast and cheap; good for incremental prop edits |

For the "generate animation" flow, default to `claude-sonnet-4-6`. Give users a model picker in settings with Haiku (fast/cheap) and Opus (best quality) as alternates.

---

## 5. Streaming — SSE, fully supported

The Anthropic SDK supports **Server-Sent Events (SSE) streaming** natively. No WebSocket needed.

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: userKey });

const stream = await client.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 8192,
  messages: [{ role: "user", content: prompt }],
});

// Stream text deltas to the client
for await (const event of stream) {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    res.write(`data: ${JSON.stringify({ delta: event.delta.text })}\n\n`);
  }
}

const final = await stream.finalMessage();
```

On the backend (Bun), forward the SSE stream to the browser using a standard `text/event-stream` response. The Remotion preview panel can update incrementally as code arrives, giving a responsive feel even for large components.

**SSE vs WebSocket:** SSE is strictly better here — unidirectional server-to-client, simpler to implement, works over HTTP/2, and the Anthropic SDK wraps it cleanly. WebSocket adds complexity for no gain in this use case.

---

## 6. Tool use / structured output

Use **tool use (function calling)** to get reliably structured output from Claude rather than parsing free-form text.

Define a tool that Claude must call to return animation code:

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: "create_remotion_component",
    description:
      "Return a complete Remotion animation component. Call this once with the final implementation.",
    input_schema: {
      type: "object",
      properties: {
        componentName: {
          type: "string",
          description: "PascalCase name for the React component",
        },
        code: {
          type: "string",
          description:
            "Complete TSX source for the component, including all imports",
        },
        durationInFrames: {
          type: "number",
          description: "Total animation duration in frames (at 30fps)",
        },
        fps: { type: "number", description: "Frames per second, default 30" },
        width: { type: "number" },
        height: { type: "number" },
        description: {
          type: "string",
          description: "One-sentence description of what the animation does",
        },
      },
      required: ["componentName", "code", "durationInFrames"],
    },
  },
];
```

Force Claude to call the tool by setting `tool_choice: { type: "tool", name: "create_remotion_component" }`. This eliminates prose-wrapping and makes parsing deterministic.

For streaming + tool use combined, use `client.messages.stream()` and listen for `input_json_delta` events to stream the JSON arguments character-by-character (the `code` field will stream token-by-token, enabling live preview updates).

---

## 7. Context window and chunking

| Model | Context window |
|---|---|
| claude-sonnet-4-6 | 200,000 tokens |
| claude-opus-4-8 | 200,000 tokens |
| claude-haiku-4-5 | 200,000 tokens |

A typical Remotion project with 5-10 components runs well under 50k tokens including full source. Context limits are unlikely to be a constraint in practice for individual animation generation.

**Where limits bite:**
- Long conversation histories: a chat session with 50+ messages of back-and-forth edits can accumulate. Implement a rolling window — keep the system prompt + last N turns + full current component source.
- Large asset lists: if the user's project includes many existing components for "edit this to match" context, summarize rather than include full source.

**Recommended chunking strategy:**
1. System prompt: ~500 tokens (Remotion conventions, output format instructions).
2. Current component source: always include in full (typically 200-2000 tokens).
3. Conversation history: last 10 turns, oldest turns summarized to one sentence each.
4. User message + any uploaded reference assets: variable.

Use `client.messages.countTokens()` before each request in dev to validate. At 150k+ tokens, consider summarizing history more aggressively.

---

## Prompt skeleton — "generate animation" use case

```typescript
const SYSTEM_PROMPT = `You are an expert Remotion animation developer. 
You generate TypeScript/TSX Remotion components that are:
- Self-contained (all imports included)
- Animated using Remotion hooks: useCurrentFrame, useVideoConfig, interpolate, spring
- Visually polished with smooth easing
- Typed correctly (no TypeScript errors)

When given a description, always call the create_remotion_component tool with your implementation.
Do not explain the code — just implement it.`;

function buildGeneratePrompt(userRequest: string, existingCode?: string) {
  const parts = [userRequest];
  if (existingCode) {
    parts.push(
      `\n\nHere is the current component to modify:\n\`\`\`tsx\n${existingCode}\n\`\`\``
    );
  }
  return parts.join("");
}
```

Key prompt engineering choices:
- "Do not explain the code" suppresses prose that bloats token count and delays streaming.
- Listing Remotion hooks by name grounds Claude in the right API surface.
- Including existing code in the prompt for edits keeps Claude from rewriting from scratch.

---

## Summary

| Question | Answer |
|---|---|
| Anthropic OAuth for third-party apps? | No — not available as of mid-2025 |
| User billing delegation? | User supplies their own API key |
| Key storage | DynamoDB + KMS envelope encryption |
| Claude.ai sub = API access? | No — separate products |
| Best model for code gen | `claude-sonnet-4-6` (default); Opus for complex |
| Streaming | SSE via SDK `.stream()`, forward as `text/event-stream` |
| Structured output | Tool use with `tool_choice: {type:"tool"}` |
| Context limit concern? | Low — 200k window; manage history rolling window |
