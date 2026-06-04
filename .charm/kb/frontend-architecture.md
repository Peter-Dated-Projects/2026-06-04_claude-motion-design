# Frontend Architecture: Next.js 3-Panel Editor UI

## 1. Editor Library Recommendation: Monaco Editor

**Decision: Monaco Editor** (the engine behind VS Code).

Comparison:

| Library | Selection API | TSX support | Bundle size | Verdict |
|---|---|---|---|---|
| Monaco Editor | `editor.getSelection()` + `editor.getModel().getValueInRange()` — first-class, rich | Built-in TypeScript/JSX worker | ~4 MB (use dynamic import) | **Recommended** |
| CodeMirror 6 | `view.state.selection` — works but needs manual wiring | Via @codemirror/lang-javascript | ~300 KB | Good fit for lightweight editors; selection wiring is doable but more custom code |
| Sandpack | No selection API; designed for full self-contained sandbox UX | Built-in | ~1.5 MB | Wrong fit — opinionated sandbox, not a raw editor |

Monaco wins because:
- `editor.getSelection()` / `editor.getModel().getValueInRange()` gives the selected text and its line range with one call — exactly what the selection-to-Claude-prompt flow needs.
- First-class TypeScript + JSX language support with type inference out of the box.
- The VS Code familiarity lowers the UX learning curve for developers.
- Load it with `next/dynamic` + `{ ssr: false }` to keep the server bundle clean.

```ts
// Usage pattern for selection capture
const selection = editor.getSelection();
const selectedText = editor.getModel()?.getValueInRange(selection) ?? '';
const { startLineNumber, endLineNumber } = selection;
```

---

## 2. State Management: Zustand

**Decision: Zustand** over Jotai or React Context.

- React Context re-renders the whole subtree on every change — bad for the editor (keystroke-level updates) and chat (stream updates) happening simultaneously.
- Jotai is excellent for atomic state but the relational shape of this app (project → conversations → messages, plus editor ↔ preview sync) maps more naturally to one flat store with slices.
- Zustand gives slice-able stores, selective subscriptions (components only re-render when their slice changes), and easy devtools integration — no boilerplate.

### Store shape (sketch)

```ts
interface AppStore {
  // Project
  projectId: string | null;
  projectName: string;

  // Code editor
  code: string;                       // current animation TSX source
  setCode: (code: string) => void;
  selection: EditorSelection | null;  // { text, startLine, endLine }
  setSelection: (sel: EditorSelection | null) => void;

  // Chat
  messages: Message[];                // { role, content, id }
  appendMessage: (msg: Message) => void;
  isStreaming: boolean;

  // Preview
  isPlaying: boolean;
  togglePlay: () => void;
  previewError: string | null;        // runtime error from sandbox
}

interface EditorSelection {
  text: string;
  startLine: number;
  endLine: number;
}
```

Components subscribe to only what they need:

```ts
// Editor panel only re-renders on code changes
const code = useAppStore(s => s.code);

// Chat only re-renders on messages/streaming changes
const messages = useAppStore(s => s.messages);
```

---

## 3. Component Tree

```
app/
  layout.tsx            -- root layout, auth guard, Zustand provider
  editor/
    page.tsx            -- EditorPage (3-panel shell)
    
components/
  editor/
    EditorPage.tsx      -- flex-row shell, manages panel sizing
    ChatPanel.tsx       -- left panel
      MessageList.tsx
      MessageBubble.tsx
      ChatInput.tsx     -- textarea + send button
    CodePanel.tsx       -- center panel
      MonacoEditor.tsx  -- dynamic import, fires onSelectionChange -> store
    PreviewPanel.tsx    -- right panel
      AnimationFrame.tsx -- the scaled iframe/sandboxed div
      PreviewControls.tsx -- play/pause, scrubber
```

### Panel sizing

Use a flex-row layout with fixed pixel widths or CSS `grid`:

```css
.editor-shell {
  display: grid;
  grid-template-columns: 320px 1fr 400px;
  height: 100vh;
  overflow: hidden;
}
```

Center column takes remaining space; left and right are fixed. Later add resizable handles with `react-resizable-panels` if needed.

---

## 4. Selection-to-Prompt Data Flow

The key insight: the editor fires selection events continuously as the user drags; we only capture when the user actually sends a message.

