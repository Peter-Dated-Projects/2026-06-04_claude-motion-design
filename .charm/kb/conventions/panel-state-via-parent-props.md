---
id: panel-state-via-parent-props
root: conventions
type: convention
status: current
summary: "Cross-panel data flows through the parent via props/callbacks, not custom DOM events or a shared store: ChatPanel emits onCodeGenerated, CodePanel takes code/onCodeChange; integration (App) owns the shared code state and wires them."
created: 2026-06-04
updated: 2026-06-04
---

The three panels do not talk to each other directly. Each panel takes its inputs
as props and reports out via callbacks; the parent (App / integration wiring,
T-032) owns the shared state and connects them.

Established by the panel components:

- `CodePanel` takes `code?: string` (pushed in by the parent) and reports edits
  via `onCodeChange` / `onLineCountChange`.
- `ChatPanel` takes `onCodeGenerated?: (code: string) => void`; when a Claude run
  finishes and yields a `<code>` block, it calls that callback. The parent routes
  the value into `CodePanel`'s `code` prop.

So the integration wiring is: App holds `const [code, setCode] = useState(...)`,
passes `onCodeGenerated={setCode}` to `ChatPanel` and `code={code}` to `CodePanel`.

Do NOT introduce `window` CustomEvents or stuff cross-panel payloads into the
Zustand stores for this. The stores (`uiStore`, `projectStore`) are for genuinely
*global* UI/project state — `uiStore.isGenerating` is the legitimate shared signal
(ChatPanel sets it; CodePanel reads it to show its read-only overlay). One-shot
data handoffs between sibling panels go through the parent as props. This mirrors
the layout convention where App owns sizing via `.panel-slot` wrappers
([[panel-layout-shell]]).
