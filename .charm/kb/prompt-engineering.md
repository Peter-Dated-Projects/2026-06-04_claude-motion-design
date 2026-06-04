# Prompt Engineering for Animation Code Generation

Research findings for T-009. Covers system prompt design, context-passing strategy, output format, error recovery, and worked examples for all five use cases.

---

## 1. System Prompt Structure

The system prompt has three jobs: (a) constrain output format so it is always parseable, (b) give Claude enough animation vocabulary to make sensible decisions without being asked, and (c) set behavioral guardrails (no markdown prose, no explanatory comments inside the TSX unless asked).

### Recommended template

```
You are an expert Remotion animation engineer. Your only output is a single TypeScript/React file (TSX) that can be dropped directly into a Remotion composition.

Rules:
- Output the COMPLETE file, from the first import to the last line. No truncation, no "..." placeholders.
- Wrap the entire file in a single <code> XML tag and nothing else. Do not add markdown fences, prose, or explanation outside that tag.
- Every animation MUST use Remotion's `useCurrentFrame`, `useVideoConfig`, and `spring`/`interpolate` primitives. Never use CSS transitions or setTimeout.
- Default composition: 30 fps, 150 frames (5 seconds), 1920x1080. Use `useVideoConfig()` to read these at runtime; do not hardcode them.
- Spring physics defaults unless the user specifies otherwise: { mass: 1, damping: 12, stiffness: 100 }.
- Keep component names PascalCase and export a single default component.
- Do not import anything that isn't available in a standard `@remotion/player` + React 18 environment.

Animation vocabulary you may use freely:
- Easing: `Easing.bezier`, `Easing.spring`, `Easing.linear`, `Easing.out(Easing.ease)`, `Easing.inOut(Easing.cubic)`
- Remotion helpers: `spring`, `interpolate`, `interpolateColors`, `useCurrentFrame`, `useVideoConfig`, `Sequence`, `Audio`, `Img`, `AbsoluteFill`
- Spring parameters: mass, damping, stiffness, overshootClamping
- Keyframe idiom: `interpolate(frame, [0, 15, 30], [0, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })`

If the request is ambiguous, make a creative choice and implement it. Do not ask clarifying questions.
```

### Why full-file output

LLMs produce fewer errors when they regenerate the whole file than when they produce a partial diff. Partial output requires the model to (a) understand its own prior output perfectly and (b) produce a syntactically valid patch — two failure modes instead of one. Full replacement also makes client-side validation trivial: parse the TSX, compile it, done. The cost is token usage, which is acceptable given typical animation files are under 200 lines.

---

## 2. Context-Passing Strategy

### Problem

A running animation conversation can accumulate: the original generation, several edits, error messages, and user messages. Naively passing all of it blows the context window and degrades generation quality (the model attends to more irrelevant history).

### Strategy: rolling single-file context

Pass only the **current code** (the last successful compile), not the full conversation history. Structure the user turn as:

```
<current_code>
{{ full TSX of the current animation }}
</current_code>

<user_request>
{{ what the user wants changed }}
</user_request>
```

This gives Claude exactly what it needs: a concrete starting point and a delta. It does not need to know how the file got to its current state.

**Token budget:** A 200-line TSX file is ~2,000 tokens. Claude Sonnet has a 200k-token context, so even with the system prompt (~500 tokens) and five turns of history plus current code, the budget is trivially fine. Only very large animation files (>2,000 lines) warrant summarization — and those indicate a design problem (split into multiple compositions).

### When the file is "new" (generate from scratch)

Omit the `<current_code>` block entirely. The system prompt already tells Claude to start from scratch.

---

## 3. Selection-Based Edit Annotation

When the user highlights a region of the code (a specific component, a keyframe block, a spring call), annotate it in the prompt with `<selection>` tags:

```
<current_code>
import { ... } from 'remotion';

export default function LogoReveal() {
  const frame = useCurrentFrame();

  <selection>
  const scale = spring({
    frame,
    fps: 30,
    config: { mass: 1, damping: 12, stiffness: 100 },
  });
  </selection>

  return <AbsoluteFill style={{ transform: `scale(${scale})` }} />;
}
</current_code>

<user_request>
Make this more elastic — higher overshoot, slower settle.
</user_request>
```

Claude reliably respects `<selection>` tags as "this is the region of interest." The instruction in the system prompt should reinforce this:

> When the user's request contains a `<selection>` block inside `<current_code>`, apply the requested change primarily to that region. Preserve the rest of the file exactly.

---

## 4. Full File Replacement vs Diff

**Recommendation: full file replacement.**