```
User drags to highlight code in MonacoEditor
  -> editor.onDidChangeCursorSelection fires
  -> MonacoEditor.tsx reads getSelection() + getValueInRange()
  -> calls useAppStore.setState({ selection: { text, startLine, endLine } })

User types in ChatInput and hits Send
  -> ChatInput.tsx reads store: { messages, selection, code }
  -> builds prompt:
       if (selection) {
         "Lines ${startLine}-${endLine}:\n```tsx\n${selection.text}\n```\n\n${userMessage}"
       } else {
         userMessage
       }
  -> POST /api/chat with { messages, prompt, fullCode: code }
  -> clears selection after send (store.setSelection(null))
  -> streams response back, appends to messages, sets code if Claude returns updated TSX
```

The selection is advisory context, not a separate system. Claude sees the highlighted region inline in the human turn. The API route on the backend decides whether to treat it as a targeted edit or a full rewrite.

---

## 5. Next.js App Router

**Use App Router** (not Pages Router).

- Route: `app/editor/[projectId]/page.tsx` — project-scoped URL, shareable, browser-history-safe.
- Auth guard in `app/layout.tsx` (or middleware) — redirect to `/login` if no session cookie.
- API routes as Route Handlers: `app/api/chat/route.ts` (streaming), `app/api/project/route.ts`.
- The editor itself is a client component (`'use client'`); wrap it in a server component that fetches initial project data and passes it down as props.

```ts
// app/editor/[projectId]/page.tsx (server component)
export default async function EditorPage({ params }) {
  const project = await fetchProject(params.projectId); // server-side DynamoDB call
  return <EditorShell initialProject={project} />;
}
```

This pattern gets the first paint with data server-rendered (no loading spinner for project metadata), while the interactive editor hydrates on the client.

---

## 6. Preview Panel Scaling (1080x1920 → panel)

**Use CSS `transform: scale()`** — not explicit sizing.

The animation renders at native 1080x1920 in an iframe (or a sandboxed div), then a wrapper applies a scale transform to fit the panel height.

```tsx
// AnimationFrame.tsx
const NATIVE_W = 1080;
const NATIVE_H = 1920;

export function AnimationFrame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const obs = new ResizeObserver(([entry]) => {
      const { height } = entry.contentRect;
      setScale(height / NATIVE_H);
    });
    obs.observe(containerRef.current!);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: NATIVE_W,
          height: NATIVE_H,
          transform: `scale(${scale})`,
          transformOrigin: 'top center',
        }}
      >
        {/* Remotion Player or iframe sandbox goes here */}
      </div>
    </div>
  );
}
```

`transform: scale` is GPU-composited — no reflow on resize events after the first paint. The ResizeObserver keeps the scale factor live as the panel is resized. The inner div stays at native dimensions, which is what Remotion expects.

---

## 7. Vercel Deployment Constraints

| Concern | Constraint | Mitigation |
|---|---|---|
| Streaming chat responses | Vercel serverless functions default timeout: 30s (hobby), 5 min (pro) | Use **Edge Runtime** for the `/api/chat` route — no timeout cap, streaming-native |
| Monaco bundle size | ~4 MB JS for Monaco workers | `next/dynamic` with `ssr: false`; Monaco self-hosts worker files via a custom webpack rule or `monaco-editor-webpack-plugin` |
| Bundle size limit | Vercel has a 50 MB uncompressed function bundle limit | Monaco + Remotion player on the client only (never imported server-side) keeps function bundles small |
| Remotion rendering | Remotion's server-side render (for MP4 export) needs a Lambda or long-running process | Do NOT put ffmpeg/Remotion server render in Vercel functions — use a separate AWS Lambda or EC2 for export (see export pipeline ticket) |
| Cold starts | Edge runtime has faster cold starts than Node | Use Edge for chat streaming; use Node runtime for auth/session routes that need DynamoDB SDK |

Edge runtime config for streaming:

```ts
// app/api/chat/route.ts
export const runtime = 'edge';

export async function POST(req: Request) {
  // ... stream Anthropic response directly
}
```

---

## Summary

| Question | Answer |
|---|---|
| Code editor | Monaco Editor (dynamic import, `ssr: false`) |
| State management | Zustand with sliced store |
| Selection-to-prompt | Capture on send, inject as inline code block in human turn |
| Preview scaling | `transform: scale()` driven by ResizeObserver |
| Next.js router | App Router; server component fetches project, client shell handles editor |
| Vercel runtime | Edge for chat streaming, Node for auth/DynamoDB routes |
| MP4 export | Offload to separate Lambda — not in Vercel functions |