| Criterion | Full file | Diff |
|---|---|---|
| LLM reliability | High — model generates coherent whole | Lower — patch must apply cleanly to unknown base |
| Client complexity | Low — replace file contents | High — apply patch, handle failures |
| Token cost | Higher (~2x) | Lower |
| Error surface | One: generate valid TSX | Two: generate valid TSX + generate valid patch |
| Validation | Straightforward | Must validate both patch and result |

Diffs (unified diff, search/replace blocks) become worth considering only when file size exceeds ~500 lines and token costs become material. At that scale, the project should already be split into multiple Remotion compositions anyway.

If diff output is ever needed, use a **structured search/replace format** rather than unified diff — it is far more reliably produced by LLMs:

```xml
<replace>
  <old>
  // exact lines to replace
  </old>
  <new>
  // replacement lines
  </new>
</replace>
```

---

## 5. Error Recovery Pattern

### Validation steps (in order)

1. **Extract** — pull the content from the `<code>` tag. If no tag found, retry once with the prompt: `"Your response did not include a <code> tag. Output only the complete TSX file inside a <code> tag."`
2. **Syntax check** — run the extracted string through a TypeScript parser (e.g. `@typescript-eslint/parser` or `esbuild` in transform-only mode). If it fails, collect the error message.
3. **Import check** — verify all imports are from the allowlist (`react`, `remotion`, `@remotion/*`). Reject unknown imports.
4. **Render probe** — mount the component in a headless Remotion player for frame 0 and frame 15. Catch any runtime exceptions.

### Retry prompt on failure

```
<current_code>
{{ the broken TSX Claude generated }}
</current_code>

<error>
{{ compiler / runtime error message }}
</error>

<user_request>
Fix the error above and return the corrected file.
</user_request>
```

**Retry budget:** two retries max. On third failure, surface the raw error to the user rather than burning more tokens. In practice, one retry resolves >90% of syntax errors because the model can see exactly what it got wrong.

### Validation loop pseudocode

```typescript
async function generateWithRetry(prompt: string, maxRetries = 2): Promise<string> {
  let attempt = 0;
  let lastCode = '';
  let lastError = '';

  while (attempt <= maxRetries) {
    const userTurn = attempt === 0
      ? buildInitialTurn(prompt)
      : buildRetryTurn(lastCode, lastError);

    const response = await claude.complete({ system: SYSTEM_PROMPT, user: userTurn });
    const code = extractCodeTag(response);

    if (!code) {
      lastError = 'No <code> tag found in response.';
      attempt++;
      continue;
    }

    const syntaxError = await checkSyntax(code);
    if (syntaxError) {
      lastCode = code;
      lastError = syntaxError;
      attempt++;
      continue;
    }

    const runtimeError = await renderProbe(code);
    if (runtimeError) {
      lastCode = code;
      lastError = runtimeError;
      attempt++;
      continue;
    }

    return code; // success
  }

  throw new Error(`Generation failed after ${maxRetries} retries. Last error: ${lastError}`);
}
```

---

## 6. Animation-Specific Vocabulary

Include the following concepts in the system prompt (or in a dedicated reference section Claude can consult):

### Motion principles
- **Overshoot**: spring goes past target before settling; controlled by low `damping` or high `stiffness`
- **Anticipation**: object moves slightly backward before the main motion (frame delay + negative translate)
- **Follow-through**: secondary elements lag behind the primary by N frames (use `delay` in `spring`)
- **Squash and stretch**: scale x/y inversely during impact frames

### Remotion-specific
- `spring({ frame, fps, config, delay, from, to })` — physics-based interpolation, always frame-accurate
- `interpolate(value, inputRange, outputRange, options)` — linear mapping with optional easing and clamp
- `Sequence` with `from` and `durationInFrames` — compositional timing
- `useCurrentFrame()` is the single source of truth for time; never use `Date.now()` or `setTimeout`
- Frame 0 is the first frame rendered; the composition length is `durationInFrames` from `useVideoConfig()`

### Common easing idioms
```typescript
// Ease out cubic (decelerate into target)
Easing.out(Easing.cubic)

// Ease in-out (smooth acceleration + deceleration)
Easing.inOut(Easing.ease)

// Custom bezier (like CSS cubic-bezier)
Easing.bezier(0.25, 0.1, 0.25, 1)

// Bounce (via spring with low damping)
spring({ frame, fps, config: { mass: 1, damping: 6, stiffness: 200 } })
```

---

## 7. Example Prompt / Response Pairs

### Use case 1: Generate from scratch

**User:**
```
Create a bouncy logo reveal animation for the word FINKS.
```

**Prompt sent to Claude:**
```
[system prompt as above]

<user_request>
Create a bouncy logo reveal animation for the word FINKS.
</user_request>
```

**Expected Claude output structure:**
```tsx
<code>
import { useCurrentFrame, useVideoConfig, spring, AbsoluteFill } from 'remotion';

export default function FINKSReveal() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: { mass: 1, damping: 8, stiffness: 180 },
  });

  const opacity = Math.min(frame / 10, 1);

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
      <span style={{
        fontSize: 120,
        fontWeight: 900,
        color: '#fff',
        transform: `scale(${scale})`,
        opacity,
        letterSpacing: '0.1em',
      }}>
        FINKS
      </span>
    </AbsoluteFill>
  );
}
</code>
```

---

### Use case 2: Iterative edit with context

**User:** "Make the bounce faster"

**Prompt sent to Claude:**
```
[system prompt]

<current_code>
{{ full current TSX }}
</current_code>

<user_request>
Make the bounce faster.
</user_request>
```

**Expected change:** Claude increases `stiffness` and reduces `mass` in the spring config, regenerates full file.

---

### Use case 3: Selection-based edit

**User highlights the spring config block, types:** "Make this more elastic"

**Prompt sent to Claude:**
```
[system prompt]

<current_code>
import { useCurrentFrame, useVideoConfig, spring, AbsoluteFill } from 'remotion';

export default function FINKSReveal() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  <selection>
  const scale = spring({
    frame,
    fps,
    config: { mass: 1, damping: 8, stiffness: 180 },
  });
  </selection>

  ...rest of file...
}
</current_code>

<user_request>
Make this more elastic — bigger overshoot, slower settle.
</user_request>
```

**Expected change:** Claude modifies `damping` down (e.g. 4–6) and `mass` up slightly, preserves rest of file.

---

### Use case 4: Style transfer

**User:** "Make it look like a TikTok-style transition"

**Prompt sent to Claude:**
```
[system prompt]

<current_code>
{{ current TSX }}
</current_code>

<user_request>
Make it look like a TikTok-style transition. Fast, punchy, with a quick zoom and chromatic aberration effect.
</user_request>
```

**Expected approach:** Claude adds a fast zoom-in spring (frames 0–8), a brief RGB channel offset using layered colored divs or CSS filter, and a fast fade-out at the end. The system prompt's vocabulary (anticipation, fast spring config) gives it enough grounding to make sensible choices.

---

### Use case 5: Debugging

**User:** "This animation stutters around frame 45, fix it"

**Prompt sent to Claude:**
```
[system prompt]

<current_code>
{{ current TSX }}
</current_code>

<user_request>
This animation stutters around frame 45. Fix it.
</user_request>
```

**Expected Claude behavior:** Look for `interpolate` calls where the input range transitions abruptly (non-monotonic or with discontinuous extrapolation), or `spring` calls whose settle time overlaps with another animation that resets frame-relative timing. Claude should return a corrected file with a brief inline comment (one line max) on what it changed and why.

**If the stutter is from a missing clamp:**
- Claude adds `extrapolateLeft: 'clamp', extrapolateRight: 'clamp'` to the interpolate call at the relevant frame range.

---

## 8. Model Selection Notes

- **Claude Sonnet** is the right default: fast enough for the interactive edit loop (<3s for a 200-line file), strong enough for reliable TSX generation.
- **Claude Opus** for first-generation of complex multi-scene compositions where quality matters more than latency.
- **Prompt caching** on the system prompt is a significant win: the system prompt (~500 tokens) is constant across all calls in a session. Using the Anthropic API's cache_control on the system prompt block reduces cost and latency for all subsequent calls in a conversation.

```typescript
// Cache the system prompt across turns
const systemBlock = {
  type: 'text',
  text: SYSTEM_PROMPT,
  cache_control: { type: 'ephemeral' },
};
```

---

## Summary Table

| Question | Answer |
|---|---|
| System prompt structure | Single-file output in `<code>` tag, full Remotion vocabulary, no explanatory prose |
| Context-passing | Pass current TSX in `<current_code>` tag only; omit history |
| Selection annotation | Wrap selected region in `<selection>` tags inside `<current_code>` |
| Full file vs diff | Full file — more reliable, simpler validation, fine for files under 500 lines |
| Error recovery | Extract -> syntax check -> import check -> render probe -> retry with error message (max 2 retries) |
| Animation vocabulary | Include in system prompt: spring params, Remotion helpers, easing idioms, motion principles |
| Existing open-source art | No widely-adopted LLM-to-Remotion prompt library exists as of 2025; Remotion's own AI tools (remotion.dev/ai) use full-file replacement and structured output; same conclusion independently reached here |
